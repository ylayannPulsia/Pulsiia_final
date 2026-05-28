// Calculs agrégés bien-être (scores, tendances, corrélation absences)
const { prisma, withCompany } = require('../middleware/tenant');

const MIN_AGGREGATE_RESPONSES = 5;

function roundScore(value) {
  return Math.round(value * 10) / 10;
}

function averageFromScores(scores) {
  if (!scores.length) return null;
  return roundScore(scores.reduce((s, v) => s + v, 0) / scores.length);
}

function scoreDistribution(scores) {
  if (!scores.length) {
    return { low: 0, mid: 0, high: 0, lowPct: 0, midPct: 0, highPct: 0 };
  }
  let low = 0;
  let mid = 0;
  let high = 0;
  for (const s of scores) {
    if (s < 5) low += 1;
    else if (s < 8) mid += 1;
    else high += 1;
  }
  const n = scores.length;
  return {
    low,
    mid,
    high,
    lowPct: Math.round((low / n) * 100),
    midPct: Math.round((mid / n) * 100),
    highPct: Math.round((high / n) * 100),
  };
}

function questionSignal(score, trend) {
  if (score == null) return { level: 'ok', text: 'Données insuffisantes' };
  if (score < 5 || (trend != null && trend <= -1)) {
    return { level: 'error', text: 'Alerte — action recommandée' };
  }
  if (score < 7 || (trend != null && trend < 0)) {
    return { level: 'warn', text: 'Vigilance' };
  }
  if (trend != null && trend > 0.3) {
    return { level: 'ok', text: 'En progression' };
  }
  return { level: 'ok', text: 'Normal' };
}

async function enrichByQuestionMetrics(companyId, activeSurvey, responses, byQuestion) {
  const closed = await prisma.survey.findFirst({
    where: withCompany(companyId, { status: 'CLOSED' }),
    orderBy: { weekStart: 'desc' },
    include: {
      questions: { orderBy: { order: 'asc' } },
      responses: { include: { answers: { select: { questionId: true, score: true } } } },
    },
  });

  const prevAvgByOrder = new Map();
  if (closed) {
    for (const q of closed.questions) {
      const scores = closed.responses.flatMap((r) =>
        r.answers.filter((a) => a.questionId === q.id).map((a) => a.score),
      );
      prevAvgByOrder.set(q.order, averageFromScores(scores));
    }
  }

  return byQuestion.map((q) => {
    if (q.type === 'TEXT') {
      const count = q.textResponseCount ?? 0;
      return {
        ...q,
        previousScore: null,
        trend: null,
        distribution: null,
        signal: { level: 'ok', text: count ? `${count} remarque(s) anonyme(s)` : 'Aucune remarque' },
      };
    }
    const scores = responses.flatMap((r) =>
      r.answers.filter((a) => a.questionId === q.questionId && a.score != null).map((a) => a.score),
    );
    const prev = prevAvgByOrder.get(q.order) ?? null;
    const trend = prev != null && q.averageScore != null
      ? roundScore(q.averageScore - prev)
      : null;
    const distribution = scoreDistribution(scores);
    const signal = questionSignal(q.averageScore, trend);
    return {
      ...q,
      previousScore: prev,
      trend,
      distribution,
      signal,
    };
  });
}

async function loadActiveSurvey(companyId) {
  return prisma.survey.findFirst({
    where: withCompany(companyId, { status: 'ACTIVE' }),
    include: {
      questions: { orderBy: { order: 'asc' } },
      responses: {
        include: {
          answers: true,
          user: { select: { id: true, siteId: true } },
        },
      },
    },
  });
}

