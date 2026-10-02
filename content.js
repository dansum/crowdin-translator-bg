// =============================================
// KA Translator v4.0
// JIPT-first approach:
//   - Top frame iterates .crowdin_jipt_untransl elements
//   - Clicks each to load the iframe translation panel
//   - Iframe handles source extraction + insertion + save
// =============================================

const WORLD_LANGUAGES = {
  'af':'Afrikaans','sq':'Albanian','am':'Amharic','ar':'Arabic',
  'hy':'Armenian','as':'Assamese','az':'Azerbaijani','eu':'Basque',
  'be':'Belarusian','bn':'Bengali','bs':'Bosnian','bg':'Bulgarian',
  'ca':'Catalan','zh-CN':'Chinese (Simplified)','zh-TW':'Chinese (Traditional)',
  'hr':'Croatian','cs':'Czech','da':'Danish','nl':'Dutch',
  'eo':'Esperanto','et':'Estonian','fi':'Finnish','fr':'French',
  'gl':'Galician','ka':'Georgian','de':'German','el':'Greek',
  'gu':'Gujarati','ht':'Haitian Creole','ha':'Hausa','he':'Hebrew',
  'hi':'Hindi','hu':'Hungarian','is':'Icelandic','ig':'Igbo',
  'id':'Indonesian','ga':'Irish','it':'Italian','ja':'Japanese',
  'jv':'Javanese','kn':'Kannada','kk':'Kazakh','km':'Khmer',
  'ko':'Korean','ku':'Kurdish','ky':'Kyrgyz','lo':'Lao',
  'lv':'Latvian','lt':'Lithuanian','mk':'Macedonian','ms':'Malay',
  'ml':'Malayalam','mt':'Maltese','mr':'Marathi','mn':'Mongolian',
  'my':'Myanmar (Burmese)','ne':'Nepali','no':'Norwegian','or':'Odia',
  'ps':'Pashto','fa':'Persian','pl':'Polish','pt':'Portuguese',
  'pa':'Punjabi','ro':'Romanian','ru':'Russian','sr':'Serbian',
  'si':'Sinhala','sk':'Slovak','sl':'Slovenian','so':'Somali',
  'es':'Spanish','sw':'Swahili','sv':'Swedish','tg':'Tajik',
  'ta':'Tamil','te':'Telugu','th':'Thai','tr':'Turkish',
  'uk':'Ukrainian','ur':'Urdu','uz':'Uzbek','vi':'Vietnamese',
  'cy':'Welsh','xh':'Xhosa','yi':'Yiddish','yo':'Yoruba','zu':'Zulu',
};
const LANGUAGES = WORLD_LANGUAGES; // backward-compat alias

let selectedLanguage = 'bg';
// ── AI provider configuration ─────────────────────────────────────────────────
// Users pick a provider in the popup and store one API key per provider.
// Adding a provider = add an entry here + a case in callProvider() + host_permissions.
const AI_PROVIDERS = {
  gemini:    { label: 'Gemini',  defaultModel: 'gemini-2.5-flash' },
  openai:    { label: 'OpenAI',  defaultModel: 'gpt-4o-mini' },
  anthropic: { label: 'Claude',  defaultModel: 'claude-haiku-4-5-20251001' },
};

let aiProvider = 'gemini';
let apiKeys = {};          // { gemini: '…', openai: '…', anthropic: '…' }
let aiModel = '';          // optional model override from popup (blank = provider default)
let glossaryUrl = '';
let glossaryUrlMath = '';
let glossaryUrlScience = '';
let _cachedGlossary = null;
let _glossaryCacheTime = 0;
let _cachedGlossaryUrlKey = '';
let _lastAICallTime = 0;
const GEMINI_FREE_GAP_MS = 4200; // Gemini free tier = 15 RPM → 1 call per ~4.2s
const DEFAULT_GAP_MS = 600;      // courtesy gap for other providers

function activeApiKey() { return (apiKeys[aiProvider] || '').trim(); }
function activeModel()  { return aiModel.trim() || AI_PROVIDERS[aiProvider]?.defaultModel; }
function providerLabel(){ return AI_PROVIDERS[aiProvider]?.label || aiProvider; }

// ── Within-batch translation memory ───────────────────────────────────────────
// Keep recent translations so Gemini can stay consistent across strings in the
// same exercise (e.g. "voyager" should transliterate the same way every time).
const TM_MAX_PAIRS = 12;     // how many recent pairs to send as context
const _translationMemory = []; // array of { src, tgt }
function pushToTM(src, tgt) {
  if (!src || !tgt) return;
  const clean = (s) => s.replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
  const cleanSrc = clean(src), cleanTgt = clean(tgt);
  if (!cleanSrc || !cleanTgt || cleanSrc.length > 200) return;
  _translationMemory.push({ src: cleanSrc, tgt: cleanTgt });
  while (_translationMemory.length > TM_MAX_PAIRS) _translationMemory.shift();
}
function clearTM() { _translationMemory.length = 0; }
const subdomain = location.hostname.split('.')[0];
if (WORLD_LANGUAGES[subdomain]) selectedLanguage = subdomain;

// ── Placeholder protection ────────────────────────────────────────────────────
const PLACEHOLDER_PATTERNS = [
  /\[\[[\s\S]*?\]\]/g,                                     // [[widget markup]]
  /\$\$[\s\S]*?\$\$/g,                                     // $$display math$$
  /\$(?:[^$\n\\]|\\.){1,200}\$/g,                           // $inline math$ (handles \$ escapes inside)
  /\\[a-zA-Z]+(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\})?/g,     // \LaTeX commands & \n
  /\((?:https?|web\+[a-z]+):\/\/[^\s)]+\)/gi,              // (URL) in markdown images/links
  /&[a-zA-Z#0-9]+;/g,                                      // HTML entities
  /<\/?[a-zA-Z][^>]*>/g,                                   // HTML tags
  /\{\{[^}]+\}\}|\{[0-9]+\}/g,                             // {{vars}} {0}
  /^#{1,6}\s?/gm,                                          // markdown headers
  /:-:+/g,                                                 // table alignment :-:
  / \| /g,                                                 // table column separator " | "
  /\|\|/g,                                                 // double-pipe ||
  // Markdown formatting markers — tokenize the DELIMITERS only (not the content
  // between them), so the words inside get translated while the markers are preserved.
  // Google Translate silently drops ** and __ delimiters, causing Crowdin QA errors.
  /\*\*/g,                                                 // ** bold/strong markers
  /__/g,                                                   // __ underline markers
  /(?<!\*)\*(?!\*)/g,                                      // * italic single-star (not **)
];

// Use Unicode Private Use Area characters (U+E000…U+F8FF) as placeholder tokens.
// These are single characters guaranteed to pass through Google Translate unchanged —
// they are not letters, digits, or characters in any human language, so Google never
// modifies, reorders, or transliterates them. Previous approaches (ZZZnZZZ letter
// sequences) were mangled because Google treated them as words/syllables and because
// it converts decimal digits to Hindi/Devanagari numerals in Indic-language output.
function tokenize(text) {
  const map = [];
  let result = text, idx = 0;
  for (const p of PLACEHOLDER_PATTERNS) {
    result = result.replace(p, match => {
      // U+E000 is the first PUA character; supports up to 6400 unique tokens
      const token = String.fromCodePoint(0xE000 + idx);
      map.push({ token, cp: 0xE000 + idx, original: match });
      idx++;
      return token;
    });
  }
  return { tokenized: result, map };
}

// Gemini understands markdown natively, so we skip the last 3 patterns (**, __, *)
// that protect markdown markers from Google Translate. Fewer PUA tokens = fewer drops.
const GEMINI_PATTERNS = PLACEHOLDER_PATTERNS.slice(0, -3);
function tokenizeForGemini(text) {
  const map = [];
  let result = text, idx = 0;
  for (const p of GEMINI_PATTERNS) {
    result = result.replace(p, match => {
      const token = String.fromCodePoint(0xE000 + idx);
      map.push({ token, cp: 0xE000 + idx, original: match });
      idx++;
      return token;
    });
  }
  return { tokenized: result, map };
}

function restore(translated, map) {
  let r = translated;
  for (const { cp, original } of map) {
    // Capture (don't consume) the optional spaces Google inserts around a token,
    // then put them back alongside the restored original so words don't run together.
    // e.g. "आपण [PUA] किंवा" → "आपण $\blueD{\text{add}}$ किंवा" (spaces preserved)
    r = r.replace(new RegExp(`( ?)\\u{${cp.toString(16)}}( ?)`, 'gu'),
      (_, before, after) => before + original + after);
  }
  return r;
}

// ── Widget deduplication ──────────────────────────────────────────────────────
// Google Translate sometimes duplicates a [[widget]] token when restructuring
// word order for the target language. This causes Crowdin QA errors like
// "'[[ dropdown 2]]' occurs 2 times in translated but 1 time in English".
// We fix it by counting each [[widget]] in the source and removing any extra
// occurrences from the translation, keeping only as many as the source has.
function fixWidgetCounts(translation, source) {
  const WIDGET = /\[\[[\s\S]*?\]\]/g;
  const counts = {};
  let m;
  while ((m = WIDGET.exec(source)) !== null) {
    counts[m[0]] = (counts[m[0]] || 0) + 1;
  }
  const seen = {};
  return translation.replace(WIDGET, w => {
    seen[w] = (seen[w] || 0) + 1;
    return seen[w] <= (counts[w] || 0) ? w : '';
  });
}

// Count PUA chars (U+E000–U+F8FF) — used to verify Google didn't drop any tokens.
function countPUA(str) {
  return [...str].filter(c => { const cp = c.codePointAt(0); return cp >= 0xE000 && cp <= 0xF8FF; }).length;
}

// ── Google Translate ──────────────────────────────────────────────────────────

// Find the best place to split a string roughly in half.
// Prefers splitting after a comma/semicolon, then at a space.
function findSplitPoint(text) {
  const mid = Math.floor(text.length / 2);
  for (const sep of [', ', '; ', ' ']) {
    let best = -1, bestDist = Infinity;
    let i = 0;
    while ((i = text.indexOf(sep, i)) !== -1) {
      const dist = Math.abs(i - mid);
      if (dist < bestDist) { bestDist = dist; best = i + sep.length; }
      i++;
    }
    if (best !== -1) return best;
  }
  return mid;
}

