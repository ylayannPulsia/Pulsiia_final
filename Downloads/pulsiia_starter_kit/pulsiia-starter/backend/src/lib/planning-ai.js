// ═══════════════════════════════════════════════════════════════
// PULSIIA — Moteur Planning Hybride
// Couche 1+2 : contraintes légales + optimiseur local
// Couche 3 : Claude Haiku (extraction intentions + explication uniquement)
// ═══════════════════════════════════════════════════════════════

const { addDays, startOfDay, endOfDay, format, differenceInHours } = require('date-fns');
const { prisma, withCompany } = require('../middleware/tenant');
const { orchestrate, planningResultToAiPayload } = require('../planning/planningOrchestrator');
const { isHaikuAvailable, HAIKU_MODEL } = require('../planning/pulseAdapter');
const {
  DEFAULT_PLANNING_RULES,
  planningRulesFromCompany,
  shiftDefaultsFromRules,
} = require('./labor-contract');
const {
  shiftNetMinutes,
  applyBreakToShift,
  enrichShiftsWithBreaks,
  sortShiftsChronologically,
  dailyNetMinutesForEmployee,
} = require('../planning/planningShiftBreaks');

// SDK Anthropic chargé en lazy pour ne pas casser le boot si non installé.
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
    console.warn('[planning-ai] @anthropic-ai/sdk indisponible :', err.message);
    _anthropic = null;
    return null;
  }
}

const AI_MODEL = HAIKU_MODEL;
const AI_MODEL_OPTIMIZE = process.env.ANTHROPIC_MODEL_OPTIMIZE || AI_MODEL;
const PLANNING_MODE = 'hybrid';
// Sonnet a besoin de plus de tokens (~4k) ; Haiku se contente de 3k
const AI_MAX_TOKENS = AI_MODEL.includes('sonnet') ? 4096 : 3072;
const AI_MAX_TOKENS_OPTIMIZE = 1500;
const PREVIOUS_SHIFTS_CONTEXT = 14; // 1 personne × 7 j × 2 max → suffisant pour le repos légal

const SHIFT_DEFAULTS = shiftDefaultsFromRules(DEFAULT_PLANNING_RULES);

function normalizeCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function allowDemoFallback(company) {
  const normalized = normalizeCompanyName(company?.name);
  return normalized === 'saveurs-co' || normalized === 'groupe-saveurs-co';
}

function pulseUnavailableError() {
  const err = new Error("Pulse n'est pas disponible pour cette entreprise tant que l'API Anthropic n'est pas configurée.");
  err.status = 503;
  return err;
}

// ── Helpers ────────────────────────────────────────────────────

