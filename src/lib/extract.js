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

async function heicToJpeg(buffer) {
  const { default: heicConvert } = await import('heic-convert');
  return Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: 0.9 }));
}

export async function ocrImage(buffer) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng');
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
    // Scanned PDFs have no text layer; fall back to OCR of the whole buffer is not
    // directly possible without rasterizing, so report what we have and let the
    // caller decide. In practice most receipts (Amazon, dental, Costco) have text.
    if (text.length >= 30) return { text, method: 'pdf-text' };
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