// Translate a single line of text (no newlines).
// If Google drops placeholder tokens, recursively splits the line in half and retries,
// reducing tokens per call until each chunk has ≤ 2 tokens and nothing gets dropped.
async function translateLine(text, lang, depth = 0) {
  if (!text || !text.trim()) return text;
  const { tokenized, map } = tokenize(text);

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${lang}&dt=t&q=${encodeURIComponent(tokenized)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Translate error ${res.status}`);
  const data = await res.json();
  const translated = data[0].map(s => s[0] || '').join('');

  const dropped = map.length - countPUA(translated);
  if (dropped > 0) {
    // Google dropped tokens — split and retry each half independently.
    // Limit recursion to 4 levels (handles up to 16 tokens safely).
    if (depth >= 4 || text.trim().split(/\s+/).length <= 1) {
      throw new Error(`Google dropped ${dropped} placeholder token(s)`);
    }
    const split = findSplitPoint(text);
    const left  = text.slice(0, split).trim();
    const right = text.slice(split).trim();
    const tLeft  = left  ? await translateLine(left,  lang, depth + 1) : '';
    const tRight = right ? await translateLine(right, lang, depth + 1) : '';
    // Rejoin: no extra space if right side starts with punctuation
    const sep = right && /^[,;.!?)]/.test(right) ? '' : ' ';
    return (tLeft + sep + tRight).trim();
  }

  const restored = restore(bgPostTokenized(translated, lang), bgLocalizeMap(map, lang));
  return fixWidgetCounts(restored, text);
}

// For multi-line strings (e.g. exercise tables), translate line by line.
// This keeps each Google Translate call small (fewer PUA tokens per call),
// preventing Google from dropping tokens — the main failure mode on complex strings.
// Pure-structure lines (e.g. "-| :-: | :-:") are kept as-is without a network call.
//
// Returns { text, flags, back, engine }:
//   flags — risky phrases marked by the model (only when the "flagPhrases" setting is on)
//   back  — { back, match, issue } back-translation check (only when "backTranslate" is on)
// opts.single = true when called from the Translate This panel.
async function translateTextDetailed(text, lang, opts = {}) {
  if (!text || !text.trim()) return { text, flags: [], back: null, engine: 'none' };

  // Pre-protect $\begin{env}...\end{env}$ blocks before any further processing.
  const mlMap = [];
  const preText = text.replace(
    /\$\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\}\$/g,
    m => {
      const cp = 0xF000 + mlMap.length;
      mlMap.push({ cp, original: m });
      return String.fromCodePoint(cp);
    }
  );
  const mlOriginal = o => (isBg(lang) && bgSettings.bgMathLocale) ? bgLocalizeMath(o) : o;
  const restoreML = s => {
    let r = s;
    for (const { cp, original } of mlMap)
      r = r.replace(new RegExp(`\\u{${cp.toString(16)}}`, 'gu'), mlOriginal(original));
    return r;
  };

  // ── AI provider path — sends whole text at once for better quality ─────────
  if (activeApiKey()) {
    try {
      const { tokenized, map } = tokenizeForGemini(preText);
      const raw = await translateWithAI(tokenized, lang);
      const split = bgSplitNotes(raw);
      const body = bgPostTokenized(stripSourceTags(split.text), lang);
      const dropped = map.length - countPUA(body);
      if (dropped > 0) throw new Error(`${providerLabel()} dropped ${dropped} placeholder token(s)`);
      const lmap = bgLocalizeMap(map, lang);
      const finalText = fixWidgetCounts(restoreML(restore(body, lmap)), text);
      const flags = split.flags
        .map(f => ({ ...f, phrase: restoreML(restore(bgPostTokenized(f.phrase, lang), lmap)) }))
        .filter(f => finalText.includes(f.phrase));

      let back = null;
      const mode = bgSettings.backTranslate;
      if (mode === 'all' || (mode === 'single' && opts.single)) {
        try { back = await backTranslateCheck(tokenized, body, lang, map); }
        catch (e) { console.warn('[KAT] Back-translation failed:', e.message); }
      }
      return { text: finalText, flags, back, engine: 'ai' };
    } catch (e) {
      console.warn(`[KAT] ${providerLabel()} failed, falling back to Google Translate:`, e.message);
    }
  }

  // ── Google Translate path — line-by-line to minimise token drops ───────────
  if (!preText.includes('\n')) {
    return { text: restoreML(await translateLine(preText, lang)), flags: [], back: null, engine: 'google' };
  }

  const lines = preText.split('\n');
  const results = [];
  for (const line of lines) {
    if (!line.trim()) {
      results.push(line);
      continue;
    }
    const { tokenized } = tokenize(line);
    const textOnly = tokenized.replace(/[-\s|*_~`#\-.:\\$]/g, '').trim();
    if (!textOnly) {
      results.push(line);
    } else {
      results.push(await translateLine(line, lang));
    }
  }
  return { text: restoreML(results.join('\n')), flags: [], back: null, engine: 'google' };
}

async function translateText(text, lang) {
  return (await translateTextDetailed(text, lang)).text;
}

// Models occasionally echo the <source> wrapper used when caching is on.
function stripSourceTags(s) {
  return s.replace(/^\s*<source>\s*/i, '').replace(/\s*<\/source>\s*$/i, '');
}

// ── AI translation engine (multi-provider) ───────────────────────────────────
// Builds one shared system prompt (rules + glossary + learned corrections), then
// dispatches to the configured provider. Each provider caller returns plain text.
//
// Prompt caching: with the "promptCaching" setting on, the system prompt holds only
// content that stays the same for a whole batch; the per-string translation memory
// travels in the user message instead. That lets Anthropic (explicit cache_control),
// OpenAI and Gemini (automatic prefix caching) reuse the system prompt.

async function buildSystemPrompt(lang, { review = false } = {}) {
  const langName = WORLD_LANGUAGES[lang] || lang;
  let sysPrompt =
    `You are a professional translator for Khan Academy educational content. ` +
    `Translate the English text to ${langName}.

` +
    `Rules:
` +
    `1. Unicode characters U+E000 through U+F8FF are placeholder tokens for math, widgets, ` +
    `and formatting. Preserve every such character EXACTLY — do not modify, move, ` +
    `duplicate, or omit any of them.
` +
    `2. Only translate the natural language words between the placeholder characters.
` +
    `3. Keep the same line breaks and paragraph structure.
` +
    `4. Use clear, student-friendly language for school-age learners (grades 3-12).
` +
    `5. Return ONLY the translated text — no explanation, no quotes, no commentary.
`;

  if (isBg(lang)) {
    sysPrompt += bgRules();
  } else {
    sysPrompt +=
    `6. TERMINOLOGY: Prefer the proper scientific/technical ${langName} term over a colloquial word or English transliteration. ` +
    `For example, in Marathi prefer जठर over पोट (stomach), पेशी over "cell", मूत्रपिंड over किडनी (kidney), ऊती over "tissue", तंत्र/संस्था over "system" — and stay consistent within a string.
` +
    `7. GENDER AGREEMENT: Match the grammatical gender of pronouns, demonstratives, and adjectives to the noun they modify. ` +
    `In Marathi: त्वचा (f), ऊती (f.pl), पेशी (f), मूत्रपिंड (n) — use ती/त्या/ते correctly. Never use masculine pronouns for feminine nouns or vice versa.
` +
    `8. POLYSEMY: When an English word has multiple meanings, choose the one that fits the educational/scientific context. ` +
    `For example, "Match the following" in Marathi is जुळवा / पडताळा (pair up), NOT सामना (wrestling match). ` +
    `"Mean" in statistics is सरासरी, not अर्थ. "Volume" in geometry/physics is घनफळ/आकारमान, not आवाज.
` +
    `9. TRANSLATE, DON'T TRANSLITERATE: Translate proper scientific terms into the target language rather than writing English in target-language script. ` +
    `If a term has no native equivalent (proper nouns like spacecraft names, e.g. "Voyager"), transliterate it ONCE and use the EXACT same transliteration every time it appears in the same string.
` +
    `10. CROSS-STRING CONSISTENCY: Within the input you receive, if the same English term appears multiple times, translate it the SAME way every time. ` +
    `Do not vary your translation choice across sentences or list items in the same input.
` +
    `11. ANSWER-MATCHES-QUESTION: For True/False or matching exercises, if an answer-choice statement repeats wording from the question, ` +
    `use the IDENTICAL target-language wording from the question — do not re-translate the same phrase differently.`;
  }

  const glossary = await getGlossary();
  if (glossary) {
    sysPrompt += `

Glossary (prefer these translations for listed terms):
${glossary}`;
  }

  // Corrections translators made to earlier AI output (local + team memory).
  const corrections = await bgCorrectionsForPrompt();
  if (corrections.length > 0) {
    sysPrompt += `

Preferences learned from translators' corrections of earlier AI output (wrong → preferred). ` +
      `When the same wording would appear, use the preferred form — but only where it fits the context:
${corrections.map(c => `- ${c.from} → ${c.to}`).join('\n')}`;
  }

  if (review) return sysPrompt;

  if (bgSettings.flagPhrases && isBg(lang)) sysPrompt += bgNotesInstruction();

  // Without caching, keep the original layout: translation memory in the system prompt.
  if (!bgSettings.promptCaching && _translationMemory.length > 0) {
    sysPrompt += `

${tmBlock()}`;
  }

  return sysPrompt;
}

// Recent in-batch translations — the strongest consistency signal the model
// gets. Without it, terms like "voyager" or "kidney" can vary per string.
function tmBlock() {
  const tmText = _translationMemory.map(p => `${p.src} → ${p.tgt}`).join('\n');
  return `Recent translations from this same exercise — be consistent with these (use the same wording for the same terms):
${tmText}`;
}

function buildUserMessage(tokenized, lang) {
  if (!bgSettings.promptCaching || _translationMemory.length === 0) return tokenized;
  const notes = bgSettings.flagPhrases && isBg(lang) ? ' (then the notes block described above)' : '';
  return `${tmBlock()}

Translate the text between <source> and </source>. Output only the translation${notes}, without the tags.
<source>
${tokenized}
</source>`;
}

// One fetch per provider. Each returns the raw translated text or throws.
async function callGemini(sysPrompt, text, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeApiKey()}`;
  const body = {
    system_instruction: { parts: [{ text: sysPrompt }] },
    contents: [{ parts: [{ text }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
  };
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { retryable: res.status === 429 || res.status === 503, error: `Gemini API ${res.status}: ${(await res.text()).slice(0, 200)}`, status: res.status };
  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) return { error: 'Gemini returned no candidates' };
  if (candidate.finishReason === 'SAFETY') return { error: 'Gemini safety filter blocked this string' };
  const result = candidate.content?.parts?.[0]?.text;
  if (!result) return { error: `Gemini empty response (finishReason: ${candidate.finishReason || 'unknown'})` };
  return { text: result.trim() };
}

async function callOpenAI(sysPrompt, text, model) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${activeApiKey()}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });
  if (!res.ok) return { retryable: res.status === 429 || res.status >= 500, error: `OpenAI API ${res.status}: ${(await res.text()).slice(0, 200)}`, status: res.status };
  const data = await res.json();
  const result = data.choices?.[0]?.message?.content;
  if (!result) return { error: 'OpenAI returned empty response' };
  return { text: result.trim() };
}

async function callAnthropic(sysPrompt, text, model) {
  // With caching on, mark the (stable) system prompt as a cache breakpoint.
  // Prompts shorter than the model's minimum (4096 tokens on Haiku 4.5) are simply not cached.
  const system = bgSettings.promptCaching
    ? [{ type: 'text', text: sysPrompt, cache_control: { type: 'ephemeral' } }]
    : sysPrompt;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': activeApiKey(),
      'anthropic-version': '2023-06-01',
      // Required for calling the Anthropic API from a browser context:
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.1,
      system,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) return { retryable: res.status === 429 || res.status === 529 || res.status >= 500, error: `Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`, status: res.status };
  const data = await res.json();
  if (data.usage?.cache_read_input_tokens) console.log(`[KAT] Anthropic cache hit: ${data.usage.cache_read_input_tokens} tokens`);
  const result = data.content?.[0]?.text;
  if (!result) return { error: 'Anthropic returned empty response' };
  return { text: result.trim() };
}

async function callProvider(sysPrompt, text, model) {
  switch (aiProvider) {
    case 'openai':    return callOpenAI(sysPrompt, text, model);
    case 'anthropic': return callAnthropic(sysPrompt, text, model);
    case 'gemini':
    default:          return callGemini(sysPrompt, text, model);
  }
}

// Rate-limited provider call with one retry on transient errors.
async function aiRequest(sysPrompt, userText) {
  const model = activeModel();

  // Rate-limit gap. Gemini's free tier is 15 RPM; other providers get a small
  // courtesy gap so batches don't hammer the API.
  const minGap = aiProvider === 'gemini' ? GEMINI_FREE_GAP_MS : DEFAULT_GAP_MS;
  const gap = Date.now() - _lastAICallTime;
  if (gap < minGap) await sleep(minGap - gap);
  _lastAICallTime = Date.now();

  let result = await callProvider(sysPrompt, userText, model);

  // Retry once on transient errors (rate limit / server overload).
  if (result.error && result.retryable) {
    const waitMs = result.status === 429 ? 12000 : 4000;
    console.warn(`[KAT] ${providerLabel()} ${result.status}, retrying after ${waitMs}ms…`);
    await sleep(waitMs);
    _lastAICallTime = Date.now();
    result = await callProvider(sysPrompt, userText, model);
  }

  if (result.error) throw new Error(result.error);
  return result.text;
}

async function translateWithAI(tokenized, lang) {
  const sysPrompt = await buildSystemPrompt(lang);
  return aiRequest(sysPrompt, buildUserMessage(tokenized, lang));
}

// ── Back-translation check (optional, one extra call) ─────────────────────────
// Translates the result back to English and asks whether the meaning still matches.
async function backTranslateCheck(srcTokenized, tgtTokenized, lang, map) {
  const langName = WORLD_LANGUAGES[lang] || lang;
  const issueLang = isBg(lang) ? 'Bulgarian' : 'English';
  const sys =
    `You verify translations of Khan Academy exercises from English into ${langName}. ` +
    `Characters U+E000–U+F8FF are placeholders for math and widgets — copy them unchanged.
