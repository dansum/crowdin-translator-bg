# KA Crowdin Translator

A Chrome extension that batch-translates Khan Academy content on the [Crowdin](https://crowdin.com) translation portal using AI — **bring your own API key** (Google Gemini, OpenAI, or Anthropic Claude) and translate entire exercises in one click while keeping math, widgets, and formatting perfectly intact.

Built by Gaganpreet Singh from Khan India team, now available for every KA language community worldwide.

> **Българска версия.** Това е копие на [Khan/crowdin-translator](https://github.com/Khan/crowdin-translator) с допълнения за българския екип. Описанието им е в раздел [„Българска версия“](#българска-версия) по-долу, а промените по версии — в [„История на версиите“](#история-на-версиите) най-долу.

---

## Българска версия

### Какво е добавено

| Функция | Какво прави | По подразбиране | Цена в жетони |
|---|---|---|---|
| **Български правила в промпта** | Вместо примерите на маратхи моделът получава правила за български: терминология по учебниците на МОН, обръщение „ти“ или „Вие“, пълен и кратък член, бройна форма, многозначни думи, без калки от английски, кавички „…“. | Винаги за български | около +300 входни жетона на заявка |
| **Кавички „…“** | Поправя "…" и “…” на „…“ в текста, без да пипа формули и HTML. | Включено | без жетони (локално) |
| **Десетична запетая във формулите** | `$3.5$` → `$3{,}5$` и `$12{,}000$` → `$12\,000$` в математиката, която иначе се пази непреведена. | Включено | без жетони (локално) |
| **🟡 Рискови фрази** | Моделът отбелязва до 5 фрази, които може да звучат зле на български (калка, чуждица, тежък израз, термин, двусмислие, граматика), с 1–3 алтернативи. В панела „Преведи този“ фразите са подчертани, а алтернатива се приема с един клик. | **Изключено** | +100–200 изходни жетона на стринг |
| **↩️ Обратен превод** | Втора заявка превежда българския текст обратно на английски и казва дали смисълът съвпада (числа, отрицание, „най-малко/най-много“, кой какво прави). | **Изключено** (може „само при Преведи този“ или „при всеки превод“) | +1 заявка на стринг |
| **🟡 Опашка „За преглед“** | След „Преведи всички“ стринговете с рискови фрази или разминаване в смисъла се събират в списък с бутон „Отвори стринга“ и сваляне като CSV. | Работи, когато има рискови фрази или обратен превод | без допълнителни жетони |
| **🔍 Провери преведените** | Бутон, който минава през вече преведените стрингове на страницата и проверява всеки за рискови фрази и смисъл. Бутонът „🔍 Провери“ в панела „Преведи този“ проверява само текущия превод. | Бутонът за партида е **скрит** | 1 заявка на стринг |
| **🧠 Памет за поправките** | Когато преводачът промени предложението в „Преведи този“ преди „Вмъкни и запиши“, разширението записва разликата (напр. „площта → лицето“). До 25 най-чести поправки се подават на модела при следващите преводи. Списъкът се вижда, трие и сваля като CSV от настройките; ⭐ = поправена поне 3 пъти, кандидат за речника. | Включено | ~200–500 входни жетона на заявка |
| **Обща памет на екипа** | Поправките се изпращат и в обща Google таблица, така че всички преводачи ги ползват. | Изключено (нужен е URL) | влиза в горните 25 |
| **⚡ Кеширане на промпта** | Паметта за преводи от текущото упражнение отива в съобщението, а не в системния промпт. Така правилата и речникът остават еднакви и доставчиците могат да ги кешират (при Claude — изрично с `cache_control`). | Включено | намалява цената при дълги речници |
| **Статистика за качеството** | Брои показаните рискови фрази и колко от тях са приети с клик, поправени на ръка или оставени, по вид, както и разминаванията при обратния превод. | Винаги | без жетони |
| **Интерфейс на български** | Настройки, бутони, панели и съобщения за напредъка. Бутонът „Преведи всички“ е в цветовете на знамето. | — | — |

Функциите, които правят заявките чувствително по-тежки, са изключени по подразбиране и се включват от настройките → „Допълнителни проверки“.

Важно:
- **Кеширането при Claude** работи само когато системният промпт е поне колкото минимума на модела (за Claude Haiku 4.5 — 4096 жетона). На практика това става при по-дълъг речник. При по-къс промпт заявката минава нормално, просто без кеш.
- **Рисковите фрази** се искат само при превод на български.
- **Без API ключ** (безплатният Google Translate) работят само кавичките и десетичната запетая.
- **Поправките** се запомнят само от панела „Преведи този“, защото там човек редактира превода преди запис.

### Обща памет на екипа

1. Създай Google таблица → „Разширения“ → „Apps Script“ и постави кода от [`docs/team-memory.gs`](docs/team-memory.gs).
2. „Внедряване“ → „Ново внедряване“ → „Уеб приложение“; „Изпълнява се като: Аз“, „Достъп: Всеки“.
3. Копирай адреса, завършващ на `/exec`, в настройките → „Памет и кеширане“ → „Обща памет на екипа (URL)“.

Всеки ред в листа „Поправки“ е една поправка. Изтриеш ли ред, поправката спира да се ползва до един час. Всеки, който има адреса, може да добавя редове, затова не го публикувай.

---

## Why this exists

Khan Academy translators work string-by-string on Crowdin's in-context (JIPT) interface: click a string, read the English, type the translation, save, repeat — thousands of times per course. Machine-translation suggestions exist but regularly break LaTeX math, drop Perseus widgets, and ignore subject terminology.

This extension automates the whole loop:

1. Finds every untranslated string on the page
2. Translates each one with the AI provider of your choice — guided by your team's terminology glossary
3. Inserts and saves the translation back into Crowdin
4. Shows live progress — you watch, review afterwards, and fix only what needs fixing

Translators in our pilots reported **2–3× faster throughput** on math content, with the AI handling the repetitive strings and humans focusing on review and the genuinely tricky sentences.

## Features

- **⚡ Translate All** — batch-translate every untranslated string on the current page
- **🌐 Translate This** — translate a single string with manual review before saving
- **Bring your own AI** — Google Gemini, OpenAI, or Anthropic Claude; each provider's key is stored separately so you can switch anytime. Optional model override for any provider.
- **Math & widget protection** — LaTeX (`$x^2$`, `$$…$$`, `\begin{align}…`), Perseus widgets (`[[☃ radio 1]]`), URLs, HTML, and markdown structure are replaced with placeholder tokens before translation and restored verbatim afterwards. The AI never gets a chance to mangle them.
- **Glossary-guided terminology** — point the extension at a plain-text glossary URL (a published Google Sheet, GitHub raw file, or Gist). Every translation request includes your team's approved terms. Separate URLs supported for math vs science, auto-selected from the page.
- **Within-batch consistency memory** — the extension feeds the AI its recent translations from the same exercise so recurring terms are translated identically every time.
- **75+ target languages** — every language Crowdin and the major AI providers support.
- **Graceful fallback** — no API key? The extension falls back to free Google Translate (lower quality, still placeholder-protected).
- **Rate-limit aware** — automatic pacing and retry for free-tier API quotas.

## Installation

The extension is not on the Chrome Web Store — you load it as an "unpacked" extension (2 minutes, no developer knowledge needed):

1. **Download** this repository — click the green **Code** button → **Download ZIP** — and extract it somewhere permanent (e.g. `Documents/ka-crowdin-translator/`). Chrome reads the folder directly, so don't delete it later.
2. Open Chrome and go to `chrome://extensions/`
3. Toggle **Developer mode** on (top-right corner)
4. Click **Load unpacked** (top-left) and select the extracted folder (the one containing `manifest.json`)
5. Pin the extension: click the puzzle-piece 🧩 icon in the toolbar, then the pin next to **KA Crowdin Translator**

## Getting an API key

You need an API key from **one** of these providers. All three offer pay-as-you-go pricing; typical cost is **well under $1 per day** of heavy translation work.

| Provider | Get a key at | Default model | Notes |
|---|---|---|---|
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-2.5-flash` | Free tier available (15 requests/min, 1,500/day). Paid tier removes limits. |
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `gpt-4o-mini` | Requires a funded platform account. |
| **Anthropic Claude** | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) | `claude-haiku-4-5-20251001` | Requires a Console account with credits. |

> **Teams:** one shared paid key with a monthly budget alert is usually simpler than individual keys. Share it privately (never in public docs), and rotate it periodically.

## Configuration

Click the extension icon to open the settings popup:

1. **Target Language** — the language you translate into. On language subdomains (e.g. `mr.khanacademy.org`) the extension auto-detects the language from the URL and this setting is overridden.
2. **AI Provider** — pick Gemini, OpenAI, or Claude.
3. **API Key** — paste the key for the selected provider. Keys are remembered per provider.
4. **🧪 Test** — sends a one-line test translation so you can verify the key works before running a batch.
5. **Advanced** (optional):
   - **Model override** — use a different model than the default (e.g. `gemini-2.5-pro`, `gpt-4o`, `claude-sonnet-4-5`).
   - **Glossary URLs** — see [Glossary guide](#glossary-guide) below.
6. **Save Settings.**

![Translation settings panel](screenshots/settings.png)

## Usage

1. Go to a Khan Academy translation portal page, e.g.
   `https://<lang>.khanacademy.org/devadmin/translations/edit/…`
2. Two floating buttons appear bottom-right:
   - **⚡ Translate All** — translates and saves every untranslated string on the page, with a progress overlay (pause anytime with ⏹ Stop)
   - **🌐 Translate This** — opens a panel for the currently selected string: translate, review/edit the output, then Insert & Save

   ![Two floating buttons "Translate All" and "Translate This"](screenshots/translate_buttons.png)

3. Review the results in Crowdin as you normally would. AI output is a draft for human review, not a replacement for it.

![View showing source language (English) and a generated translation](screenshots/confirm_translation.png)

## Glossary guide

The single highest-impact quality lever. A glossary is a plain-text file of approved term pairs:

```
prime number | ಅವಿಭಾಜ್ಯ ಸಂಖ್ಯೆ
photosynthesis | प्रकाशसंश्लेषण
refractive index | अपवर्तनांक
```

- One `English | Translation` pair per line; lines starting with `#` are comments
- Host it at any URL that returns plain text:
  - **GitHub raw file or Gist** (recommended — version-controlled, free)
  - **Published Google Sheet** (File → Share → Publish to web → CSV/TSV)
- Paste the URL into the popup. The extension fetches it fresh every hour, so glossary updates reach every translator automatically — no reinstall needed.
- Up to ~50,000 characters (≈1,000–1,500 terms) are included per request.
- **Subject-aware URLs**: if you maintain separate math and science glossaries, set both — the extension detects the subject from the page URL and loads the matching one.

**Workflow that worked for us:** a language lead owns one glossary sheet per subject; translators flag wrong terms during review; the lead updates the sheet; everyone's next batch uses the fix.

## How it works (technical)

```
┌────────────────────── Khan Academy page (top frame) ──────────────────────┐
│  .crowdin_jipt_untransl elements  ←  finds & clicks each untranslated one │
│      │                                                                    │
│      │  window.postMessage (GET_STATE / INSERT_SAVE)                      │
│      ▼                                                                    │
│  ┌── Crowdin iframe (cross-origin) ──┐                                    │
│  │ source extraction · text insert · │                                    │
│  │ save-button detection             │                                    │
│  └───────────────────────────────────┘                                    │
└───────────────────────────────────────────────────────────────────────────┘
```

- `content.js` runs in **both frames** (`all_frames: true`) and detects its context via `window === window.top`.
- Before any text reaches an AI, every protected pattern (LaTeX, widgets, URLs, HTML, markdown markers) is replaced with a single **Unicode Private-Use-Area character** (U+E000–U+F8FF). These survive every translation engine untouched and are restored byte-for-byte afterwards. If the model drops even one token, the translation is rejected and retried through the fallback path.
- The AI request includes: translation rules (terminology, gender agreement, polysemy, transliteration policy), your glossary, and the last ~12 translations from the current batch for consistency.
- Multi-line math environments (`$\begin{align}…\end{align}$`) are tokenized before line-splitting so they always travel as one unit.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Buttons don't appear | Refresh the page. Confirm you're on a `khanacademy.org` translation URL and the extension is enabled. |
| "Extension context invalidated" in console | You reloaded the extension while the page was open — refresh the page. |
| Test button fails with 401/403 | Wrong or expired API key, or the key's account has no credit. |
| Test fails with 429 | Rate limit / quota exhausted. Gemini free tier resets daily (midnight Pacific). Wait or upgrade to paid. |
| Strings skipped during a batch | Open DevTools → Console → filter `[KAT]` to see the reason per string (already translated, UI text, rate limit, etc.). |
| Translations save but look wrong | Check the glossary is loading: console shows `[KAT] Loaded … glossary`. Improve the glossary — it's the biggest quality lever. |
| Overlay says "Google Translate" instead of your provider | No API key saved for the selected provider — open the popup and check. |

Console debugging: DevTools on the KA page, filter by `[KAT]` (top frame) or `[KAT iframe]` (Crowdin panel).

## Privacy & cost notes

- Source strings are sent to the AI provider you configure (Google, OpenAI, or Anthropic) under **your** API key and their API terms. No data is sent anywhere else; the extension has no backend and collects nothing.
- API keys are stored in `chrome.storage.sync` (synced to your Chrome profile). Never commit keys to a repository or share them in public channels.
- Rough cost guide with default models: a 50-string exercise ≈ $0.01–0.05 depending on provider. Set a billing alert on your provider account.

## Contributing

Not accepting contributions.

## Repository layout

```
├── manifest.json    # Chrome MV3 manifest
├── bg.js            # Bulgarian team additions: rules, post-processing, notes, corrections memory, stats
├── content.js       # All logic: frame handling, tokenization, AI providers, batch loop
├── popup.html       # Settings UI
├── popup.js         # Settings persistence + per-provider key test
├── styles.css       # Injected button/overlay styles
├── docs/team-memory.gs  # Google Apps Script for the shared team corrections memory
└── icons/           # Extension icons
```

## License

MIT (see `LICENSE`).

## История на версиите

Версиите се именуват `BG-ГГГГММДД-ННН`: датата на версията и поредният номер за деня. Текущата версия се вижда долу в настройките на разширението.

### BG-20261002-002

- Български правила в промпта вместо примерите на маратхи: терминология по учебниците, обръщение „ти“/„Вие“ (настройка), пълен и кратък член, бройна форма, многозначни думи, без калки, кавички „…“.
- Автоматична поправка на кавичките „…“ и десетична запетая във формулите (`$3{,}5$`, `$12\,000$`) — локално, без жетони.
- 🟡 Подчертаване на рискови фрази с алтернативи, приемани с един клик (изключено по подразбиране).
- ↩️ Обратен превод за проверка на смисъла (изключен по подразбиране).
- 🟡 Опашка „За преглед“ след „Преведи всички“, с CSV.
- 🔍 Проверка на вече преведени стрингове: бутон „Провери“ в панела и бутон за цялата страница (скрит по подразбиране).
- 🧠 Памет за поправките на преводача, подавана в следващите заявки, и обща памет на екипа чрез Google Apps Script.
- ⚡ Кеширане на промпта: паметта за преводи е преместена в съобщението, а при Claude системният промпт се маркира с `cache_control`.
- Статистика за качеството в настройките.
- Интерфейс на български; бутонът „Преведи всички“ е в цветовете на българското знаме.
- По подразбиране целевият език е български.
- Поправка: панелите на разширението вече не се бъркат с полето за превод на Crowdin при „Вмъкни и запиши“.

### BG-20261002-001

- Фонът на бутона „Translate All“ прелива от зелено към червено.
