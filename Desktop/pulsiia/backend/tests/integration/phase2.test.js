'use strict';

// Tests d'intégration Phase 2 — planning, absences, prepaie, bienetre, communication
// Requiert PostgreSQL (DATABASE_URL → pulsiia_test)

const request = require('supertest');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const app = require('../../src/index');

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

// ─── Setup ────────────────────────────────────────────────────────────────────

let company, site;
let drh, manager, rh, collab;
let drhToken, managerToken, rhToken, collabToken;

async function login(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

beforeAll(async () => {
  await prisma.$connect();

  // Nettoyage
  await prisma.message.deleteMany({ where: { channel: { company: { slug: 'test-p2' } } } });
  await prisma.channel.deleteMany({ where: { company: { slug: 'test-p2' } } });
  await prisma.answer.deleteMany({ where: { response: { survey: { company: { slug: 'test-p2' } } } } });
  await prisma.surveyResponse.deleteMany({ where: { survey: { company: { slug: 'test-p2' } } } });
  await prisma.question.deleteMany({ where: { survey: { company: { slug: 'test-p2' } } } });
  await prisma.survey.deleteMany({ where: { company: { slug: 'test-p2' } } });
  await prisma.payVariable.deleteMany({ where: { company: { slug: 'test-p2' } } });
  await prisma.absence.deleteMany({ where: { company: { slug: 'test-p2' } } });
  await prisma.shift.deleteMany({ where: { company: { slug: 'test-p2' } } });
  await prisma.refreshToken.deleteMany({ where: { user: { company: { slug: 'test-p2' } } } });
  await prisma.user.deleteMany({ where: { company: { slug: 'test-p2' } } });
  await prisma.site.deleteMany({ where: { company: { slug: 'test-p2' } } });
  await prisma.company.deleteMany({ where: { slug: 'test-p2' } });

  const passwordHash = await bcrypt.hash('TestPass123!', 4);

  company = await prisma.company.create({
    data: {
      name: 'Test Phase 2',
      slug: 'test-p2',
      sector: 'HCR',
      emailDomain: 'test-p2.fr',
      authMode: 'PASSWORD',
    },
  });

  site = await prisma.site.create({
    data: { companyId: company.id, name: 'Site Principal', city: 'Paris', isHQ: true },
  });

  [drh, manager, rh, collab] = await Promise.all([
    prisma.user.create({ data: { companyId: company.id, email: 'drh@test-p2.fr', firstName: 'DRH', lastName: 'Test', role: 'DRH', passwordHash, isActive: true, primarySiteId: site.id } }),
    prisma.user.create({ data: { companyId: company.id, email: 'manager@test-p2.fr', firstName: 'Manager', lastName: 'Test', role: 'MANAGER', passwordHash, isActive: true, primarySiteId: site.id } }),
    prisma.user.create({ data: { companyId: company.id, email: 'rh@test-p2.fr', firstName: 'RH', lastName: 'Test', role: 'RH', passwordHash, isActive: true, primarySiteId: site.id } }),
    prisma.user.create({ data: { companyId: company.id, email: 'collab@test-p2.fr', firstName: 'Collab', lastName: 'Test', role: 'COLLABORATEUR', passwordHash, isActive: true, primarySiteId: site.id } }),
  ]);

  [drhToken, managerToken, rhToken, collabToken] = await Promise.all([
    login('drh@test-p2.fr', 'TestPass123!'),
    login('manager@test-p2.fr', 'TestPass123!'),
    login('rh@test-p2.fr', 'TestPass123!'),
    login('collab@test-p2.fr', 'TestPass123!'),
  ]);
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { channel: { companyId: company.id } } });
  await prisma.channel.deleteMany({ where: { companyId: company.id } });
  await prisma.answer.deleteMany({ where: { response: { survey: { companyId: company.id } } } });
  await prisma.surveyResponse.deleteMany({ where: { survey: { companyId: company.id } } });
  await prisma.question.deleteMany({ where: { survey: { companyId: company.id } } });
  await prisma.survey.deleteMany({ where: { companyId: company.id } });
  await prisma.payVariable.deleteMany({ where: { companyId: company.id } });
  await prisma.absence.deleteMany({ where: { companyId: company.id } });
  await prisma.shift.deleteMany({ where: { companyId: company.id } });
  await prisma.refreshToken.deleteMany({ where: { user: { companyId: company.id } } });
  await prisma.user.deleteMany({ where: { companyId: company.id } });
  await prisma.site.deleteMany({ where: { companyId: company.id } });
  await prisma.company.deleteMany({ where: { id: company.id } });
  await prisma.$disconnect();
});

// ─── Planning ─────────────────────────────────────────────────────────────────