` +
    `1) Translate the ${langName} text back into English as literally as possible.
` +
    `2) Compare its meaning with the original English. Small wording or style differences still match. ` +
    `Changed numbers, a lost or added negation, swapped quantities (at least / at most, more / less), ` +
    `a different actor, or missing or extra information do NOT match.
` +
    `Answer ONLY with JSON: {"back": "<literal English back-translation>", "match": true or false, ` +
    `"issue": "<if match is false: a short explanation in ${issueLang}; otherwise empty>"}`;
  const user = `Original English:
${srcTokenized}

${langName} translation:
${tgtTokenized}`;
  const out = bgExtractJson(await aiRequest(sys, user), '{', '}');
  if (!out || typeof out.back !== 'string') return null;
  const result = {
    back: map ? restore(out.back, map) : out.back,
    match: out.match !== false,
    issue: String(out.issue || ''),
  };
  bgStat(s => { s.backChecks++; if (!result.match) s.backMismatches++; });
  return result;
}

// ── Review an existing translation (Translate This "Check" + batch check) ─────
// One call: risky phrases + back-translation of a translation that already exists.
async function reviewExistingTranslation(source, translation, lang) {
  const langName = WORLD_LANGUAGES[lang] || lang;
  const sys = await buildSystemPrompt(lang, { review: true });
  const user =
    `REVIEW MODE — do not translate anything. Review the existing ${langName} translation below ` +
    `against its English source, using the rules above. Math, widgets and markup must stay unchanged and are not a problem.
` +
    `Answer ONLY with JSON: {"flags": [up to 5 items {"phrase": "<exact substring of the translation>", ` +
    `"reason": "calque" | "anglicism" | "awkward" | "terminology" | "ambiguous" | "grammar", ` +
    `"note": "<short explanation in ${isBg(lang) ? 'Bulgarian' : 'English'}>", "alternatives": ["<1 to 3 replacements>"]}], ` +
    `"back": "<literal English back-translation>", "match": true or false, ` +
    `"issue": "<if the meaning differs from the source: short explanation; otherwise empty>"}

English source:
${source}

