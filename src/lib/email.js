// Optional email ingestion: polls an IMAP inbox (e.g. a dedicated free Gmail account
// you forward receipts to) and runs attachments + message bodies through the same
// pipeline as drag-and-drop uploads. Disabled by default; configure in Settings.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db, getSetting, audit } from '../db.js';
import { ingestDocument } from './ingest.js';
import { isSupported, htmlToText } from './extract.js';

let pollTimer = null;
let lastCheck = { at: null, result: null, error: null };

export function emailStatus() {
  return {
    enabled: !!getSetting('email_enabled'),
    configured: !!(getSetting('email_user') && getSetting('email_password')),
    lastCheck,
    recentSkipped: db.prepare('SELECT subject, from_addr, reason, email_date, created_at FROM skipped_emails ORDER BY id DESC LIMIT 10').all(),
  };
}

export async function checkEmailNow() {
  const user = getSetting('email_user');
  const password = getSetting('email_password');
  if (!user || !password) throw new Error('Email is not configured — set the IMAP account in Settings first.');

  const client = new ImapFlow({
    host: getSetting('email_host') || 'imap.gmail.com',
    port: getSetting('email_port') || 993,
    secure: true,
    auth: { user, pass: password },
    logger: false,
  });

  let processed = 0, skipped = 0;
  const skippedDetails = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Look at all unread mail (no time bound, as before) PLUS anything from the last
      // week even if already read. The message-id dedup below — not the read/unread flag —
      // is the real guard against reprocessing, so opening a receipt in Gmail before the
      // app polls can no longer make it vanish. Fall back to unread-only if a server
      // rejects the OR search.
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      let candidates;
      try {
        candidates = await client.search({ or: [{ seen: false }, { since }] });
      } catch {
        candidates = await client.search({ seen: false });
      }

      for (const seq of candidates || []) {
        // Cheap envelope fetch first: get the message-id without downloading the body,
        // so messages we've already handled cost almost nothing and aren't re-counted.
        const env = await client.fetchOne(seq, { envelope: true });
        const messageId = env?.envelope?.messageId || `uid-${seq}`;
        if (db.prepare('SELECT 1 FROM processed_sources WHERE kind = ? AND ref = ?').get('email_message_id', messageId)) {
          continue; // already processed in a previous run — ignore quietly
        }

        const msg = await client.fetchOne(seq, { source: true });
        if (!msg?.source) continue;
        const parsed = await simpleParser(msg.source);
        const sourceDetail = { from: parsed.from?.text, subject: parsed.subject, emailDate: parsed.date?.toISOString(), messageId };
        let ingested = false;

        for (const att of parsed.attachments || []) {
          if (!isSupported(att.contentType, att.filename || '')) continue;
          ingestDocument(att.content, {
            originalName: att.filename || `attachment-${seq}`,
            mime: att.contentType,
            source: 'email',
            sourceDetail,
          });
          ingested = true;
        }

        // No usable attachments → ingest the message body itself (order confirmations
        // like Amazon put line items in the HTML body).
        if (!ingested) {
          const body = parsed.text || htmlToText(parsed.html);
          if (body.trim().length > 40) {
            ingestDocument(Buffer.from(`Email from: ${parsed.from?.text}\nSubject: ${parsed.subject}\nDate: ${parsed.date}\n\n${body}`, 'utf8'), {
              originalName: `${(parsed.subject || 'email').slice(0, 80)}.txt`,
              mime: 'text/plain',
              source: 'email',
              sourceDetail,
            });
            ingested = true;
          }
        }

        db.prepare('INSERT OR IGNORE INTO processed_sources (kind, ref) VALUES (?, ?)').run('email_message_id', messageId);
        await client.messageFlagsAdd(seq, ['\\Seen']);
        if (ingested) {
          processed++;
        } else {
          // The app couldn't turn this message into a receipt. Record it visibly instead
          // of silently dropping it — the email itself stays in the inbox for you to handle.
          const reason = (parsed.attachments || []).length
            ? 'Had attachments, but none were a supported type (PDF, JPG, PNG, HEIC, TIFF, GIF).'
            : 'No attachment, and no readable text in the message body.';
          db.prepare('INSERT INTO skipped_emails (message_id, from_addr, subject, reason, email_date) VALUES (?, ?, ?, ?, ?)')
            .run(messageId, parsed.from?.text || '', parsed.subject || '', reason, parsed.date?.toISOString() || '');
          audit('email_skipped', { messageId, subject: parsed.subject, reason });
          skippedDetails.push({ subject: parsed.subject || '(no subject)', reason });
          skipped++;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  lastCheck = { at: new Date().toISOString(), result: { processed, skipped, skippedDetails }, error: null };
  audit('email_check', { processed, skipped });
  return lastCheck.result;
}

export function restartEmailPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (!getSetting('email_enabled')) return;
  const minutes = Math.max(2, Number(getSetting('email_poll_minutes')) || 15);
  pollTimer = setInterval(() => {
    checkEmailNow().catch(err => {
      lastCheck = { at: new Date().toISOString(), result: null, error: err.message };
    });
  }, minutes * 60 * 1000);
  pollTimer.unref?.();
}
