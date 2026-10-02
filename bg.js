// =============================================
// KA Translator — Bulgarian team additions
// Loaded before content.js (same isolated world, so these globals are shared).
//   - Bulgarian-specific prompt rules (ти/Вие, член, бройна форма, кавички)
//   - Free post-processing: „…“ quotes, decimal comma inside math
//   - Optional (token-heavy, off by default): risky-phrase notes, back-translation
//   - Corrections memory (local + optional team Apps Script endpoint)
//   - Quality statistics
// =============================================

// ── Settings ──────────────────────────────────────────────────────────────────
// Everything that makes translation requests noticeably heavier is OFF by default.
const BG_DEFAULTS = {
  bgAddress: 'ti',           // 'ti' | 'vie' — how the student is addressed
  bgFixQuotes: true,         // "…" / “…” → „…“ (local, free)
  bgMathLocale: true,        // $3.5$ → $3{,}5$, $12{,}000$ → $12\,000$ (local, free)
  useCorrections: true,      // send up to BG_MAX_CORRECTIONS learned corrections with each request
  promptCaching: true,       // keep the system prompt stable so providers can cache it
  teamMemoryUrl: '',         // optional Google Apps Script web app URL (shared corrections)
  flagPhrases: false,        // HEAVY: ask the model to mark risky phrases (+~100–200 output tokens/string)
  backTranslate: 'off',      // HEAVY: 'off' | 'single' (only Translate This) | 'all' (one extra call/string)
  reviewTranslatedBtn: false // HEAVY: show the "check translated strings" batch button
};
const BG_MAX_CORRECTIONS = 25;
const BG_NOTES_MARKER = '===NOTES===';

let bgSettings = { ...BG_DEFAULTS };

function bgApply(r) {
  for (const k of Object.keys(BG_DEFAULTS)) {
    if (r[k] !== undefined) bgSettings[k] = r[k];
  }
}
try {
  chrome.storage.sync.get(Object.keys(BG_DEFAULTS), bgApply);
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'sync') return;
    for (const k of Object.keys(BG_DEFAULTS)) {
      if (c[k]) bgSettings[k] = c[k].newValue === undefined ? BG_DEFAULTS[k] : c[k].newValue;
    }
    if (c.teamMemoryUrl) _bgTeamCache = null;
  });
} catch (e) { /* not running as an extension (e.g. unit tests) */ }

function isBg(lang) { return lang === 'bg'; }

// ── Prompt rules for Bulgarian ────────────────────────────────────────────────
// Replaces the generic rules 6+ (which use Marathi examples) when the target is Bulgarian.
function bgRules() {
  const address = bgSettings.bgAddress === 'vie'
    ? `formal plural "Вие" (imperatives like "Намерете", "Изберете", "Въведете"; "Вашият отговор")`
    : `informal singular "ти" (imperatives like "Намери", "Избери", "Въведи"; "твоят отговор")`;
  return [
    `6. TERMINOLOGY: Use the standard terminology of Bulgarian school textbooks (МОН). Examples: area of a figure → "лице" (not "площ" in geometry exercises), line → "права", line segment → "отсечка", ray → "лъч", mean → "средно аритметично", volume → "обем", set → "множество", fraction → "дроб", numerator/denominator → "числител"/"знаменател". Prefer a Bulgarian word over an unnecessary anglicism ("проверете", not "чекнете").`,
    `7. ADDRESSING THE STUDENT: Always use the ${address}. Never mix "ти" and "Вие" within a string or across strings.`,
    `8. DEFINITE ARTICLE: Masculine singular nouns take the full article (-ът/-ят) when they are the grammatical subject and the short article (-а/-я) everywhere else (objects, after prepositions). Example: "Ученикът реши задачата", but "Дай молива на ученика".`,
    `9. COUNT FORM: After cardinal numbers and after "колко"/"няколко", masculine non-person nouns take the count form: "два триъгълника", "5 метра", "колко литра", "няколко квадрата". For persons use "двама ученици", "трима приятели".`,
    `10. POLYSEMY: Choose the meaning that fits the educational context. "Mean" (statistics) → "средно аритметично"/"средна стойност", not "означава". "Volume" → "обем", not "сила на звука". "Match the following" → "Свържи"/"Съпостави", not "мач". "Table" → "таблица". "Express" (math) → "запиши"/"изрази".`,
    `11. TRANSLATE, DON'T TRANSLITERATE: Translate terms into Bulgarian. If a term has no Bulgarian equivalent (proper names like "Voyager"), transliterate it once and use the EXACT same form every time.`,
    `12. CROSS-STRING CONSISTENCY: If the same English term appears several times, translate it the SAME way every time.`,
    `13. ANSWER-MATCHES-QUESTION: For True/False or matching exercises, if an answer choice repeats wording from the question, reuse the IDENTICAL Bulgarian wording.`,
    `14. NATURAL BULGARIAN: Avoid calques from English: drop unnecessary possessive pronouns ("Намери стойността", not "Намери неговата стойност"), avoid needless passive voice ("изчислихме", not "е бил изчислен"), do not start many sentences with "Нека", and use natural Bulgarian word order. "Make sure" → "Увери се"/"Провери", never "Направи сигурно".`,
    `15. PUNCTUATION AND NUMBERS IN TEXT: Use Bulgarian quotation marks „…“. In plain text (outside placeholders) write decimals with a comma (3,5) and group thousands with a space (12 000).`,
  ].join('\n');
}

