// HSA Tracker — local-first HSA eligible expense tracker.
// Run with: npm start   (then open http://localhost:8321)
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './src/db.js';
import { api } from './src/routes/api.js';
import { restartEmailPolling } from './src/lib/email.js';
import { listJobs } from './src/lib/ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8321;

const app = express();

// Even though the server binds to 127.0.0.1, a webpage in the user's browser can
// still fire cross-origin requests at localhost. Reject anything whose Host or
// Origin isn't local, so outside pages can't read or mutate the ledger.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  const origin = req.headers.origin;
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  const localOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  if (!localHost || !localOrigin) return res.status(403).json({ error: 'Local requests only' });
  next();
});

app.use(express.json({ limit: '5mb' }));

// Regular-app lifecycle: the dashboard page sends a heartbeat while open; once
// every tab has been closed for a few minutes (and nothing is mid-processing),
// the server quits itself. Disable with HSA_NO_AUTOEXIT=1 (used by `npm run dev`).
let lastHeartbeat = null;
app.post('/api/heartbeat', (req, res) => { lastHeartbeat = Date.now(); res.json({ ok: true }); });
if (!process.env.HSA_NO_AUTOEXIT) {
  const IDLE_MS = Number(process.env.HSA_IDLE_MS) || 3 * 60 * 1000;
  setInterval(() => {
    if (!lastHeartbeat) return; // never exit before the app has been opened once
    const busy = listJobs().some(j => ['queued', 'extracting', 'triaging'].includes(j.status));
    if (busy) { lastHeartbeat = Date.now(); return; }
    if (Date.now() - lastHeartbeat > IDLE_MS) {
      console.log('Dashboard closed — HSA Tracker is quitting itself.');
      process.exit(0);
    }
  }, Math.min(30000, Math.max(1000, Math.floor((Number(process.env.HSA_IDLE_MS) || 30000) / 2))));
}

// Local-only by default: bind to localhost so nothing is exposed to the network.
app.use('/api', api);
app.use(express.static(path.join(__dirname, 'public')));

// Final safety net: body-parser and multer errors (bad JSON, too many files,
// oversized file) become plain-English JSON instead of an HTML stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = 400, msg;
  if (err.code === 'LIMIT_FILE_SIZE') msg = 'That file is larger than the 50 MB limit.';
  else if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') msg = 'Upload up to 20 files at a time.';
  else if (err.type === 'entity.parse.failed') msg = 'Invalid request body.';
  else { status = err.status || 500; msg = err.message || 'Unexpected error'; }
  console.error(err);
  res.status(status).json({ error: msg });
});

restartEmailPolling();

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  HSA Tracker running → http://localhost:${PORT}\n`);
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log('HSA Tracker server is already running — reusing it.');
  } else {
    throw err;
  }
});
