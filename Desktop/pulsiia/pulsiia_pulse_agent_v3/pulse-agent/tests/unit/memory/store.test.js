/**
 * Unit tests — MemoryStore
 */

const { MemoryStore } = require('../../../src/memory/store');
const { MockEmbedder } = require('../../../src/memory/embedder');

const mockPrisma = () => ({
  $executeRaw: jest.fn().mockResolvedValue(1),
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  pulseMemory: {
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    delete: jest.fn().mockResolvedValue({}),
  },
});

const baseCtx = { tenantId: 't1', userId: 'u1' };

describe('MemoryStore', () => {
  let prisma, embedder, store;

  beforeEach(() => {
    prisma = mockPrisma();
    embedder = new MockEmbedder();
    store = new MemoryStore({ prisma, embedder, logger: console });
  });

  describe('create', () => {
    it("crée une mémoire avec embedding", async () => {
      const result = await store.create({
        tenantId: 't1',
        category: 'PREFERENCE_COLLAB',
        content: 'Léa préfère ne pas le mercredi',
      });
      expect(result.id).toBeDefined();
      expect(result.content).toBe('Léa préfère ne pas le mercredi');
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it("rejette une catégorie invalide", async () => {
      await expect(
        store.create({
          tenantId: 't1',
          category: 'INVALIDE',
          content: 'test',
        })
      ).rejects.toThrow(/Catégorie invalide/);
    });

    it("rejette un content trop long", async () => {
      await expect(
        store.create({
          tenantId: 't1',
          category: 'DECISION',
          content: 'a'.repeat(501),
        })
      ).rejects.toThrow(/500 caractères/);
    });

    it("scope userId pour PREFERENCE_USER", async () => {
      await store.create({
        tenantId: 't1',
        userId: 'u1',
        category: 'PREFERENCE_USER',
        content: 'Préférence Marie',
      });
      const call = prisma.$executeRaw.mock.calls[0];
      // Le userId devrait être passé dans la query
      expect(JSON.stringify(call)).toContain('u1');
    });
  });

  describe('retrieve', () => {
    it('appelle pgvector avec la bonne query et tenantId', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        {
          id: 'm1',
          category: 'PLANNING_PATTERN',
          content: 'samedi cuisine = +1',
          confidence: 0.9,
          similarity: 0.85,
        },
      ]);

      const result = await store.retrieve(
        'planning samedi soir',
        baseCtx,
        { k: 5 }
      );

      expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
      const callArgs = prisma.$queryRawUnsafe.mock.calls[0];
      expect(callArgs[2]).toBe('t1'); // tenantId
      expect(callArgs[3]).toBe('u1'); // userId
      expect(callArgs[5]).toBe(5); // k
      expect(result).toHaveLength(1);
      expect(result[0].similarity).toBe(0.85);
    });

    it('exige tenantId', async () => {
      await expect(store.retrieve('test', { userId: 'u1' })).rejects.toThrow(
        /tenantId requis/
      );
    });

    it('respecte le filtre minConfidence', async () => {
      await store.retrieve('test', baseCtx, { minConfidence: 0.8 });
      expect(prisma.$queryRawUnsafe.mock.calls[0][4]).toBe(0.8);
    });
  });

  describe('forget (RGPD Art. 17)', () => {
    it("supprime une mémoire qui appartient à l'utilisateur", async () => {
      prisma.pulseMemory.findFirst.mockResolvedValue({
        id: 'm1',
        userId: 'u1',
        tenantId: 't1',
      });
      const result = await store.forget('m1', baseCtx);
      expect(result.ok).toBe(true);
      expect(prisma.pulseMemory.delete).toHaveBeenCalledWith({ where: { id: 'm1' } });
    });

    it("refuse de supprimer une mémoire d'un autre utilisateur", async () => {
      prisma.pulseMemory.findFirst.mockResolvedValue({
        id: 'm1',
        userId: 'autre-user',
        tenantId: 't1',
      });
      await expect(store.forget('m1', baseCtx)).rejects.toThrow(/Accès refusé/);
    });

    it('autorise la suppression de mémoires tenant-wide (userId null)', async () => {
      prisma.pulseMemory.findFirst.mockResolvedValue({
        id: 'm1',
        userId: null,
        tenantId: 't1',
      });
      const result = await store.forget('m1', baseCtx);
      expect(result.ok).toBe(true);
    });
  });

  describe('demote', () => {
    it('décroît la confiance', async () => {
      prisma.pulseMemory.findFirst.mockResolvedValue({
        id: 'm1',
        confidence: 0.7,
        tenantId: 't1',
      });
      prisma.pulseMemory.update.mockResolvedValue({ id: 'm1', confidence: 0.5 });
      const result = await store.demote('m1', baseCtx, 0.2);
      expect(result.confidence).toBe(0.5);
    });

    it('supprime si confidence tombe < 0.2', async () => {
      prisma.pulseMemory.findFirst.mockResolvedValue({
        id: 'm1',
        confidence: 0.3,
        tenantId: 't1',
      });
      const result = await store.demote('m1', baseCtx, 0.2);
      expect(result.deleted).toBe(true);
      expect(prisma.pulseMemory.delete).toHaveBeenCalled();
    });
  });
});
