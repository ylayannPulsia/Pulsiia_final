/**
 * E2E test — Express routes via supertest
 */

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Bonjour Marie !' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
    },
  }));
});

const express = require('express');
const request = require('supertest');
const { createPulseRouter } = require('../../src/routes');

describe('Pulse routes (E2E)', () => {
  let app;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';

    const fakeAuth = (req, res, next) => {
      req.user = {
        id: 'u1',
        email: 'marie@saveurs.fr',
        prenom: 'Marie',
        nom: 'Lambert',
        role: 'DRH',
        tenantId: 't1',
        tenant: { nom: 'Saveurs', etablissements: ['Paris 11'] },
        permissions: { write: true },
      };
      next();
    };

    const router = createPulseRouter({
      prisma: { auditLog: { create: jest.fn().mockResolvedValue({}) } },
      services: {},
      logger: { info: () => {}, error: () => {}, warn: () => {} },
      requireAuth: fakeAuth,
    });

    app = express();
    app.use(express.json());
    app.use('/api/pulse', router);
  });

  it('GET /health → 200', async () => {
    const res = await request(app).get('/api/pulse/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.model).toBe('claude-opus-4-7');
  });

  it('POST /chat avec message valide → 200 + reply', async () => {
    const res = await request(app)
      .post('/api/pulse/chat')
      .send({ messages: [{ role: 'user', content: 'Bonjour' }] });
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/Bonjour Marie/);
    expect(res.body.sessionId).toBeDefined();
  });

  it('POST /chat sans messages → 400', async () => {
    const res = await request(app)
      .post('/api/pulse/chat')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non vide/);
  });

  it('POST /chat avec historique trop long → 400', async () => {
    const longMessages = Array.from({ length: 31 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`,
    }));
    const res = await request(app)
      .post('/api/pulse/chat')
      .send({ messages: longMessages });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/trop long/);
  });
});
