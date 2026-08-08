// Optional email ingestion: polls an IMAP inbox (e.g. a dedicated free Gmail account
// you forward receipts to) and runs attachments + message bodies through the same
// pipeline as drag-and-drop uploads. Disabled by default; configure in Settings.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db, getSetting, audit } from '../db.js';
import { ingestDocument } from './ingest.js';
import { isSupported } from './extract.js';

let pollTimer = null;
let lastCheck = { at: null, result: null, error: null };

export function emailStatus() {
  return {
    enabled: !!getSetting('email_enabled'),
    configured: !!(getSetting('email_user') && getSetting('email_password')),
    lastCheck,
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
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const unseen = await client.search({ seen: false });
      for (const uid of unseen || []) {
        const msg = await client.fetchOne(uid, { source: true });
        if (!msg?.source) continue;
        const parsed = await simpleParser(msg.source);
        const messageId = parsed.messageId || `uid-${uid}-${parsed.date?.getTime() || ''}`;

        // Dedup on message id
        const seen = db.prepare('SELECT 1 FROM processed_sources WHERE kind = ? AND ref = ?').get('email_message_id', messageId);
        if (seen) { skipped++; await client.messageFlagsAdd(uid, ['\\Seen']); continue; }

        const sourceDetail = { from: parsed.from?.text, subject: parsed.subject, emailDate: parsed.date?.toISOString(), messageId };
        let ingested = false;

        for (const att of parsed.attachments || []) {
          if (!isSupported(att.contentType, att.filename || '')) continue;
          ingestDocument(att.content, {
            originalName: att.filename || `attachment-${uid}`,
            mime: att.contentType,
            source: 'email',
            sourceDetail,
          });
          ingested = true;
        }

        // No usable attachments → ingest the message body itself (order confirmations
        // like Amazon put line items in the HTML body).
        if (!ingested) {
          const body = parsed.text || parsed.html?.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ') || '';
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
        await client.messageFlagsAdd(uid, ['\\Seen']);
        if (ingested) processed++; else skipped++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  lastCheck = { at: new Date().toISOString(), result: { processed, skipped }, error: null };
  audit('email_check', lastCheck.result);
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
