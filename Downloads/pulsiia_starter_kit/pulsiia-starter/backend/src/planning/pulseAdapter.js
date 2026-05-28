// ═══════════════════════════════════════════════════════════════
// PULSIIA — Couche 3 : Pulse Adapter (Claude Haiku — in/out uniquement)
// N'intervient PAS dans la génération du planning
// ═══════════════════════════════════════════════════════════════

const { prisma } = require('../middleware/tenant');

let _anthropic = null;

function getAnthropicClient() {
  if (_anthropic !== null) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY || process.env.PLANNING_AI_ENABLED === 'false') {
    _anthropic = null;
    return null;
  }
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _anthropic;
  } catch (err) {
    console.warn('[pulseAdapter] SDK indisponible :', err.message);
    _anthropic = null;
    return null;
  }
}

const HAIKU_MODEL = process.env.PLANNING_HAIKU_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS_INTENT = parseInt(process.env.PLANNING_MAX_TOKENS_INTENT, 10) || 512;
const MAX_TOKENS_EXPLAIN = parseInt(process.env.PLANNING_MAX_TOKENS_EXPLAIN, 10) || 300;

const EXTRACT_INTENT_PROMPT = `Tu es un assistant RH expert en droit du travail français et convention CHR.
L'utilisateur est une DRH qui décrit en langage naturel ses besoins pour le planning.
Extrais les contraintes supplémentaires au format JSON strict :
{
  "week": "YYYY-WXX ou null",
  "site": "nom du site ou null",
  "excludeEmployees": [{ "employeeId": "...", "name": "...", "days": ["monday",...] }],
  "priorityCoverage": [{ "day": "...", "shift": "...", "reason": "..." }],
  "forceWorkDays": ["monday","thursday"],
  "minimizeOvertime": true,
  "customRules": ["règle en texte libre"]
}
Pour excludeEmployees : si un prénom/nom est mentionné sans ID, mets-le dans "name".
Réponds UNIQUEMENT avec le JSON, sans commentaire ni markdown.`;

const EXPLAIN_PLANNING_PROMPT = `Tu es Pulse, l'assistant RH de Pulsiia. Tu es direct, professionnel, et bienveillant.
Tu reçois un planning généré automatiquement et tu dois en faire un résumé clair.
Format de ta réponse :
1. Résumé en 1-2 phrases (couverture globale, statut HS)
2. Points d'attention (postes à risque, alertes légales)
3. Suggestions concrètes si des postes sont non couverts
4. Maximum 5 phrases au total — tu es un assistant, pas un rapport
Tu ne génères PAS le planning, tu l'expliques uniquement.`;

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

const EMPTY_INTENT = {
  week: null,
  site: null,
  excludeEmployees: [],
  priorityCoverage: [],
  forceWorkDays: [],
  minimizeOvertime: false,
  customRules: [],
};

const DAY_MAP_FR_EN = {
  lundi: 'monday', mardi: 'tuesday', mercredi: 'wednesday', jeudi: 'thursday',
  vendredi: 'friday', samedi: 'saturday', dimanche: 'sunday',
  lun: 'monday', mar: 'tuesday', mer: 'wednesday', jeu: 'thursday',
  ven: 'friday', sam: 'saturday', dim: 'sunday',
};