function bgNotesInstruction() {
  return `

RISKY-PHRASE NOTES: After the translation, output a line containing exactly ${BG_NOTES_MARKER} and then a JSON array (use [] if nothing is risky) of at most 5 phrases from YOUR translation that may sound unnatural in Bulgarian, are calques or unnecessary anglicisms, are ambiguous, use doubtful terminology, or have a clearly better Bulgarian alternative. Each item: {"phrase": "<exact substring of your translation>", "reason": "calque" | "anglicism" | "awkward" | "terminology" | "ambiguous" | "grammar", "note": "<short explanation in Bulgarian>", "alternatives": ["<1 to 3 replacements>"]}. Never include placeholder characters in a phrase. Output nothing after the JSON array.`;
}

// ── Local post-processing (no tokens) ─────────────────────────────────────────
// Applied to the TOKENIZED translation, so math/HTML/URLs (placeholders) are never touched.
function bgFixQuotes(s) {
  return s
    .replace(/“([^”\n]*)”/g, '„$1“')
    .replace(/"([^"\n]+)"/g, '„$1“');
}

// Applied to protected math originals ($…$, $$…$$, $\begin…\end$) before they are restored.
// KA English writes thousands as 12{,}000 — Bulgarian uses 12\,000 and a decimal comma 3{,}5.
function bgLocalizeMath(m) {
  if (!m || m[0] !== '$') return m;
  return m
    .replace(/(\d)\{,\}(?=\d{3})/g, '$1\\,')
    .replace(/(\d)\.(?=\d)/g, '$1{,}');
}

function bgPostTokenized(s, lang) {
  if (!isBg(lang) || !s) return s;
  return bgSettings.bgFixQuotes ? bgFixQuotes(s) : s;
}

function bgLocalizeMap(map, lang) {
  if (!isBg(lang) || !bgSettings.bgMathLocale) return map;
  return map.map(e => ({ ...e, original: bgLocalizeMath(e.original) }));
}

// ── Model output parsing ──────────────────────────────────────────────────────
function bgExtractJson(s, open, close) {
  if (!s) return null;
  const a = s.indexOf(open), b = s.lastIndexOf(close);
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

function bgCleanFlags(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(f => f && typeof f.phrase === 'string' && f.phrase.trim())
    .slice(0, 5)
    .map(f => ({
      phrase: f.phrase.trim(),
      reason: String(f.reason || 'awkward'),
      note: String(f.note || ''),
      alternatives: Array.isArray(f.alternatives) ? f.alternatives.map(String).filter(Boolean).slice(0, 3) : [],
    }));
}

// Splits "<translation>\n===NOTES===\n[...]" into its parts. Missing/invalid notes → no flags.
function bgSplitNotes(raw) {
  const i = raw.indexOf(BG_NOTES_MARKER);
  if (i === -1) return { text: raw.trim(), flags: [] };
  return {
    text: raw.slice(0, i).trim(),
    flags: bgCleanFlags(bgExtractJson(raw.slice(i + BG_NOTES_MARKER.length), '[', ']')),
  };
}

const BG_REASON_LABELS = {
  calque: 'калка', anglicism: 'чуждица', awkward: 'звучи тежко',
  terminology: 'термин', ambiguous: 'двусмислие', grammar: 'граматика',
};
function bgReasonLabel(r) { return BG_REASON_LABELS[r] || r; }

// ── Word diff (for corrections memory) ────────────────────────────────────────
// Returns changed hunks between the AI output and what the translator saved.
function bgDiffHunks(a, b) {
  const A = (a || '').split(/\s+/).filter(Boolean);
  const B = (b || '').split(/\s+/).filter(Boolean);
  if (!A.length || !B.length || A.length > 300 || B.length > 300) return [];
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks = [];
  let i = 0, j = 0, from = [], to = [];
  const flush = () => {
    if (from.length || to.length) hunks.push({ from: from.join(' '), to: to.join(' ') });
    from = []; to = [];
  };
  while (i < n && j < m) {
    if (A[i] === B[j]) { flush(); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) from.push(A[i++]);
    else to.push(B[j++]);
  }
  while (i < n) from.push(A[i++]);
  while (j < m) to.push(B[j++]);
  flush();
  return hunks;
}

const bgTrimPunct = s => s.replace(/^[\s.,;:!?„“"()]+|[\s.,;:!?„“"()]+$/g, '');

// Keeps only short, word-level replacements that make sense as reusable preferences.
function bgCorrectionPairs(aiText, finalText) {
  return bgDiffHunks(aiText, finalText)
    .map(h => ({ from: bgTrimPunct(h.from), to: bgTrimPunct(h.to) }))
    .filter(h => h.from && h.to && h.from !== h.to)
    .filter(h => h.from.split(' ').length <= 6 && h.to.split(' ').length <= 6)
    .filter(h => !/[$\\[\]{}<>]/.test(h.from + h.to));
}

// ── Corrections memory ────────────────────────────────────────────────────────
function bgLocalGet(key, fallback) {
  return new Promise(res => {
    try { chrome.storage.local.get([key], r => res(r[key] ?? fallback)); }
    catch (e) { res(fallback); }
  });
}
function bgLocalSet(obj) {
  return new Promise(res => { try { chrome.storage.local.set(obj, res); } catch (e) { res(); } });
}

async function bgRecordCorrections(aiText, finalText, source) {
  const pairs = bgCorrectionPairs(aiText, finalText);
  if (!pairs.length) return [];
  const store = await bgLocalGet('bgCorrections', {});
  const now = Date.now();
  for (const p of pairs) {
    const key = `${p.from}→${p.to}`;
    const cur = store[key] || { from: p.from, to: p.to, count: 0 };
    cur.count++;
    cur.last = now;
    cur.example = (source || '').slice(0, 160);
    store[key] = cur;
  }
  await bgLocalSet({ bgCorrections: store });
  bgSendToTeam(pairs, source);
  return pairs;
}

// Team memory: a Google Apps Script web app (see docs/team-memory.gs).
// GET → JSON [{from,to,count}], POST (text/plain JSON) → appends corrections.
let _bgTeamCache = null, _bgTeamTime = 0;
async function bgTeamCorrections() {
  const url = (bgSettings.teamMemoryUrl || '').trim();
  if (!url) return [];
  if (_bgTeamCache && Date.now() - _bgTeamTime < 3_600_000) return _bgTeamCache;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return _bgTeamCache || [];
    const data = await res.json();
    _bgTeamCache = Array.isArray(data) ? data.filter(d => d && d.from && d.to) : [];
    _bgTeamTime = Date.now();
    return _bgTeamCache;
  } catch (e) {
    console.warn('[KAT] Team memory fetch failed:', e.message);
    return _bgTeamCache || [];
  }
}

