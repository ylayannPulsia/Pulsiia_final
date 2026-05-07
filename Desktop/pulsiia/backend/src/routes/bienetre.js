'use strict';

const { Router } = require('express');
const { z } = require('zod');
const prisma = require('../lib/prisma');
const { authenticate, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { ValidationError, NotFoundError } = require('../utils/errors');

const router = Router();
router.use(authenticate);

const QUESTION_CHOICES = ['Très mal', 'Mal', 'Bof', 'Bien', 'Au top'];

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(new ValidationError(result.error.errors[0].message));
    req.body = result.data;
    next();
  };
}

const surveySchema = z.object({
  title: z.string().min(2).max(200),
  weekStart: z.string().datetime(),
  questions: z.array(z.object({
    prompt: z.string().min(1).max(300),
    order: z.number().int().min(0).default(0),
  })).min(1).max(10),
});

const respondSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().cuid(),
    value: z.number().int().min(1).max(5),
    comment: z.string().max(500).optional(),
  })).min(1),
});

// ─── GET /api/bienetre/surveys ────────────────────────────────────────────────

router.get('/surveys', async (req, res, next) => {
  try {
    const { companyId, role } = req.user;
    const MANAGERS = ['MANAGER', 'RH', 'DRH', 'ADMIN'];
    const isManager = MANAGERS.includes(role);
    const { status, page = '1', limit = '20' } = req.query;

    const where = { companyId };
    if (status) where.status = status;
    if (!isManager) where.status = 'OPEN';

    const skip = (Number(page) - 1) * Number(limit);
    const [surveys, total] = await Promise.all([
      prisma.survey.findMany({
        where,
        include: {
          questions: { orderBy: { position: 'asc' } },
          _count: { select: { responses: true } },
        },
        orderBy: { weekStart: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.survey.count({ where }),
    ]);

    res.json({ surveys, total });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/bienetre/surveys/:id/scores ─────────────────────────────────────

router.get('/surveys/:id/scores', requireRole('MANAGER'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const survey = await prisma.survey.findFirst({
      where: { id: req.params.id, companyId },
      include: { questions: { orderBy: { position: 'asc' } } },
    });
    if (!survey) return next(new NotFoundError('Sondage introuvable'));

    const answers = await prisma.answer.findMany({
      where: { response: { surveyId: survey.id } },
      include: { question: { select: { id: true, prompt: true, position: true } } },
    });

    const byQuestion = {};
    for (const a of answers) {
      const qid = a.questionId;
      if (!byQuestion[qid]) byQuestion[qid] = { question: a.question, values: [], avg: 0, count: 0 };
      byQuestion[qid].values.push(a.value);
    }
    for (const q of Object.values(byQuestion)) {
      q.avg = q.values.reduce((s, v) => s + v, 0) / q.values.length;
      q.count = q.values.length;
      delete q.values;
    }

    const responseCount = await prisma.surveyResponse.count({ where: { surveyId: survey.id } });
    const globalAvg = responseCount > 0
      ? answers.reduce((s, a) => s + a.value, 0) / answers.length
      : null;

    res.json({
      surveyId: survey.id,
      title: survey.title,
      weekStart: survey.weekStart,
      status: survey.status,
      responseCount,
      globalAvg,
      byQuestion: Object.values(byQuestion).sort((a, b) => a.question.position - b.question.position),
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/bienetre/trends ─────────────────────────────────────────────────

router.get('/trends', requireRole('MANAGER'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const weeks = Math.min(Number(req.query.weeks || 8), 52);

    const surveys = await prisma.survey.findMany({
      where: { companyId, status: { in: ['CLOSED', 'OPEN'] } },
      include: { responses: { select: { score: true } } },
      orderBy: { weekStart: 'desc' },
      take: weeks,
    });

    const trend = surveys.map(s => ({
      weekStart: s.weekStart,
      title: s.title,
      responseCount: s.responses.length,
      avg: s.responses.length > 0
        ? s.responses.reduce((acc, r) => acc + Number(r.score), 0) / s.responses.length
        : null,
    })).reverse();

    res.json({ trend });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/bienetre/surveys ───────────────────────────────────────────────

router.post('/surveys', requireRole('RH'), validate(surveySchema), audit('bienetre.survey.create'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const { title, weekStart, questions } = req.body;

    const survey = await prisma.survey.create({
      data: {
        companyId,
        title,
        weekStart: new Date(weekStart),
        status: 'OPEN',
        questions: {
          create: questions.map((q, i) => ({
            prompt: q.prompt,
            position: q.order ?? i,
            choices: QUESTION_CHOICES,
          })),
        },
      },
      include: { questions: { orderBy: { position: 'asc' } } },
    });

    res.status(201).json(survey);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/bienetre/surveys/:id/respond ───────────────────────────────────

router.post('/surveys/:id/respond', validate(respondSchema), audit('bienetre.survey.respond'), async (req, res, next) => {
  try {
    const { companyId, id: callerId } = req.user;
    const { answers } = req.body;

    const survey = await prisma.survey.findFirst({ where: { id: req.params.id, companyId } });
    if (!survey) return next(new NotFoundError('Sondage introuvable'));
    if (survey.status !== 'OPEN') return next(new ValidationError('Ce sondage n\'est plus ouvert'));

    const existing = await prisma.surveyResponse.findFirst({
      where: { surveyId: survey.id, userId: callerId },
    });
    if (existing) return next(new ValidationError('Vous avez déjà répondu à ce sondage'));

    const avg = answers.reduce((s, a) => s + a.value, 0) / answers.length;

    await prisma.surveyResponse.create({
      data: {
        surveyId: survey.id,
        userId: callerId,
        score: avg.toFixed(2),
        answers: {
          create: answers.map(a => ({
            questionId: a.questionId,
            value: a.value,
            comment: a.comment || null,
          })),
        },
      },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/bienetre/surveys/:id/close ─────────────────────────────────────

router.post('/surveys/:id/close', requireRole('RH'), audit('bienetre.survey.close'), async (req, res, next) => {
  try {
    const { companyId } = req.user;
    const survey = await prisma.survey.findFirst({ where: { id: req.params.id, companyId } });
    if (!survey) return next(new NotFoundError('Sondage introuvable'));
    if (survey.status !== 'OPEN') return next(new ValidationError('Ce sondage n\'est pas ouvert'));

    const updated = await prisma.survey.update({
      where: { id: req.params.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
