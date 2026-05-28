// src/routes/bienetre.js — Sondages bien-être, réponses, scores et tendances
const router = require('express').Router();
const { body, query, param } = require('express-validator');
const { authenticate, authorize } = require('../middleware/auth');
const { ADMIN_ROLES, ANALYTICS_ROLES } = require('../middleware/roles');
const { prisma, getCompanyId, withCompany, ensureSurveyInCompany } = require('../middleware/tenant');
const { handleValidation } = require('../middleware/validate');
const {
  MIN_AGGREGATE_RESPONSES,
  roundScore,
  averageFromScores,
  computeWellbeingScores,
  computeSiteTrends,
  absenceRatePercent,
  computeCorrelation,
} = require('../lib/bienetre-scores');
const { computeEndsAt, getSurveyAvailability, responseDayKey } = require('../lib/survey-schedule');
const { pickDailyQuestions, dailyQcmLabel } = require('../lib/daily-qcm');
const {
  hasFullPlanningAccess,
  isManagerRole,
  getManagedUserIds,
} = require('../lib/planning-scope');

async function resolveBienetreScope(req, companyId, requestedSiteId = null) {
  if (hasFullPlanningAccess(req.user.role)) {
    return {
      siteId: requestedSiteId || null,
      teamUserIds: null,
      managerScope: false,
    };
  }

  if (isManagerRole(req.user.role)) {
    if (!req.user.siteId) {
      return { forbidden: true, status: 403, error: 'Aucun établissement assigné à votre compte.' };
    }
    if (requestedSiteId && requestedSiteId !== req.user.siteId) {
      return { forbidden: true, status: 403, error: 'Accès limité à votre équipe.' };
    }
    const teamUserIds = await getManagedUserIds(req, companyId, req.user.siteId);
    return {
      siteId: req.user.siteId,
      teamUserIds,
      managerScope: true,
    };
  }

  return {
    siteId: requestedSiteId || null,
    teamUserIds: null,
    managerScope: false,
  };
}

function mapQuestion(q) {
  return {
    id: q.id,
    text: q.text,
    order: q.order,
    type: q.type || 'SCALE',
    optional: Boolean(q.optional),
  };
}

function mapSurvey(survey, extra = {}) {
  const durationDays = survey.durationDays ?? 7;
  const endsAt = survey.endsAt || computeEndsAt(survey.weekStart, durationDays);
  const questions = extra.questions != null
    ? extra.questions.map(mapQuestion)
    : (survey.questions || []).sort((a, b) => a.order - b.order).map(mapQuestion);
  const { questions: _q, ...restExtra } = extra;

  return {
    id: survey.id,
    weekStart: survey.weekStart,
    weekLabel: extra.weekLabel != null ? extra.weekLabel : survey.weekLabel,
    status: survey.status,
    durationDays,
    endsAt,
    onlyOnWorkShifts: survey.onlyOnWorkShifts !== false,
    isCustom: Boolean(survey.isCustom),
    isDailyRotation: extra.isDailyRotation != null ? extra.isDailyRotation : !survey.isCustom,
    createdAt: survey.createdAt,
    questions,
    ...restExtra,
  };
}

function activeQuestionsForSurvey(survey, companyId, day = new Date()) {
  return pickDailyQuestions(survey.questions || [], day, companyId, survey.isCustom);
}