function parseWeekStart(value) {
  if (value instanceof Date) {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const d = new Date(`${value.slice(0, 10)}T00:00:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error('weekStart invalide (attendu : Date ou YYYY-MM-DD).');
}

function fmtDate(d) {
  return format(d, 'yyyy-MM-dd');
}

function deriveDepartment(user) {
  const pole = (user.secondaryRoles && user.secondaryRoles[0]) || '';
  if (pole) return pole;
  const j = (user.jobTitle || '').toLowerCase();
  if (j.includes('cuisin') || j.includes('chef') || j.includes('pâtiss')) return 'Cuisine';
  if (j.includes('serve') || j.includes('sommelier') || j.includes('barman')) return 'Service';
  if (j.includes('accueil') || j.includes('hôte')) return 'Accueil';
  if (j.includes('plong')) return 'Plonge';
  if (j.includes('directeur') || j.includes('rh') || user.role === 'DRH' || user.role === 'RH') return 'Direction';
  return 'Service';
}

function planningRulesForCompany(company) {
  const rules = planningRulesFromCompany(company);
  return { ...rules, targetWeeklyHours: rules.legalWeeklyHours ?? rules.targetWeeklyHours ?? 35 };
}

function shiftDefaultsForCompany(company) {
  return shiftDefaultsFromRules(planningRulesForCompany(company));
}

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

function shiftHours(startTime, endTime, breakMin, breakStart, breakEnd, type) {
  return shiftNetMinutes({
    type: type || 'JOURNEE',
    startTime,
    endTime,
    breakMin,
    breakStart,
    breakEnd,
  }) / 60;
}

const WEEKDAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const DAY_KEYS_EN = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function forceWorkDatesSet(forceWorkDays, weekStart) {
  const set = new Set();
  for (const key of forceWorkDays || []) {
    const idx = DAY_KEYS_EN.indexOf(key);
    if (idx >= 0) set.add(fmtDate(addDays(weekStart, idx)));
  }
  return set;
}

function preferNonForcedDay(a, b, forcedDates) {
  const aForced = forcedDates.has(a.date) ? 1 : 0;
  const bForced = forcedDates.has(b.date) ? 1 : 0;
  if (aForced !== bForced) return aForced - bForced;
  return b.date.localeCompare(a.date);
}

/** Jours (0=lun … 6=dim) où le salarié est indisponible selon le texte saisi. */
function parseUnavailableDayIndices(constraintText) {
  const text = String(constraintText || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  if (!text) return new Set();

  const mentionsDay = WEEKDAY_NAMES.some((d) => text.includes(d));
  const hasReposOff = /\b(?:repos|off)\b/.test(text);
  const hasUnavailability = /(?:pas\s+(?:dispo|disponible)|indisponible|non\s+(?:dispo|disponible)|ne\s+peut\s+pas|impossible)/.test(text);
  const hasEqualsRepos = /=\s*(?:repos|off)\b/.test(text);
  const hasReposOnDays = mentionsDay && (hasReposOff || hasEqualsRepos);
  const hasClassicReposPhrase = /(?:repos|off)\s+(?:le|les|l')/.test(text);

  const hasIntent = hasUnavailability || hasReposOnDays || hasClassicReposPhrase;
  if (!hasIntent) return new Set();

  const off = new Set();
  const rangeMatch = text.match(
    /du\s+(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+au\s+(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)/,
  );
  if (rangeMatch) {
    const start = WEEKDAY_NAMES.indexOf(rangeMatch[1]);
    const end = WEEKDAY_NAMES.indexOf(rangeMatch[2]);
    if (start >= 0 && end >= 0) {
      if (start <= end) {
        for (let d = start; d <= end; d++) off.add(d);
      } else {
        for (let d = start; d < 7; d++) off.add(d);
        for (let d = 0; d <= end; d++) off.add(d);
      }
      return off;
    }
  }

  for (let i = 0; i < WEEKDAY_NAMES.length; i++) {
    if (text.includes(WEEKDAY_NAMES[i])) off.add(i);
  }

  // "jeudi, vendredi" ou "jeu ven" (abréviations isolées)
  if (!off.size && mentionsDay) {
    const abbrev = [
      [/\blun\b/, 0], [/\bmar\b/, 1], [/\bmer\b/, 2], [/\bjeu\b/, 3],
      [/\bven\b/, 4], [/\bsam\b/, 5], [/\bdim\b/, 6],
    ];
    for (const [re, idx] of abbrev) {
      if (re.test(text)) off.add(idx);
    }
  }

  return off;
}

/** Force OFF/ABSENT sur les jours interdits — appliqué après IA ou heuristique. */
function enforcePlanningConstraints(aiPayload, context) {
  if (!aiPayload?.shifts || !context?.users?.length) return aiPayload;

  const shifts = [...aiPayload.shifts];

  for (const user of context.users) {
    const offDays = parseUnavailableDayIndices(user.planningConstraint);
    if (!offDays.size) continue;

    for (const dayIdx of offDays) {
      const date = fmtDate(addDays(context.weekStart, dayIdx));

      const isAbsent = (user.absences || []).some((a) => {
        const start = fmtDate(a.startDate);
        const end = fmtDate(a.endDate);
        return date >= start && date <= end;
      });
      const type = isAbsent ? 'ABSENT' : 'OFF';
      const patch = {
        employeeId: user.id,
        date,
        startTime: null,
        endTime: null,
        breakStart: null,
        breakEnd: null,
        breakMin: null,
        type,
        aiConfidence: 0.95,
        notes: 'Contrainte individuelle (indisponibilité)',
      };

      for (let i = shifts.length - 1; i >= 0; i--) {
        if (shifts[i].employeeId === user.id && shifts[i].date === date) {
          shifts.splice(i, 1);
        }
      }
      shifts.push(patch);
    }
  }

  return { ...aiPayload, shifts };
}

// ── Construction du contexte de planning ──────────────────────

async function buildPlanningContext(companyId, siteId, weekStart, options = {}) {
  const start = startOfDay(weekStart);
  const end = endOfDay(addDays(start, 6));
  const previousWeekStart = addDays(start, -7);
  const previousWeekEnd = endOfDay(addDays(start, -1));

  const [site, users, previousShifts, absences, recentWellbeing] = await Promise.all([
    prisma.site.findFirst({
      where: { id: siteId, companyId, isActive: true },
      include: { company: { select: { id: true, name: true, convention: true, settings: true } } },
    }),
    prisma.user.findMany({
      where: withCompany(companyId, { siteId, isActive: true }),
      select: {
        id: true,
        firstName: true,
        lastName: true,
        role: true,
        jobTitle: true,
        contractType: true,
        weeklyHours: true,
        competences: true,
        secondaryRoles: true,
        avatarColor: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    }),
    prisma.shift.findMany({
      where: withCompany(companyId, {
        siteId,
        date: { gte: previousWeekStart, lte: previousWeekEnd },
      }),
      select: { userId: true, date: true, type: true, startTime: true, endTime: true },
      orderBy: { date: 'asc' },
    }),
    prisma.absence.findMany({
      where: withCompany(companyId, {
        startDate: { lte: end },
        endDate: { gte: start },
        status: { in: ['APPROUVE', 'EN_ATTENTE'] },
      }),
      select: { userId: true, type: true, startDate: true, endDate: true, status: true },
    }),
    prisma.surveyResponse.findMany({
      where: {
        createdAt: { gte: addDays(new Date(), -21) },
        user: { companyId, siteId },
      },
      select: {
        userId: true,
        answers: { select: { score: true }, where: { score: { not: null } } },
      },
      take: 200,
    }),
  ]);

  if (!site) {
    const err = new Error('Site introuvable.');
    err.status = 404;
    throw err;
  }

  // Score bien-être moyen par utilisateur sur 21 jours glissants
  const wellbeingScores = {};
  for (const resp of recentWellbeing) {
    if (!resp.answers.length) continue;
    const avg = resp.answers.reduce((acc, a) => acc + (a.score || 0), 0) / resp.answers.length;
    if (!wellbeingScores[resp.userId]) wellbeingScores[resp.userId] = [];
    wellbeingScores[resp.userId].push(avg);
  }
  const wellbeingByUser = {};
  for (const [userId, scores] of Object.entries(wellbeingScores)) {
    wellbeingByUser[userId] = +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2);
  }

  // Absences indexées par userId
  const absencesByUser = {};
  for (const abs of absences) {
    if (!absencesByUser[abs.userId]) absencesByUser[abs.userId] = [];
    absencesByUser[abs.userId].push(abs);
  }

  const allowedUserIds = Array.isArray(options.selectedUserIds) && options.selectedUserIds.length
    ? new Set(options.selectedUserIds)
    : null;
  const filteredUsers = allowedUserIds
    ? users.filter((u) => allowedUserIds.has(u.id))
    : users;

  if (allowedUserIds && !filteredUsers.length) {
    const err = new Error('Aucun collaborateur valide sélectionné pour ce site.');
    err.status = 400;
    throw err;
  }

  const constraintsByUser = {};
  for (const item of options.userConstraints || []) {
    if (!item?.userId || !item?.text) continue;
    constraintsByUser[item.userId] = String(item.text).trim();
  }

  return {
    site,
    company: site.company,
    users: filteredUsers.map((u) => ({
      ...u,
      department: deriveDepartment(u),
      wellbeingScore: wellbeingByUser[u.id] ?? null,
      absences: absencesByUser[u.id] || [],
      planningConstraint: constraintsByUser[u.id] || null,
    })),
    previousShifts,
    weekStart: start,
    weekEnd: end,
    planningRules: planningRulesForCompany(site.company),
  };
}

// ── Génération IA via Claude ──────────────────────────────────

function buildPrompt(context) {
  const { users, previousShifts, weekStart, planningRules, company } = context;

  const employeesData = users.map((u) => ({
    id: u.id,
    name: `${u.firstName} ${u.lastName}`,
    role: u.department,
    jobTitle: u.jobTitle || '',
    contract: u.contractType,
    weeklyHours: u.weeklyHours || 35,
    skills: u.competences || [],
    wellbeingScore: u.wellbeingScore,
    absences: u.absences.map((a) => ({
      from: fmtDate(a.startDate),
      to: fmtDate(a.endDate),
      type: a.type,
      status: a.status,
    })),
    planningConstraint: u.planningConstraint || null,
  }));

  // On garde uniquement les shifts des 2 derniers jours de la semaine précédente
  // (vendredi/samedi/dimanche) — c'est tout ce qui matter pour les 11h de repos légal.
  const lastDaysOnly = previousShifts
    .filter((s) => s.type !== 'OFF' && s.type !== 'ABSENT')
    .slice(-PREVIOUS_SHIFTS_CONTEXT);
  const compactPreviousShifts = lastDaysOnly.map((s) => ({
    userId: s.userId,
    date: fmtDate(s.date),
    type: s.type,
    end: s.endTime,
  }));

  // Le contexte « variable » seulement — les règles + schéma sont dans le system cacheable.
  return `Site : ${context.site.name}
Semaine du ${fmtDate(weekStart)} au ${fmtDate(addDays(weekStart, 6))}

Équipe (${users.length} personne(s)) :
${JSON.stringify(employeesData)}

Contraintes saisies manuellement (prioritaires) :
${JSON.stringify(users.filter((u) => u.planningConstraint).map((u) => ({
  userId: u.id,
  name: `${u.firstName} ${u.lastName}`,
  constraint: u.planningConstraint,
})))}

Règles opérationnelles du site :
${JSON.stringify(planningRules)}

Fin de la semaine précédente (pour respecter le repos de 11 h) :
${JSON.stringify(compactPreviousShifts)}

Génère le planning JSON.`;
}

// System prompt fixe — éligible au prompt caching d'Anthropic (-90% sur ces tokens).
// Les variables dynamiques (équipe, semaine, etc.) restent dans le message user.
const SYSTEM_PROMPT_STATIC = `Tu es un expert en planification RH pour des entreprises CHR (Hôtels, Cafés, Restaurants, secteur Santé) en France.
Tu génères des plannings hebdomadaires optimisés respectant :
- Le Code du travail français (repos minimum 11 h entre 2 shifts, temps de travail max 10 h/jour, 48 h/semaine)
- La continuité de service et les besoins opérationnels
- Les contraintes individuelles des salariés (heures contractuelles, absences, score bien-être)

RÈGLES STRICTES POUR LA RÉPONSE :
1. Tu réponds UNIQUEMENT en JSON valide, sans texte avant ou après, sans markdown.
2. Tu utilises EXCLUSIVEMENT ces valeurs de "type" : MATIN | APREM | NUIT | JOURNEE | OFF | ABSENT
3. Tu places les jours non travaillés en "OFF" (jamais omettre un jour).
4. Tu vises le quota d'heures hebdo contractuel de chaque salarié (±10 %).
5. Si le score bien-être est < 5/10, tu évites les shifts NUIT et limites à 8 h/jour.
6. Les champs planningConstraint sont OBLIGATOIRES : jours « pas dispo », repos, indisponibilité → type OFF (ou ABSENT si absence déjà connue), jamais de shift travaillé ce jour-là.
7. COUPURES : tu peux créer plusieurs entrées shifts le même jour pour un même employeeId (ex. 11:00–15:00 puis 18:00–22:00) — type JOURNEE avec startTime/endTime distincts.
8. PAUSES : pour tout créneau ≥ 6 h, indique breakStart/breakEnd (ex. 12:00–12:30) ou breakMin (ex. 30). Déduis la pause de la durée travaillée.

SCHÉMA DE SORTIE OBLIGATOIRE :
{
  "shifts": [{ "employeeId": "string", "date": "YYYY-MM-DD", "startTime": "HH:MM|null", "endTime": "HH:MM|null", "breakStart": "HH:MM|null", "breakEnd": "HH:MM|null", "breakMin": number|null, "type": "MATIN|APREM|NUIT|JOURNEE|OFF|ABSENT", "aiConfidence": 0.0, "notes": "string|null" }],
  "suggestions": ["conseils RH actionnables"],
  "warnings": ["alertes légales ou opérationnelles"],
  "coverageAnalysis": { "understaffedSlots": [], "overstaffedSlots": [], "criticalGaps": [] },
  "summary": "résumé exécutif en 2 phrases"
}`;

async function callClaude(context) {
  const client = getAnthropicClient();
  if (!client) return null;

  const prompt = buildPrompt(context);

  // Prompt caching : on déclare le system prompt comme cachable (ephemeral 5 min).
  // -> Économie ~90% sur ces tokens dès la 2e génération dans la fenêtre.
  const response = await client.messages.create({
    model: AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    system: [
      { type: 'text', text: SYSTEM_PROMPT_STATIC, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `Convention collective applicable : ${context.company?.convention || 'CHR'}.` },
    ],
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const parsed = safeJsonParse(text);
  if (!parsed || !Array.isArray(parsed.shifts)) {
    throw new Error('Réponse IA invalide ou non parsable.');
  }
  return {
    parsed,
    model: response.model || AI_MODEL,
    usage: response.usage || null,
  };
}

// ── Génération heuristique locale (fallback démo) ─────────────

function heuristicGenerate(context) {
  const { users, weekStart, planningRules } = context;
  const shifts = [];
  const suggestions = [];
  const warnings = [];

  const shiftTimes = shiftDefaultsFromRules(planningRules);
  const templates = planningRules?.shiftTemplates || {};

  // Distribution simple : alternance matin/aprem selon le département + 2 repos / semaine
  for (const user of users) {
    const dept = user.department;
    const wellbeing = user.wellbeingScore;
    let canNight = (templates.NUIT?.enabled !== false) && (dept === 'Cuisine' || dept === 'Service');

    // Repos jeudi+dimanche par défaut ; collaborateurs Cuisine repos lundi+jeudi
    const restDays = dept === 'Cuisine' ? [0, 3] : [3, 6];

    const unavailableDays = parseUnavailableDayIndices(user.planningConstraint);
    for (let i = 0; i < 7; i++) {
      const date = fmtDate(addDays(weekStart, i));

      const isAbsent = (user.absences || []).some((a) => {
        const start = fmtDate(a.startDate);
        const end = fmtDate(a.endDate);
        return date >= start && date <= end;
      });

      if (isAbsent) {
        shifts.push({ employeeId: user.id, date, startTime: null, endTime: null, type: 'ABSENT', aiConfidence: 0.95 });
        continue;
      }

      if (unavailableDays.has(i)) {
        shifts.push({
          employeeId: user.id,
          date,
          startTime: null,
          endTime: null,
          type: 'OFF',
          aiConfidence: 0.95,
          notes: 'Contrainte individuelle appliquée',
        });
        continue;
      }

      if (restDays.includes(i)) {
        shifts.push({ employeeId: user.id, date, startTime: null, endTime: null, type: 'OFF', aiConfidence: 0.9 });
        continue;
      }

      let type;
      if (dept === 'Cuisine') {
        type = i % 2 === 0 ? 'MATIN' : 'APREM';
      } else if (dept === 'Service') {
        type = i % 2 === 0 ? 'APREM' : 'MATIN';
      } else if (dept === 'Accueil') {
        type = 'JOURNEE';
      } else {
        type = 'JOURNEE';
      }

      // Bien-être bas → éviter nuit
      if (wellbeing != null && wellbeing < 5 && type === 'NUIT') type = 'APREM';
      if (!canNight && type === 'NUIT') type = 'APREM';
      if (templates[type]?.enabled === false) {
        type = type === 'NUIT' ? 'APREM' : 'MATIN';
      }

      const times = shiftTimes[type] || shiftTimes.MATIN || { start: '09:00', end: '17:00' };
      shifts.push(applyBreakToShift({
        employeeId: user.id,
        date,
        startTime: times.start,
        endTime: times.end,
        type,
        aiConfidence: 0.78,
        notes: wellbeing != null && wellbeing < 5 ? 'Charge allégée (bien-être bas)' : undefined,
      }, planningRules));
    }

    if (wellbeing != null && wellbeing < 5) {
      suggestions.push(`${user.firstName} ${user.lastName} : score bien-être ${wellbeing}/10 — limiter les soirées.`);
    }
    if (unavailableDays.size) {
      const daysLabel = [...unavailableDays].map((d) => WEEKDAY_NAMES[d]).join(', ');
      suggestions.push(`${user.firstName} ${user.lastName} : indisponibilité appliquée (${daysLabel}).`);
    }
  }

  const enforced = enforcePlanningConstraints({
    shifts,
    suggestions,
    warnings,
    coverageAnalysis: null,
    summary: null,
  }, { users, weekStart });
  return finalizeHeuristicPayload(enforced, { users, weekStart });
}

function finalizeHeuristicPayload(raw, context) {
  const { users, weekStart } = context;
  const shifts = raw.shifts || [];
  const suggestions = raw.suggestions || [];
  const warnings = raw.warnings || [];

  // Couverture matin/aprem
  const coverage = { understaffedSlots: [], overstaffedSlots: [], criticalGaps: [] };
  for (let i = 0; i < 7; i++) {
    const date = fmtDate(addDays(weekStart, i));
    const matin = shifts.filter((s) => s.date === date && s.type === 'MATIN').length;
    const aprem = shifts.filter((s) => s.date === date && s.type === 'APREM').length;
    if (matin < 2) coverage.understaffedSlots.push(`${date} matin : ${matin} pers.`);
    if (aprem < 2) coverage.understaffedSlots.push(`${date} après-midi : ${aprem} pers.`);
  }

  const workCount = shifts.filter((s) => s.type !== 'OFF' && s.type !== 'ABSENT').length;
  return {
    shifts,
    suggestions,
    warnings,
    coverageAnalysis: coverage,
    summary: `Planning généré localement (heuristique) — ${workCount} shifts répartis sur ${users.length} collaborateurs.`,
  };
}

// ── Détection de conflits légaux ──────────────────────────────

function detectConflicts(aiShifts, context) {
  const conflicts = [];
  const { users } = context;
  const userById = new Map(users.map((u) => [u.id, u]));

  const byUser = {};
  for (const s of aiShifts) {
    if (!byUser[s.employeeId]) byUser[s.employeeId] = [];
    byUser[s.employeeId].push(s);
  }

  for (const [userId, list] of Object.entries(byUser)) {
    const user = userById.get(userId);
    if (!user) continue;
    const fullName = `${user.firstName} ${user.lastName}`;
    const workShifts = list
      .filter((s) => s.type !== 'OFF' && s.type !== 'ABSENT')
      .sort((a, b) => (a.date + (a.startTime || '00:00')).localeCompare(b.date + (b.startTime || '00:00')));

    const offDays = parseUnavailableDayIndices(user.planningConstraint);
    for (const s of workShifts) {
      for (let i = 0; i < 7; i++) {
        if (!offDays.has(i)) continue;
        const expected = fmtDate(addDays(context.weekStart, i));
        if (s.date === expected) {
          conflicts.push({
            type: 'CONSTRAINT_VIOLATION',
            severity: 'error',
            userId,
            employeeName: fullName,
            date: s.date,
            message: `${fullName} : shift planifié le ${WEEKDAY_NAMES[i]} alors que la contrainte impose le repos.`,
          });
        }
      }
    }

    // 1) Chevauchement avec une absence approuvée
    for (const s of workShifts) {
      const absent = (user.absences || []).some((a) => {
        const date = s.date;
        return date >= fmtDate(a.startDate) && date <= fmtDate(a.endDate);
      });
      if (absent) {
        conflicts.push({
          type: 'ABSENCE_OVERLAP',
          severity: 'error',
          userId,
          employeeName: fullName,
          date: s.date,
          message: `${fullName} est en absence le ${s.date}.`,
        });
      }
    }

    // 2) Repos < 11h
    for (let i = 0; i < workShifts.length - 1; i++) {
      const cur = workShifts[i];
      const nxt = workShifts[i + 1];
      if (!cur.endTime || !nxt.startTime) continue;
      const curEnd = new Date(`${cur.date}T${cur.endTime}:00`);
      const nxtStart = new Date(`${nxt.date}T${nxt.startTime}:00`);
      const restH = differenceInHours(nxtStart, curEnd);
      if (restH < 11 && restH > 0) {
        conflicts.push({
          type: 'INSUFFICIENT_REST',
          severity: 'error',
          userId,
          employeeName: fullName,
          date: nxt.date,
          message: `Repos insuffisant (${restH}h < 11h légales) entre ${cur.date} ${cur.endTime} et ${nxt.date} ${nxt.startTime}.`,
        });
      }
    }

    // 3) Heures hebdo
    const totalHours = workShifts.reduce((acc, s) => acc + shiftHours(s.startTime, s.endTime), 0);
    if (totalHours > 48) {
      conflicts.push({
        type: 'WEEKLY_HOURS_EXCEEDED',
        severity: 'warning',
        userId,
        employeeName: fullName,
        message: `${fullName} : ${totalHours.toFixed(1)}h planifiées (max légal 48h).`,
      });
    }

    // 4) 6 jours consécutifs
    let consecutive = 0;
    for (const s of list.sort((a, b) => a.date.localeCompare(b.date))) {
      if (s.type === 'OFF' || s.type === 'ABSENT') consecutive = 0;
      else consecutive += 1;
      if (consecutive > 6) {
        conflicts.push({
          type: 'TOO_MANY_CONSECUTIVE_DAYS',
          severity: 'warning',
          userId,
          employeeName: fullName,
          date: s.date,
          message: `${fullName} : plus de 6 jours consécutifs travaillés.`,
        });
        break;
      }
    }
  }

  return conflicts;
}

function isAnthropicApiError(err) {
  const msg = String(err?.message || err?.error?.message || err || '');
  return /usage limits|rate_limit|overloaded|quota|invalid_request_error/i.test(msg);
}

function anthropicFallbackNote(err) {
  if (!isAnthropicApiError(err)) return '';
  return '\n\n_(Quota API Anthropic atteint — mode local activé.)_';
}

/** Détecte une demande de conformité légale / refonte du brouillon. */
function wantsLegalCompliance(message) {
  const t = String(message || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return /legal|legale|conflit|code du travail|repos minimum|11\s*h|48\s*h|conforme|conformite|refaire|contraintes/.test(t);
}

function ensureFullWeekShifts(shifts, context) {
  const workShifts = (shifts || []).filter((s) => s.type !== 'OFF' && s.type !== 'ABSENT');
  const out = [...workShifts];
  const hasDayEntry = new Set(out.map((s) => `${s.employeeId}|${s.date}`));

  for (const user of context.users) {
    for (let i = 0; i < 7; i++) {
      const date = fmtDate(addDays(context.weekStart, i));
      const key = `${user.id}|${date}`;
      if (hasDayEntry.has(key)) continue;
      out.push({
        employeeId: user.id,
        date,
        type: 'OFF',
        startTime: null,
        endTime: null,
        breakStart: null,
        breakEnd: null,
        breakMin: null,
        aiConfidence: 0.85,
      });
      hasDayEntry.add(key);
    }
  }
  return out;
}

/** Corrige repos 11h, heures hebdo max, jours consécutifs et journée > 10h. */
function enforceLegalCompliance(shifts, context) {
  const rules = context.planningRules || DEFAULT_PLANNING_RULES;
  const minRest = rules.minRestBetweenShifts ?? 11;
  const maxWeekly = rules.maxWeeklyHours ?? 48;
  const maxConsecutive = rules.maxConsecutiveDays ?? 6;
  const maxDailyHours = 10;
  const forcedDates = forceWorkDatesSet(context.forceWorkDays, context.weekStart);

  let list = ensureFullWeekShifts(shifts, context);
  const fixes = [];
  const userById = new Map(context.users.map((u) => [u.id, u]));

  const setOff = (userId, date, reason, shiftRef = null) => {
    if (shiftRef) {
      const idx = list.findIndex((s) => s === shiftRef || (
        s.employeeId === userId && s.date === date
        && s.startTime === shiftRef.startTime && s.endTime === shiftRef.endTime
      ));
      if (idx < 0 || list[idx].type === 'ABSENT' || list[idx].type === 'OFF') return false;
      list[idx] = {
        ...list[idx],
        type: 'OFF',
        startTime: null,
        endTime: null,
        breakStart: null,
        breakEnd: null,
        breakMin: null,
        notes: reason,
        aiConfidence: 0.9,
      };
    } else {
      let changed = false;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].employeeId === userId && list[i].date === date && list[i].type !== 'ABSENT' && list[i].type !== 'OFF') {
          list.splice(i, 1);
          changed = true;
        }
      }
      if (!changed) return false;
      list.push({
        employeeId: userId,
        date,
        type: 'OFF',
        startTime: null,
        endTime: null,
        breakStart: null,
        breakEnd: null,
        breakMin: null,
        notes: reason,
        aiConfidence: 0.9,
      });
    }
    const u = userById.get(userId);
    fixes.push(`${u ? `${u.firstName} ${u.lastName}` : userId} · ${date} → repos (${reason})`);
    return true;
  };

  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    const byUser = {};
    for (const s of list) {
      if (!byUser[s.employeeId]) byUser[s.employeeId] = [];
      byUser[s.employeeId].push(s);
    }

    for (const userId of Object.keys(byUser)) {
      const getWork = () => list
        .filter((s) => s.employeeId === userId && s.type !== 'OFF' && s.type !== 'ABSENT')
        .sort((a, b) => a.date.localeCompare(b.date));
      const getSorted = () => list
        .filter((s) => s.employeeId === userId)
        .sort((a, b) => a.date.localeCompare(b.date));

      const workList = getWork();
      const chron = sortShiftsChronologically(workList);
      for (let i = 0; i < chron.length - 1; i++) {
        const cur = chron[i];
        const nxt = chron[i + 1];
        if (cur.date === nxt.date) continue;
        if (!cur.endTime || !nxt.startTime) continue;
        const curEnd = new Date(`${cur.date}T${cur.endTime}:00`);
        const nxtStart = new Date(`${nxt.date}T${nxt.startTime}:00`);
        const restH = differenceInHours(nxtStart, curEnd);
        if (restH < minRest && restH >= 0) {
          if (setOff(userId, nxt.date, `repos légal ${minRest}h`)) changed = true;
        }
      }

      const datesWorked = [...new Set(getWork().map((s) => s.date))];
      for (const date of datesWorked) {
        const dailyH = dailyNetMinutesForEmployee(userId, date, list) / 60;
        if (dailyH > maxDailyHours) {
          const dayShifts = getWork().filter((s) => s.date === date);
          const target = dayShifts.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))[0];
          if (setOff(userId, date, `max ${maxDailyHours}h/jour`, target)) changed = true;
        }
      }

      let totalHours = getWork().reduce(
        (acc, s) => acc + shiftHours(s.startTime, s.endTime, s.breakMin, s.breakStart, s.breakEnd, s.type),
        0,
      );
      if (totalHours > maxWeekly) {
        const days = getWork().sort((a, b) => preferNonForcedDay(a, b, forcedDates));
        for (const s of days) {
          if (totalHours <= maxWeekly) break;
          const h = shiftHours(s.startTime, s.endTime, s.breakMin, s.breakStart, s.breakEnd, s.type);
          if (setOff(userId, s.date, `max ${maxWeekly}h/semaine`, s)) {
            totalHours -= h;
            changed = true;
          }
        }
      }

      let consecutive = 0;
      const workedDates = [...new Set(getWork().map((s) => s.date))].sort();
      for (const dateStr of workedDates) {
        consecutive += 1;
        if (consecutive > maxConsecutive) {
          if (setOff(userId, dateStr, `max ${maxConsecutive} jours consécutifs`)) {
            consecutive = 0;
            changed = true;
          }
        }
        const nextDay = fmtDate(addDays(new Date(`${dateStr}T00:00:00`), 1));
        if (!workedDates.includes(nextDay)) consecutive = 0;
      }
    }

    if (!changed) break;
  }

  return { shifts: list, fixes };
}

/** Recalcule le brouillon en local avec règles légales (sans API). */
async function legalComplianceRegenerate({
  companyId,
  siteId,
  weekStart,
  planningWeekId,
  generatedBy,
}) {
  const start = parseWeekStart(weekStart);
  const end = endOfDay(addDays(start, 6));
  const context = await buildPlanningContext(companyId, siteId, start, {});

  const existing = await prisma.shift.findMany({
    where: withCompany(companyId, { siteId, date: { gte: start, lte: end } }),
    select: { userId: true, date: true, type: true, startTime: true, endTime: true },
  });

  let shifts = existing.length > 0
    ? existing.map((s) => ({
      employeeId: s.userId,
      date: fmtDate(s.date),
      type: s.type,
      startTime: s.startTime,
      endTime: s.endTime,
      aiConfidence: 0.82,
    }))
    : heuristicGenerate(context).shifts;

  shifts = enforcePlanningConstraints({ shifts }, context).shifts;
  const { shifts: legalShifts, fixes } = enforceLegalCompliance(shifts, context);
  const conflicts = detectConflicts(legalShifts, context);

  const aiPayload = finalizeHeuristicPayload({
    shifts: legalShifts,
    suggestions: fixes.length
      ? [`${fixes.length} correction(s) automatique(s) pour conformité légale.`]
      : ['Aucune correction légale supplémentaire nécessaire.'],
    warnings: conflicts.map((c) => c.message),
    coverageAnalysis: null,
    summary: null,
  }, context);

  await savePlanningToDB({
    companyId,
    siteId,
    weekStart: start,
    weekEnd: end,
    aiPayload,
    conflicts,
    generatedBy,
    modelLabel: 'heuristic-legal',
    promptDebug: { mode: 'legal-compliance', fixCount: fixes.length },
    replacingExisting: true,
    priorStatus: 'VALIDATED',
  });

  const conflictLabel = conflicts.length
    ? `${conflicts.length} conflit(s) restant(s) à vérifier.`
    : 'Aucun conflit légal détecté.';

  const reply = fixes.length
    ? `Planning recalculé en mode local : ${fixes.length} correction(s) (repos 11h, max 48h/semaine, max 6 jours consécutifs, max 10h/jour). ${conflictLabel}`
    : `Le brouillon a été revérifié selon le Code du travail. ${conflictLabel}`;

  return { reply, fixes, conflicts };
}

// ── Sauvegarde en DB ──────────────────────────────────────────

async function savePlanningToDB({
  companyId,
  siteId,
  weekStart,
  weekEnd,
  aiPayload,
  conflicts,
  generatedBy,
  modelLabel,
  promptDebug,
  replacingExisting = false,
  priorStatus = null,
}) {
  const fullReplace = replacingExisting && ['VALIDATED', 'PUBLISHED'].includes(priorStatus);
  const shiftsData = (aiPayload.shifts || [])
    .filter((s) => s.employeeId && s.date)
    .map((s) => ({
      userId: s.employeeId,
      siteId,
      companyId,
      date: startOfDay(new Date(`${s.date.slice(0, 10)}T00:00:00`)),
      type: s.type || 'OFF',
      startTime: s.startTime || null,
      endTime: s.endTime || null,
      breakStart: s.breakStart || null,
      breakEnd: s.breakEnd || null,
      breakMin: s.breakMin != null ? s.breakMin : null,
      notes: s.notes || null,
      isAiGenerated: true,
      aiConfidence: typeof s.aiConfidence === 'number' ? s.aiConfidence : 0.8,
    }));

  const confidences = shiftsData.map((s) => s.aiConfidence).filter((n) => typeof n === 'number');
  const avgConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0.75;

  return prisma.$transaction(async (tx) => {
    let previousShiftsBackup = [];
    if (fullReplace) {
      previousShiftsBackup = await tx.shift.findMany({
        where: { companyId, siteId, date: { gte: weekStart, lte: weekEnd } },
        select: {
          userId: true,
          date: true,
          type: true,
          startTime: true,
          endTime: true,
          breakStart: true,
          breakEnd: true,
          breakMin: true,
          notes: true,
          isAiGenerated: true,
          aiConfidence: true,
        },
      });
    }
    const aiPromptPayload = {
      ...(promptDebug && typeof promptDebug === 'object' ? promptDebug : {}),
      ...(fullReplace && previousShiftsBackup.length
        ? {
          previousShiftsBackup: previousShiftsBackup.map((s) => ({
            userId: s.userId,
            date: fmtDate(s.date),
            type: s.type,
            startTime: s.startTime,
            endTime: s.endTime,
            breakStart: s.breakStart,
            breakEnd: s.breakEnd,
            breakMin: s.breakMin,
            notes: s.notes,
            isAiGenerated: Boolean(s.isAiGenerated),
            aiConfidence: typeof s.aiConfidence === 'number' ? s.aiConfidence : null,
          })),
        }
        : {}),
    };

    const week = await tx.planningWeek.upsert({
      where: { siteId_weekStart: { siteId, weekStart } },
      create: {
        companyId,
        siteId,
        weekStart,
        weekEnd,
        status: 'DRAFT',
        isAiGenerated: true,
        aiModel: modelLabel,
        aiConfidence: avgConfidence,
        aiPrompt: aiPromptPayload,
        aiSummary: aiPayload.summary || null,
        aiSuggestions: {
          suggestions: aiPayload.suggestions || [],
          warnings: aiPayload.warnings || [],
        },
        conflicts,
        coverage: aiPayload.coverageAnalysis || null,
        generatedAt: new Date(),
        generatedBy: generatedBy || null,
      },
      update: {
        status: 'DRAFT',
        isAiGenerated: true,
        aiModel: modelLabel,
        aiConfidence: avgConfidence,
        aiPrompt: aiPromptPayload,
        aiSummary: aiPayload.summary || null,
        aiSuggestions: {
          suggestions: aiPayload.suggestions || [],
          warnings: aiPayload.warnings || [],
        },
        conflicts,
        coverage: aiPayload.coverageAnalysis || null,
        generatedAt: new Date(),
        generatedBy: generatedBy || null,
        validatedBy: null,
        validatedAt: null,
      },
    });

    // Remplacement complet si un planning validé/publié existait ; sinon shifts IA seulement
    await tx.shift.deleteMany({
      where: fullReplace
        ? { companyId, siteId, date: { gte: weekStart, lte: weekEnd } }
        : {
          companyId,
          siteId,
          date: { gte: weekStart, lte: weekEnd },
          isAiGenerated: true,
          OR: [
            { planningWeekId: week.id },
            { planningWeekId: null },
          ],
        },
    });

    if (shiftsData.length) {
      await tx.shift.createMany({
        data: shiftsData.map((s) => ({ ...s, planningWeekId: week.id })),
      });
    }

    return week;
  });
}

// ── Génération hebdo (point d'entrée principal) ───────────────

async function generateWeeklyPlanning({
  companyId,
  siteId,
  weekStart,
  generatedBy,
  selectedUserIds,
  userConstraints,
  naturalInput,
  structuredParams,
  replacingExisting = false,
  priorStatus = null,
}) {
  const start = parseWeekStart(weekStart);
  const end = endOfDay(addDays(start, 6));
  const context = await buildPlanningContext(companyId, siteId, start, { selectedUserIds, userConstraints });
  const demoAllowed = allowDemoFallback(context.company);

  if (!demoAllowed && !isHaikuAvailable()) {
    throw pulseUnavailableError();
  }

  const previousShifts = context.previousShifts.map((s) => ({
    employeeId: s.userId,
    date: fmtDate(s.date),
    type: s.type,
    startTime: s.startTime,
    endTime: s.endTime,
  }));

  const allAbsences = context.users.flatMap((u) => u.absences || []);

  let orchestratorResult;
  let aiError = null;
  try {
    orchestratorResult = await orchestrate({
      naturalInput: naturalInput || null,
      structuredParams: structuredParams || null,
      employees: context.users,
      absences: allAbsences,
      weekStart: start,
      planningRules: context.planningRules,
      previousShifts,
      userConstraints,
    });
  } catch (err) {
    aiError = err.message;
    console.warn('[planning-ai] orchestrate error:', err.message);
    if (!demoAllowed) {
      throw pulseUnavailableError();
    }
    orchestratorResult = await orchestrate({
      naturalInput: null,
      structuredParams: structuredParams || null,
      employees: context.users,
      absences: allAbsences,
      weekStart: start,
      planningRules: context.planningRules,
      previousShifts,
      userConstraints,
    });
  }

  let aiPayload = planningResultToAiPayload(orchestratorResult);

  const validUserIds = new Set(context.users.map((u) => u.id));
  aiPayload.shifts = (aiPayload.shifts || []).filter((s) => validUserIds.has(s.employeeId));

  context.forceWorkDays = orchestratorResult.extraConstraints?.forceWorkDays || [];
  context.weekStart = start;

  aiPayload = enforcePlanningConstraints(aiPayload, context);

  aiPayload.shifts = enrichShiftsWithBreaks(aiPayload.shifts, context.planningRules);

  const legal = enforceLegalCompliance(aiPayload.shifts, context);
  aiPayload.shifts = legal.shifts;
  if (legal.fixes.length) {
    aiPayload.warnings = [...(aiPayload.warnings || []), ...legal.fixes.slice(0, 8)];
  }

  const conflicts = detectConflicts(aiPayload.shifts, context);
  for (const v of orchestratorResult.validation?.violations || []) {
    conflicts.push({
      type: 'LEGAL_VIOLATION',
      severity: 'error',
      userId: v.employeeId,
      date: v.date,
      message: v.message || String(v),
    });
  }

  const usedAi = Boolean(
    orchestratorResult.intentMeta?.usedAi || orchestratorResult.explainMeta?.usedAi,
  );
  const modelLabel = `hybrid/${HAIKU_MODEL}`;
  const usage = {
    intent: orchestratorResult.intentMeta?.usage,
    explain: orchestratorResult.explainMeta?.usage,
  };

  const planningWeek = await savePlanningToDB({
    companyId,
    siteId,
    weekStart: start,
    weekEnd: end,
    aiPayload,
    conflicts,
    generatedBy,
    modelLabel,
    promptDebug: {
      mode: PLANNING_MODE,
      weekStart: fmtDate(start),
      siteName: context.site.name,
      employeeCount: context.users.length,
      selectedUserIds: selectedUserIds || context.users.map((u) => u.id),
      naturalInput: naturalInput || null,
      stats: orchestratorResult.stats,
      forceWorkDays: orchestratorResult.extraConstraints?.forceWorkDays || [],
    },
    replacingExisting,
    priorStatus,
  });

  return {
    planningWeekId: planningWeek.id,
    siteId,
    weekStart: fmtDate(start),
    weekEnd: fmtDate(end),
    usedAi,
    aiError,
    model: modelLabel,
    mode: PLANNING_MODE,
    usage,
    replacedPriorStatus: priorStatus,
    confidence: planningWeek.aiConfidence,
    shifts: aiPayload.shifts,
    conflicts,
    suggestions: aiPayload.suggestions || [],
    warnings: aiPayload.warnings || [],
    coverage: aiPayload.coverageAnalysis || null,
    summary: aiPayload.summary || orchestratorResult.explanation || null,
    explanation: orchestratorResult.explanation || aiPayload.summary || null,
    stats: orchestratorResult.stats || null,
    alerts: orchestratorResult.alerts || [],
    valid: orchestratorResult.valid,
    employees: context.users.map((u) => ({
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      role: u.role,
      department: u.department,
      jobTitle: u.jobTitle,
      avatarColor: u.avatarColor,
      wellbeingScore: u.wellbeingScore,
    })),
  };
}

// ── Récupération planning d'une semaine ───────────────────────

async function getWeeklyPlanning({ companyId, siteId, weekStart }) {
  const start = parseWeekStart(weekStart);
  const end = endOfDay(addDays(start, 6));

  const [planningWeek, shifts, employees] = await Promise.all([
    prisma.planningWeek.findFirst({
      where: { companyId, siteId, weekStart: start },
    }),
    prisma.shift.findMany({
      where: withCompany(companyId, { siteId, date: { gte: start, lte: end } }),
      include: {
        user: {
          select: {
            id: true, firstName: true, lastName: true, jobTitle: true,
            secondaryRoles: true, avatarColor: true,
          },
        },
      },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    }),
    prisma.user.findMany({
      where: withCompany(companyId, { siteId, isActive: true }),
      select: {
        id: true, firstName: true, lastName: true, jobTitle: true,
        secondaryRoles: true, weeklyHours: true, avatarColor: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    }),
  ]);

  return {
    siteId,
    weekStart: fmtDate(start),
    weekEnd: fmtDate(end),
    planningWeek: planningWeek ? {
      id: planningWeek.id,
      status: planningWeek.status,
      isAiGenerated: planningWeek.isAiGenerated,
      aiModel: planningWeek.aiModel,
      aiConfidence: planningWeek.aiConfidence,
      aiSummary: planningWeek.aiSummary,
      aiSuggestions: planningWeek.aiSuggestions,
      conflicts: planningWeek.conflicts,
      coverage: planningWeek.coverage,
      generatedAt: planningWeek.generatedAt,
      validatedAt: planningWeek.validatedAt,
    } : null,
    shifts: shifts.map((s) => ({
      id: s.id,
      userId: s.userId,
      date: fmtDate(s.date),
      type: s.type,
      startTime: s.startTime,
      endTime: s.endTime,
      breakStart: s.breakStart,
      breakEnd: s.breakEnd,
      breakMin: s.breakMin,
      isAiGenerated: s.isAiGenerated,
      aiConfidence: s.aiConfidence,
      notes: s.notes,
      employee: s.user,
    })),
    employees: employees.map((u) => ({
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      jobTitle: u.jobTitle,
      department: deriveDepartment(u),
      weeklyHours: u.weeklyHours,
      avatarColor: u.avatarColor,
    })),
  };
}

// ── Validation / publication ──────────────────────────────────

async function validatePlanningWeek({ companyId, planningWeekId, userId }) {
  const week = await prisma.planningWeek.findFirst({
    where: { id: planningWeekId, companyId },
  });
  if (!week) {
    const err = new Error('Semaine de planning introuvable.');
    err.status = 404;
    throw err;
  }
  const updated = await prisma.planningWeek.update({
    where: { id: week.id },
    data: { status: 'VALIDATED', validatedBy: userId, validatedAt: new Date() },
  });
  return updated;
}

// ── Optimisation ciblée (ajustements) ─────────────────────────

async function optimizePlanningWeek({ companyId, siteId, weekStart, issue }) {
  const start = parseWeekStart(weekStart);
  const end = endOfDay(addDays(start, 6));
  const context = await buildPlanningContext(companyId, siteId, start);

  const existing = await prisma.shift.findMany({
    where: withCompany(companyId, { siteId, date: { gte: start, lte: end } }),
    include: { user: { select: { id: true, firstName: true, lastName: true } } },
    take: 100,
  });

  const client = getAnthropicClient();
  if (!client) {
    if (!allowDemoFallback(context.company)) {
      return {
        usedAi: false,
        adjustments: [],
        explanation: "Optimisation IA indisponible : configurez ANTHROPIC_API_KEY pour activer l'assistant planning.",
      };
    }
    return {
      usedAi: false,
      adjustments: [],
      explanation: "Mode local : pas de clé Anthropic configurée. Modifie les shifts manuellement pour résoudre l'incident.",
    };
  }

  try {
    const response = await client.messages.create({
      model: AI_MODEL_OPTIMIZE,
      max_tokens: AI_MAX_TOKENS_OPTIMIZE,
      system: [{
        type: 'text',
        text: 'Tu es un expert RH français. Propose UNIQUEMENT des ajustements MINIMAUX pour résoudre un problème de planning. Tu réponds UNIQUEMENT en JSON valide, sans markdown.',
        cache_control: { type: 'ephemeral' },
      }],
      messages: [
        {
          role: 'user',
          content: `Planning actuel : ${JSON.stringify(existing.slice(0, 60).map((s) => ({
            id: s.id,
            userId: s.userId,
            name: `${s.user.firstName} ${s.user.lastName}`,
            date: fmtDate(s.date),
            type: s.type,
            startTime: s.startTime,
            endTime: s.endTime,
          })), null, 2)}

Problème : "${issue}"

Équipe disponible : ${JSON.stringify(context.users.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`, role: u.department })))}

Retourne :
{
  "adjustments": [
    {
      "action": "SWAP|ADD|REMOVE|MODIFY",
      "shiftId": "string|null",
      "userId": "string",
      "date": "YYYY-MM-DD",
      "type": "MATIN|APREM|NUIT|JOURNEE|OFF",
      "startTime": "HH:MM|null",
      "endTime": "HH:MM|null",
      "breakStart": "HH:MM|null",
      "breakEnd": "HH:MM|null",
      "breakMin": number|null,
      "reason": "string"
    }
  ],
  "explanation": "Résumé court"
}`,
        },
      ],
    });

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = safeJsonParse(text) || { adjustments: [], explanation: text.slice(0, 200) };
    return { usedAi: true, model: response.model || AI_MODEL, ...parsed };
  } catch (err) {
    console.warn('[planning-ai] optimize API fallback:', err.message);
    if (!allowDemoFallback(context.company)) {
      return {
        usedAi: false,
        adjustments: [],
        explanation: "Optimisation IA indisponible : la connexion API Anthropic a échoué. Réessayez après rétablissement.",
      };
    }
    if (wantsLegalCompliance(issue)) {
      const leg = await legalComplianceRegenerate({ companyId, siteId, weekStart, planningWeekId: null });
      return {
        usedAi: false,
        adjustments: [],
        explanation: leg.reply + anthropicFallbackNote(err),
      };
    }
    const h = heuristicChatReply(issue, context);
    return {
      usedAi: false,
      adjustments: h.adjustments,
      explanation: h.reply + anthropicFallbackNote(err),
    };
  }
}