async function computeWellbeingScores(companyId, { siteId = null, teamUserIds = null } = {}) {
  const survey = await loadActiveSurvey(companyId);

  if (!survey) {
    return {
      survey: null,
      globalScore: null,
      participationRate: 0,
      responseCount: 0,
      eligibleCount: 0,
      previousGlobalScore: null,
      byQuestion: [],
      bySite: [],
    };
  }

  const eligibleWhere = withCompany(companyId, { isActive: true });

  const responses = survey.responses.filter((r) => {
    if (teamUserIds?.length) return teamUserIds.includes(r.userId);
    if (siteId) return r.user.siteId === siteId;
    return true;
  });

  let eligibleCount;
  if (teamUserIds?.length) {
    eligibleCount = teamUserIds.length;
  } else if (siteId) {
    eligibleCount = await prisma.user.count({ where: { ...eligibleWhere, siteId } });
  } else {
    eligibleCount = await prisma.user.count({ where: eligibleWhere });
  }

  const responseCount = new Set(responses.map((r) => r.userId)).size;
  const participationRate = eligibleCount
    ? Math.round((responseCount / eligibleCount) * 100)
    : 0;

  const allScores = responses.flatMap((r) =>
    r.answers.filter((a) => a.score != null).map((a) => a.score),
  );
  const globalScore = averageFromScores(allScores);

  const byQuestionRaw = survey.questions.map((q) => {
    if (q.type === 'TEXT') {
      const texts = responses.flatMap((r) =>
        r.answers.filter((a) => a.questionId === q.id && a.textValue).map((a) => a.textValue),
      );
      return {
        questionId: q.id,
        text: q.text,
        order: q.order,
        type: 'TEXT',
        optional: q.optional,
        averageScore: null,
        responseCount: texts.length,
        textResponseCount: texts.length,
      };
    }
    const scores = responses.flatMap((r) =>
      r.answers.filter((a) => a.questionId === q.id && a.score != null).map((a) => a.score),
    );
    return {
      questionId: q.id,
      text: q.text,
      order: q.order,
      type: 'SCALE',
      optional: false,
      averageScore: averageFromScores(scores),
      responseCount: scores.length,
    };
  });

  const byQuestion = await enrichByQuestionMetrics(
    companyId,
    survey,
    responses,
    byQuestionRaw,
  );

  let bySite = [];

  if (teamUserIds?.length) {
    const site = siteId
      ? await prisma.site.findFirst({
        where: { id: siteId, companyId, isActive: true },
        select: { id: true, name: true },
      })
      : null;
    bySite = [{
      siteId: siteId || null,
      siteName: site?.name || 'Mon équipe',
      averageScore: globalScore,
      participationRate,
      responseCount,
      eligibleCount,
      meetsAnonymity: responseCount >= MIN_AGGREGATE_RESPONSES,
    }];
  } else {
    const sites = await prisma.site.findMany({
      where: withCompany(companyId, { isActive: true }),
      select: { id: true, name: true },
    });

    const scoresBySite = new Map();
    for (const site of sites) scoresBySite.set(site.id, []);
    scoresBySite.set(null, []);

    for (const response of survey.responses) {
      const siteKey = response.user.siteId ?? null;
      if (!scoresBySite.has(siteKey)) scoresBySite.set(siteKey, []);
      scoresBySite.get(siteKey).push(
        ...response.answers.filter((a) => a.score != null).map((a) => a.score),
      );
    }

    const usersPerSite = await prisma.user.groupBy({
      by: ['siteId'],
      where: eligibleWhere,
      _count: { id: true },
    });
    const eligibleBySite = Object.fromEntries(
      usersPerSite.map((row) => [row.siteId ?? 'none', row._count.id]),
    );

    const responsesPerSite = {};
    for (const response of survey.responses) {
      const key = response.user.siteId ?? 'none';
      responsesPerSite[key] = (responsesPerSite[key] || 0) + 1;
    }

    bySite = sites.map((site) => {
      const scores = scoresBySite.get(site.id) || [];
      const eligible = eligibleBySite[site.id] || 0;
      const responded = responsesPerSite[site.id] || 0;
      const averageScore = averageFromScores(scores);
      return {
        siteId: site.id,
        siteName: site.name,
        averageScore,
        participationRate: eligible ? Math.round((responded / eligible) * 100) : 0,
        responseCount: responded,
        eligibleCount: eligible,
        meetsAnonymity: responded >= MIN_AGGREGATE_RESPONSES,
      };
    });

    const unassignedScores = scoresBySite.get(null) || [];
    if (unassignedScores.length || eligibleBySite.none) {
      bySite.push({
        siteId: null,
        siteName: 'Non affecté',
        averageScore: averageFromScores(unassignedScores),
        participationRate: eligibleBySite.none
          ? Math.round(((responsesPerSite.none || 0) / eligibleBySite.none) * 100)
          : 0,
        responseCount: responsesPerSite.none || 0,
        eligibleCount: eligibleBySite.none || 0,
        meetsAnonymity: (responsesPerSite.none || 0) >= MIN_AGGREGATE_RESPONSES,
      });
    }

    if (siteId) {
      bySite = bySite.filter((s) => s.siteId === siteId);
    }
  }

  const closed = await prisma.survey.findFirst({
    where: withCompany(companyId, { status: 'CLOSED' }),
    orderBy: { weekStart: 'desc' },
    include: {
      responses: { include: { answers: { select: { score: true } } } },
    },
  });
  let previousGlobalScore = null;
  if (closed) {
    const prevScores = closed.responses.flatMap((r) => r.answers.map((a) => a.score));
    previousGlobalScore = averageFromScores(prevScores);
  }

  return {
    survey: {
      id: survey.id,
      weekLabel: survey.weekLabel,
      weekStart: survey.weekStart,
    },
    globalScore,
    previousGlobalScore,
    participationRate,
    responseCount,
    eligibleCount,
    byQuestion,
    bySite,
  };
}

