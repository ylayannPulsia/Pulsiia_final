/**
 * Unit tests — ToolExecutor
 */

const { ToolExecutor } = require('../../src/tools/executor');

// ─── Mocks ──────────────────────────────────────
const mockPrisma = () => ({
  shift: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
  variablePaie: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  auditLog: {
    create: jest.fn().mockResolvedValue({}),
  },
});

const mockServices = () => ({
  planning: {
    detectUncoveredShifts: jest.fn(),
    suggestReplacement: jest.fn(),
  },
  prepaie: { detectAnomalies: jest.fn() },
  bienetre: {
    analyzeTeam: jest.fn(),
    predictTurnover: jest.fn(),
  },
  roi: { computeMonthly: jest.fn() },
});

const mockLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
});

const baseCtx = {
  user: {
    id: 'user-1',
    email: 'marie.lambert@saveurs.fr',
    role: 'DRH',
    permissions: { write: true },
  },
  tenantId: 'tenant-1',
  sessionId: 'sess-1',
};

// ─── Tests ──────────────────────────────────────
describe('ToolExecutor', () => {
  let prisma, services, logger, executor;

  beforeEach(() => {
    prisma = mockPrisma();
    services = mockServices();
    logger = mockLogger();
    executor = new ToolExecutor({ prisma, services, logger });
  });

  describe('permissions', () => {
    it('refuse l\'action sans utilisateur authentifié', async () => {
      const result = await executor.execute('lire_planning', {}, {});
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Authentification/);
    });

    it('refuse valider_variable_paie pour un MANAGER', async () => {
      const ctx = {
        ...baseCtx,
        user: { ...baseCtx.user, role: 'MANAGER' },
      };
      const result = await executor.execute(
        'valider_variable_paie',
        { variable_id: 'v1' },
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Permission refusée/);
    });

    it('autorise valider_variable_paie pour un DRH', async () => {
      prisma.variablePaie.update.mockResolvedValue({
        id: 'v1',
        statut: 'VALIDE',
      });
      const result = await executor.execute(
        'valider_variable_paie',
        { variable_id: 'v1' },
        baseCtx
      );
      expect(result.ok).toBe(true);
      expect(prisma.variablePaie.update).toHaveBeenCalled();
    });

    it('refuse une action en écriture si permissions.write absent', async () => {
      const ctx = {
        ...baseCtx,
        user: { ...baseCtx.user, permissions: { write: false } },
      };
      const result = await executor.execute(
        'creer_shift',
        {
          collaborateur_id: 'c1',
          date: '2026-04-01',
          heure_debut: '06:00',
          heure_fin: '14:00',
          type_shift: 'matin',
          etablissement_id: 'e1',
        },
        ctx
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/écriture/);
    });
  });

  describe('dispatch', () => {
    it('retourne une erreur pour un tool inconnu', async () => {
      const result = await executor.execute('outil_fictif', {}, baseCtx);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Tool inconnu/);
    });
  });

  describe('lire_planning', () => {
    it('retourne les shifts formatés', async () => {
      prisma.shift.findMany.mockResolvedValue([
        {
          id: 's1',
          date: new Date('2026-03-04'),
          heureDebut: '06:00',
          heureFin: '14:00',
          typeShift: 'matin',
          statut: 'PLANIFIE',
          collaborateur: { id: 'c1', nom: 'Martin', prenom: 'Thomas' },
        },
      ]);

      const result = await executor.execute(
        'lire_planning',
        { date_debut: '2026-03-03', date_fin: '2026-03-09' },
        baseCtx
      );

      expect(result.ok).toBe(true);
      expect(result.data.total).toBe(1);
      expect(result.data.shifts[0].collaborateur).toBe('Thomas M.');
    });
  });

  describe('audit log', () => {
    it('logge chaque exécution réussie', async () => {
      prisma.shift.findMany.mockResolvedValue([]);
      await executor.execute(
        'lire_planning',
        { date_debut: '2026-03-03', date_fin: '2026-03-09' },
        baseCtx
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'pulse.lire_planning',
            outcome: 'success',
            userId: 'user-1',
          }),
        })
      );
    });

    it('logge les échecs avec le message d\'erreur', async () => {
      prisma.shift.findMany.mockRejectedValue(new Error('DB down'));
      await executor.execute(
        'lire_planning',
        { date_debut: '2026-03-03', date_fin: '2026-03-09' },
        baseCtx
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: 'error',
            error: 'DB down',
          }),
        })
      );
    });
  });

  describe('bien-être anonymisation', () => {
    it('appelle le service avec anonymize:true', async () => {
      services.bienetre.analyzeTeam.mockResolvedValue({ score: 7.6 });
      await executor.execute(
        'analyser_bienetre_equipe',
        { equipe_id: 'eq1' },
        baseCtx
      );
      expect(services.bienetre.analyzeTeam).toHaveBeenCalledWith(
        expect.objectContaining({ anonymize: true })
      );
    });
  });
});