const VALID_SHIFT_TYPES = ['MATIN', 'APREM', 'NUIT', 'JOURNEE', 'OFF', 'ABSENT'];

/** Applique les ajustements proposés par l'IA / le chat sur le planning brouillon. */
async function applyPlanningAdjustments({ companyId, siteId, weekStart, planningWeekId, adjustments }) {
  const start = parseWeekStart(weekStart);
  const end = endOfDay(addDays(start, 6));
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { settings: true },
  });
  const shiftTimes = shiftDefaultsFromRules(planningRulesForCompany(company));

  for (const adj of adjustments || []) {
    const userId = adj.userId;
    const dateStr = adj.date ? String(adj.date).slice(0, 10) : null;
    if (!userId || !dateStr) continue;

    const shiftDate = startOfDay(new Date(`${dateStr}T00:00:00`));
    if (shiftDate < start || shiftDate > end) continue;

    const user = await prisma.user.findFirst({
      where: { id: userId, companyId, siteId, isActive: true },
    });
    if (!user) continue;

    const action = String(adj.action || 'MODIFY').toUpperCase();

    if (action === 'REMOVE') {
      if (adj.shiftId) {
        await prisma.shift.deleteMany({ where: { id: adj.shiftId, companyId } });
      } else {
        await prisma.shift.deleteMany({
          where: { companyId, siteId, userId, date: shiftDate },
        });
      }
      continue;
    }

    const shiftType = VALID_SHIFT_TYPES.includes(adj.type) ? adj.type : 'OFF';
    const defaults = shiftTimes[shiftType] || shiftTimes.OFF || { start: null, end: null };
    const data = {
      type: shiftType,
      startTime: adj.startTime ?? defaults.start,
      endTime: adj.endTime ?? defaults.end,
      breakStart: adj.breakStart ?? null,
      breakEnd: adj.breakEnd ?? null,
      breakMin: adj.breakMin != null ? adj.breakMin : null,
      isAiGenerated: true,
      aiConfidence: 0.85,
      notes: adj.reason ? String(adj.reason).slice(0, 240) : 'Modifié via assistant planning',
      planningWeekId: planningWeekId || undefined,
    };

    if (action === 'ADD') {
      await prisma.shift.create({
        data: { ...data, companyId, siteId, userId, date: shiftDate },
      });
      continue;
    }

    const existing = await prisma.shift.findFirst({
      where: {
        companyId,
        siteId,
        userId,
        date: shiftDate,
        ...(adj.shiftId ? { id: adj.shiftId } : {}),
      },
      orderBy: { startTime: 'asc' },
    });
    if (existing) {
      await prisma.shift.update({ where: { id: existing.id }, data });
    } else {
      await prisma.shift.create({
        data: { ...data, companyId, siteId, userId, date: shiftDate },
      });
    }
  }
}

