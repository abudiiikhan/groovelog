/*
  Groovelog Backend Server
  ========================
  Connects to MusicBrainz (free, no API key needed) + Cover Art Archive
  Run: npm install && npm start
  Server starts on http://localhost:3001
*/

const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const Database   = require('better-sqlite3');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── MusicBrainz requires a descriptive User-Agent ── */
const MB_BASE    = 'https://musicbrainz.org/ws/2';
const CAA_BASE   = 'https://coverartarchive.org';
const MB_HEADERS = {
  'User-Agent': 'Groovelog/1.0.0 (your@email.com)',
  'Accept':     'application/json',
};

/* ── SQLite database (stores ratings, reviews, users) ── */
const db = new Database(path.join(__dirname, 'groovelog.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS art_cache (
    key       TEXT PRIMARY KEY,
    coverUrl  TEXT,
    mbid      TEXT,
    releaseMbid TEXT,
    updated   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    handle    TEXT UNIQUE NOT NULL,
    name      TEXT NOT NULL,
    created   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ratings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    userId    INTEGER NOT NULL,
    mbid      TEXT NOT NULL,
    type      TEXT NOT NULL CHECK(type IN ('album','song')),
    score     REAL NOT NULL CHECK(score >= 0 AND score <= 10),
    review    TEXT DEFAULT '',
    updated   TEXT DEFAULT (datetime('now')),
    UNIQUE(userId, mbid, type)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    userId    INTEGER NOT NULL,
    mbid      TEXT NOT NULL,
    text      TEXT NOT NULL,
    created   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS likes (
    userId    INTEGER NOT NULL,
    reviewId  INTEGER NOT NULL,
    PRIMARY KEY(userId, reviewId)
  );

  CREATE TABLE IF NOT EXISTS follows (
    followerId  INTEGER NOT NULL,
    followeeId  INTEGER NOT NULL,
    PRIMARY KEY(followerId, followeeId)
  );

  CREATE TABLE IF NOT EXISTS recs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    fromUserId INTEGER NOT NULL,
    toUserId   INTEGER NOT NULL,
    mbid       TEXT NOT NULL,
    note       TEXT DEFAULT '',
    seen       INTEGER DEFAULT 0,
    created    TEXT DEFAULT (datetime('now'))
  );

  /* Seed a demo user if none exist */
  INSERT OR IGNORE INTO users (id, handle, name) VALUES (1, '@you', 'Jess');
`);

/* ── Middleware ── */
app.use(cors());
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 100, message: { error: 'Rate limit exceeded' } }));

/* ── Serve the frontend HTML app ── */
const fs = require('fs');
app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'groovelog_app.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.send('<h2>groovelog_app.html not found in this folder.<br>Make sure it is in the same folder as server.js</h2>');
  }
});
app.use(express.static(__dirname));

/* ── Simple in-memory cache (5 min TTL) ── */
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function cached(key, fn) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return Promise.resolve(entry.data);
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data; });
}

/* ── MusicBrainz helpers ── */
async function mbFetch(path) {
  const url = `${MB_BASE}${path}`;
  const res  = await fetch(url, { headers: MB_HEADERS });
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}: ${url}`);
  return res.json();
}