function bgSendToTeam(pairs, source) {
  const url = (bgSettings.teamMemoryUrl || '').trim();
  if (!url || !pairs.length) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // simple request → no CORS preflight
    body: JSON.stringify({ corrections: pairs, source: (source || '').slice(0, 300) }),
  }).catch(e => console.warn('[KAT] Team memory upload failed:', e.message));
}

// Merged local + team corrections, most frequent first, capped for token cost.
async function bgCorrectionsForPrompt() {
  if (!bgSettings.useCorrections) return [];
  const local = Object.values(await bgLocalGet('bgCorrections', {}));
  const merged = {};
  for (const c of [...local, ...(await bgTeamCorrections())]) {
    const key = `${c.from}→${c.to}`;
    merged[key] = merged[key] || { from: c.from, to: c.to, count: 0, last: 0 };
    merged[key].count += Number(c.count) || 1;
    merged[key].last = Math.max(merged[key].last, Number(c.last) || 0);
  }
  return Object.values(merged)
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, BG_MAX_CORRECTIONS);
}

// ── Quality statistics ────────────────────────────────────────────────────────
const BG_STATS_EMPTY = {
  stringsTranslated: 0, flagsShown: 0, flagsAccepted: 0, flagsEditedByHand: 0,
  flagsIgnored: 0, backChecks: 0, backMismatches: 0, editedBeforeSave: 0, byReason: {},
};
// Updates are chained so concurrent read-modify-write calls don't lose counts.
let _bgStatChain = Promise.resolve();
function bgStat(update) {
  _bgStatChain = _bgStatChain.then(async () => {
    const s = { ...BG_STATS_EMPTY, ...(await bgLocalGet('bgStats', {})) };
    s.byReason = { ...(s.byReason || {}) };
    update(s);
    await bgLocalSet({ bgStats: s });
  }).catch(e => console.warn('[KAT] stats:', e.message));
  return _bgStatChain;
}

// When a string with flags is saved: was each flagged phrase changed?
function bgStatFlagOutcome(flags, finalText, acceptedCount) {
  if (!flags || !flags.length) return;
  bgStat(s => {
    for (const f of flags) {
      s.byReason[f.reason] = (s.byReason[f.reason] || 0) + 1;
    }
    const changed = flags.filter(f => !finalText.includes(f.phrase)).length;
    s.flagsAccepted += Math.min(acceptedCount, changed);
    s.flagsEditedByHand += Math.max(0, changed - acceptedCount);
    s.flagsIgnored += flags.length - changed;
  });
}

// ── CSV helper ────────────────────────────────────────────────────────────────
function bgCsv(rows) {
  return '﻿' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

if (typeof module !== 'undefined') {
  module.exports = {
    bgFixQuotes, bgLocalizeMath, bgSplitNotes, bgDiffHunks, bgCorrectionPairs,
    bgExtractJson, bgCsv, bgRules, bgSettings,
  };
}