function heuristicChatReply(message, context) {
  const text = String(message || '').toLowerCase();
  const adjustments = [];

  for (const user of context.users) {
    const fn = user.firstName.toLowerCase();
    if (!text.includes(fn)) continue;
    const offDays = parseUnavailableDayIndices(message);
    for (const dayIdx of offDays) {
      adjustments.push({
        action: 'MODIFY',
        userId: user.id,
        date: fmtDate(addDays(context.weekStart, dayIdx)),
        type: 'OFF',
        startTime: null,
        endTime: null,
        reason: `Chat : repos demandé pour ${user.firstName}`,
      });
    }
  }

  if (adjustments.length) {
    return {
      usedAi: false,
      adjustments,
      reply: `J'ai mis à jour le planning : ${adjustments.length} jour(s) en repos selon votre demande.`,
    };
  }

  return {
    usedAi: false,
    adjustments: [],
    reply: 'Mode local : indiquez le prénom et les jours (ex. « Mettre Sophie en repos jeudi et vendredi »). Avec une clé Anthropic, des modifications plus complexes sont possibles.',
  };
}

/** Chat Pulse — extrait les intentions (Haiku) puis régénère via moteur hybride. */
async function chatPlanningWeek({
  companyId,
  siteId,
  weekStart,
  message,
  planningWeekId,
  generatedBy,
  selectedUserIds,
  userConstraints,
}) {
  const start = parseWeekStart(weekStart);

  if (wantsLegalCompliance(message)) {
    const leg = await legalComplianceRegenerate({
      companyId,
      siteId,
      weekStart,
      planningWeekId,
      generatedBy,
    });
    const weekData = await getWeeklyPlanning({ companyId, siteId, weekStart });
    return {
      reply: leg.reply,
      adjustments: [],
      weekData,
      usedAi: false,
      model: 'heuristic-legal',
      mode: PLANNING_MODE,
    };
  }

  const existing = await prisma.planningWeek.findFirst({
    where: planningWeekId
      ? { id: planningWeekId, companyId }
      : { companyId, siteId, weekStart: start },
  });

  const priorPrompt = existing?.aiPrompt && typeof existing.aiPrompt === 'object' ? existing.aiPrompt : {};
  const teamIds = selectedUserIds?.length
    ? selectedUserIds
    : (Array.isArray(priorPrompt.selectedUserIds) ? priorPrompt.selectedUserIds : null);

  const regen = await generateWeeklyPlanning({
    companyId,
    siteId,
    weekStart,
    generatedBy,
    naturalInput: message,
    selectedUserIds: teamIds,
    userConstraints: userConstraints || [],
    replacingExisting: Boolean(existing),
    priorStatus: existing?.status || null,
  });

  const weekData = await getWeeklyPlanning({ companyId, siteId, weekStart });
  return {
    reply: regen.explanation || regen.summary || 'Planning mis à jour selon votre demande.',
    adjustments: [],
    weekData,
    usedAi: regen.usedAi,
    model: regen.model,
    mode: PLANNING_MODE,
    stats: regen.stats,
    valid: regen.valid,
  };
}