${langName} translation:
${translation}`;
  const out = bgExtractJson(await aiRequest(sys, user), '{', '}');
  if (!out) throw new Error('Could not read the review result');
  const flags = bgCleanFlags(out.flags).filter(f => translation.includes(f.phrase));
  const back = typeof out.back === 'string'
    ? { back: out.back, match: out.match !== false, issue: String(out.issue || '') }
    : null;
  bgStat(s => {
    s.flagsShown += flags.length;
    if (back) { s.backChecks++; if (!back.match) s.backMismatches++; }
  });
  return { flags, back };
}

// Detects subject from the page URL or document content.
// Returns 'math', 'science', or '' (unknown — use default glossary).
function detectSubject() {
  try {
    const url = (location.href + ' ' + (document.title || '')).toLowerCase();
    const SCIENCE_HINTS = /\b(science|biology|physics|chemistry|life-?process|microbio|ecology|matter|atoms?|cells?|tissue|organ|photosynth|respiration|optic|refract|gravity|space|astronomy|magnet|electric|sound|light|reaction|compound|polymer|monomer|acid|base|element|periodic|mitosis|meiosis|dna|protein|enzyme|carbon|hydrogen|oxygen)\b/;
    const MATH_HINTS = /\b(math|maths|algebra|geometry|arithmetic|trigonometry|calculus|fraction|decimal|equation|polynomial|quadratic|linear|coordinate|triangle|circle|polygon|theorem|statistics|probability|integers|rational|irrational|congruent|similar|matrix|vector|set-theory)\b/;
    if (SCIENCE_HINTS.test(url)) return 'science';
    if (MATH_HINTS.test(url)) return 'math';
  } catch (e) {}
  return '';
}

// Pick the most-specific glossary URL configured for the current page.
function pickGlossaryUrl() {
  const subj = detectSubject();
  if (subj === 'science' && glossaryUrlScience) return { url: glossaryUrlScience, key: 'science' };
  if (subj === 'math'    && glossaryUrlMath)    return { url: glossaryUrlMath,    key: 'math' };
  if (glossaryUrl) return { url: glossaryUrl, key: 'default' };
  return null;
}

async function getGlossary() {
  const picked = pickGlossaryUrl();
  if (!picked) return null;
  const now = Date.now();
  // Cache by URL key so switching subjects mid-batch picks the right glossary.
  if (_cachedGlossary && _cachedGlossaryUrlKey === picked.url &&
      now - _glossaryCacheTime < 3_600_000) return _cachedGlossary;
  try {
    const res = await fetch(picked.url, { cache: 'no-store' });
    if (!res.ok) return (_cachedGlossaryUrlKey === picked.url ? _cachedGlossary : null);
    const text = (await res.text()).slice(0, 50000);
    _cachedGlossary = text;
    _glossaryCacheTime = now;
    _cachedGlossaryUrlKey = picked.url;
    console.log(`[KAT] Loaded ${picked.key} glossary (${text.length} chars)`);
    return text;
  } catch (e) {
    console.warn('[KAT] Failed to fetch glossary:', e.message);
    return (_cachedGlossaryUrlKey === picked.url ? _cachedGlossary : null);
  }
}

function isTranslatableSource(text) {
  if (!text || text.length < 2) return false;
  // Skip if the ENTIRE string is just a bare URL
  if (/^(https?|web\+[a-z]+):\/\/\S+$/i.test(text.trim())) return false;
  // Skip if entire string is a bare image with no other text
  if (/^!\[.*?\]\([^)]+\)$/.test(text.trim())) return false;
  if (text.startsWith('[⚙')) return false;
  if (/^[\d\s\W]+$/.test(text)) return false;
  return true;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Frame detection ───────────────────────────────────────────────────────────
const IS_TOP_FRAME = (window === window.top);

// ============================================================================
// IFRAME MODE — runs inside the crowdin-editor-iframe
// Called AFTER a JIPT element has been clicked in the parent, so the
// translation panel should now be rendered and inputs should exist.
// ============================================================================
if (!IS_TOP_FRAME) {
  setupIframeMode();
}

function setupIframeMode() {
  const reply = (data) => {
    try { window.parent.postMessage({ __kat: true, ...data }, '*'); } catch(e) {}
  };

  // ── findInput ──────────────────────────────────────────────────────────────
  // NOTE: This is called AFTER a JIPT element was clicked in the parent frame,
  // so the Crowdin translation panel should now be rendered and have inputs.
  function findInput() {
    // Method 1: Visible textareas
    for (const el of document.querySelectorAll('textarea')) {
      if (el.closest && el.closest('#ka-translator-overlay')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 5 && rect.height > 5) return el;
    }

    // Method 2: Visible contenteditable (not body/html)
    for (const sel of [
      '[contenteditable="true"]',
      '[contenteditable=""]',
      '[role="textbox"]',
      '[spellcheck="true"]',
    ]) {
      for (const el of document.querySelectorAll(sel)) {
        if (el === document.body || el === document.documentElement) continue;
        if (el.closest && el.closest('#ka-translator-overlay')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) return el;
      }
    }

    // Method 3: .contentEditable property check
    for (const el of document.querySelectorAll('div,p,span,li,td,section,article,main')) {
      if (el === document.body) continue;
      if (el.contentEditable === 'true') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) return el;
      }
    }

    // Method 4: Shadow DOM traversal
    function searchShadow(root) {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const found = searchShadow(el.shadowRoot);
          if (found) return found;
        }
      }
      for (const sel of ['textarea','[contenteditable="true"]','[role="textbox"]']) {
        const el = root.querySelector(sel);
        if (el && el !== document.body) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 5 && rect.height > 5) return el;
        }
      }
      return null;
    }
    const shadowResult = searchShadow(document.body);
    if (shadowResult) return shadowResult;

    // Method 5: activeElement
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== document.documentElement && ae.tagName !== 'HTML') {
      if (ae.isContentEditable || ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') {
        return ae;
      }
    }

    return null;
  }

  // ── findSource ─────────────────────────────────────────────────────────────
  // Patterns that indicate UI chrome or transient save-status messages
  const UI_LABEL = /^(source string|source file|string:|context|tm and mt|hindi translation|translation memory|words?:|chars?:|characters?:|qa issues?|no trans|add smart|copy from|clear|cancel|other language|saving|saved|close|view|approve|reject|delete|edit)/i;
  const SAVE_STATUS = /(saving|saved|translation.*saved|अनुवाद सहेजा|सहेजा जा)/i;

  function cleanSourceText(txt) {
    if (!txt) return null;
    txt = txt.trim();
    if (txt.length < 2 || txt.length > 5000) return null;
    if (UI_LABEL.test(txt)) return null;
    if (SAVE_STATUS.test(txt)) return null;                // reject "Saving..." toasts
    if (/^[\d\s\W]+$/.test(txt)) return null;             // reject pure symbols/numbers
    // Reject concatenated button text (typically short words joined without spaces)
    if (txt.length < 30 && /[A-Z]{2,}/.test(txt) && txt.split(/\s+/).length < 3) return null;
    return txt;
  }

  function findSource() {
    // ════════════════════════════════════════════════════════════════════════
    // Strategy 1 (PRIMARY): Parse the FULL BODY TEXT between "SOURCE STRING"
    // and "CONTEXT" markers. The Crowdin panel always shows:
    //   SOURCE STRING ← →
    //   [actual source text]
    //   CONTEXT ▶
    //   [translation textarea]
    // This avoids any DOM traversal pitfalls entirely.
    // ════════════════════════════════════════════════════════════════════════
    try {
      const bodyText = document.body.innerText || '';
      const ssMatch = /SOURCE STRING/i.exec(bodyText);
      if (ssMatch) {
        // Everything after the "SOURCE STRING" label
        const afterSS = bodyText.slice(ssMatch.index + ssMatch[0].length);
        // Cut at "CONTEXT" (next section) — or take up to 600 chars if not found
        const ctxMatch = /\n\s*CONTEXT\b/i.exec(afterSS);
        let snippet = ctxMatch ? afterSS.slice(0, ctxMatch.index) : afterSS.slice(0, 600);
        // Strip icon characters (arrows, UI glyphs).
        // Preserve newlines — collapsing them destroys table structure.
        snippet = snippet.replace(/[←→↑↓⟵⟶⬅➡✎⊞✕⋮▶◀‹›«»]/g, '')
                         .replace(/[ \t\r]+/g, ' ')   // collapse horizontal whitespace only
                         .replace(/\n[ \t]*/g, '\n')  // trim leading whitespace per line
                         .replace(/^string:\s*/i, '')  // strip Crowdin "String:" UI label
                         .replace(/^source file preview[^\n]*\n?/i, '') // strip "Source File Preview ⇧⌘P"
                         .replace(/[⇧⌘⌥⌃]\S*/g, '')  // strip keyboard shortcut glyphs
                         .trim();
        if (snippet.length >= 2 && snippet.length <= 3000 &&
            !SAVE_STATUS.test(snippet) && !UI_LABEL.test(snippet)) {
          console.log('[KAT iframe] findSource (body-parse):', snippet.slice(0, 80));
          return snippet;
        }
        console.log('[KAT iframe] findSource body-parse rejected:', snippet.slice(0, 80));
      }
    } catch(e) {}

    // ════════════════════════════════════════════════════════════════════════
    // Strategy 2: CSS class selectors (Crowdin class naming conventions)
    // ════════════════════════════════════════════════════════════════════════
    for (const sel of [
      '[class*="source-string" i]', '[class*="source-text" i]', '[class*="source-phrase" i]',
      '[class*="original-text" i]', '[class*="sourceString" i]', '[class*="sourceText" i]',
      '[class*="srcText" i]', '[class*="src-segment" i]', '[class*="segment-source" i]',
      '[id*="source" i]', '[data-type="source"]',
    ]) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          const txt = cleanSourceText((el.innerText || el.textContent || ''));
          if (txt) {
            console.log('[KAT iframe] findSource (class-sel):', sel, txt.slice(0, 60));
            return txt;
          }
        }
      } catch(e) {}
    }

    // Debug dump
    const preview = (document.body.innerText || '').slice(0, 400).replace(/\n+/g, ' | ');
    console.log('[KAT iframe] findSource: NOT FOUND. Body:', preview);
    return null;
  }

  function insertText(el, text) {
    el.focus();
    // Clear first
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSet) {
        nativeSet.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable
      el.focus();
      // Try execCommand first
      document.execCommand('selectAll', false, null);
      const ok = document.execCommand('insertText', false, text);
      if (!ok || !(el.innerText || el.textContent || '').trim()) {
        // Fallback: direct innerText
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  function doSave(input) {
    const allBtns = [...document.querySelectorAll('button, [role="button"]')];

    // Strategy 1: Green button by color — the Crowdin approve/save button is distinctly green
    for (const btn of allBtns) {
      if (btn.closest && btn.closest('#ka-translator-overlay')) continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const bg = getComputedStyle(btn).backgroundColor;
      const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (m) {
        const [r, g, b] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
        if (g >= 100 && g > r * 1.3 && g > b * 1.3) {
          btn.click();
          console.log('[KAT iframe] ✅ Clicked green save btn, color:', bg);
          return true;
        }
      }
    }

    // Strategy 2: aria-label / title / data-qa / class keyword match
    for (const btn of allBtns) {
      if (btn.closest && btn.closest('#ka-translator-overlay')) continue;
      const label = (
        btn.getAttribute('aria-label') || btn.getAttribute('title') ||
        btn.getAttribute('data-qa') || (typeof btn.className === 'string' ? btn.className : '')
      ).toLowerCase();
      const text = (btn.textContent || btn.innerText || '').trim().toLowerCase();
      if (
        label.includes('save') || label.includes('approve') || label.includes('confirm') ||
        text === 'save' || text === 'approve' || text === '✓' || text === '✔' || text === 'ok'
      ) {
        btn.click();
        console.log('[KAT iframe] ✅ Clicked labeled save btn:', label || text);
        return true;
      }
    }

    // Strategy 3: Try ALL visible buttons — pick any that has a distinctive color (non-white/grey)
    // and is small (icon-sized), positioned in the right area of the panel
    const iconBtns = allBtns.filter(b => {
      if (b.closest && b.closest('#ka-translator-overlay')) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.width < 80 && r.height > 0 && r.height < 60;
    });
    // Sort by rightmost position — the save button is usually the rightmost in its toolbar
    iconBtns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    for (const btn of iconBtns.slice(0, 5)) {
      const bg = getComputedStyle(btn).backgroundColor;
      // Any clearly colored button (not transparent/white/grey)
      const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?/);
      if (m) {
        const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
        const [r, g, b] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
        // Not transparent, not white (>250,>250,>250), not grey (r≈g≈b)
        if (alpha > 0.3 && !(r > 220 && g > 220 && b > 220) && Math.max(r,g,b) - Math.min(r,g,b) > 20) {
          btn.click();
          console.log('[KAT iframe] ✅ Clicked colored icon btn:', bg);
          return true;
        }
      }
    }

    // Strategy 4: Keyboard shortcuts (try both, don't return true — these are last resort)
    const target = input || document.activeElement;
    if (target && target !== document.body) {
      target.focus();
      // Ctrl+Enter
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true
      }));
      target.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true
      }));
    }
    // Ctrl+S
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true, bubbles: true
    }));

    // Log all visible buttons for debugging
    const btnDebug = allBtns
      .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, 20)
      .map(b => ({
        txt: (b.textContent || '').trim().slice(0, 25),
        label: b.getAttribute('aria-label') || '',
        title: b.title || '',
        cls: (typeof b.className === 'string' ? b.className : '').slice(0, 60),
        color: getComputedStyle(b).backgroundColor,
        x: Math.round(b.getBoundingClientRect().right),
        y: Math.round(b.getBoundingClientRect().top),
      }));
    console.log('[KAT iframe] ⚠️ doSave fallback — all visible buttons:\n' + JSON.stringify(btnDebug, null, 2));
    // Return false so the counter doesn't falsely increment
    return false;
  }

  // ── Scan for debugging ─────────────────────────────────────────────────────
  function scanDom() {
    const result = { editable: [], textareas: [], interesting: [], bodyLen: document.body.innerHTML.length };
    for (const el of document.querySelectorAll('*')) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const tag = el.tagName;
      const id = el.id || '';
      const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 100);
      const rect = el.getBoundingClientRect();
      const vis = rect.width > 0 && rect.height > 0;
      if (tag === 'TEXTAREA') {
        result.textareas.push({ tag, id, cls, w: Math.round(rect.width), h: Math.round(rect.height) });
      } else if (el.contentEditable === 'true' || el.contentEditable === '') {
        result.editable.push({ tag, id, cls, w: Math.round(rect.width), h: Math.round(rect.height), vis });
      } else if ((el.getAttribute('role') || '').match(/textbox|editor/)) {
        result.interesting.push({ tag, id, cls: cls.slice(0,50), role: el.getAttribute('role'), vis });
      }
    }
    return result;
  }

  window.addEventListener('message', async (e) => {
    if (!e.data?.__kat) return;
    const { cmd } = e.data;

    if (cmd === 'PING') {
      reply({ cmd: 'PONG', url: location.href });
    }
    else if (cmd === 'GET_STATE') {
      await sleep(300);
      const input = findInput();
      const rawSource = findSource();
      // Guard: reject implausibly long "source" strings (likely grabbed wrong section)
      const source = rawSource && rawSource.length <= 3000 ? rawSource : null;
      const existing = input ? (input.value || input.innerText || input.textContent || '').trim() : '';
      const debug = {
        inputTag: input?.tagName || null,
        inputId: input?.id || null,
        inputCls: input ? (typeof input.className === 'string' ? input.className.slice(0,80) : '') : null,
        allCE: document.querySelectorAll('[contenteditable]').length,
        allTA: document.querySelectorAll('textarea').length,
        bodyLen: document.body.innerHTML.length,
        url: location.href,
      };
      reply({ cmd: 'STATE', source, existing, hasInput: !!input, debug });
    }
    else if (cmd === 'INSERT_SAVE') {
      const input = findInput();
      if (input) {
        // Always trim — fixes Crowdin QA "trailing newline" error
        const cleanText = (e.data.text || '').trim();
        insertText(input, cleanText);
        await sleep(400);
        input.focus();
        await sleep(150);
        const saved = doSave(input);
        await sleep(2000); // wait for Crowdin "Saving..." toast to clear
        reply({ cmd: 'INSERT_SAVE_DONE', ok: saved });
      } else {
        reply({ cmd: 'INSERT_SAVE_DONE', ok: false, error: 'no_input' });
      }
    }
    else if (cmd === 'SCAN') {
      const scan = scanDom();
      reply({ cmd: 'SCAN_RESULT', scan });
    }
  });

  reply({ cmd: 'IFRAME_READY', url: location.href });
  console.log('[KA Translator v4.0] iframe mode active at', location.href);
}

// ============================================================================
// TOP FRAME MODE (only runs in the main page, not in iframes)
// ============================================================================
if (IS_TOP_FRAME) {

// Subdomain takes priority — if we're on hi.khanacademy.org, always use Hindi.
// Only fall back to stored preference when the subdomain isn't a known language code.
const SETTINGS_KEYS = ['targetLanguage', 'aiProvider', 'apiKeys', 'aiModel',
                       'geminiApiKey', // legacy single-key setting (pre-multi-provider)
                       'glossaryUrl', 'glossaryUrlMath', 'glossaryUrlScience'];

function applySettings(r) {
  if (r.targetLanguage && !WORLD_LANGUAGES[subdomain]) selectedLanguage = r.targetLanguage;
  if (r.aiProvider && AI_PROVIDERS[r.aiProvider]) aiProvider = r.aiProvider;
  if (r.apiKeys && typeof r.apiKeys === 'object') apiKeys = { ...apiKeys, ...r.apiKeys };
  // Legacy migration: users who saved a Gemini key before providers existed
  if (r.geminiApiKey && !apiKeys.gemini) apiKeys.gemini = r.geminiApiKey;
  if (typeof r.aiModel === 'string') aiModel = r.aiModel;
  if (r.glossaryUrl)        glossaryUrl        = r.glossaryUrl;
  if (r.glossaryUrlMath)    glossaryUrlMath    = r.glossaryUrlMath;
  if (r.glossaryUrlScience) glossaryUrlScience = r.glossaryUrlScience;
}

chrome.storage.sync.get(SETTINGS_KEYS, applySettings);
chrome.storage.onChanged.addListener(c => {
  if (c.targetLanguage && !WORLD_LANGUAGES[subdomain]) selectedLanguage = c.targetLanguage.newValue;
  if (c.aiProvider && AI_PROVIDERS[c.aiProvider.newValue]) aiProvider = c.aiProvider.newValue;
  if (c.apiKeys)  apiKeys = c.apiKeys.newValue || {};
  if (c.aiModel)  aiModel = c.aiModel.newValue || '';
  if (c.geminiApiKey && !apiKeys.gemini) apiKeys.gemini = c.geminiApiKey.newValue || '';
  if (c.glossaryUrl)        { glossaryUrl        = c.glossaryUrl.newValue        || ''; _cachedGlossary = null; }
  if (c.glossaryUrlMath)    { glossaryUrlMath    = c.glossaryUrlMath.newValue    || ''; _cachedGlossary = null; }
  if (c.glossaryUrlScience) { glossaryUrlScience = c.glossaryUrlScience.newValue || ''; _cachedGlossary = null; }
});

// ── Iframe finder ─────────────────────────────────────────────────────────────
// Finds the Crowdin translation iframe by multiple strategies, since the ID
// 'crowdin-editor-iframe' is not always present (varies by page/view mode).
function findCrowdinIframe() {
  const byId = document.getElementById('crowdin-editor-iframe');
  if (byId) return byId;
  for (const ifr of document.querySelectorAll('iframe')) {
    try {
      const src = ifr.src || ifr.getAttribute('src') || '';
      const id = ifr.id || '';
      const cls = typeof ifr.className === 'string' ? ifr.className : '';
      if (src.includes('crowdin.com') || id.toLowerCase().includes('crowdin') ||
          cls.toLowerCase().includes('crowdin')) return ifr;
    } catch(e) {}
  }
  // Last resort: first visible, reasonably large iframe
  for (const ifr of document.querySelectorAll('iframe')) {
    try {
      const r = ifr.getBoundingClientRect();
      if (r.width > 100 && r.height > 100) return ifr;
    } catch(e) {}
  }
  return null;
}

// ── postMessage helper ────────────────────────────────────────────────────────
function iframeCmd(cmd, extra = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const iframe = findCrowdinIframe();
    if (!iframe) { resolve(null); return; }

    const replyCmd = {
      GET_STATE: 'STATE', INSERT_SAVE: 'INSERT_SAVE_DONE',
      PING: 'PONG', SCAN: 'SCAN_RESULT',
    }[cmd];

    let settled = false;
    const handler = (e) => {
      if (!e.data?.__kat || e.data.cmd !== replyCmd) return;
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      clearTimeout(t);
      resolve(e.data);
    };
    const t = setTimeout(() => {
      if (!settled) { settled = true; window.removeEventListener('message', handler); resolve(null); }
    }, timeoutMs);
    window.addEventListener('message', handler);
    try { iframe.contentWindow.postMessage({ __kat: true, cmd, ...extra }, '*'); }
    catch(e) { settled = true; clearTimeout(t); resolve(null); }
  });
}

function waitForIframe(maxMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(pingInterval);
      window.removeEventListener('message', onReady);
      obs.disconnect();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), maxMs);
    const onReady = (e) => {
      if (e.data?.__kat && e.data.cmd === 'IFRAME_READY') done(true);
    };
    window.addEventListener('message', onReady);
    const obs = new MutationObserver(() => {
      if (findCrowdinIframe()) {
        setTimeout(async () => {
          const r = await iframeCmd('PING', {}, 2000);
          if (r) done(true);
        }, 800);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    if (findCrowdinIframe()) {
      iframeCmd('PING', {}, 2000).then(r => { if (r) done(true); });
    }
    const pingInterval = setInterval(async () => {
      if (findCrowdinIframe()) {
        const r = await iframeCmd('PING', {}, 1500);
        if (r) done(true);
      }
    }, 2500);
  });
}

// ── JIPT element helpers ──────────────────────────────────────────────────────

// Selectors for untranslated JIPT strings in the KA page
const JIPT_UNTRANSL_SELS = [
  '.crowdin_jipt_untransl',
  '[class*="jipt"][class*="untransl"]',
  '[class*="jipt"]:not([class*="approved"]):not([class*="selected"])',
];

// Selectors for the string list items in the Crowdin editor layout
// (used as fallback if JIPT inline-mode not detected)
const EDITOR_LIST_SELS = [
  '.source-string', '[class*="stringItem"]', '[class*="string-row"]',
  '[class*="phraseRow"]', '[class*="translation-unit"]',
];

function getUntranslatedElements() {
  for (const sel of JIPT_UNTRANSL_SELS) {
    try {
      const els = [...document.querySelectorAll(sel)].filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (els.length > 0) return { els, mode: 'jipt' };
    } catch(e) {}
  }
  // Fallback: editor list items
  for (const sel of EDITOR_LIST_SELS) {
    try {
      const els = [...document.querySelectorAll(sel)];
      if (els.length > 0) return { els, mode: 'editor' };
    } catch(e) {}
  }
  return { els: [], mode: 'none' };
}

// Get source text from a JIPT element's data attributes
function getJiptSourceAttr(el) {
  for (const attr of [
    'data-crowdin-source', 'data-original', 'data-en', 'data-source',
    'data-phrase', 'data-string', 'title',
  ]) {
    try {
      const val = el.getAttribute(attr);
      if (val && val.length > 1 && val.length < 5000) return val.trim();
    } catch(e) {}
  }
  // Check parents (up to 3 levels)
  let p = el.parentElement;
  for (let i = 0; i < 3; i++) {
    if (!p || p === document.body) break;
    for (const attr of ['data-crowdin-source','data-original','data-en','data-source']) {
      try {
        const val = p.getAttribute(attr);
        if (val && val.length > 1) return val.trim();
      } catch(e) {}
    }
    p = p.parentElement;
  }
  return null;
}

// Click a JIPT element and wait for the iframe panel to render
async function activateJiptElement(el) {
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(200);
    el.focus();
    el.click();
  } catch(e) {
    console.warn('[KAT] click error:', e.message);
  }
}

// ── Review queue ──────────────────────────────────────────────────────────────
// Strings a reviewer should look at after a batch: risky phrases or a meaning
// mismatch in the back-translation. Filled by Translate All and by Check Translated.
let _reviewQueue = [];
function noteResult(source, r, el) {
  bgStat(s => { s.stringsTranslated++; s.flagsShown += r.flags.length; });
  if (r.flags.length || (r.back && !r.back.match)) {
    _reviewQueue.push({ source, text: r.text, flags: r.flags, back: r.back, el });
  }
}

// ── TRANSLATE ALL ─────────────────────────────────────────────────────────────
async function translateAll() {
  chrome.storage.sync.get(SETTINGS_KEYS, async result => {
    applySettings(result);
    clearTM(); // start a fresh translation memory for each new batch
    _reviewQueue = [];
    await runNavigationBatch();
  });
}

async function runNavigationBatch() {
  const MAX = 500;
  const overlay = showProgressOverlay();
  let stopped = false, done = 0, skipped = 0, errors = 0;

  overlay.querySelector('#ka-stop-btn').onclick = () => {
    stopped = true;
    overlay.querySelector('#ka-stop-btn').textContent = 'Спиране…';
    overlay.remove();
  };

  await sleep(300);

  // ── Step 1: Make sure the Crowdin editor iframe is open ──
  if (!findCrowdinIframe()) {
    // Try to auto-open by clicking the first available JIPT element
    const { els: earlyEls } = getUntranslatedElements();
    if (earlyEls.length > 0) {
      updateProgress(overlay, 0, 0, '⏳ Отварям панела на редактора…');
      await activateJiptElement(earlyEls[0]);
      await sleep(1500);
    }
    // If still no iframe, ask the user
    if (!findCrowdinIframe()) {
      updateProgress(overlay, 0, 0, '👆 Щракни върху стринг, за да се отвори редакторът');
      overlay.querySelector('#ka-prog-current').textContent =
        'Щракни върху стринг на страницата, за да се отвори панелът за превод, и опитай пак.';
      const appeared = await new Promise(r => {
        const obs = new MutationObserver(() => {
          if (findCrowdinIframe()) { obs.disconnect(); r(true); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); r(false); }, 60000);
      });
      if (!appeared || stopped) {
        const s = overlay.querySelector('#ka-stop-btn');
        s.textContent = '✕ Затвори'; s.onclick = () => overlay.remove();
        return;
      }
    }
  }

  // ── Step 2: Connect to iframe content script ──
  updateProgress(overlay, 0, 0, '⏳ Свързване с редактора на Crowdin…');
  const ready = await waitForIframe(12000);
  if (!ready) {
    updateProgress(overlay, 0, 0, '❌ Редакторът не отговаря — презареди страницата');
    const s = overlay.querySelector('#ka-stop-btn');
    s.textContent = '✕ Затвори'; s.onclick = () => overlay.remove();
    return;
  }

  // ── Step 3: Find untranslated JIPT elements ──
  updateProgress(overlay, 0, 0, '🔍 Търся непреведени стрингове…');
  await sleep(400);

  const { els: jiptElements, mode } = getUntranslatedElements();
  console.log(`[KAT] Found ${jiptElements.length} elements in mode="${mode}"`);

  if (jiptElements.length === 0) {
    // No JIPT elements found — fall back to the old iframe-navigation approach
    updateProgress(overlay, 0, 0, '⚠️ Няма стрингове на страницата — минавам през редактора…');
    await sleep(500);
    await runIframeFallback(overlay, MAX, () => stopped);
    return;
  }

  const total = jiptElements.length;
  updateProgress(overlay, 0, total, `✅ Намерени непреведени стрингове: ${total}. Започвам…`);
  await sleep(600);

  // Track the source of the last successfully saved string.
  // Used to detect when the Crowdin panel hasn't yet switched to the new string
  // (stale panel would show the previous string's translation as "existing").
  let prevSavedSource = null;

  // ── Step 4: Process each JIPT element ──
  for (let i = 0; i < jiptElements.length && i < MAX; i++) {
    if (stopped) break;

    const el = jiptElements[i];

    // Get source text from element attributes before clicking
    const attrSource = getJiptSourceAttr(el);

    // Click to activate this string in the Crowdin editor panel
    updateProgress(overlay, done, total, `Стринг ${i+1}/${total} — отварям…`, attrSource ? `"${attrSource.slice(0,50)}"` : '');
    await activateJiptElement(el);

    // Wait for the Crowdin iframe to render: need BOTH hasInput AND source text.
    // Also wait for the panel to switch AWAY from the previous string's source —
    // otherwise stale "existing" text from the just-saved string would cause false skips.
    let state = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (stopped) break;
      await sleep(attempt === 0 ? 900 : 500);
      state = await iframeCmd('GET_STATE', {}, 4000);

      // If the panel is still showing the previous string's source, keep waiting.
      // (This happens when Crowdin hasn't fully transitioned to the next string yet.)
      if (prevSavedSource && state?.source &&
          state.source.slice(0, 60).trim() === prevSavedSource.slice(0, 60).trim() &&
          attempt < 10) {
        console.log(`[KAT] attempt ${attempt+1}: panel still showing prev source, waiting…`);
        continue;
      }

      const srcFound = !!(state?.source || attrSource);
      const ready = state?.hasInput && srcFound;
      if (ready) break;
      console.log(`[KAT] attempt ${attempt+1}: hasInput=${state?.hasInput}, source=${state?.source?.slice(0,30)||'null'}, attrSrc=${attrSource?.slice(0,20)||'null'}, bodyLen=${state?.debug?.bodyLen}`);
      // If we already have attrSource, hasInput alone is enough — don't keep waiting
      if (state?.hasInput && attrSource) break;
    }

    if (stopped) break;

    if (!state?.hasInput) {
      // Iframe still has no input — run a scan to diagnose
      const scan = await iframeCmd('SCAN', {}, 5000);
      const d = scan?.scan;
      const diagMsg = d
        ? `Iframe: ${d.bodyLen}B body, ${d.editable?.length||0} CE, ${d.textareas?.length||0} TA`
        : 'Could not reach iframe';
      console.log('[KAT] No input after clicking JIPT element:', diagMsg, scan?.scan);

      // Try a different approach: look for input directly in top frame
      // (sometimes the translation panel is rendered in the top frame)
      const topInput = findTopFrameTranslationInput();
      if (topInput) {
        console.log('[KAT] Found input in top frame!', topInput.tagName, topInput.className);
        const source = attrSource || findTopFrameSource();
        if (source && isTranslatableSource(source)) {
          try {
            const r = await translateTextDetailed(source, selectedLanguage);
            const translation = r.text;
            await insertInTopFrame(topInput, translation);
            done++;
            prevSavedSource = source;
            pushToTM(source, translation);
            noteResult(source, r, el);
            updateProgress(overlay, done, total, `Записани: ${done} ✓`, `"${source.slice(0,50)}"`);
          } catch(e) {
            errors++;
            console.warn('[KAT]', e.message);
          }
        } else {
          skipped++;
        }
        continue;
      }

      // If nothing works, skip this element
      skipped++;
      updateProgress(overlay, done, total, `Пропуснат (няма поле за превод, ${diagMsg})`, attrSource?.slice(0,40) || '');
      continue;
    }

    // We have a state with input!
    const source = state.source || attrSource;
    const existing = state.existing || '';

    // Only skip if existing translation contains Indic/non-ASCII script — that means
    // it's a real saved translation in the target language. Pure-ASCII existing content
    // is either a stale English pre-fill or leftover from the previous panel state.
    const hasRealTranslation = existing.length > 0 && /[^\x00-\x7F]/.test(existing);
    if (hasRealTranslation) {
      skipped++;
      updateProgress(overlay, done, total, `Пропуснат (вече е преведен)`, source ? `"${source.slice(0,50)}"` : '');
      continue;
    }

    // Extra guard: reject source if it contains Hindi/Devanagari script
    // (means we accidentally grabbed a UI element already translated)
    if (source && /[ऀ-ॿ]/.test(source)) {
      skipped++;
      console.warn('[KAT] Rejected source with Devanagari (likely UI text):', source.slice(0,60));
      updateProgress(overlay, done, total, `Пропуснат (текст от интерфейса)`, `"${source.slice(0,50)}"`);
      continue;
    }

    if (!source || !isTranslatableSource(source)) {
      skipped++;
      updateProgress(overlay, done, total, `Пропуснат (не подлежи на превод)`, source ? `"${source.slice(0,50)}"` : '(няма оригинал)');
      continue;
    }

    // Translate and insert
    updateProgress(overlay, done, total, 'Превеждам…', `"${source.slice(0,55)}"`);
    try {
      const r = await translateTextDetailed(source, selectedLanguage);
      const translation = r.text;
      const result = await iframeCmd('INSERT_SAVE', { text: translation }, 8000);
      if (result?.ok) {
        done++;
        prevSavedSource = source;
        pushToTM(source, translation);
        noteResult(source, r, el);
        updateProgress(overlay, done, total, `Записани: ${done} ✓`, `"${source.slice(0,55)}"`);
      } else {
        errors++;
        const errDetail = result?.error || 'save failed';
        console.warn('[KAT] INSERT_SAVE failed:', errDetail, 'for source:', source.slice(0,50));
        updateProgress(overlay, done, total, `Записани: ${done} (грешки: ${errors})`, errDetail);
      }
    } catch(e) {
      errors++;
      console.warn('[KAT]', e.message);
    }

    await sleep(300);
  }

  showSummary(overlay, done, jiptElements.length, errors, skipped);
}

// ── Top-frame input/source detection ─────────────────────────────────────────
// For the case where the Crowdin panel is rendered in the top frame

// The extension's own panels contain textareas — never treat them as Crowdin's input.
const KAT_UI = '#ka-translator-overlay, #ka-single-panel, #ka-review-panel';

function findTopFrameTranslationInput() {
  // Look for contenteditable or textarea that appeared after clicking a JIPT element.
  // Exclude the JIPT content elements themselves (they're the source display).
  const JIPT_CLASSES = ['crowdin_jipt_untransl', 'crowdin_jipt_approved', 'jipt-selected',
                        'crowdin_jipt_translated', 'crowdin_jipt'];

  for (const el of document.querySelectorAll('textarea')) {
    if (el.closest(KAT_UI)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 20 && rect.height > 10) return el;
  }

  for (const el of document.querySelectorAll('[contenteditable="true"]')) {
    if (el === document.body || el === document.documentElement) continue;
    if (el.closest(KAT_UI)) continue;
    // Skip JIPT content nodes
    if (JIPT_CLASSES.some(c => el.classList.contains(c))) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 20 && rect.height > 10) return el;
  }
  return null;
}

function findTopFrameSource() {
  for (const sel of [
    '[class*="source" i]', '[class*="original" i]', '[data-type="source"]',
  ]) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt && txt.length > 1 && txt.length < 3000) return txt;
      }
    } catch(e) {}
  }
  return null;
}

async function insertInTopFrame(el, text) {
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSet) nativeSet.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false, null);
    const ok = document.execCommand('insertText', false, text);
    if (!ok || !(el.innerText || '').trim()) {
      el.innerText = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }
  await sleep(300);
  // Try to save
  for (const sel of ['button[class*="save" i]','button[class*="approve" i]','button[type="submit"]']) {
    const btn = document.querySelector(sel);
    if (btn && !btn.closest(KAT_UI)) { btn.click(); return; }
  }
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true }));
}

// ── Iframe fallback (old navigation approach) ─────────────────────────────────
// Used when no JIPT elements are detected in the top frame.
// Relies on the user having already selected the first string.
async function runIframeFallback(overlay, MAX, isStopped) {
  let done = 0, skipped = 0, errors = 0, total = 0;
  let firstSource = null, processedCount = 0;

  for (let i = 0; i < MAX; i++) {
    if (isStopped()) break;

    let state = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (isStopped()) break;
      state = await iframeCmd('GET_STATE');
      if (state?.hasInput) break;
      updateProgress(overlay, done, total, `⏳ Чакам редактора… (${attempt+1}/10)`,
        state?.debug ? `CEs:${state.debug.allCE} TAs:${state.debug.allTA}` : '');
      await sleep(1000);
    }

    if (isStopped()) break;

    if (!state?.hasInput) {
      updateProgress(overlay, done, total, '❌ Няма поле за превод. Избери стринг в редактора и опитай пак.');
      const s = overlay.querySelector('#ka-stop-btn');
      s.textContent = '✕ Затвори'; s.onclick = () => overlay.remove();
      return;
    }

    const { source, existing } = state;

    if (!firstSource && source) { firstSource = source; }
    else if (processedCount >= 2 && source && source === firstSource) { break; }

    if (existing && existing.length > 0) {
      skipped++; total++; processedCount++;
      updateProgress(overlay, done, total, 'Пропуснат (вече е преведен)', source?.slice(0,50) || '');

      // NEXT: try iframe's doNext OR look for untranslated JIPT element
      await iframeCmdNext();
    } else if (source && isTranslatableSource(source)) {
      total++; processedCount++;
      updateProgress(overlay, done, total, 'Превеждам…', `"${source.slice(0,55)}"`);
      try {
        const r = await translateTextDetailed(source, selectedLanguage);
        const translation = r.text;
        const result = await iframeCmd('INSERT_SAVE', { text: translation });
        if (result?.ok) {
          done++;
          pushToTM(source, translation);
          noteResult(source, r, null);
          updateProgress(overlay, done, total, `Записани: ${done} ✓`, `"${source.slice(0,55)}"`);
        } else {
          errors++;
        }
      } catch(e) {
        errors++;
        console.warn('[KAT]', e.message);
      }
      await iframeCmdNext();
    } else {
      skipped++; total++; processedCount++;
      updateProgress(overlay, done, total, 'Пропуснат', source?.slice(0,50) || '(няма оригинал)');
      await iframeCmdNext();
    }

    await sleep(300);
  }

  showSummary(overlay, done, total, errors, skipped);
}

// "Next" helper: first tries clicking the next JIPT element, then falls back to iframe doNext
async function iframeCmdNext() {
  // Try clicking next untranslated JIPT element
  const { els } = getUntranslatedElements();
  if (els.length > 0) {
    await activateJiptElement(els[0]);
    await sleep(600);
    return;
  }
  // Fallback: send NEXT to iframe (old approach)
  const iframe = document.getElementById('crowdin-editor-iframe');
  if (iframe) {
    // Try pressing ArrowDown in iframe to select next string
    try {
      iframe.contentWindow.postMessage({ __kat: true, cmd: 'DO_NEXT' }, '*');
    } catch(e) {}
    await sleep(900);
  }
}

// ── Progress overlay ──────────────────────────────────────────────────────────
function showProgressOverlay(title = '⚡ Превод на всички стрингове') {
  document.getElementById('ka-translator-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ka-translator-overlay';
  Object.assign(overlay.style, {
    position:'fixed', bottom:'100px', right:'20px', width:'390px',
    background:'#fff', borderRadius:'16px',
    boxShadow:'0 10px 40px rgba(0,0,0,0.2)',
    zIndex:'2147483647', overflow:'hidden',
    fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
    border:'1px solid #e5e7eb',
  });
  overlay.innerHTML = `
    <div style="background:linear-gradient(135deg,#059669,#0d9488);padding:14px 18px;color:#fff">
      <div style="font-size:15px;font-weight:700">${escapeHtml(title)}</div>
      <div style="font-size:11px;opacity:.85;margin-top:2px">${activeApiKey() ? providerLabel() + ' AI' : 'Google Translate'} · ${WORLD_LANGUAGES[selectedLanguage]||selectedLanguage}</div>
    </div>
    <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
      <div>
        <div style="display:flex;justify-content:space-between;margin-bottom:5px;font-size:13px;color:#374151">
          <span id="ka-prog-label">Започвам…</span>
          <span id="ka-prog-count" style="font-weight:600;color:#059669">0</span>
        </div>
        <div style="background:#f3f4f6;border-radius:99px;height:6px;overflow:hidden">
          <div id="ka-prog-bar" style="height:100%;width:5%;background:linear-gradient(90deg,#059669,#0d9488);border-radius:99px;transition:width .4s"></div>
        </div>
      </div>
      <div id="ka-prog-current" style="font-size:12px;color:#6b7280;min-height:16px;word-break:break-word"></div>
      <div style="display:flex;justify-content:flex-end">
        <button id="ka-stop-btn" style="padding:7px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1.5px solid #e5e7eb;background:#fff;color:#374151;font-family:inherit">⏹ Спри</button>
      </div>
      <div id="ka-summary" style="font-size:13px;border-radius:8px;padding:10px 14px;display:none"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

