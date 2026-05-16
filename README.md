# Groovelog Backend

Node.js + Express backend connecting to MusicBrainz (free, no API key needed).

## Setup

### 1. Install Node.js
Download from https://nodejs.org (v18 or higher)

### 2. Install dependencies
```bash
cd groovelog-backend
npm install
```

### 3. Start the server
```bash
npm start
```
Server runs at http://localhost:3001

### 4. Connect the frontend
In `groovelog_app.html`, find this line near the top:
```js
const API_BASE = null;
```
Change it to:
```js
const API_BASE = 'http://localhost:3001';
```

Now the app will fetch real album data, cover art, and store ratings in a local SQLite database.

## What the backend does

| Feature | How |
|---|---|
| Album search | MusicBrainz free API |
| Artist search | MusicBrainz free API |
| Track search | MusicBrainz free API |
| Cover art | Cover Art Archive (free) |
| Ratings storage | Local SQLite file (`groovelog.db`) |
| Reviews storage | Local SQLite file |
| Comments | Local SQLite file |
| Recommendations | Local SQLite file |

## API endpoints

```
GET  /api/health
GET  /api/search?q=frank+ocean&type=release
GET  /api/album/:mbid
GET  /api/artist/:mbid
GET  /api/trending
POST /api/rate          { mbid, type, score, review }
GET  /api/ratings/:mbid
GET  /api/comments/:mbid
POST /api/comments      { mbid, text }
GET  /api/recs?userId=1
POST /api/recs          { fromUserId, toUserId, mbid, note }
GET  /api/profile/:userId
GET  /api/cover/:mbid
```

## Deploying to production

For a live URL you can share, deploy to Railway or Render:

**Railway (recommended, free tier)**
1. Push to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Set environment variable: `PORT=3001`
4. Update `API_BASE` in the HTML to your Railway URL

**Render**
Same process at render.com

## MusicBrainz fair use
- Max 1 request/second (the server caches responses for 5 minutes)
- User-Agent header is required (set in server.js)
- Free forever, no API key needed
