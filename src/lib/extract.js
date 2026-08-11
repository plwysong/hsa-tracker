// Document text extraction: PDF text layer via pdfjs, OCR fallback via tesseract.js,
// HEIC → JPEG conversion so phone photos work.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/heic', 'image/heif']);

export function isSupported(mime, filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  return mime === 'application/pdf' || IMAGE_MIMES.has(mime) ||
    ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'heic', 'heif', 'txt', 'csv', 'eml', 'html'].includes(ext);
}

export async function extractPdfText(buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Group items by line (y position) so amounts stay next to their descriptions
    const lines = new Map();
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: item.transform[4], str: item.str });
    }
    const sorted = [...lines.entries()].sort((a, b) => b[0] - a[0]);
    for (const [, items] of sorted) {
      items.sort((a, b) => a.x - b.x);
      parts.push(items.map(i => i.str).join(' ').trim());
    }
    parts.push('');
  }
  await doc.destroy();
  return parts.join('\n').trim();
}

/** Rasterize the first pages of a scanned PDF and OCR them. */
async function ocrPdf(buffer, maxPages = 3) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const parts = [];
  const pages = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    parts.push(await ocrImage(canvas.toBuffer('image/png')));
  }
  await doc.destroy();
  return parts.join('\n');
}

async function heicToJpeg(buffer) {
  const { default: heicConvert } = await import('heic-convert');
  return Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: 0.9 }));
}

export async function ocrImage(buffer) {
  const { createWorker } = await import('tesseract.js');
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  // The English model ships with the app (@tesseract.js-data/eng) so OCR never
  // downloads anything. 4.0.0_best_int is the variant tesseract.js requests for
  // its default LSTM-only mode; cacheMethod 'none' stops it from writing a
  // duplicate copy of the model into the process working directory.
  const langPath = path.join(
    path.dirname(createRequire(import.meta.url).resolve('@tesseract.js-data/eng/package.json')),
    '4.0.0_best_int');
  const worker = await createWorker('eng', undefined, { langPath, cacheMethod: 'none', gzip: true });
  try {
    const { data } = await worker.recognize(buffer);
    return (data.text || '').trim();
  } finally {
    await worker.terminate();
  }
}

/**
 * Extract text from a receipt document.
 * Returns { text, method } where method is 'pdf-text' | 'pdf-ocr' | 'ocr' | 'plain'.
 */
export async function extractText(buffer, mime, filename = '') {
  const ext = filename.toLowerCase().split('.').pop();

  if (mime === 'application/pdf' || ext === 'pdf') {
    const text = await extractPdfText(buffer);
    if (text.length >= 30) return { text, method: 'pdf-text' };
    // Scanned PDFs have no text layer — rasterize the first pages and OCR them.
    try {
      const ocrText = await ocrPdf(buffer);
      if (ocrText.trim().length >= 30) return { text: ocrText, method: 'pdf-ocr' };
    } catch { /* rasterization unavailable — fall through with what we have */ }
    return { text, method: 'pdf-text-sparse' };
  }

  if (mime === 'image/heic' || mime === 'image/heif' || ext === 'heic' || ext === 'heif') {
    buffer = await heicToJpeg(buffer);
    mime = 'image/jpeg';
  }

  if (IMAGE_MIMES.has(mime) || ['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext)) {
    const text = await ocrImage(buffer);
    return { text, method: 'ocr' };
  }

  // Plain text / html / eml fallback
  return { text: buffer.toString('utf8'), method: 'plain' };
}
