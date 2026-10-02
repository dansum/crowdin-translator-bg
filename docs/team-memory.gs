/**
 * KA Crowdin Translator BG — обща памет на екипа за поправки.
 *
 * Как се настройва (около 5 минути):
 *  1. Създай нова Google таблица (напр. „Поправки на превода“).
 *  2. Разширения → Apps Script. Изтрий примерния код и постави този файл.
 *  3. Внедряване → Ново внедряване → тип „Уеб приложение“.
 *       Изпълнява се като: Аз
 *       Кой има достъп: Всеки
 *  4. Копирай URL адреса, който завършва на /exec, и го постави в настройките
 *     на разширението: „Памет и кеширане“ → „Обща памет на екипа (URL)“.
 *
 * Всеки ред в листа „Поправки“ е една поправка. Ако изтриеш ред, поправката
 * спира да се подава на модела (след до 1 час, заради кеша в разширението).
 * Всеки, който има URL адреса, може да добавя редове — не го публикувай.
 */

const SHEET_NAME = 'Поправки';
const HEADER = ['Дата', 'Грешно', 'Предпочитано', 'Оригинал (пример)'];

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADER);
    sh.setFrozenRows(1);
  }
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// GET → [{from, to, count, last}] — всички поправки, групирани и преброени.
function doGet() {
  const rows = getSheet_().getDataRange().getValues().slice(1);
  const agg = {};
  rows.forEach(function (r) {
    const from = String(r[1] || '').trim();
    const to = String(r[2] || '').trim();
    if (!from || !to) return;
    const key = from + '→' + to;
    if (!agg[key]) agg[key] = { from: from, to: to, count: 0, last: 0 };
    agg[key].count++;
    const t = new Date(r[0]).getTime() || 0;
    if (t > agg[key].last) agg[key].last = t;
  });
  return json_(Object.keys(agg).map(function (k) { return agg[k]; }));
}

// POST {corrections: [{from, to}], source} → добавя редове в листа.
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = JSON.parse(e.postData.contents || '{}');
    const sh = getSheet_();
    const now = new Date();
    (data.corrections || []).slice(0, 20).forEach(function (c) {
      if (!c || !c.from || !c.to) return;
      sh.appendRow([now, String(c.from).slice(0, 200), String(c.to).slice(0, 200),
                    String(data.source || '').slice(0, 300)]);
    });
    return json_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}
