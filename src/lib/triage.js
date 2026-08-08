// AI eligibility triage. Pluggable providers:
//   anthropic-api  — Claude API call with an API key (default)
//   openai-api     — OpenAI API call with an API key
//   keywords       — offline heuristic fallback (no AI, coarse results); also
//                    engaged automatically whenever an API call fails
import { getSetting, setSetting, audit } from '../db.js';

const TRIAGE_PROMPT = `You are an HSA (Health Savings Account) eligibility analyst. You will receive the raw extracted text of a receipt, order confirmation, or medical statement. Your job:

1. Identify the merchant/provider name, purchase or service date, and any order/receipt/invoice ID.
2. Split the document into individual LINE ITEMS (one per product or service charge). Ignore payments, credits, taxes, shipping, subtotals, and totals — only actual product/service charges.
3. Judge each line item's HSA eligibility under IRS Publication 502:
   - ELIGIBLE (verdict "eligible"): medical/dental/vision/pharmacy services, prescription and OTC medications, contact lenses & lens solution, prescription eyewear, first-aid supplies, medical devices (thermometers, BP monitors, glucose monitors), feminine hygiene products, sunscreen SPF 15+, and similar clearly-qualified expenses. Confidence High or Medium.
   - NEEDS JUDGMENT (verdict "needs_judgment"): general-wellness vitamins and dietary supplements — these qualify ONLY with a doctor's Letter of Medical Necessity (LMN) for a diagnosed condition. Always queue these with confidence Low and say in the rationale that an LMN is required. Also use this verdict for genuinely ambiguous items.
   - NOT ELIGIBLE (verdict "not_eligible"): groceries, general hygiene items (toothpaste, floss, soap, deodorant), cosmetics, electronics, household goods, clothing, non-prescription sunglasses/goggles, pill organizers, books, and anything clearly non-medical.
4. Assign each item a category: Dental, Medical, Vision, Pharmacy, or Other.
5. Write a plain-English rationale (1-2 sentences) for EVERY item explaining the verdict — this becomes a permanent audit record.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "provider": "merchant or provider name",
  "purchase_date": "YYYY-MM-DD or null if unknown",
  "order_ref": "order/receipt/invoice id or null",
  "payment_method": "payment method if shown, else null",
  "document_summary": "one sentence describing this document",
  "items": [
    {
      "description": "line item description",
      "amount": 12.34,
      "date": "YYYY-MM-DD or null (use item-level service date if present, else document date)",
      "category": "Dental|Medical|Vision|Pharmacy|Other",
      "verdict": "eligible|needs_judgment|not_eligible",
      "confidence": "High|Medium|Low",
      "rationale": "why"
    }
  ]
}

If the document contains no recognizable purchases at all, return {"provider": null, "purchase_date": null, "order_ref": null, "payment_method": null, "document_summary": "...", "items": []}.

RECEIPT TEXT:
`;