// ── Alertes postes découverts (temps réel) ────────────────────

async function detectUnderstaffedSlots({ companyId, siteId, date }) {
  const day = date ? startOfDay(new Date(`${String(date).slice(0, 10)}T00:00:00`)) : startOfDay(new Date());
  const shifts = await prisma.shift.findMany({
    where: withCompany(companyId, {
      siteId,
      date: { gte: day, lt: addDays(day, 1) },
      type: { in: ['MATIN', 'APREM', 'NUIT', 'JOURNEE'] },
    }),
    include: { user: { select: { id: true, firstName: true, lastName: true, secondaryRoles: true, jobTitle: true } } },
  });

  const site = await prisma.site.findFirst({
    where: { id: siteId, companyId },
    include: { company: { select: { settings: true } } },
  });
  const rules = planningRulesForCompany(site?.company);

  const alerts = [];
  for (const slot of rules.criticalSlots || []) {
    const slotMin = parseInt(slot.time.replace(':', ''), 10);
    const covered = shifts.filter((s) => {
      if (!s.startTime || !s.endTime) return false;
      const startMin = parseInt(s.startTime.replace(':', ''), 10);
      const endMin = parseInt(s.endTime.replace(':', ''), 10);
      return startMin <= slotMin && endMin > slotMin;
    });
    if (covered.length < slot.minStaff) {
      alerts.push({
        type: 'UNDERSTAFFED',
        severity: covered.length === 0 ? 'critical' : 'warning',
        time: slot.time,
        label: slot.label,
        current: covered.length,
        required: slot.minStaff,
        siteId,
        message: `Poste découvert (${site?.name || 'site'}) : ${slot.label} — ${covered.length}/${slot.minStaff} personne(s).`,
      });
    }
  }
  return alerts;
}

module.exports = {
  AI_MODEL,
  PLANNING_MODE,
  SHIFT_DEFAULTS,
  generateWeeklyPlanning,
  getWeeklyPlanning,
  validatePlanningWeek,
  optimizePlanningWeek,
  chatPlanningWeek,
  applyPlanningAdjustments,
  detectUnderstaffedSlots,
  buildPlanningContext,
  isAiEnabled: () => isHaikuAvailable(),
  isHybridMode: () => true,
};