async function getCoverArt(mbid) {
  try {
    const res = await fetch(`${CAA_BASE}/release/${mbid}`, { headers: MB_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    const front = data.images?.find(i => i.front) || data.images?.[0];
    const url = front?.thumbnails?.['500'] || front?.thumbnails?.large || front?.image || null;
    // Always return https:// — Cover Art Archive returns http:// which browsers block
    return url ? url.replace('http://', 'https://') : null;
  } catch { return null; }
}

/* ── Format album from MusicBrainz release ── */
async function formatRelease(rel) {
  const cover = await getCoverArt(rel.id);
  const avgRating = db.prepare(
    `SELECT AVG(score) as avg, COUNT(*) as count FROM ratings WHERE mbid=? AND type='album'`
  ).get(rel.id);
  const myRating = db.prepare(
    `SELECT score, review FROM ratings WHERE userId=1 AND mbid=? AND type='album'`
  ).get(rel.id);
  return {
    mbid:       rel.id,
    title:      rel.title,
    artist:     rel['artist-credit']?.[0]?.name || rel['artist-credit']?.[0]?.artist?.name || 'Unknown',
    year:       rel.date?.slice(0, 4) || null,
    tracks:     rel['track-count'] || null,
    coverUrl:   cover,
    avg:        avgRating?.avg ? +avgRating.avg.toFixed(1) : null,
    ratings:    avgRating?.count || 0,
    myScore:    myRating?.score ?? null,
    myReview:   myRating?.review ?? '',
  };
}

/* ═════════════════════════════════════════════
   ROUTES
═════════════════════════════════════════════ */

/* ── Health check ── */
app.get('/api/health', (_, res) => res.json({ ok: true, db: 'connected' }));

/* ── Resolve album: title+artist → real MBID + cover art ──
   GET /api/resolve?title=Blonde&artist=Frank+Ocean
   This is how we avoid hardcoding MBIDs.
   The app calls this once per album; results are cached 30 min.
*/
app.get('/api/resolve', async (req, res) => {
  try {
    const { title, artist } = req.query;
    if (!title || !artist) return res.status(400).json({ error: 'title and artist required' });

    const key = `resolve:${title.toLowerCase()}:${artist.toLowerCase()}`;
    // Check memory cache first
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return res.json(hit.data);
    // Check persistent DB cache (survives server restarts)
    const dbHit = db.prepare('SELECT * FROM art_cache WHERE key=?').get(key);
    if (dbHit) {
      const result = { coverUrl: dbHit.coverUrl, mbid: dbHit.mbid, releaseMbid: dbHit.releaseMbid };
      cache.set(key, { data: result, ts: Date.now() });
      return res.json(result);
    }

    // Search MusicBrainz release-groups for best match
    const q = encodeURIComponent(`releasegroup:"${title}" AND artist:"${artist}"`);
    const data = await mbFetch(`/release-group?query=${q}&limit=5&fmt=json`);
    const rgs = data['release-groups'] || [];

    // Pick highest-score studio album match
    const match = rgs
      .filter(rg => !rg['primary-type'] || rg['primary-type'] === 'Album')
      .sort((a, b) => (b.score || 0) - (a.score || 0))[0];

    if (!match) {
      const result = { mbid: null, coverUrl: null };
      cache.set(key, { data: result, ts: Date.now() });
      return res.json(result);
    }

    // Get the canonical release from this release-group for cover art
    const rgData = await mbFetch(`/release?release-group=${match.id}&limit=10&fmt=json`);
    const releases = (rgData.releases || [])
      .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

    // Try each release until we find cover art
    let coverUrl = null;
    for (const rel of releases.slice(0, 5)) {
      coverUrl = await getCoverArt(rel.id);
      if (coverUrl) break;
      await new Promise(r => setTimeout(r, 200));
    }

    const result = {
      mbid:     match.id,       // release-group MBID
      releaseMbid: releases[0]?.id || null,  // first release MBID (for track lookup)
      coverUrl,
      title:    match.title,
      year:     match['first-release-date']?.slice(0, 4) || null,
    };
    cache.set(key, { data: result, ts: Date.now() });
    // Persist to DB so future server restarts don't re-fetch
    db.prepare(`INSERT OR REPLACE INTO art_cache (key, coverUrl, mbid, releaseMbid) VALUES (?,?,?,?)`)
      .run(key, result.coverUrl||null, result.mbid||null, result.releaseMbid||null);
    res.json(result);
  } catch (err) {
    console.error('/api/resolve error:', err.message);
    res.status(502).json({ error: 'Resolve failed', details: err.message });
  }
});

/* ── Search albums, artists, songs ──
   GET /api/search?q=frank+ocean&type=release
   type: release | artist | recording
*/
app.get('/api/search', async (req, res) => {
  try {
    const { q, type = 'release', limit = 20 } = req.query;
    if (!q || q.length < 2) return res.status(400).json({ error: 'Query too short' });

    const key = `search:${type}:${q}:${limit}`;
    const data = await cached(key, () =>
      // MusicBrainz returns results sorted by its own relevance score (0-100).
      // We request more than needed so we can re-rank by score.
      mbFetch(`/${type}?query=${encodeURIComponent(q)}&limit=25&fmt=json`)
    );

    if (type === 'release') {
      const releases = data.releases || [];

      // Filter to studio albums only, deduplicate by release-group
      const seen = new Set();
      const albums = releases
        .filter(r => {
          const pt = r['release-group']?.['primary-type'];
          if (pt && pt !== 'Album') return false;
          const rgId = r['release-group']?.id || r.id;
          if (seen.has(rgId)) return false;
          seen.add(rgId);
          return true;
        })
        // MusicBrainz score is the primary relevance signal — keep it
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 10);

      const results = await Promise.all(albums.map(formatRelease));
      return res.json({ results, total: data.count });
    }

    if (type === 'artist') {
      // MusicBrainz artist score (0-100) is a solid relevance signal
      const artists = (data.artists || [])
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 5)
        .map(a => ({
          mbid:    a.id,
          name:    a.name,
          genre:   a.tags?.[0]?.name || a.disambiguation || '',
          country: a.country || null,
          score:   a.score,
        }));
      return res.json({ results: artists, total: data.count });
    }

    if (type === 'recording') {
      const tracks = (data.recordings || [])
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 10)
        .map(r => ({
          mbid:      r.id,
          title:     r.title,
          artist:    r['artist-credit']?.[0]?.name || 'Unknown',
          duration:  r.length ? `${Math.floor(r.length/60000)}:${String(Math.floor((r.length%60000)/1000)).padStart(2,'0')}` : null,
          album:     r.releases?.[0]?.title || null,
          albumMbid: r.releases?.[0]?.id || null,
          avg:       null,
        }));
      return res.json({ results: tracks, total: data.count });
    }

    res.json({ results: [], total: 0 });
  } catch (err) {
    console.error('/api/search error:', err.message);
    res.status(502).json({ error: 'MusicBrainz unavailable', details: err.message });
  }
});