function updateProgress(overlay, done, total, label, current) {
  const pct = total > 0 ? Math.min(Math.round((done/total)*100), 100) : 10;
  overlay.querySelector('#ka-prog-bar').style.width = Math.max(pct, 5)+'%';
  overlay.querySelector('#ka-prog-count').textContent = total > 0 ? `${done} / ${total}` : `${done}`;
  overlay.querySelector('#ka-prog-label').textContent = label;
  if (current !== undefined) overlay.querySelector('#ka-prog-current').textContent = current;
}

function showSummary(overlay, done, total, errors, skipped, mode = 'translate') {
  const s = overlay.querySelector('#ka-summary');
  s.style.display = 'block';
  s.style.background = errors === 0 ? '#d1fae5' : '#fef3c7';
  s.style.color = errors === 0 ? '#065f46' : '#92400e';
  s.innerHTML = (mode === 'check'
      ? `🔍 Проверени: <strong>${done}</strong>`
      : `✅ Преведени и записани: <strong>${done}</strong>`)
    + (skipped > 0 ? ` · ⏭ пропуснати: <strong>${skipped}</strong>` : '')
    + (errors > 0 ? ` · ⚠️ грешки: <strong>${errors}</strong>` : '');
  if (_reviewQueue.length > 0) {
    s.innerHTML += `
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,.08);color:#92400e">
        🟡 За преглед: <strong>${_reviewQueue.length}</strong> (рискови фрази или разминаване в смисъла)
        <div style="display:flex;gap:6px;margin-top:6px">
          <button id="ka-queue-show" style="${SMALL_BTN}">📋 Покажи списъка</button>
          <button id="ka-queue-csv" style="${SMALL_BTN}">⬇️ CSV</button>
        </div>
      </div>`;
    s.querySelector('#ka-queue-show').onclick = showReviewPanel;
    s.querySelector('#ka-queue-csv').onclick = downloadQueueCsv;
  }
  const stop = overlay.querySelector('#ka-stop-btn');
  stop.textContent = '✕ Затвори';
  stop.onclick = () => overlay.remove();
}

