// QCM journalier : rotation de questions (sauf sondage RH personnalisé)
const { startOfDay } = require('date-fns');

const SCALES_PER_DAY = 4;

function daySeed(date, companyId) {
  const d = startOfDay(date);
  const start = new Date(d.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((d - start) / 86400000);
  const key = `${companyId || ''}-${d.getFullYear()}-${dayOfYear}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * @param {Array<{id:string,order:number,type?:string,optional?:boolean,text:string}>} allQuestions
 */
function pickDailyQuestions(allQuestions, date, companyId, isCustom) {
  const sorted = [...(allQuestions || [])].sort((a, b) => a.order - b.order);
  if (!sorted.length) return [];

  if (isCustom) return sorted;

  const scales = sorted.filter((q) => (q.type || 'SCALE') !== 'TEXT');
  const texts = sorted.filter((q) => (q.type || 'SCALE') === 'TEXT');
  if (!scales.length) return sorted.slice(0, 5);

  const seed = daySeed(date, companyId);
  const picked = [];
  const used = new Set();

  for (let i = 0; i < scales.length && picked.length < SCALES_PER_DAY; i += 1) {
    const idx = (seed + i * 11) % scales.length;
    const q = scales[idx];
    if (used.has(q.id)) continue;
    used.add(q.id);
    picked.push(q);
  }

  for (let i = 0; picked.length < SCALES_PER_DAY && i < scales.length; i += 1) {
    const q = scales[i];
    if (used.has(q.id)) continue;
    used.add(q.id);
    picked.push(q);
  }

  if (texts.length) picked.push(texts[0]);

  return picked
    .sort((a, b) => a.order - b.order)
    .map((q, index) => ({ ...q, order: index + 1 }));
}

function dailyQcmLabel(date = new Date()) {
  const d = startOfDay(date);
  const fmt = d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  return fmt.charAt(0).toUpperCase() + fmt.slice(1);
}

module.exports = {
  pickDailyQuestions,
  dailyQcmLabel,
  SCALES_PER_DAY,
};