/* ── Get album detail by MBID ──
   GET /api/album/:mbid
*/
app.get('/api/album/:mbid', async (req, res) => {
  try {
    const { mbid } = req.params;
    const key = `album:${mbid}`;

    // Try as release first, then as release-group
    let data = await cached(key, async () => {
      try {
        return await mbFetch(`/release/${mbid}?inc=recordings+artist-credits+release-groups&fmt=json`);
      } catch {
        // Might be a release-group MBID — find its first release
        const rgData = await mbFetch(`/release?release-group=${mbid}&limit=5&fmt=json`);
        const releases = (rgData.releases || []).sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999'));
        if (!releases[0]) throw new Error('No releases found for release-group');
        return await mbFetch(`/release/${releases[0].id}?inc=recordings+artist-credits+release-groups&fmt=json`);
      }
    });

    const cover = await getCoverArt(mbid);
    const avgRating = db.prepare(`SELECT AVG(score) as avg, COUNT(*) as count FROM ratings WHERE mbid=? AND type='album'`).get(mbid);
    const myRating  = db.prepare(`SELECT score, review FROM ratings WHERE userId=1 AND mbid=? AND type='album'`).get(mbid);

    const tracks = (data.media?.[0]?.tracks || []).map(t => {
      const songRating = db.prepare(`SELECT AVG(score) as avg, COUNT(*) as count FROM ratings WHERE mbid=? AND type='song'`).get(t.recording?.id || t.id);
      const mySongRating = db.prepare(`SELECT score, review FROM ratings WHERE userId=1 AND mbid=? AND type='song'`).get(t.recording?.id || t.id);
      return {
        id:       t.position,
        mbid:     t.recording?.id || t.id,
        title:    t.title || t.recording?.title,
        dur:      t.length ? `${Math.floor(t.length/60000)}:${String(Math.floor((t.length%60000)/1000)).padStart(2,'0')}` : '?:??',
        avg:      songRating?.avg ? +songRating.avg.toFixed(1) : null,
        ratings:  songRating?.count || 0,
        mine:     mySongRating?.score ?? null,
        myReview: mySongRating?.review ?? '',
      };
    });

    res.json({
      mbid,
      title:     data.title,
      artist:    data['artist-credit']?.[0]?.name || 'Unknown',
      year:      data.date?.slice(0, 4) || null,
      tracks:    tracks.length || data['track-count'],
      genre:     data['release-group']?.genres?.[0]?.name || null,
      coverUrl:  cover,
      avg:       avgRating?.avg ? +avgRating.avg.toFixed(1) : null,
      ratings:   avgRating?.count || 0,
      myScore:   myRating?.score ?? null,
      myReview:  myRating?.review ?? '',
      tracklist: tracks,
    });
  } catch (err) {
    console.error('/api/album error:', err.message);
    res.status(502).json({ error: 'Failed to fetch album', details: err.message });
  }
});