const SMALL_BTN = 'padding:5px 10px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:1.5px solid #e5e7eb;background:#fff;color:#374151;font-family:inherit';

// ── Highlighting risky phrases ────────────────────────────────────────────────
// Returns HTML of `text` with each flagged phrase wrapped in <mark>. Overlaps are skipped.
function highlightFlags(text, flags) {
  const ranges = [];
  flags.forEach((f, i) => {
    const at = text.indexOf(f.phrase);
    if (at !== -1) ranges.push({ a: at, b: at + f.phrase.length, i });
  });
  ranges.sort((x, y) => x.a - y.a);
  let html = '', pos = 0;
  for (const r of ranges) {
    if (r.a < pos) continue;
    const f = flags[r.i];
    const tip = `${bgReasonLabel(f.reason)}: ${f.note}${f.alternatives.length ? ' → ' + f.alternatives.join(' / ') : ''}`;
    html += escapeHtml(text.slice(pos, r.a))
      + `<mark title="${escapeHtml(tip)}" style="background:#fde68a;border-bottom:2px solid #d97706;border-radius:3px;padding:0 2px">${escapeHtml(text.slice(r.a, r.b))}</mark>`;
    pos = r.b;
  }
  return html + escapeHtml(text.slice(pos));
}

function backHtml(back) {
  if (!back) return '';
  const head = back.match
    ? `<div style="color:#065f46;font-weight:600">✅ Смисълът съвпада</div>`
    : `<div style="color:#991b1b;font-weight:600">❌ Възможно разминаване в смисъла${back.issue ? ': ' + escapeHtml(back.issue) : ''}</div>`;
  return `${head}<div style="color:#6b7280;margin-top:3px"><span style="font-weight:600">Обратен превод:</span> ${escapeHtml(back.back)}</div>`;
}