describe('Planning — shifts', () => {
  let shiftId;

  it('POST /api/planning/shifts — manager crée un shift', async () => {
    const startsAt = new Date();
    startsAt.setHours(9, 0, 0, 0);
    const endsAt = new Date(startsAt);
    endsAt.setHours(17, 0, 0, 0);

    const res = await request(app)
      .post('/api/planning/shifts')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({
        userId: collab.id,
        siteId: site.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        type: 'JOURNEE',
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.hoursWorked).toBe('8.00');
    shiftId = res.body.id;
  });

  it('POST /api/planning/shifts — collab ne peut pas créer (403)', async () => {
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + 8 * 3600000);
    const res = await request(app)
      .post('/api/planning/shifts')
      .set('Authorization', `Bearer ${collabToken}`)
      .send({ userId: collab.id, siteId: site.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
    expect(res.status).toBe(403);
  });

  it('GET /api/planning/week — retourne les shifts de la semaine', async () => {
    const res = await request(app)
      .get('/api/planning/week')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('shifts');
    expect(Array.isArray(res.body.shifts)).toBe(true);
  });

  it('PATCH /api/planning/shifts/:id — manager modifie un shift', async () => {
    const res = await request(app)
      .patch(`/api/planning/shifts/${shiftId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ notes: 'Shift modifié' });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('Shift modifié');
  });

  it('DELETE /api/planning/shifts/:id — manager supprime un shift', async () => {
    const res = await request(app)
      .delete(`/api/planning/shifts/${shiftId}`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─── Absences ─────────────────────────────────────────────────────────────────

describe('Absences', () => {
  let absenceId;

  it('POST /api/absences — collab crée une absence pour lui-même', async () => {
    const startsAt = new Date();
    startsAt.setDate(startsAt.getDate() + 10);
    const endsAt = new Date(startsAt);
    endsAt.setDate(startsAt.getDate() + 2);

    const res = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${collabToken}`)
      .send({
        type: 'CP',
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reason: 'Vacances test',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    absenceId = res.body.id;
  });

  it('GET /api/absences — collab ne voit que ses propres absences', async () => {
    const res = await request(app)
      .get('/api/absences')
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(200);
    expect(res.body.absences.every(a => a.user.id === collab.id)).toBe(true);
  });

  it('PUT /api/absences/:id/status — manager approuve une absence', async () => {
    const res = await request(app)
      .put(`/api/absences/${absenceId}/status`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ status: 'APPROVED' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
  });

  it('GET /api/absences/stats/summary — manager voit les stats', async () => {
    const res = await request(app)
      .get('/api/absences/stats/summary')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pendingCount');
  });
});

// ─── Pré-paie ─────────────────────────────────────────────────────────────────

describe('Pré-paie — variables', () => {
  let varId;
  const now = new Date();

  it('POST /api/prepaie/variables — RH crée une variable', async () => {
    const res = await request(app)
      .post('/api/prepaie/variables')
      .set('Authorization', `Bearer ${rhToken}`)
      .send({
        userId: collab.id,
        kind: 'HEURES_SUPP',
        periodYear: now.getFullYear(),
        periodMonth: now.getMonth() + 1,
        amount: 25.5,
        unit: 'h',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    varId = res.body.id;
  });

  it('GET /api/prepaie/variables — RH voit les variables', async () => {
    const res = await request(app)
      .get('/api/prepaie/variables')
      .set('Authorization', `Bearer ${rhToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.variables)).toBe(true);
  });

  it('PUT /api/prepaie/variables/:id/validate — DRH valide une variable', async () => {
    const res = await request(app)
      .put(`/api/prepaie/variables/${varId}/validate`)
      .set('Authorization', `Bearer ${drhToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VALIDATED');
  });

  it('GET /api/prepaie/export — DRH exporte en CSV', async () => {
    const res = await request(app)
      .get(`/api/prepaie/export?year=${now.getFullYear()}&month=${now.getMonth() + 1}`)
      .set('Authorization', `Bearer ${drhToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('GET /api/prepaie/variables — collab ne peut pas accéder (403)', async () => {
    const res = await request(app)
      .get('/api/prepaie/variables')
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(403);
  });
});

// ─── Bien-être ────────────────────────────────────────────────────────────────

describe('Bien-être — sondages', () => {
  let surveyId;
  let questionIds;

  it('POST /api/bienetre/surveys — RH crée un sondage', async () => {
    const weekStart = new Date();
    const day = weekStart.getDay() || 7;
    weekStart.setDate(weekStart.getDate() - day + 1);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() + 14); // semaine prochaine + 1

    const res = await request(app)
      .post('/api/bienetre/surveys')
      .set('Authorization', `Bearer ${rhToken}`)
      .send({
        title: 'Test sondage bien-être',
        weekStart: weekStart.toISOString(),
        questions: [
          { prompt: 'Comment vous sentez-vous ?', order: 0 },
          { prompt: 'La charge de travail était-elle raisonnable ?', order: 1 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.questions).toHaveLength(2);
    surveyId = res.body.id;
    questionIds = res.body.questions.map(q => q.id);
  });

  it('GET /api/bienetre/surveys — collab voit les sondages ouverts', async () => {
    const res = await request(app)
      .get('/api/bienetre/surveys')
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.surveys)).toBe(true);
  });

  it('POST /api/bienetre/surveys/:id/respond — collab répond', async () => {
    const res = await request(app)
      .post(`/api/bienetre/surveys/${surveyId}/respond`)
      .set('Authorization', `Bearer ${collabToken}`)
      .send({
        answers: questionIds.map((qid, i) => ({ questionId: qid, value: 4 - i })),
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/bienetre/surveys/:id/respond — deux fois interdit', async () => {
    const res = await request(app)
      .post(`/api/bienetre/surveys/${surveyId}/respond`)
      .set('Authorization', `Bearer ${collabToken}`)
      .send({
        answers: questionIds.map(qid => ({ questionId: qid, value: 3 })),
      });
    expect(res.status).toBe(422);
  });

  it('GET /api/bienetre/surveys/:id/scores — manager voit les scores', async () => {
    const res = await request(app)
      .get(`/api/bienetre/surveys/${surveyId}/scores`)
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('globalAvg');
    expect(res.body.responseCount).toBe(1);
  });

  it('POST /api/bienetre/surveys/:id/close — RH clôture le sondage', async () => {
    const res = await request(app)
      .post(`/api/bienetre/surveys/${surveyId}/close`)
      .set('Authorization', `Bearer ${rhToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CLOSED');
  });
});

// ─── Communication ────────────────────────────────────────────────────────────

describe('Communication — canaux & messages', () => {
  let channelId, messageId;

  it('POST /api/communication/channels — RH crée un canal', async () => {
    const res = await request(app)
      .post('/api/communication/channels')
      .set('Authorization', `Bearer ${rhToken}`)
      .send({ name: 'Test Channel', kind: 'TEAM' });
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('test-channel');
    channelId = res.body.id;
  });

  it('GET /api/communication/channels — tous les membres voient les canaux', async () => {
    const res = await request(app)
      .get('/api/communication/channels')
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.channels)).toBe(true);
  });

  it('POST /api/communication/channels/:id/messages — collab envoie un message', async () => {
    const res = await request(app)
      .post(`/api/communication/channels/${channelId}/messages`)
      .set('Authorization', `Bearer ${collabToken}`)
      .send({ content: 'Bonjour tout le monde !' });
    expect(res.status).toBe(201);
    expect(res.body.content).toBe('Bonjour tout le monde !');
    messageId = res.body.id;
  });

  it('GET /api/communication/channels/:id/messages — messages paginés', async () => {
    const res = await request(app)
      .get(`/api/communication/channels/${channelId}/messages`)
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
    expect(res.body.messages.length).toBeGreaterThan(0);
  });

  it('PATCH /api/communication/messages/:id — auteur modifie son message', async () => {
    const res = await request(app)
      .patch(`/api/communication/messages/${messageId}`)
      .set('Authorization', `Bearer ${collabToken}`)
      .send({ content: 'Message modifié' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Message modifié');
    expect(res.body.editedAt).not.toBeNull();
  });

  it('POST /api/communication/messages/:id/pin — RH épingle un message', async () => {
    const res = await request(app)
      .post(`/api/communication/messages/${messageId}/pin`)
      .set('Authorization', `Bearer ${rhToken}`);
    expect(res.status).toBe(200);
    expect(res.body.isPinned).toBe(true);
  });

  it('DELETE /api/communication/messages/:id — auteur supprime son message', async () => {
    const res = await request(app)
      .delete(`/api/communication/messages/${messageId}`)
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(200);
  });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

describe('Dashboard', () => {
  it('GET /api/dashboard/kpis — manager voit les KPIs', async () => {
    const res = await request(app)
      .get('/api/dashboard/kpis')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('activeUsers');
    expect(res.body).toHaveProperty('pendingAbsences');
    expect(res.body).toHaveProperty('pendingPayVars');
  });

  it('GET /api/dashboard/kpis — collab n\'a pas accès (403)', async () => {
    const res = await request(app)
      .get('/api/dashboard/kpis')
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(403);
  });

  it('GET /api/dashboard/activity — manager voit l\'activité', async () => {
    const res = await request(app)
      .get('/api/dashboard/activity')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.activity)).toBe(true);
  });
});

// ─── Users ────────────────────────────────────────────────────────────────────

describe('Users', () => {
  it('GET /api/users — manager liste les utilisateurs', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(4);
  });

  it('GET /api/users/:id — collab accède à son propre profil', async () => {
    const res = await request(app)
      .get(`/api/users/${collab.id}`)
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(collab.id);
  });

  it('GET /api/users/:id — collab ne voit pas un autre profil (403)', async () => {
    const res = await request(app)
      .get(`/api/users/${drh.id}`)
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(403);
  });
});

// ─── Sites ────────────────────────────────────────────────────────────────────

describe('Sites', () => {
  it('GET /api/sites — tous les membres voient les sites', async () => {
    const res = await request(app)
      .get('/api/sites')
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sites)).toBe(true);
  });

  it('GET /api/sites/:id — retourne les détails du site', async () => {
    const res = await request(app)
      .get(`/api/sites/${site.id}`)
      .set('Authorization', `Bearer ${collabToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(site.id);
  });
});