function normalizeFr(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Lexique — renforcer la couverture / ajouter du monde sur des jours. */
const ADD_COVERAGE_TERMS = [
  'travail', 'travailler', 'couvr', 'couverture', 'planif', 'besoin', 'faut',
  'ouvert', 'ouvrir', 'equipe', 'personnel', 'gens', 'monde', 'salari', 'employe', 'employ',
  'veux', 'voudrai', 'souhait', 'demand', 'ajout', 'rajout', 'renforc', 'staff', 'staffer',
  'mettre', 'mettez', 'place', 'placer', 'positionn', 'affect', 'assign', 'programm',
  'envoy', 'mobilis', 'doubl', 'tripl', 'remplir', 'combler', 'garantir', 'assurer',
  'maintenir', 'operati', 'present', 'effectif', 'renfort', 'backup', 'boost', 'augment',
  'muscler', 'habiller', 'pourvoir', 'plus de', 'manque de', 'besoin de',
  'il nous faut', 'il faut du', 'il faut des', 'mets du', 'met du', 'mets des', 'met des',
  'fais venir', 'fait venir', 'faire venir', 'recrut', 'dispo sur', 'disponib',
];

/** Lexique — sous-effectif / jour vide. */
const UNDERSTAFFED_TERMS = [
  'personne', 'vide', 'decouvert', 'manque', 'sous-effectif', 'sous effectif',
  'pas assez', 'trop peu', 'insuffisant', 'insuffisante', 'aucun', 'zero',
  'personnel insuffisant', 'equipe reduite', 'creneau vide', 'poste vide',
  'pas de monde', 'pas de gens', 'pas de personnel', 'pas de salarie', 'pas de salari',
  'personne nest la', "personne n'est la", 'nobody', 'understaff',
];

/** Lexique — retirer / repos / supprimer un collaborateur ou un shift. */
const REMOVE_REST_TERMS = [
  'retir', 'supprim', 'enlev', 'oter', 'ote ', 'virer', 'degag', 'liber', 'liberer',
  'repos', 'off', 'evite', 'eviter', 'indispo', 'indisponib', 'exclu', 'deprogram',
  'deplanif', 'annul', 'cancel', 'enlever', 'supprimer', 'ne pas planif', 'pas planif',
  'pas de shift', 'pas de creneau', 'laisser en repos', 'mettre en repos', 'met en repos',
  'mets en repos', 'jour off', 'jour de repos', 'conge', 'libre', 'absent',
  'retire du', 'sortir du planning', 'ote du', 'enleve du', 'supprime du',
  'retire la', 'retire le', 'enleve la', 'enleve le', 'pas dispo', 'non dispo',
  'non disponible', 'ne peut pas', 'impossible', 'debarras', 'clear', 'vide le',
  'desassign', 'desaffect', 'retirer du service', 'sortir du service',
];

function termMatches(lower, terms) {
  return terms.some((term) => lower.includes(term));
}

function employeeMentioned(text, emp) {
  const lower = normalizeFr(text);
  const fn = normalizeFr(emp.firstName || '');
  const ln = normalizeFr(emp.lastName || '');
  if (!fn && !ln) return false;
  return (fn && lower.includes(fn)) || (ln && lower.includes(ln));
}

/** « Supprimer les repos du samedi » → renforcer la couverture ce jour-là. */
function signalsCancelRestDay(text) {
  const lower = normalizeFr(text);
  return /(?:supprim|enlev|retir|annul|oter|enlever|ote).{0,45}repos/.test(lower)
    || /repos.{0,20}(?:supprim|enlev|retir|annul|oter)/.test(lower);
}

function signalsUnderstaffed(text) {
  return termMatches(normalizeFr(text), UNDERSTAFFED_TERMS);
}

function signalsAddCoverage(text) {
  const lower = normalizeFr(text);
  if (signalsCancelRestDay(text)) return true;

  // « Mettre en repos » prime sur le verbe « mettre » seul
  if (/met(?:tre|tez|s)?\s+(?:\w+\s+)?en\s+repos|laisser\s+en\s+repos|jour\s+de\s+repos/.test(lower)) {
    return termMatches(lower, ['ajout', 'rajout', 'renforc', 'couvr', 'plus de', 'gens', 'monde', 'effectif', 'besoin']);
  }

  if (parseDayRange(text).length) {
    return termMatches(lower, ADD_COVERAGE_TERMS)
      || /du\s+\w+\s+au\s+\w+/.test(lower);
  }
  return termMatches(lower, ADD_COVERAGE_TERMS);
}

function signalsRemoveOrRest(text) {
  return termMatches(normalizeFr(text), REMOVE_REST_TERMS);
}

function parseDaysFromText(text) {
  const lower = normalizeFr(text);
  const days = [];
  for (const [fr, en] of Object.entries(DAY_MAP_FR_EN)) {
    if (lower.includes(fr)) days.push(en);
  }
  return [...new Set(days)];
}

function parseDayRange(text) {
  const lower = normalizeFr(text);
  const dayToken = '(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|lun|mar|mer|jeu|ven|sam|dim)';
  const rangePatterns = [
    new RegExp(`du\\s+${dayToken}\\s+au\\s+${dayToken}`),
    new RegExp(`de\\s+${dayToken}\\s+(?:au|a|jusqu['']?au)\\s+${dayToken}`),
    new RegExp(`${dayToken}\\s*(?:-|–|—|→|au|jusqu['']?au|\\ba\\b)\\s*${dayToken}`),
  ];
  const order = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  for (const re of rangePatterns) {
    const rangeMatch = lower.match(re);
    if (!rangeMatch) continue;
    const start = DAY_MAP_FR_EN[rangeMatch[1]];
    const end = DAY_MAP_FR_EN[rangeMatch[2]];
    if (!start || !end) continue;
    const si = order.indexOf(start);
    const ei = order.indexOf(end);
    if (si < 0 || ei < 0) continue;
    if (si <= ei) return order.slice(si, ei + 1);
    return [...order.slice(si), ...order.slice(0, ei + 1)];
  }
  return [];
}

/** Jours où l'équipe doit travailler (demande DRH). */
function parseForceWorkDays(text) {
  const understaffed = signalsUnderstaffed(text);
  const wantsWork = signalsAddCoverage(text) || understaffed;

  if (!wantsWork) return [];

  const range = parseDayRange(text);
  if (range.length) return range;

  const days = parseDaysFromText(text);
  if (!days.length) return [];

  const wantsRest = signalsRemoveOrRest(text)
    && !signalsAddCoverage(text)
    && !understaffed
    && !signalsCancelRestDay(text);
  if (wantsRest) return [];

  return days;
}

/** Exclut un ou plusieurs collaborateurs nommés sur certains jours. */
function parseExcludeEmployeesFromText(text, employees) {
  if (!signalsRemoveOrRest(text)) return [];

  const results = [];
  for (const emp of employees || []) {
    if (!employeeMentioned(text, emp)) continue;
    const days = parseDaysFromText(text);
    if (!days.length) continue;
    results.push({
      employeeId: emp.id,
      name: `${emp.firstName} ${emp.lastName}`,
      days,
    });
  }
  return results;
}

/** Heuristique locale si Haiku indisponible. */
function heuristicExtractIntent(text, employees) {
  const lower = normalizeFr(text);
  const intent = { ...EMPTY_INTENT, excludeEmployees: [], customRules: [], forceWorkDays: [] };

  if (/minimis.*heures?\s*sup|pas d'?heures?\s*sup|eviter.*hs|redui.*heures?\s*sup|limiter.*hs/.test(lower)) {
    intent.minimizeOvertime = true;
  }

  intent.forceWorkDays = parseForceWorkDays(text);
  intent.excludeEmployees = parseExcludeEmployeesFromText(text, employees);

  if (/vendredi\s+soir|couvre.*vendredi|service.*vendredi|soir.*vendredi|aprem.*vendredi|apres.?midi.*vendredi/.test(lower)) {
    intent.priorityCoverage.push({ day: 'friday', shift: 'aprem', reason: 'Demande DRH — vendredi soir' });
  }
  if (/samedi\s+matin|matin.*samedi|matinee.*samedi/.test(lower)) {
    intent.priorityCoverage.push({ day: 'saturday', shift: 'matin', reason: 'Demande DRH — samedi matin' });
  }
  if (/samedi\s+soir|soir.*samedi|aprem.*samedi|apres.?midi.*samedi/.test(lower)) {
    intent.priorityCoverage.push({ day: 'saturday', shift: 'aprem', reason: 'Demande DRH — samedi après-midi' });
  }

  if (text?.trim()) intent.customRules.push(String(text).trim().slice(0, 200));
  return intent;
}

async function logHaikuUsage(action, usage, metadata) {
  if (!usage) return;
  try {
    await prisma.auditLog.create({
      data: {
        action: `planning_haiku.${action}`,
        metadata: {
          model: HAIKU_MODEL,
          input_tokens: usage.input_tokens ?? usage.inputTokens,
          output_tokens: usage.output_tokens ?? usage.outputTokens,
          ...metadata,
        },
      },
    });
  } catch (err) {
    console.warn('[pulseAdapter] audit log:', err.message);
  }
}

/**
 * Extrait les intentions depuis un prompt naturel (Couche 3 — entrée).
 */
async function extractIntent(naturalLanguageInput, employees = []) {
  const client = getAnthropicClient();
  if (!client) {
    return { intent: heuristicExtractIntent(naturalLanguageInput, employees), usedAi: false, usage: null };
  }

  try {
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: MAX_TOKENS_INTENT,
      system: EXTRACT_INTENT_PROMPT,
      messages: [{ role: 'user', content: naturalLanguageInput }],
    });

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const heuristic = heuristicExtractIntent(naturalLanguageInput, employees);
    const parsed = safeJsonParse(text);
    const intent = parsed
      ? {
        ...EMPTY_INTENT,
        ...parsed,
        forceWorkDays: [...new Set([
          ...(parsed.forceWorkDays || []),
          ...(heuristic.forceWorkDays || []),
        ])],
        priorityCoverage: [
          ...(parsed.priorityCoverage || []),
          ...(heuristic.priorityCoverage || []),
        ],
        excludeEmployees: [
          ...(parsed.excludeEmployees || []),
          ...(heuristic.excludeEmployees || []),
        ],
      }
      : heuristic;
    await logHaikuUsage('extractIntent', response.usage, { inputLength: naturalLanguageInput?.length });

    return { intent, usedAi: true, usage: response.usage };
  } catch (err) {
    console.warn('[pulseAdapter] extractIntent fallback:', err.message);
    return {
      intent: heuristicExtractIntent(naturalLanguageInput, employees),
      usedAi: false,
      usage: null,
      error: err.message,
    };
  }
}