// ── Review panel (after a batch) ──────────────────────────────────────────────
function showReviewPanel() {
  document.getElementById('ka-review-panel')?.remove();
  const panel = document.createElement('div');
  panel.id = 'ka-review-panel';
  Object.assign(panel.style, {
    position:'fixed', top:'60px', left:'20px', width:'420px', maxHeight:'calc(100vh - 90px)',
    background:'#fff', borderRadius:'12px', boxShadow:'0 10px 40px rgba(0,0,0,0.2)',
    zIndex:'2147483646', overflow:'hidden', border:'1px solid #e5e7eb', display:'flex', flexDirection:'column',
    fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif', fontSize:'13px', color:'#111827',
  });
  panel.innerHTML = `
    <div id="ka-rv-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:linear-gradient(135deg,#d97706,#b45309);color:#fff;cursor:move;user-select:none">
      <div style="font-size:14px;font-weight:700">🟡 За преглед (${_reviewQueue.length})</div>
      <div style="display:flex;gap:6px">
        <button id="ka-rv-csv" style="background:rgba(255,255,255,.18);border:none;color:#fff;padding:4px 10px;border-radius:12px;cursor:pointer;font-size:12px">⬇️ CSV</button>
        <button id="ka-rv-close" style="background:rgba(255,255,255,.18);border:none;color:#fff;width:26px;height:26px;border-radius:50%;cursor:pointer">✕</button>
      </div>
    </div>
    <div id="ka-rv-list" style="overflow:auto;padding:4px 16px 12px"></div>`;
  document.body.appendChild(panel);
  makeDraggable(panel, panel.querySelector('#ka-rv-hdr'));
  panel.querySelector('#ka-rv-close').onclick = () => panel.remove();
  panel.querySelector('#ka-rv-csv').onclick = downloadQueueCsv;

  const list = panel.querySelector('#ka-rv-list');
  _reviewQueue.forEach((item, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'padding:10px 0;border-bottom:1px solid #f3f4f6;line-height:1.5';
    row.innerHTML = `
      <div style="color:#6b7280;font-size:12px">${idx + 1}. ${escapeHtml(item.source.slice(0, 160))}</div>
      <div style="margin-top:4px">${highlightFlags(item.text, item.flags)}</div>
      ${item.flags.map(f => `<div style="font-size:12px;margin-top:3px">• <b>${escapeHtml(f.phrase)}</b> — ${escapeHtml(bgReasonLabel(f.reason))}${f.note ? ': ' + escapeHtml(f.note) : ''}${f.alternatives.length ? ' → <i>' + escapeHtml(f.alternatives.join(' / ')) + '</i>' : ''}</div>`).join('')}
      ${item.back && !item.back.match ? `<div style="font-size:12px;margin-top:4px;background:#fef2f2;border-radius:6px;padding:6px 8px">${backHtml(item.back)}</div>` : ''}
      ${item.el ? `<button data-open="${idx}" style="${SMALL_BTN};margin-top:6px">↗ Отвори стринга</button>` : ''}`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-open]').forEach(b => {
    b.onclick = () => activateJiptElement(_reviewQueue[Number(b.dataset.open)].el);
  });
}