async function computeSiteTrends(companyId, siteId, weeks = 6, { teamUserIds = null } = {}) {
  const surveys = await prisma.survey.findMany({
    where: withCompany(companyId, { status: { in: ['ACTIVE', 'CLOSED'] } }),
    orderBy: { weekStart: 'desc' },
    take: weeks,
    include: {
      responses: {
        include: {
          answers: { select: { score: true } },
          user: { select: { id: true, siteId: true } },
        },
      },
    },
  });

  const eligible = teamUserIds?.length
    ? teamUserIds.length
    : await prisma.user.count({
      where: withCompany(companyId, { isActive: true, siteId }),
    });

  return surveys
    .map((survey) => {
      const siteResponses = survey.responses.filter((r) => {
        if (teamUserIds?.length) return teamUserIds.includes(r.userId);
        return r.user.siteId === siteId;
      });
      const scores = siteResponses.flatMap((r) => r.answers.map((a) => a.score));
      return {
        weekStart: survey.weekStart,
        weekLabel: survey.weekLabel,
        score: averageFromScores(scores),
        responseCount: siteResponses.length,
        eligibleCount: eligible,
        meetsAnonymity: siteResponses.length >= MIN_AGGREGATE_RESPONSES,
      };
    })
    .reverse();
}

async function absenceRatePercent(companyId, siteId, weeks = 6, { teamUserIds = null } = {}) {
  const since = new Date();
  since.setDate(since.getDate() - weeks * 7);

  const userWhere = teamUserIds?.length
    ? { id: { in: teamUserIds } }
    : { siteId };

  const headcount = teamUserIds?.length
    ? teamUserIds.length
    : await prisma.user.count({
      where: withCompany(companyId, { isActive: true, siteId }),
    });
  if (!headcount) return 0;

  const absences = await prisma.absence.findMany({
    where: {
      companyId,
      user: userWhere,
      startDate: { gte: since },
      status: { in: ['APPROUVE', 'EN_ATTENTE'] },
    },
    select: { days: true },
  });

  const totalDays = absences.reduce((s, a) => s + (a.days || 0), 0);
  const capacity = headcount * weeks;
  return roundScore(Math.min(100, (totalDays / Math.max(1, capacity)) * 100));
}

async function computeCorrelation(companyId, { siteId = null, teamUserIds = null } = {}) {
  const scores = await computeWellbeingScores(companyId, { siteId, teamUserIds });
  const sites = (scores.bySite || []).filter((s) => s.siteId != null || teamUserIds?.length);

  const rows = await Promise.all(
    sites.map(async (site) => ({
      siteId: site.siteId,
      siteName: site.siteName,
      score: site.averageScore,
      absenceRate: site.siteId
        ? await absenceRatePercent(companyId, site.siteId, 6, { teamUserIds })
        : 0,
      responseCount: site.responseCount,
    })),
  );

  return { sites: rows };
}

module.exports = {
  MIN_AGGREGATE_RESPONSES,
  roundScore,
  averageFromScores,
  scoreDistribution,
  questionSignal,
  computeWellbeingScores,
  computeSiteTrends,
  absenceRatePercent,
  computeCorrelation,
};