// ── GET /api/bienetre/surveys/current ───────────────────────────
router.get('/surveys/current', authenticate, async (req, res) => {
  const companyId = getCompanyId(req);

  const survey = await prisma.survey.findFirst({
    where: withCompany(companyId, { status: 'ACTIVE' }),
    include: { questions: { orderBy: { order: 'asc' } } },
  });

  if (!survey) {
    return res.json({ survey: null, hasResponded: false, alreadyAnswered: false });
  }

  const userId = req.user.id;
  const today = responseDayKey();
  const availability = await getSurveyAvailability(survey, userId, companyId);
  const todayQuestions = activeQuestionsForSurvey(survey, companyId, today);

  if (!availability.available) {
    return res.json({
      survey: mapSurvey(survey, {
        questions: todayQuestions,
        weekLabel: survey.isCustom ? survey.weekLabel : dailyQcmLabel(today),
        isDailyRotation: !survey.isCustom,
      }),
      hasResponded: false,
      alreadyAnswered: false,
      respondedAt: null,
      todayScore: null,
      availability,
    });
  }

  const existing = await prisma.surveyResponse.findUnique({
    where: {
      surveyId_userId_responseDate: {
        surveyId: survey.id,
        userId,
        responseDate: today,
      },
    },
    include: { answers: { select: { score: true } } },
  });

  const hasRespondedToday = Boolean(existing);
  const todayScore = hasRespondedToday
    ? averageFromScores(existing.answers.filter((a) => a.score != null).map((a) => a.score))
    : null;

  res.json({
    survey: mapSurvey(survey, {
      questions: todayQuestions,
      weekLabel: survey.isCustom
        ? survey.weekLabel
        : dailyQcmLabel(today),
      isDailyRotation: !survey.isCustom,
    }),
    hasResponded: hasRespondedToday,
    alreadyAnswered: hasRespondedToday,
    respondedAt: existing?.createdAt ?? null,
    todayScore,
    availability,
  });
});

// ── POST /api/bienetre/surveys/:id/respond ──────────────────────
router.post(
  '/surveys/:id/respond',
  authenticate,
  [
    param('id').isString().notEmpty().withMessage('Identifiant de sondage requis.'),
    body('answers').isArray({ min: 1, max: 5 }).withMessage('Les réponses doivent être un tableau (1 à 5 éléments).'),
    body('answers.*.questionId').isString().notEmpty().withMessage('Identifiant de question requis.'),
    body('answers.*.score').optional().isInt({ min: 1, max: 10 }),
    body('answers.*.textValue').optional().isString().isLength({ max: 2000 }),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { id: surveyId } = req.params;
    const { answers } = req.body;
    const companyId = getCompanyId(req);
    const userId = req.user.id;

    const survey = await ensureSurveyInCompany(surveyId, companyId, {
      questions: { orderBy: { order: 'asc' } },
    });

    if (!survey) {
      return res.status(404).json({ error: 'Sondage introuvable.' });
    }
    if (survey.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Ce sondage n\'est plus actif.' });
    }

    const availability = await getSurveyAvailability(survey, userId, companyId);
    if (!availability.available) {
      return res.status(403).json({
        error: availability.message || 'Questionnaire non disponible aujourd\'hui.',
        reason: availability.reason,
      });
    }

    const activeQuestions = activeQuestionsForSurvey(survey, companyId, responseDayKey());
    const questionIds = new Set(activeQuestions.map((q) => q.id));
    if (answers.length !== activeQuestions.length) {
      return res.status(400).json({
        error: `Répondez aux ${activeQuestions.length} question(s) du QCM du jour.`,
      });
    }

    const seenQuestions = new Set();
    const questionById = new Map(activeQuestions.map((q) => [q.id, q]));
    for (const a of answers) {
      if (!questionIds.has(a.questionId)) {
        return res.status(400).json({ error: 'Question invalide pour ce sondage.' });
      }
      if (seenQuestions.has(a.questionId)) {
        return res.status(400).json({ error: 'Chaque question ne peut être répondue qu\'une fois.' });
      }
      seenQuestions.add(a.questionId);

      const q = questionById.get(a.questionId);
      if (q.type === 'TEXT') {
        const text = (a.textValue || '').trim();
        if (!q.optional && !text) {
          return res.status(400).json({ error: `Réponse requise pour « ${q.text} ».` });
        }
        if (text.length > 2000) {
          return res.status(400).json({ error: 'Texte trop long (max. 2000 caractères).' });
        }
      } else {
        const score = a.score;
        if (score == null || score < 1 || score > 10) {
          return res.status(400).json({ error: `Note entre 1 et 10 requise pour « ${q.text} ».` });
        }
      }
    }

    try {
      const responseDate = responseDayKey();
      const response = await prisma.$transaction(async (tx) => {
        const already = await tx.surveyResponse.findUnique({
          where: {
            surveyId_userId_responseDate: { surveyId, userId, responseDate },
          },
        });
        if (already) {
          const err = new Error('ALREADY_RESPONDED');
          err.code = 'ALREADY_RESPONDED';
          throw err;
        }

        const created = await tx.surveyResponse.create({
          data: { surveyId, userId, responseDate },
        });

        await tx.answer.createMany({
          data: answers.map((a) => {
            const q = questionById.get(a.questionId);
            if (q.type === 'TEXT') {
              const text = (a.textValue || '').trim();
              return {
                responseId: created.id,
                questionId: a.questionId,
                score: null,
                textValue: text || null,
              };
            }
            return {
              responseId: created.id,
              questionId: a.questionId,
              score: a.score,
              textValue: null,
            };
          }),
        });

        return created;
      });

      res.status(201).json({
        message: 'Réponses enregistrées.',
        responseId: response.id,
      });
    } catch (err) {
      if (err.code === 'ALREADY_RESPONDED' || err.code === 'P2002') {
        return res.status(409).json({ error: 'Vous avez déjà répondu à ce sondage.' });
      }
      throw err;
    }
  },
);

