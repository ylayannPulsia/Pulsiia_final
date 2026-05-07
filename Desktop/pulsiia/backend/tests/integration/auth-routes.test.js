'use strict';

// Tests d'intégration routes auth — CDC §14.2 "auth.test.js — login, refresh, logout (7 tests)"
// Requiert PostgreSQL (TEST_DATABASE_URL ou DATABASE_URL vers pulsiia_test)

const request = require('supertest');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const app = require('../../src/index');

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

// ─── Données de test ─────────────────────────────────────────────────────────

let company;
let testUser;

beforeAll(async () => {
  await prisma.$connect();
  // Nettoyage
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany({ where: { email: 'test.auth@pulsiia-test.fr' } });
  await prisma.company.deleteMany({ where: { slug: 'test-auth-co' } });

  company = await prisma.company.create({
    data: {
      name: 'Test Auth Co',
      slug: 'test-auth-co',
      sector: 'HCR',
      emailDomain: 'pulsiia-test.fr',
      authMode: 'PASSWORD',
    },
  });

  testUser = await prisma.user.create({
    data: {
      email: 'test.auth@pulsiia-test.fr',
      firstName: 'Test',
      lastName: 'Auth',
      role: 'COLLABORATEUR',
      companyId: company.id,
      passwordHash: await bcrypt.hash('TestPass123!', 4),
      isActive: true,
    },
  });
});

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: testUser.id } });
  await prisma.user.delete({ where: { id: testUser.id } });
  await prisma.company.delete({ where: { id: company.id } });
  await prisma.$disconnect();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/auth/check-domain', () => {
  it('retourne PASSWORD pour un domaine inconnu', async () => {
    const res = await request(app)
      .post('/api/auth/check-domain')
      .send({ email: 'quelquun@inconnu.fr' });
    expect(res.status).toBe(200);
    expect(res.body.authMode).toBe('PASSWORD');
  });

  it('retourne le mode d\'auth de l\'entreprise pour un domaine connu', async () => {
    const res = await request(app)
      .post('/api/auth/check-domain')
      .send({ email: 'user@pulsiia-test.fr' });
    expect(res.status).toBe(200);
    expect(res.body.authMode).toBe('PASSWORD');
    expect(res.body.companyName).toBe('Test Auth Co');
  });
});

describe('POST /api/auth/login', () => {
  it('authentifie avec des credentials valides', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test.auth@pulsiia-test.fr', password: 'TestPass123!' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    expect(res.body.user.email).toBe('test.auth@pulsiia-test.fr');
  });

  it('rejette un mot de passe incorrect (401)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test.auth@pulsiia-test.fr', password: 'MauvaisMotDePasse' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejette un email inconnu (401 — pas d\'information sur l\'existence)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'inconnu@pulsiia-test.fr', password: 'TestPass123!' });
    expect(res.status).toBe(401);
  });

  it('valide le format de l\'email (422)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'pas-un-email', password: 'TestPass123!' });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/auth/refresh + GET /api/auth/me + POST /api/auth/logout', () => {
  let accessToken;
  let refreshToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test.auth@pulsiia-test.fr', password: 'TestPass123!' });
    accessToken = res.body.accessToken;
    refreshToken = res.body.refreshToken;
  });

  it('GET /me retourne le profil de l\'utilisateur connecté', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('test.auth@pulsiia-test.fr');
  });

  it('GET /me sans token retourne 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('POST /refresh génère un nouvel access token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    // Le refresh token ne doit plus fonctionner (rotation single-use)
    const reuse = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });
    expect(reuse.status).toBe(401);
    // Mettre à jour pour le logout
    refreshToken = res.body.refreshToken;
  });

  it('POST /logout révoque le refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken });
    expect(res.status).toBe(200);
    // Vérifier que le token est bien révoqué
    const retryRefresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });
    expect(retryRefresh.status).toBe(401);
  });
});
