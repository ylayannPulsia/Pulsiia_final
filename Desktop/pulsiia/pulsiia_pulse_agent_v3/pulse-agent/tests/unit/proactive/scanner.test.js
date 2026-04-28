/**
 * Integration test — Scanner
 */

const { Scanner } = require('../../../src/proactive/scanner');

describe('Scanner', () => {
  let prisma, services, notifier, scanner;

  beforeEach(() => {
    prisma = {
      user: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      proactiveAlertSent: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    services = {
      planning: {
        detectUncoveredShifts: jest.fn().mockResolvedValue({ shifts: [] }),
        getDailySummary: jest.fn().mockResolvedValue({ shiftsCount: 0, uncoveredCount: 0 }),
      },
      prepaie: {
        detectAnomalies: jest.fn().mockResolvedValue({ anomalies: [] }),
        getCloture: jest.fn().mockResolvedValue(null),
        getStatus: jest.fn().mockResolvedValue({ aValiderCount: 0 }),
      },
      bienetre: {
        listTeamsWithScoreDrop: jest.fn().mockResolvedValue([]),
        listHighTurnoverRisks: jest.fn().mockResolvedValue([]),
      },
      roi: {
        computeMonthly: jest.fn().mockResolvedValue({ economies_eur: 0 }),
      },
    };
    notifier = { send: jest.fn().mockResolvedValue({ websocket: { ok: true } }) };
    scanner = new Scanner({ prisma, services, notifier, logger: console });
  });

  it("ne scanne pas les utilisateurs avec lastScanAt récent", async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        tenantId: 't1',
        email: 'marie@x.fr',
        prenom: 'Marie',
        nom: 'L',
        role: 'DRH',
        active: true,
        lastScanAt: new Date(), // tout juste scanné
        alertPreferences: { enabled: true, intervalMinutes: 30, channels: ['websocket'] },
      },
    ]);

    const result = await scanner.runScan();
    expect(result.scanned).toBe(1);
    expect(result.alertsSent).toBe(0);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("envoie une alerte CRITICAL pour poste découvert dans les 24h", async () => {
    services.planning.detectUncoveredShifts.mockResolvedValueOnce({
      shifts: [
        {
          id: 'shift1',
          date: new Date().toISOString().slice(0, 10),
          heure_debut: '14:00',
          heure_fin: '22:00',
          type: 'aprem',
          etablissement: 'Paris 11',
        },
      ],
    });

    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        tenantId: 't1',
        email: 'marie@x.fr',
        prenom: 'Marie',
        nom: 'L',
        role: 'DRH',
        active: true,
        lastScanAt: null,
        alertPreferences: {
          enabled: true,
          intervalMinutes: 30,
          channels: ['websocket', 'email'],
        },
      },
    ]);

    const result = await scanner.runScan();
    expect(result.alertsSent).toBeGreaterThanOrEqual(1);
    expect(notifier.send).toHaveBeenCalled();
    const call = notifier.send.mock.calls[0];
    expect(call[0].rule).toBe('planning.uncovered_shift_24h');
    expect(call[2]).toContain('websocket');
  });

  it("ignore digest hors heures du matin", async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        tenantId: 't1',
        email: 'marie@x.fr',
        prenom: 'Marie',
        nom: 'L',
        role: 'DRH',
        active: true,
        lastScanAt: null,
        alertPreferences: { enabled: true, intervalMinutes: 30, channels: ['email'] },
      },
    ]);

    await scanner.runScan({ includeDigest: false });
    // digest.morning ne doit pas être appelé
    expect(services.planning.getDailySummary).not.toHaveBeenCalled();
  });

  it("inclut digest si includeDigest: true", async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        tenantId: 't1',
        email: 'marie@x.fr',
        prenom: 'Marie',
        nom: 'L',
        role: 'DRH',
        active: true,
        lastScanAt: null,
        alertPreferences: { enabled: true, intervalMinutes: 30, channels: ['email'] },
      },
    ]);

    await scanner.runScan({ includeDigest: true });
    expect(services.planning.getDailySummary).toHaveBeenCalled();
  });

  it("met à jour lastScanAt après le scan", async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'u1',
        tenantId: 't1',
        email: 'marie@x.fr',
        prenom: 'Marie',
        nom: 'L',
        role: 'DRH',
        active: true,
        lastScanAt: null,
        alertPreferences: { enabled: true, intervalMinutes: 30, channels: ['websocket'] },
      },
    ]);

    await scanner.runScan();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ lastScanAt: expect.any(Date) }),
      })
    );
  });
});