/* ── Get artist page ──
   GET /api/artist/:mbid
*/
app.get('/api/artist/:mbid', async (req, res) => {
  try {
    const { mbid } = req.params;
    const key = `artist:${mbid}`;
    const data = await cached(key, () =>
      mbFetch(`/artist/${mbid}?inc=release-groups+tags&fmt=json`)
    );
    const rgs = data['release-groups'] || [];

    const mapRg = rg => ({
      mbid:   rg.id,
      title:  rg.title,
      year:   rg['first-release-date']?.slice(0, 4) || null,
      tracks: 0,
    });

    // Albums — newest first
    const albums = rgs
      .filter(rg => rg['primary-type'] === 'Album' && !rg['secondary-types']?.length)
      .sort((a, b) => (b['first-release-date'] || '').localeCompare(a['first-release-date'] || ''))
      .slice(0, 30)
      .map(mapRg);

    // Singles — newest first
    const singles = rgs
      .filter(rg => rg['primary-type'] === 'Single')
      .sort((a, b) => (b['first-release-date'] || '').localeCompare(a['first-release-date'] || ''))
      .slice(0, 30)
      .map(mapRg);

    // EPs
    const eps = rgs
      .filter(rg => rg['primary-type'] === 'EP')
      .sort((a, b) => (b['first-release-date'] || '').localeCompare(a['first-release-date'] || ''))
      .slice(0, 10)
      .map(mapRg);

    res.json({
      mbid,
      name:    data.name,
      country: data.country || null,
      genre:   data.tags?.[0]?.name || null,
      albums,
      singles,
      eps,
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch artist', details: err.message });
  }
});

/* ── Trending albums (uses MusicBrainz popular releases + our ratings) ──
   GET /api/trending
*/
app.get('/api/trending', async (req, res) => {
  try {
    // Most rated in our DB first
    const topLocal = db.prepare(`
      SELECT mbid, COUNT(*) as cnt, AVG(score) as avg
      FROM ratings WHERE type='album'
      GROUP BY mbid ORDER BY cnt DESC LIMIT 5
    `).all();

    // Pad with hardcoded popular IDs if DB is sparse
    const POPULAR_MBIDS = [
      'b84ee12a-09ef-421b-82de-0441a926375b', // Blonde - Frank Ocean
      '2314e60e-b5f5-4f16-9ac7-15a14a1b0c3c', // To Pimp A Butterfly
      'ffc7e7e1-1f7f-48c0-b7b0-caa1aa37e50a', // CTRL - SZA
      '4cdfe082-a8d5-4207-a6dc-c33fde7d94a4', // Currents
    ];
    const mbids = [...new Set([...topLocal.map(r => r.mbid), ...POPULAR_MBIDS])].slice(0, 6);

    const results = await Promise.all(
      mbids.map(mbid =>
        cached(`album:meta:${mbid}`, async () => {
          try {
            const data = await mbFetch(`/release/${mbid}?fmt=json`);
            const cover = await getCoverArt(mbid);
            const r = db.prepare(`SELECT AVG(score) as avg, COUNT(*) as cnt FROM ratings WHERE mbid=?`).get(mbid);
            return {
              mbid, cover,
              title:   data.title,
              artist:  data['artist-credit']?.[0]?.name || 'Unknown',
              year:    data.date?.slice(0, 4),
              avg:     r?.avg ? +r.avg.toFixed(1) : null,
              ratings: r?.cnt || 0,
            };
          } catch { return null; }
        })
      )
    );
    res.json({ trending: results.filter(Boolean) });
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch trending', details: err.message });
  }
});

/* ── Rate an album or song ──
   POST /api/rate
   Body: { mbid, type, score, review, userId }
*/
app.post('/api/rate', (req, res) => {
  try {
    const { mbid, type, score, review = '', userId = 1 } = req.body;
    if (!mbid || !type || score === undefined) return res.status(400).json({ error: 'mbid, type and score required' });
    if (score < 0 || score > 10) return res.status(400).json({ error: 'Score must be 0-10' });
    if (!['album','song'].includes(type)) return res.status(400).json({ error: 'type must be album or song' });

    db.prepare(`
      INSERT INTO ratings (userId, mbid, type, score, review, updated)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(userId, mbid, type) DO UPDATE SET score=excluded.score, review=excluded.review, updated=excluded.updated
    `).run(userId, mbid, type, score, review);

    const avgRow = db.prepare(`SELECT AVG(score) as avg, COUNT(*) as cnt FROM ratings WHERE mbid=? AND type=?`).get(mbid, type);
    res.json({ ok: true, avg: +avgRow.avg.toFixed(1), ratings: avgRow.cnt });
  } catch (err) {
    res.status(500).json({ error: 'DB error', details: err.message });
  }
});

/* ── Get ratings for a specific album/song ──
   GET /api/ratings/:mbid?type=album&userId=1
*/
app.get('/api/ratings/:mbid', (req, res) => {
  const { mbid } = req.params;
  const { type = 'album', userId = 1 } = req.query;
  const avg     = db.prepare(`SELECT AVG(score) as avg, COUNT(*) as cnt FROM ratings WHERE mbid=? AND type=?`).get(mbid, type);
  const my      = db.prepare(`SELECT score, review FROM ratings WHERE userId=? AND mbid=? AND type=?`).get(userId, mbid, type);
  const reviews = db.prepare(`
    SELECT r.id, r.score, r.review, r.updated, u.handle, u.name
    FROM ratings r JOIN users u ON r.userId=u.id
    WHERE r.mbid=? AND r.type=? ORDER BY r.updated DESC LIMIT 50
  `).all(mbid, type);
  res.json({ avg: avg?.avg ? +avg.avg.toFixed(1) : null, count: avg?.cnt || 0, myScore: my?.score ?? null, myReview: my?.review ?? '', reviews });
});

/* ── Comments ──
   GET  /api/comments/:mbid
   POST /api/comments
*/
app.get('/api/comments/:mbid', (req, res) => {
  const { mbid } = req.params;
  const rows = db.prepare(`
    SELECT c.id, c.text, c.created, u.handle, u.name
    FROM comments c JOIN users u ON c.userId=u.id
    WHERE c.mbid=? ORDER BY c.created ASC
  `).all(mbid);
  res.json({ comments: rows });
});

app.post('/api/comments', (req, res) => {
  const { mbid, text, userId = 1 } = req.body;
  if (!mbid || !text?.trim()) return res.status(400).json({ error: 'mbid and text required' });
  const result = db.prepare(`INSERT INTO comments (userId, mbid, text) VALUES (?, ?, ?)`).run(userId, mbid, text.trim());
  res.json({ ok: true, id: result.lastInsertRowid });
});

/* ── Recommendations ──
   GET  /api/recs?userId=1          — recs for user
   POST /api/recs                   — send a rec
*/
app.get('/api/recs', (req, res) => {
  const { userId = 1 } = req.query;
  const rows = db.prepare(`
    SELECT r.id, r.mbid, r.note, r.seen, r.created, u.handle, u.name
    FROM recs r JOIN users u ON r.fromUserId=u.id
    WHERE r.toUserId=? ORDER BY r.created DESC
  `).all(userId);
  res.json({ recs: rows });
});

app.post('/api/recs', (req, res) => {
  const { fromUserId = 1, toUserId, mbid, note = '' } = req.body;
  if (!toUserId || !mbid) return res.status(400).json({ error: 'toUserId and mbid required' });
  const result = db.prepare(`INSERT INTO recs (fromUserId, toUserId, mbid, note) VALUES (?, ?, ?, ?)`).run(fromUserId, toUserId, mbid, note);
  res.json({ ok: true, id: result.lastInsertRowid });
});

/* ── Profile / feed ──
   GET /api/profile/:userId
*/
app.get('/api/profile/:userId', (req, res) => {
  const { userId } = req.params;
  const user    = db.prepare(`SELECT * FROM users WHERE id=?`).get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const ratings = db.prepare(`SELECT mbid, type, score, review, updated FROM ratings WHERE userId=? ORDER BY updated DESC LIMIT 20`).all(userId);
  const stats   = db.prepare(`SELECT COUNT(*) as cnt, AVG(score) as avg FROM ratings WHERE userId=? AND type='album'`).get(userId);
  res.json({ user, ratings, stats: { count: stats.cnt, avg: stats.avg ? +stats.avg.toFixed(1) : null } });
});

/* ── Cover art proxy ──
   GET /api/cover/:mbid
*/
app.get('/api/cover/:mbid', async (req, res) => {
  try {
    const url = await getCoverArt(req.params.mbid);
    if (!url) return res.status(404).json({ error: 'No cover art' });
    res.json({ url });
  } catch (err) {
    res.status(502).json({ error: 'Cover art unavailable' });
  }
});

/* ── Artist image via Wikipedia ──
   MusicBrainz has no images. Wikipedia does — free, no key needed.
   GET /api/artist-image?name=Drake
   Strategy:
   1. Search Wikipedia for the artist
   2. Get the page thumbnail from the Wikipedia API
   3. Return the image URL
*/
app.get('/api/artist-image', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'name required' });

    const key = `artist-img:${name.toLowerCase()}`;
    const cached_result = cache.get(key);
    if (cached_result && Date.now() - cached_result.ts < 30 * 60 * 1000) {
      return res.json(cached_result.data);
    }

    // Step 1: Search Wikipedia for the artist
    const searchUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Groovelog/1.0 (your@email.com)' }
    });

    if (searchRes.ok) {
      const data = await searchRes.json();
      const imgUrl = data.thumbnail?.source || data.originalimage?.source || null;
      const result = { url: imgUrl, description: data.description || null };
      cache.set(key, { data: result, ts: Date.now() });
      return res.json(result);
    }

    // Step 2: Fallback — search Wikipedia API
    const wikiSearch = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(name)}&prop=pageimages&format=json&pithumbsize=400&origin=*`,
      { headers: { 'User-Agent': 'Groovelog/1.0 (your@email.com)' } }
    );
    if (wikiSearch.ok) {
      const wd = await wikiSearch.json();
      const pages = Object.values(wd.query?.pages || {});
      const imgUrl = pages[0]?.thumbnail?.source || null;
      const result = { url: imgUrl };
      cache.set(key, { data: result, ts: Date.now() });
      return res.json(result);
    }

    res.json({ url: null });
  } catch (err) {
    res.json({ url: null });
  }
});

/* ── Pre-warm cover art cache on startup ──
   Resolves the main albums in the background so the home screen
   loads with art immediately after the first visit warms the cache.
*/
const PREWARM_ALBUMS = [
  {title:"Blonde",              artist:"Frank Ocean"},
  {title:"To Pimp a Butterfly", artist:"Kendrick Lamar"},
  {title:"CTRL",                artist:"SZA"},
  {title:"Currents",            artist:"Tame Impala"},
  {title:"After Hours",         artist:"The Weeknd"},
  {title:"IGOR",                artist:"Tyler, the Creator"},
  {title:"In Rainbows",         artist:"Radiohead"},
  {title:"Lemonade",            artist:"Beyoncé"},
  {title:"folklore",            artist:"Taylor Swift"},
  {title:"channel ORANGE",      artist:"Frank Ocean"},
];

async function prewarmCache() {
  console.log('  Pre-warming cover art cache...');
  for (const {title, artist} of PREWARM_ALBUMS) {
    const key = `resolve:${title.toLowerCase()}:${artist.toLowerCase()}`;
    const existing = db.prepare('SELECT key FROM art_cache WHERE key=? AND coverUrl IS NOT NULL').get(key);
    if (existing) { console.log(`  ✓ cached: ${title}`); continue; }
    try {
      const q = encodeURIComponent(`releasegroup:"${title}" AND artist:"${artist}"`);
      const data = await mbFetch(`/release-group?query=${q}&limit=3&fmt=json`);
      const match = (data['release-groups']||[])
        .filter(rg=>!rg['primary-type']||rg['primary-type']==='Album')
        .sort((a,b)=>(b.score||0)-(a.score||0))[0];
      if (!match) continue;
      const rgData = await mbFetch(`/release?release-group=${match.id}&limit=5&fmt=json`);
      const releases = (rgData.releases||[]).sort((a,b)=>(a.date||'9999').localeCompare(b.date||'9999'));
      let coverUrl = null;
      for (const rel of releases.slice(0,3)) {
        coverUrl = await getCoverArt(rel.id);
        if (coverUrl) break;
        await new Promise(r=>setTimeout(r,300));
      }
      db.prepare(`INSERT OR REPLACE INTO art_cache (key,coverUrl,mbid,releaseMbid) VALUES (?,?,?,?)`)
        .run(key, coverUrl||null, match.id, releases[0]?.id||null);
      console.log(`  ${coverUrl?'✓':'✗'} resolved: ${title}`);
      await new Promise(r=>setTimeout(r,1100)); // respect MB rate limit
    } catch(e) { console.log(`  ✗ failed: ${title} — ${e.message}`); }
  }
  console.log('  Cover art pre-warm complete.');
}

/* ── Start server ── */
app.listen(PORT, () => {
  // Start cache pre-warming in background (non-blocking)
  setTimeout(prewarmCache, 2000);
  console.log(`
  ╔════════════════════════════════════════╗
  ║  Groovelog API running on port ${PORT}    ║
  ║  MusicBrainz: connected (no key needed)║
  ║  Database: groovelog.db               ║
  ║  Cover art: pre-warming in background ║
  ╚════════════════════════════════════════╝

  Endpoints:
    GET  /api/health
    GET  /api/search?q=frank+ocean&type=release
    GET  /api/album/:mbid
    GET  /api/artist/:mbid
    GET  /api/trending
    POST /api/rate
    GET  /api/ratings/:mbid
    GET  /api/comments/:mbid
    POST /api/comments
    GET  /api/recs?userId=1
    POST /api/recs
    GET  /api/profile/:userId
    GET  /api/cover/:mbid
  `);
});