function buildFallbackExplanation(planningResult, originalRequest) {
  const stats = planningResult.stats || {};
  const alerts = planningResult.alerts || [];
  const uncovered = alerts.filter((a) => a.type === 'UNCOVERED_SLOT').length;
  const coverage = stats.coverageRate ?? 100;
  const hs = stats.totalOvertimeHours ?? 0;

  let text = `Planning généré — couverture ${coverage}%`;
  if (hs > 0) text += `, ${hs}h supplémentaires estimées`;
  text += '.';
  if (uncovered) text += ` ${uncovered} poste(s) non couvert(s) — vérifiez les disponibilités.`;
  if (originalRequest) text += ` (Demande : « ${String(originalRequest).slice(0, 80)} »)`;
  return text;
}

/**
 * Explique le planning généré en langage naturel (Couche 3 — sortie).
 */
async function explainPlanning(planningResult, originalRequest) {
  const client = getAnthropicClient();
  const fallback = buildFallbackExplanation(planningResult, originalRequest);

  if (!client) return { explanation: fallback, usedAi: false, usage: null };

  try {
    const context = JSON.stringify({
      stats: planningResult.stats,
      alerts: (planningResult.alerts || []).slice(0, 15),
      valid: planningResult.valid,
      originalRequest: originalRequest || null,
      shiftCount: planningResult.planning?.shifts?.filter((s) => s.type !== 'OFF' && s.type !== 'ABSENT').length,
    });

    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: MAX_TOKENS_EXPLAIN,
      system: EXPLAIN_PLANNING_PROMPT,
      messages: [{ role: 'user', content: context }],
    });

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    await logHaikuUsage('explainPlanning', response.usage, {});

    return { explanation: text || fallback, usedAi: true, usage: response.usage };
  } catch (err) {
    console.warn('[pulseAdapter] explainPlanning fallback:', err.message);
    return { explanation: fallback, usedAi: false, usage: null, error: err.message };
  }
}

function isHaikuAvailable() {
  return Boolean(getAnthropicClient());
}

module.exports = {
  extractIntent,
  explainPlanning,
  heuristicExtractIntent,
  parseForceWorkDays,
  parseExcludeEmployeesFromText,
  parseDaysFromText,
  signalsAddCoverage,
  signalsRemoveOrRest,
  signalsUnderstaffed,
  isHaikuAvailable,
  HAIKU_MODEL,
  EXTRACT_INTENT_PROMPT,
  EXPLAIN_PLANNING_PROMPT,
};