function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in AI response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------- Provider: Anthropic API ----------
// If the configured model is ever retired ("model not found"), the provider's
// live model list is queried, the best successor is picked, saved, and the
// request retried — so the app heals itself instead of breaking.
async function resolveModelNotFound(provider, failedModel) {
  let picked = null;
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': getSetting('anthropic_api_key'), 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) return null;
    const models = (await res.json()).data || [];
    const byNewest = models.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    picked = (byNewest.find(m => /sonnet/i.test(m.id)) || byNewest[0])?.id || null;
  } else {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${getSetting('openai_api_key')}` },
    });
    if (!res.ok) return null;
    const models = ((await res.json()).data || [])
      .filter(m => /^gpt/i.test(m.id) && !/instruct|audio|realtime|search|transcribe|tts|image|embed|moderation|preview/i.test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0));
    picked = (models.find(m => /mini/i.test(m.id)) || models[0])?.id || null;
  }
  if (!picked || picked === failedModel) return null;
  setSetting(provider === 'anthropic' ? 'anthropic_model' : 'openai_model', picked);
  audit('model_auto_switch', { provider, from: failedModel, to: picked });
  return picked;
}

function isModelNotFound(status, bodyText) {
  return status === 404 || (status === 400 && /model/i.test(bodyText));
}

async function runAnthropicApi(prompt, allowModelDiscovery = true) {
  const key = getSetting('anthropic_api_key');
  if (!key) throw new Error('No Anthropic API key configured in Settings');
  const model = getSetting('anthropic_model') || 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (allowModelDiscovery && isModelNotFound(res.status, body)) {
      const successor = await resolveModelNotFound('anthropic', model);
      if (successor) return runAnthropicApi(prompt, false);
    }
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.content.map(b => b.text || '').join('');
}

// ---------- Provider: OpenAI API ----------
async function runOpenAiApi(prompt, allowModelDiscovery = true) {
  const key = getSetting('openai_api_key');
  if (!key) throw new Error('No OpenAI API key configured in Settings');
  const model = getSetting('openai_model') || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (allowModelDiscovery && isModelNotFound(res.status, body)) {
      const successor = await resolveModelNotFound('openai', model);
      if (successor) return runOpenAiApi(prompt, false);
    }
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---------- Provider: offline keyword heuristic ----------
const ELIGIBLE_PATTERNS = [
  [/contact lens|acuvue|biotrue|opti-?free|renu|dailies/i, 'Vision', 'High', 'Contact lenses / lens care are qualified medical expenses.'],
  [/prescription|rx\b|pharmacy|copay|co-pay/i, 'Pharmacy', 'High', 'Prescription/pharmacy charges are qualified medical expenses.'],
  [/dental|dentist|prophylaxis|filling|crown|x-?ray|radiograph|exam|resin|composite|veneer|onlay|inlay|denture|extraction|root canal|periodontal|sealant|fluoride|\bd\d{4}\b/i, 'Dental', 'High', 'Dental treatment is a qualified medical expense (CDT service codes are D-prefixed).'],
  [/glasses|eyeglass|optometr|ophthalmolog|vision exam|lenscrafters|pearle vision|visionworks|warby parker|america's best|eyemart/i, 'Vision', 'High', 'Vision care is a qualified medical expense.'],
  [/ibuprofen|acetaminophen|tylenol|advil|aspirin|antacid|allergy|antihistamine|cold medicine|cough|band-?aid|bandage|gauze|first aid|thermometer|blood pressure|glucose|sunscreen spf|eye drops|artificial tears|systane|lubricant eye|saline/i, 'Pharmacy', 'High', 'OTC medication / medical supplies are qualified medical expenses.'],
  [/doctor|clinic|hospital|urgent care|lab test|physical therapy|chiropract/i, 'Medical', 'High', 'Medical services are qualified medical expenses.'],
];
const SUPPLEMENT_PATTERN = /vitamin|supplement|omega|fish oil|magnesium|zinc|creatine|glycine|theanine|ashwagandha|coq10|probiotic|collagen|nac\b|boron/i;

const KNOWN_MERCHANTS = [
  [/costco/i, 'Costco'], [/amazon/i, 'Amazon.com'], [/walgreens/i, 'Walgreens'],
  [/cvs/i, 'CVS'], [/walmart/i, 'Walmart'], [/\btarget\b/i, 'Target'], [/rite aid/i, 'Rite Aid'],
];
const HEADER_STOPWORDS = /^(order|details|purchase|summary|history|report|account|invoice|receipt|statement|item|quantity|status|price|payment|shipping|billing|address|membership|aging|time|date|page|for|from|to|and|of|the)$/i;

function guessProvider(text, lines) {
  for (const [re, name] of KNOWN_MERCHANTS) if (re.test(text)) return name;
  // Letterhead heuristic: in the first few lines, find a multi-word segment that
  // isn't dates/amounts/boilerplate — e.g. the practice name between TIME and DATE.
  for (const line of lines.slice(0, 8)) {
    const segs = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const seg of segs) {
      if (/\$|\d{1,2}[:\/]\d/.test(seg)) continue;
      const words = seg.split(/\s+/).filter(w => /[A-Za-z]{2,}/.test(w));
      if (words.length < 2 || seg.length < 8 || seg.length > 60) continue;
      if (words.every(w => HEADER_STOPWORDS.test(w))) continue;
      return seg;
    }
  }
  return null;
}

function toIsoDate(m, d, y) {
  y = Number(y); if (y < 100) y += 2000;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function keywordTriage(text) {
  const items = [];
  const lines = text.split('\n');
  const amountRe = /\$?\s?(\d{1,4}(?:,\d{3})?\.\d{2})\b/;
  const provider = guessProvider(text, lines);
  // Document date: first full date in the opening lines (order date, print date…)
  let docDate = null;
  for (const line of lines.slice(0, 30)) {
    const dm = line.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
    if (dm) { docDate = toIsoDate(dm[1], dm[2], dm[3]); break; }
  }
  for (const line of lines) {
    const m = line.match(amountRe);
    if (!m) continue;
    const amount = parseFloat(m[1].replace(',', ''));
    let desc = line.replace(m[0], '').trim().replace(/\s{2,}/g, ' ');
    // Line-level service date (common in medical/dental statements) — use it as
    // the item date and strip it out of the description.
    let itemDate = null;
    const ld = desc.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b\s*/);
    if (ld) { itemDate = toIsoDate(ld[1], ld[2], ld[3]); desc = desc.slice(ld[0].length); }
    desc = desc.replace(/^[,;\s]+|[,;\s]+$/g, '');
    if (!desc || desc.length < 3 || amount <= 0) continue;
    if (/total|subtotal|tax|shipping|payment|acct pmt|\bpmt\b|balance|change|tender/i.test(desc)) continue;

    let matched = false;
    for (const [re, category, confidence, rationale] of ELIGIBLE_PATTERNS) {
      if (re.test(desc)) {
        items.push({ description: desc, amount, date: itemDate, category, verdict: 'eligible', confidence, rationale: rationale + ' (keyword match — no AI provider configured)' });
        matched = true;
        break;
      }
    }
    if (!matched && SUPPLEMENT_PATTERN.test(desc)) {
      items.push({ description: desc, amount, date: itemDate, category: 'Other', verdict: 'needs_judgment', confidence: 'Low', rationale: "General wellness supplement — needs a doctor's Letter of Medical Necessity for a diagnosed condition to qualify (IRS Pub 502). (keyword match — no AI provider configured)" });
      matched = true;
    }
    // No silent misses: lines with an amount but no keyword go to the Discarded
    // log so they stay auditable and re-queueable instead of vanishing.
    if (!matched) {
      items.push({ description: desc, amount, date: itemDate, category: 'Other', verdict: 'not_eligible', confidence: 'Low', rationale: 'No medical keyword matched (offline mode). If this is actually a medical expense, re-queue it from the Discarded tab or re-triage the receipt with an AI engine.' });
    }
  }
  return {
    provider, purchase_date: docDate, order_ref: null, payment_method: null,
    document_summary: 'Keyword-only triage (offline mode) — dates/provider are best-effort guesses; review carefully.',
    items,
  };
}

/**
 * Run eligibility triage over raw receipt text.
 * Returns the parsed triage object (see TRIAGE_PROMPT JSON schema).
 */
export async function triageReceipt(rawText) {
  const providerName = getSetting('ai_provider') || 'anthropic-api';
  const truncated = rawText.length > 60000 ? rawText.slice(0, 60000) + '\n[...truncated...]' : rawText;
  const prompt = TRIAGE_PROMPT + truncated;

  if (providerName === 'keywords') return { ...keywordTriage(rawText), ai_provider: 'keywords' };

  try {
    const raw = providerName === 'openai-api' ? await runOpenAiApi(prompt) : await runAnthropicApi(prompt);
    const parsed = extractJson(raw);
    if (!Array.isArray(parsed.items)) parsed.items = [];
    // Normalize amounts
    parsed.items = parsed.items.filter(i => i && i.description && Number.isFinite(Number(i.amount)) && Number(i.amount) > 0)
      .map(i => ({ ...i, amount: Number(i.amount) }));
    return { ...parsed, ai_provider: providerName };
  } catch (err) {
    // AI provider unavailable — degrade to keyword triage rather than losing the receipt.
    const fallback = keywordTriage(rawText);
    fallback.items = fallback.items.map(i => ({
      ...i,
      confidence: 'Low',
      rationale: i.rationale.replace(' (keyword match — no AI provider configured)', '') +
        ` [AI triage (${providerName}) was unavailable: ${err.message}. This is a coarse keyword result — re-check it.]`,
    }));
    fallback.document_summary = `AI triage failed (${err.message}) — fell back to keyword matching. Review carefully; some line items may be missing.`;
    return { ...fallback, ai_provider: 'keywords-fallback', ai_error: err.message };
  }
}

/** Quick connectivity test for the configured provider. */
export async function testProvider() {
  const providerName = getSetting('ai_provider') || 'anthropic-api';
  if (providerName === 'keywords') return { ok: true, provider: 'keywords', note: 'Offline keyword mode — always available.' };
  const prompt = 'Respond with ONLY this JSON, nothing else: {"ok": true}';
  const raw = providerName === 'openai-api' ? await runOpenAiApi(prompt) : await runAnthropicApi(prompt);
  const parsed = extractJson(raw);
  return { ok: parsed.ok === true, provider: providerName };
}
