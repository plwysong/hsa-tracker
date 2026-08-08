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