// ── GET /api/bienetre/scores?siteId= ────────────────────────────
router.get(
  '/scores',
  authenticate,
  authorize(...ANALYTICS_ROLES),
  [query('siteId').optional().isString()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const scope = await resolveBienetreScope(req, companyId, req.query.siteId || null);
    if (scope.forbidden) {
      return res.status(scope.status).json({ error: scope.error });
    }
    const payload = await computeWellbeingScores(companyId, {
      siteId: scope.siteId,
      teamUserIds: scope.teamUserIds,
    });
    res.json({ ...payload, managerScope: scope.managerScope });
  },
);

// ── GET /api/bienetre/my-team — manager & collaborateur ─────────
router.get('/my-team', authenticate, async (req, res) => {
  const companyId = getCompanyId(req);
  const { siteId, id: userId, role } = req.user;

  if (!siteId) {
    return res.json({
      available: false,
      reason: 'NO_SITE',
      message: 'Aucun établissement associé à votre compte.',
    });
  }

  const site = await prisma.site.findFirst({
    where: { id: siteId, companyId, isActive: true },
    select: { id: true, name: true },
  });
  if (!site) {
    return res.json({ available: false, reason: 'SITE_NOT_FOUND' });
  }

  const teamUserIds = isManagerRole(role)
    ? await getManagedUserIds(req, companyId, siteId)
    : null;

  const scores = await computeWellbeingScores(companyId, { siteId, teamUserIds });
  const teamRow = teamUserIds?.length
    ? scores.bySite[0]
    : scores.bySite.find((s) => s.siteId === siteId) || scores.bySite[0];

  if (!teamRow?.meetsAnonymity) {
    return res.json({
      available: false,
      reason: 'INSUFFICIENT_RESPONSES',
      minRequired: MIN_AGGREGATE_RESPONSES,
      siteName: isManagerRole(role) ? `${site.name} — Mon équipe` : site.name,
      responseCount: teamRow?.responseCount || 0,
      message: `Minimum ${MIN_AGGREGATE_RESPONSES} réponses requises pour afficher le score agrégé.`,
      managerScope: Boolean(teamUserIds?.length),
    });
  }

  const trends = await computeSiteTrends(companyId, siteId, 4, { teamUserIds });
  const prev = trends.length >= 2 ? trends[trends.length - 2].score : null;
  const curr = teamRow.averageScore;
  const trendDelta = prev != null && curr != null ? roundScore(curr - prev) : null;

  const history = await prisma.surveyResponse.findMany({
    where: { userId, survey: withCompany(companyId) },
    include: {
      survey: { select: { weekLabel: true, weekStart: true } },
      answers: { select: { score: true, textValue: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 7,
  });

  const personalHistory = history.map((r) => ({
    weekLabel: r.survey.weekLabel,
    weekStart: r.survey.weekStart,
    score: averageFromScores(r.answers.filter((a) => a.score != null).map((a) => a.score)),
    done: true,
  }));

  const qcmStatus = await prisma.survey.findFirst({
    where: withCompany(companyId, { status: 'ACTIVE' }),
    select: { id: true, weekLabel: true },
  });
  let hasRespondedToday = false;
  if (qcmStatus) {
    const resp = await prisma.surveyResponse.findUnique({
      where: {
        surveyId_userId_responseDate: {
          surveyId: qcmStatus.id,
          userId,
          responseDate: responseDayKey(),
        },
      },
    });
    hasRespondedToday = Boolean(resp);
  }

  res.json({
    available: true,
    site: { id: site.id, name: isManagerRole(role) ? `${site.name} — Mon équipe` : site.name },
    score: teamRow.averageScore,
    participationRate: teamRow.participationRate,
    responseCount: teamRow.responseCount,
    eligibleCount: teamRow.eligibleCount,
    trendDelta,
    byQuestion: scores.byQuestion,
    survey: scores.survey,
    trends,
    personalHistory,
    qcmPending: qcmStatus && !hasRespondedToday,
    activeSurveyLabel: qcmStatus?.weekLabel || null,
    managerScope: Boolean(teamUserIds?.length),
  });
});

// ── GET /api/bienetre/sites/:siteId/detail ──────────────────────
router.get(
  '/sites/:siteId/detail',
  authenticate,
  authorize(...ANALYTICS_ROLES),
  [param('siteId').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const { siteId } = req.params;

    const scope = await resolveBienetreScope(req, companyId, siteId);
    if (scope.forbidden) {
      return res.status(scope.status).json({ error: scope.error });
    }

    const site = await prisma.site.findFirst({
      where: { id: siteId, companyId, isActive: true },
    });
    if (!site) return res.status(404).json({ error: 'Établissement introuvable.' });

    const scores = await computeWellbeingScores(companyId, {
      siteId,
      teamUserIds: scope.teamUserIds,
    });
    const siteRow = scope.teamUserIds?.length
      ? scores.bySite[0]
      : scores.bySite.find((s) => s.siteId === siteId);
    const history = await computeSiteTrends(companyId, siteId, 6, { teamUserIds: scope.teamUserIds });
    const absenceRate = await absenceRatePercent(companyId, siteId, 6, { teamUserIds: scope.teamUserIds });

    const prevWeek = history.length >= 2 ? history[history.length - 2] : null;
    const trendDelta = prevWeek?.score != null && siteRow?.averageScore != null
      ? roundScore(siteRow.averageScore - prevWeek.score)
      : 0;

    const absencesRecent = await prisma.absence.count({
      where: {
        companyId,
        user: scope.teamUserIds?.length
          ? { id: { in: scope.teamUserIds } }
          : { siteId },
        status: { in: ['APPROUVE', 'EN_ATTENTE'] },
        endDate: { gte: new Date() },
      },
    });

    res.json({
      site: {
        id: site.id,
        name: scope.managerScope ? `${site.name} — Mon équipe` : site.name,
      },
      score: siteRow?.averageScore,
      participationRate: siteRow?.participationRate,
      responseCount: siteRow?.responseCount || 0,
      eligibleCount: siteRow?.eligibleCount || 0,
      meetsAnonymity: siteRow?.meetsAnonymity,
      trendDelta,
      absenceRate,
      absencesToday: absencesRecent,
      byQuestion: scores.byQuestion,
      history,
      conseil: buildSiteConseil(siteRow, scores.byQuestion, absenceRate),
      managerScope: scope.managerScope,
    });
  },
);

function buildSiteConseil(siteRow, byQuestion, absenceRate) {
  const score = siteRow?.averageScore;
  if (score == null) {
    return {
      icon: 'ℹ️',
      color: '#64748B',
      bg: '#F8FAFC',
      border: '#E2E8F0',
      text: 'Pas assez de réponses pour générer une analyse.',
    };
  }
  const weakest = [...(byQuestion || [])]
    .filter((q) => q.averageScore != null)
    .sort((a, b) => a.averageScore - b.averageScore)[0];

  if (score < 6) {
    return {
      icon: '🚨',
      color: '#991B1B',
      bg: '#FEF2F2',
      border: '#FECACA',
      text: `Score critique (${score}/10). ${weakest ? `Point faible : « ${weakest.text} » (${weakest.averageScore}/10). ` : ''}Absentéisme estimé ${absenceRate}%. Entretien manager recommandé cette semaine.`,
    };
  }
  if (score < 7.5) {
    return {
      icon: '💡',
      color: '#1D4ED8',
      bg: '#EFF6FF',
      border: '#BFCFFE',
      text: `Score modéré (${score}/10). ${weakest ? `Surveiller « ${weakest.text} ». ` : ''}Absentéisme ${absenceRate}%.`,
    };
  }
  return {
    icon: '✅',
    color: '#065F46',
    bg: '#ECFDF5',
    border: '#A7F3D0',
    text: `Bonne dynamique (${score}/10). Continuer le suivi QCM et maintenir la charge de travail équilibrée.`,
  };
}

// ── GET /api/bienetre/correlation ───────────────────────────────
router.get('/correlation', authenticate, authorize(...ANALYTICS_ROLES), [
  query('siteId').optional().isString(),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const scope = await resolveBienetreScope(req, companyId, req.query.siteId || null);
    if (scope.forbidden) {
      return res.status(scope.status).json({ error: scope.error, sites: [] });
    }
    const data = await computeCorrelation(companyId, {
      siteId: scope.siteId,
      teamUserIds: scope.teamUserIds,
    });
    res.json({ ...data, managerScope: scope.managerScope });
  } catch (err) {
    console.error('GET /api/bienetre/correlation', err);
    res.status(500).json({ error: 'Impossible de calculer la corrélation.', sites: [] });
  }
});

// ── GET /api/bienetre/surveys/list ──────────────────────────────
router.get('/surveys/list', authenticate, authorize(...ADMIN_ROLES), async (req, res) => {
  const companyId = getCompanyId(req);
  const surveys = await prisma.survey.findMany({
    where: withCompany(companyId),
    orderBy: { weekStart: 'desc' },
    take: 12,
    include: {
      questions: { orderBy: { order: 'asc' } },
      _count: { select: { responses: true } },
    },
  });
  res.json({
    surveys: surveys.map((s) => ({
      ...mapSurvey(s),
      responseCount: s._count.responses,
    })),
  });
});

// ── GET /api/bienetre/my-responses — historique QCM du collaborateur ─
router.get('/my-responses', authenticate, async (req, res) => {
  const companyId = getCompanyId(req);
  const userId = req.user.id;

  const responses = await prisma.surveyResponse.findMany({
    where: {
      userId,
      survey: withCompany(companyId),
    },
    include: {
      survey: { select: { weekStart: true, weekLabel: true, status: true } },
      answers: { select: { score: true, textValue: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 14,
  });

  const history = responses.map((r) => {
    const scores = r.answers.map((a) => a.score);
    const avg = averageFromScores(scores);
    const d = new Date(r.responseDate);
    const dayLabel = d.toLocaleDateString('fr-FR', { weekday: 'short' }).charAt(0).toUpperCase();
    return {
      date: r.createdAt,
      responseDate: r.responseDate,
      weekStart: r.survey.weekStart,
      weekLabel: r.survey.weekLabel,
      day: dayLabel,
      score: avg,
      done: true,
    };
  });

  res.json({ history });
});

// ── GET /api/bienetre/trends?weeks=4&siteId= ─────────────────────
router.get(
  '/trends',
  authenticate,
  authorize(...ANALYTICS_ROLES),
  [
    query('weeks').optional().isInt({ min: 1, max: 52 }),
    query('siteId').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const companyId = getCompanyId(req);
    const weeks = parseInt(req.query.weeks, 10) || 4;
    const requestedSiteId = req.query.siteId || null;
    const scope = await resolveBienetreScope(req, companyId, requestedSiteId);
    if (scope.forbidden) {
      return res.status(scope.status).json({ error: scope.error });
    }

    if (scope.siteId) {
      const points = await computeSiteTrends(companyId, scope.siteId, weeks, {
        teamUserIds: scope.teamUserIds,
      });
      return res.json({
        weeks,
        siteId: scope.siteId,
        managerScope: scope.managerScope,
        points: points.map((p) => ({
          weekStart: p.weekStart,
          weekLabel: p.weekLabel,
          averageScore: p.score,
          responseCount: p.responseCount,
        })),
      });
    }

    if (isManagerRole(req.user.role)) {
      return res.status(403).json({ error: 'Accès limité à votre équipe.' });
    }

    const surveys = await prisma.survey.findMany({
      where: withCompany(companyId, { status: { in: ['ACTIVE', 'CLOSED'] } }),
      orderBy: { weekStart: 'desc' },
      take: weeks,
      include: {
        responses: { include: { answers: { select: { score: true } } } },
      },
    });

    const eligibleCount = await prisma.user.count({
      where: withCompany(companyId, { isActive: true }),
    });

    const points = surveys
      .map((survey) => {
        const scores = survey.responses.flatMap((r) => r.answers.map((a) => a.score));
        const responseCount = survey.responses.length;
        return {
          surveyId: survey.id,
          weekStart: survey.weekStart,
          weekLabel: survey.weekLabel,
          status: survey.status,
          averageScore: averageFromScores(scores),
          participationRate: eligibleCount
            ? Math.round((responseCount / eligibleCount) * 100)
            : 0,
          responseCount,
        };
      })
      .reverse();

    res.json({ weeks, eligibleCount, points });
  },
);

// ── GET /api/bienetre/surveys/:id ───────────────────────────────
router.get(
  '/surveys/:id',
  authenticate,
  authorize(...ADMIN_ROLES),
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const survey = await ensureSurveyInCompany(req.params.id, companyId, {
      questions: { orderBy: { order: 'asc' } },
      _count: { select: { responses: true } },
    });
    if (!survey) return res.status(404).json({ error: 'Sondage introuvable.' });
    res.json({
      survey: mapSurvey(survey, { responseCount: survey._count.responses }),
    });
  },
);

// ── POST /api/bienetre/surveys ──────────────────────────────────
router.post(
  '/surveys',
  authenticate,
  authorize(...ADMIN_ROLES),
  [
    body('weekStart').isISO8601().withMessage('Date de début de semaine invalide.'),
    body('weekLabel').isString().trim().notEmpty().withMessage('Libellé de semaine requis.'),
    body('durationDays').optional().isInt({ min: 1, max: 14 }),
    body('onlyOnWorkShifts').optional().isBoolean(),
    body('isCustom').optional().isBoolean(),
    body('questions').isArray({ min: 1, max: 5 }).withMessage('Entre 1 et 5 questions requises.'),
    body('questions.*.text').isString().trim().notEmpty().withMessage('Texte de question requis.'),
    body('questions.*.order').optional().isInt({ min: 1, max: 5 }),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { weekStart, weekLabel, questions, durationDays, onlyOnWorkShifts, isCustom } = req.body;
    const companyId = getCompanyId(req);
    const start = new Date(weekStart);
    const days = durationDays != null ? parseInt(durationDays, 10) : 7;
    const endsAt = computeEndsAt(start, days);

    const normalizedQuestions = questions.map((q, index) => ({
      text: q.text.trim(),
      order: q.order ?? index + 1,
      type: q.type === 'TEXT' ? 'TEXT' : 'SCALE',
      optional: Boolean(q.optional),
    }));

    const survey = await prisma.survey.create({
      data: {
        companyId,
        weekStart: start,
        weekLabel: weekLabel.trim(),
        status: 'DRAFT',
        durationDays: days,
        endsAt,
        onlyOnWorkShifts: onlyOnWorkShifts !== false,
        isCustom: Boolean(isCustom),
        questions: { create: normalizedQuestions },
      },
      include: { questions: { orderBy: { order: 'asc' } } },
    });

    res.status(201).json({ survey: mapSurvey(survey) });
  },
);

// ── PUT /api/bienetre/surveys/:id ───────────────────────────────
router.put(
  '/surveys/:id',
  authenticate,
  authorize(...ADMIN_ROLES),
  [
    param('id').isString().notEmpty(),
    body('weekLabel').optional().isString().trim().notEmpty(),
    body('weekStart').optional().isISO8601(),
    body('durationDays').optional().isInt({ min: 1, max: 14 }),
    body('onlyOnWorkShifts').optional().isBoolean(),
    body('isCustom').optional().isBoolean(),
    body('questions').optional().isArray({ min: 1, max: 5 }),
    body('questions.*.text').optional().isString().trim().notEmpty(),
    body('questions.*.order').optional().isInt({ min: 1, max: 5 }),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { id } = req.params;
    const companyId = getCompanyId(req);
    const existing = await ensureSurveyInCompany(id, companyId, {
      questions: { orderBy: { order: 'asc' } },
      _count: { select: { responses: true } },
    });
    if (!existing) return res.status(404).json({ error: 'Sondage introuvable.' });
    if (existing.status === 'CLOSED') {
      return res.status(400).json({ error: 'Impossible de modifier un sondage clôturé.' });
    }

    const hasResponses = existing._count.responses > 0;
    const { weekLabel, weekStart, durationDays, onlyOnWorkShifts, isCustom, questions } = req.body;

    if (questions?.length && hasResponses) {
      return res.status(400).json({
        error: 'Des réponses existent déjà — vous ne pouvez plus modifier les questions.',
      });
    }

    const start = weekStart ? new Date(weekStart) : existing.weekStart;
    const days = durationDays != null ? parseInt(durationDays, 10) : existing.durationDays;
    const endsAt = computeEndsAt(start, days);

    const survey = await prisma.$transaction(async (tx) => {
      if (questions?.length) {
        await tx.question.deleteMany({ where: { surveyId: id } });
        await tx.question.createMany({
          data: questions.map((q, index) => ({
            surveyId: id,
            text: q.text.trim(),
            order: q.order ?? index + 1,
            type: q.type === 'TEXT' ? 'TEXT' : 'SCALE',
            optional: Boolean(q.optional),
          })),
        });
      }

      return tx.survey.update({
        where: { id },
        data: {
          ...(weekLabel ? { weekLabel: weekLabel.trim() } : {}),
          weekStart: start,
          durationDays: days,
          endsAt,
          ...(onlyOnWorkShifts !== undefined ? { onlyOnWorkShifts: Boolean(onlyOnWorkShifts) } : {}),
          ...(isCustom !== undefined ? { isCustom: Boolean(isCustom) } : {}),
        },
        include: {
          questions: { orderBy: { order: 'asc' } },
          _count: { select: { responses: true } },
        },
      });
    });

    res.json({
      survey: mapSurvey(survey, { responseCount: survey._count.responses }),
      message: 'Sondage mis à jour.',
    });
  },
);

// ── PUT /api/bienetre/surveys/:id/activate ──────────────────────
router.put(
  '/surveys/:id/activate',
  authenticate,
  authorize(...ADMIN_ROLES),
  [param('id').isString().notEmpty().withMessage('Identifiant de sondage requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { id } = req.params;
    const companyId = getCompanyId(req);

    const target = await ensureSurveyInCompany(id, companyId);
    if (!target) {
      return res.status(404).json({ error: 'Sondage introuvable.' });
    }
    if (target.status === 'CLOSED') {
      return res.status(400).json({ error: 'Impossible d\'activer un sondage clôturé.' });
    }

    const survey = await prisma.$transaction(async (tx) => {
      await tx.survey.updateMany({
        where: withCompany(companyId, { status: 'ACTIVE', id: { not: id } }),
        data: { status: 'CLOSED' },
      });

      return tx.survey.update({
        where: { id },
        data: { status: 'ACTIVE' },
        include: { questions: { orderBy: { order: 'asc' } } },
      });
    });

    res.json({ survey: mapSurvey(survey), message: 'Sondage activé. L\'ancien sondage actif a été clôturé.' });
  },
);

// ── PUT /api/bienetre/surveys/:id/close ─────────────────────────
router.put(
  '/surveys/:id/close',
  authenticate,
  authorize(...ADMIN_ROLES),
  [param('id').isString().notEmpty().withMessage('Identifiant de sondage requis.')],
  async (req, res) => {
    if (!handleValidation(req, res)) return;

    const { id } = req.params;
    const companyId = getCompanyId(req);

    const target = await ensureSurveyInCompany(id, companyId, {
      questions: { orderBy: { order: 'asc' } },
    });
    if (!target) {
      return res.status(404).json({ error: 'Sondage introuvable.' });
    }
    if (target.status === 'CLOSED') {
      return res.status(400).json({ error: 'Ce sondage est déjà clôturé.' });
    }

    const survey = await prisma.survey.update({
      where: { id },
      data: { status: 'CLOSED' },
      include: { questions: { orderBy: { order: 'asc' } } },
    });

    res.json({ survey: mapSurvey(survey), message: 'Sondage clôturé.' });
  },
);

// ── POST /api/bienetre/surveys/:id/remind ───────────────────────
router.post(
  '/surveys/:id/remind',
  authenticate,
  authorize(...ADMIN_ROLES),
  [param('id').isString().notEmpty()],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const survey = await ensureSurveyInCompany(req.params.id, companyId, {
      _count: { select: { responses: true } },
    });
    if (!survey) return res.status(404).json({ error: 'Sondage introuvable.' });
    if (survey.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Seul un sondage actif peut être relancé.' });
    }

    const eligibleCount = await prisma.user.count({
      where: withCompany(companyId, { isActive: true }),
    });
    const pendingCount = Math.max(0, eligibleCount - survey._count.responses);

    res.json({
      message: `Relance enregistrée — ${pendingCount} collaborateur(s) n'ont pas encore répondu.`,
      pendingCount,
      eligibleCount,
      responseCount: survey._count.responses,
    });
  },
);

// ── GET /api/bienetre/meetings ──────────────────────────────────
router.get(
  '/meetings',
  authenticate,
  authorize(...ANALYTICS_ROLES),
  [query('status').optional().isIn(['PLANNED', 'DONE', 'CANCELLED', 'all'])],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const status = req.query.status || 'PLANNED';
    const where = withCompany(companyId, status === 'all' ? {} : { status });
    const meetings = await prisma.wellbeingMeeting.findMany({
      where,
      orderBy: { scheduledAt: 'asc' },
      take: 30,
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });
    res.json({
      meetings: meetings.map((m) => ({
        id: m.id,
        teamLabel: m.teamLabel,
        siteId: m.siteId,
        scheduledAt: m.scheduledAt,
        type: m.type,
        note: m.note,
        status: m.status,
        createdBy: `${m.createdBy.firstName} ${m.createdBy.lastName}`.trim(),
        createdAt: m.createdAt,
      })),
    });
  },
);

// ── POST /api/bienetre/meetings ─────────────────────────────────
router.post(
  '/meetings',
  authenticate,
  authorize(...ANALYTICS_ROLES),
  [
    body('teamLabel').isString().trim().notEmpty(),
    body('scheduledAt').isISO8601(),
    body('type').optional().isString().trim(),
    body('note').optional().isString(),
    body('siteId').optional().isString(),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const { teamLabel, scheduledAt, type, note, siteId } = req.body;

    let effectiveSiteId = siteId || null;
    if (isManagerRole(req.user.role)) {
      if (!req.user.siteId) {
        return res.status(403).json({ error: 'Aucun établissement assigné.' });
      }
      if (siteId && siteId !== req.user.siteId) {
        return res.status(403).json({ error: 'Entretien limité à votre équipe.' });
      }
      effectiveSiteId = req.user.siteId;
    }

    if (effectiveSiteId) {
      const site = await prisma.site.findFirst({
        where: { id: effectiveSiteId, companyId, isActive: true },
      });
      if (!site) return res.status(400).json({ error: 'Site invalide.' });
    }

    const meeting = await prisma.wellbeingMeeting.create({
      data: {
        companyId,
        siteId: effectiveSiteId,
        teamLabel: teamLabel.trim(),
        scheduledAt: new Date(scheduledAt),
        type: type?.trim() || 'Point manager bien-être',
        note: note?.trim() || null,
        createdById: req.user.id,
      },
      include: { createdBy: { select: { firstName: true, lastName: true } } },
    });

    res.status(201).json({
      meeting: {
        id: meeting.id,
        teamLabel: meeting.teamLabel,
        siteId: meeting.siteId,
        scheduledAt: meeting.scheduledAt,
        type: meeting.type,
        note: meeting.note,
        status: meeting.status,
        createdBy: `${meeting.createdBy.firstName} ${meeting.createdBy.lastName}`.trim(),
      },
      message: 'Entretien planifié.',
    });
  },
);

// ── PATCH /api/bienetre/meetings/:id ────────────────────────────
router.patch(
  '/meetings/:id',
  authenticate,
  authorize(...ANALYTICS_ROLES),
  [
    param('id').isString().notEmpty(),
    body('status').optional().isIn(['PLANNED', 'DONE', 'CANCELLED']),
  ],
  async (req, res) => {
    if (!handleValidation(req, res)) return;
    const companyId = getCompanyId(req);
    const existing = await prisma.wellbeingMeeting.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!existing) return res.status(404).json({ error: 'Entretien introuvable.' });

    const meeting = await prisma.wellbeingMeeting.update({
      where: { id: existing.id },
      data: { status: req.body.status || existing.status },
    });
    res.json({ meeting, message: 'Entretien mis à jour.' });
  },
);

module.exports = router;