function downloadQueueCsv() {
  const rows = [['Оригинал', 'Превод', 'Рискови фрази', 'Обратен превод', 'Смисълът съвпада', 'Проблем']];
  for (const q of _reviewQueue) {
    rows.push([
      q.source, q.text,
      q.flags.map(f => `${f.phrase} (${bgReasonLabel(f.reason)}${f.note ? ': ' + f.note : ''})${f.alternatives.length ? ' → ' + f.alternatives.join(' / ') : ''}`).join('\n'),
      q.back?.back || '', q.back ? (q.back.match ? 'да' : 'не') : '', q.back?.issue || '',
    ]);
  }
  downloadText(bgCsv(rows), `za-pregled-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
}

function downloadText(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Check already-translated strings (optional, token-heavy) ──────────────────
const JIPT_TRANSL_SELS = [
  '.crowdin_jipt_translated',
  '.crowdin_jipt_approved',
  '[class*="crowdin_jipt"]:not(.crowdin_jipt_untransl)',
];

function getTranslatedElements() {
  for (const sel of JIPT_TRANSL_SELS) {
    try {
      const els = [...document.querySelectorAll(sel)].filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !el.classList.contains('crowdin_jipt_untransl');
      });
      // Keep only the outermost element when JIPT nodes are nested.
      const outer = els.filter(el => !els.some(o => o !== el && o.contains(el)));
      if (outer.length > 0) return outer;
    } catch(e) {}
  }
  return [];
}

async function checkTranslated() {
  if (!activeApiKey()) {
    showToast('⚠️ Проверката изисква API ключ за ИИ доставчик (виж настройките).', 'warn');
    return;
  }
  chrome.storage.sync.get(SETTINGS_KEYS, async result => {
    applySettings(result);
    _reviewQueue = [];
    await runCheckBatch();
  });
}

async function runCheckBatch() {
  const overlay = showProgressOverlay('🔍 Проверка на преведените стрингове');
  let stopped = false, checked = 0, skipped = 0, errors = 0;
  overlay.querySelector('#ka-stop-btn').onclick = () => { stopped = true; overlay.remove(); };

  const els = getTranslatedElements();
  const total = els.length;
  if (total === 0) {
    updateProgress(overlay, 0, 0, 'Няма преведени стрингове на тази страница.');
    showSummary(overlay, 0, 0, 0, 0, 'check');
    return;
  }

  if (!findCrowdinIframe()) { await activateJiptElement(els[0]); await sleep(1500); }
  updateProgress(overlay, 0, total, '⏳ Свързване с редактора на Crowdin…');
  if (!(await waitForIframe(12000))) {
    updateProgress(overlay, 0, total, '❌ Редакторът не отговаря — презареди страницата');
    showSummary(overlay, 0, total, 1, 0, 'check');
    return;
  }

  let prevSource = null;
  for (let i = 0; i < els.length; i++) {
    if (stopped) return;
    const el = els[i];
    updateProgress(overlay, checked, total, `Стринг ${i+1}/${total} — отварям…`);
    await activateJiptElement(el);

    let state = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(attempt === 0 ? 900 : 500);
      state = await iframeCmd('GET_STATE', {}, 4000);
      const stale = prevSource && state?.source && state.source.slice(0, 60) === prevSource.slice(0, 60);
      if (state?.hasInput && state?.source && !stale) break;
    }
    const source = state?.source || getJiptSourceAttr(el);
    const existing = (state?.existing || '').trim();
    if (!source || !existing || !/[^\x00-\x7F]/.test(existing)) {
      skipped++;
      continue;
    }
    prevSource = source;

    updateProgress(overlay, checked, total, 'Проверявам…', `"${source.slice(0, 55)}"`);
    try {
      const r = await reviewExistingTranslation(source, existing, selectedLanguage);
      checked++;
      if (r.flags.length || (r.back && !r.back.match)) {
        _reviewQueue.push({ source, text: existing, flags: r.flags, back: r.back, el });
      }
      updateProgress(overlay, checked, total, `Проверени: ${checked} · за преглед: ${_reviewQueue.length}`);
    } catch (e) {
      errors++;
      console.warn('[KAT] Review failed:', e.message);
    }
  }
  showSummary(overlay, checked, total, errors, skipped, 'check');
}

// ── Floating buttons ──────────────────────────────────────────────────────────
function injectButtons() {
  if (document.getElementById('ka-btn-group')) { syncCheckBtn(); return; }
  const group = document.createElement('div');
  group.id = 'ka-btn-group';
  Object.assign(group.style, {
    position:'fixed', bottom:'28px', right:'28px', zIndex:'2147483647',
    display:'flex', flexDirection:'column', gap:'10px', alignItems:'flex-end',
  });

  // Colours of the Bulgarian flag (white, green, red), blended top to bottom.
  const allBtn = makeBtn('⚡ Преведи всички',
    'linear-gradient(180deg,#ffffff 12%,#00966E 50%,#D62612 88%)', translateAll,
    { textShadow:'0 1px 2px rgba(0,0,0,.85)', border:'1px solid #d1d5db' });
  const singleBtn = makeBtn('🌐 Преведи този', 'linear-gradient(135deg,#4f46e5,#7c3aed)', translateThis);

  group.appendChild(allBtn);
  group.appendChild(singleBtn);
  document.body.appendChild(group);
  syncCheckBtn();
}

// The "check translated" button only shows when enabled in the settings.
function syncCheckBtn() {
  const group = document.getElementById('ka-btn-group');
  if (!group) return;
  const existing = document.getElementById('ka-check-btn');
  if (bgSettings.reviewTranslatedBtn && !existing) {
    const btn = makeBtn('🔍 Провери преведените', 'linear-gradient(135deg,#d97706,#b45309)', checkTranslated);
    btn.id = 'ka-check-btn';
    group.appendChild(btn);
  } else if (!bgSettings.reviewTranslatedBtn && existing) {
    existing.remove();
  }
}
chrome.storage.onChanged.addListener(c => { if (c.reviewTranslatedBtn) syncCheckBtn(); });

function makeBtn(label, bg, onClick, extraStyle = {}) {
  const btn = document.createElement('button');
  btn.type='button'; btn.textContent=label;
  Object.assign(btn.style, {
    padding:'10px 18px', background:bg, color:'#fff', border:'none',
    borderRadius:'50px', fontSize:'13px', fontWeight:'700',
    fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
    cursor:'pointer', boxShadow:'0 4px 16px rgba(0,0,0,0.25)', whiteSpace:'nowrap',
    ...extraStyle,
  });
  btn.addEventListener('mouseenter',()=>{ btn.style.opacity='.9'; btn.style.transform='translateY(-2px)'; });
  btn.addEventListener('mouseleave',()=>{ btn.style.opacity='1'; btn.style.transform='none'; });
  btn.addEventListener('click', onClick);
  return btn;
}

// ── Single string translation ─────────────────────────────────────────────────
async function translateThis() {
  // First try top frame source
  let src = findTopFrameSource();
  // If not found, ask iframe
  if (!src) {
    const state = await iframeCmd('GET_STATE', {}, 3000);
    src = state?.source || '';
  }
  showSinglePanel(src || '(Първо отвори стринг, после натисни „Преведи този“)');
}

const LABEL_STYLE = 'font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px';
const TA_STYLE = 'width:100%;padding:8px 10px;border:1.5px solid #e5e7eb;border-radius:7px;font-size:13px;font-family:inherit;line-height:1.5;outline:none;resize:vertical;box-sizing:border-box';
const PANEL_BTN = 'padding:7px 11px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:none;background:#f3f4f6;color:#374151;font-family:inherit';

function showSinglePanel(sourceText) {
  document.getElementById('ka-single-panel')?.remove();
  const panel = document.createElement('div');
  panel.id = 'ka-single-panel';
  Object.assign(panel.style, {
    position:'fixed', top:'60px', right:'20px', width:'380px', maxHeight:'calc(100vh - 190px)', overflowY:'auto',
    background:'#fff', borderRadius:'12px',
    boxShadow:'0 10px 40px rgba(0,0,0,0.2)',
    zIndex:'2147483646', border:'1px solid #e5e7eb',
    fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
  });
  panel.innerHTML = `
    <div id="ka-sp-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;cursor:move;user-select:none">
      <div style="font-size:14px;font-weight:700">🌐 Превод <span style="font-size:10px;background:rgba(255,255,255,.2);padding:2px 8px;border-radius:20px;margin-left:6px">${activeApiKey() ? providerLabel() : 'Google'}</span></div>
      <button id="ka-sp-close" style="background:rgba(255,255,255,.15);border:none;color:#fff;width:26px;height:26px;border-radius:50%;cursor:pointer;font-size:13px">✕</button>
    </div>
    <div style="padding:12px 16px 0">
      <div style="${LABEL_STYLE}">Език</div>
      <select id="ka-sp-lang" style="width:100%;padding:8px 10px;border:1.5px solid #e5e7eb;border-radius:7px;font-size:13px;background:#fafafa;outline:none;cursor:pointer">
        ${Object.entries(LANGUAGES).map(([c,n])=>`<option value="${c}"${c===selectedLanguage?' selected':''}>${n}</option>`).join('')}
      </select>
    </div>
    <div style="padding:12px 16px 0">
      <div style="${LABEL_STYLE}">Оригинал (английски)</div>
      <textarea id="ka-sp-src" rows="3" style="${TA_STYLE};background:#f9fafb">${escapeHtml(sourceText)}</textarea>
    </div>
    <div style="padding:12px 16px 0">
      <div style="${LABEL_STYLE}">Превод</div>
      <textarea id="ka-sp-result" rows="4" style="${TA_STYLE}" placeholder="Тук ще се появи преводът…"></textarea>
    </div>
    <div id="ka-sp-flags" style="display:none;margin:10px 16px 0;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:12px;line-height:1.5;color:#111827"></div>
    <div id="ka-sp-back" style="display:none;margin:10px 16px 0;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.5"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px 14px;gap:6px;flex-wrap:wrap">
      <div style="display:flex;gap:6px">
        <button id="ka-sp-go" style="${PANEL_BTN}">🔄 Преведи</button>
        <button id="ka-sp-check" style="${PANEL_BTN}" title="Провери текущия превод за рискови фрази и смисъл (1 заявка към ИИ)">🔍 Провери</button>
      </div>
      <div style="display:flex;gap:6px">
        <button id="ka-sp-copy" style="${PANEL_BTN}">📋 Копирай</button>
        <button id="ka-sp-insert" style="${PANEL_BTN};background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff">✅ Вмъкни и запиши</button>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  makeDraggable(panel, document.getElementById('ka-sp-hdr'));
  document.getElementById('ka-sp-close').onclick = () => panel.remove();

  const resultEl = document.getElementById('ka-sp-result');
  const flagsEl = document.getElementById('ka-sp-flags');
  const backEl = document.getElementById('ka-sp-back');
  let aiText = '';     // last AI output — the baseline for learning corrections
  let flags = [];      // risky phrases currently shown
  let accepted = 0;    // alternatives the translator picked with one click

  const renderFlags = () => {
    if (!flags.length) { flagsEl.style.display = 'none'; return; }
    const text = resultEl.value;
    flagsEl.style.display = 'block';
    flagsEl.innerHTML = `
      <div style="font-weight:700;color:#92400e;margin-bottom:6px">🟡 Рискови фрази (${flags.length})</div>
      <div style="background:#fff;border-radius:6px;padding:6px 8px;margin-bottom:6px;white-space:pre-wrap">${highlightFlags(text, flags)}</div>
      ${flags.map((f, i) => {
        const resolved = !text.includes(f.phrase);
        return `<div style="margin-top:6px;${resolved ? 'opacity:.55' : ''}">
          ${resolved ? '✓ ' : ''}<b>${escapeHtml(f.phrase)}</b>
          <span style="background:#fef3c7;border-radius:10px;padding:0 6px;margin-left:4px">${escapeHtml(bgReasonLabel(f.reason))}</span>
          ${f.note ? `<div style="color:#4b5563">${escapeHtml(f.note)}</div>` : ''}
          ${!resolved && f.alternatives.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px">${f.alternatives.map((a, j) =>
            `<button data-f="${i}" data-a="${j}" title="Замени в превода" style="padding:2px 8px;border-radius:10px;border:1px solid #d97706;background:#fff;color:#92400e;cursor:pointer;font-size:12px;font-family:inherit">${escapeHtml(a)}</button>`).join('')}</div>` : ''}
        </div>`;
      }).join('')}`;
    flagsEl.querySelectorAll('button[data-f]').forEach(b => {
      b.onclick = () => {
        const f = flags[Number(b.dataset.f)];
        resultEl.value = resultEl.value.replace(f.phrase, f.alternatives[Number(b.dataset.a)]);
        accepted++;
        renderFlags();
      };
    });
  };
  resultEl.addEventListener('input', renderFlags);

  const renderBack = (back) => {
    if (!back) { backEl.style.display = 'none'; return; }
    backEl.style.display = 'block';
    backEl.style.background = back.match ? '#ecfdf5' : '#fef2f2';
    backEl.style.border = `1px solid ${back.match ? '#a7f3d0' : '#fecaca'}`;
    backEl.innerHTML = backHtml(back);
  };

  const doTranslate = async () => {
    const lang = document.getElementById('ka-sp-lang').value;
    selectedLanguage = lang;
    chrome.storage.sync.set({ targetLanguage: lang });
    const src = document.getElementById('ka-sp-src').value.trim();
    const b = document.getElementById('ka-sp-go');
    resultEl.value=''; resultEl.placeholder='⏳ Превеждам…'; b.disabled=true; b.textContent='⏳…';
    flags = []; accepted = 0; renderFlags(); renderBack(null);
    try {
      const r = await translateTextDetailed(src, lang, { single: true });
      resultEl.value = r.text;
      aiText = r.text;
      flags = r.flags;
      renderFlags();
      renderBack(r.back);
      bgStat(s => { s.stringsTranslated++; s.flagsShown += r.flags.length; });
      resultEl.placeholder='Тук ще се появи преводът…';
    } catch(e) { resultEl.placeholder=`❌ ${e.message}`; }
    finally { b.disabled=false; b.textContent='🔄 Преведи'; }
  };

  const doCheck = async () => {
    const t = resultEl.value.trim();
    const src = document.getElementById('ka-sp-src').value.trim();
    if (!t || !src) return;
    if (!activeApiKey()) { showToast('⚠️ Проверката изисква API ключ за ИИ доставчик.', 'warn'); return; }
    const b = document.getElementById('ka-sp-check');
    b.disabled = true; b.textContent = '⏳…';
    try {
      const r = await reviewExistingTranslation(src, t, document.getElementById('ka-sp-lang').value);
      flags = r.flags; accepted = 0;
      renderFlags();
      renderBack(r.back);
      if (!r.flags.length && (!r.back || r.back.match)) showToast('✅ Не открих рискови места.', 'success');
    } catch (e) { showToast(`⚠️ ${e.message}`, 'warn'); }
    finally { b.disabled = false; b.textContent = '🔍 Провери'; }
  };

  // Learn from the translator's edits and record flag statistics before saving.
  const learn = async (finalText) => {
    bgStatFlagOutcome(flags, finalText, accepted);
    if (aiText && finalText !== aiText) {
      bgStat(s => { s.editedBeforeSave++; });
      const pairs = await bgRecordCorrections(aiText, finalText, document.getElementById('ka-sp-src').value);
      if (pairs.length) return ` 🧠 Запомних: ${pairs.map(p => `${p.from} → ${p.to}`).join('; ').slice(0, 100)}`;
    }
    return '';
  };

  document.getElementById('ka-sp-go').onclick = doTranslate;
  document.getElementById('ka-sp-check').onclick = doCheck;
  document.getElementById('ka-sp-copy').onclick = () => {
    const t = resultEl.value;
    if (!t) return;
    navigator.clipboard.writeText(t).then(() => {
      const b = document.getElementById('ka-sp-copy');
      b.textContent='✅ Копирано'; setTimeout(()=>{ b.textContent='📋 Копирай'; },2000);
    });
  };
  document.getElementById('ka-sp-insert').onclick = async () => {
    const t = resultEl.value;
    if (!t) return;
    // Try top frame first
    const topInput = findTopFrameTranslationInput();
    if (topInput) {
      await insertInTopFrame(topInput, t);
      showToast('✅ Вмъкнато и записано!' + await learn(t), 'success');
      panel.remove();
      return;
    }
    // Fall back to iframe
    const result = await iframeCmd('INSERT_SAVE', { text: t }, 5000);
    if (result?.ok) {
      showToast('✅ Вмъкнато и записано!' + await learn(t), 'success');
      panel.remove();
    } else {
      showToast('⚠️ Не успях да вмъкна — избери стринг и опитай пак „Вмъкни и запиши“', 'warn');
    }
  };
  if (sourceText && !sourceText.startsWith('(')) doTranslate();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showToast(msg, type) {
  const t = document.createElement('div');
  Object.assign(t.style, {
    position:'fixed', bottom:'90px', left:'50%', transform:'translateX(-50%)',
    padding:'10px 18px', borderRadius:'8px', fontSize:'13px', fontWeight:'500',
    zIndex:'2147483647', fontFamily:'inherit', boxShadow:'0 4px 14px rgba(0,0,0,.15)',
    background:type==='success'?'#d1fae5':'#fef3c7',
    color:type==='success'?'#065f46':'#92400e', maxWidth:'80vw',
  });
  t.textContent=msg; document.body.appendChild(t);
  setTimeout(()=>t.remove(), 4500);
}
function makeDraggable(panel, handle) {
  let sx,sy,sl,st;
  handle.addEventListener('mousedown', e => {
    sx=e.clientX; sy=e.clientY;
    const r=panel.getBoundingClientRect(); sl=r.left; st=r.top;
    const mv=e=>{ panel.style.left=`${sl+e.clientX-sx}px`; panel.style.top=`${st+e.clientY-sy}px`; panel.style.right='auto'; };
    const up=()=>{ document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
    document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
    e.preventDefault();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
function boot() { injectButtons(); }
if (document.body) boot();
else document.addEventListener('DOMContentLoaded', boot);
const _obs = new MutationObserver(() => { if (!document.getElementById('ka-btn-group')) injectButtons(); });
_obs.observe(document.body||document.documentElement, { childList:true, subtree:true });
setTimeout(boot,1000); setTimeout(boot,3000);
} // end if (IS_TOP_FRAME)
