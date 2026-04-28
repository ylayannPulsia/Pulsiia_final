/**
 * Unit tests — Prioritizer
 */

const { Prioritizer } = require('../../../src/proactive/prioritizer');
const { SEVERITY } = require('../../../src/proactive/rules');

const mockPrisma = (recentSent = []) => ({
  proactiveAlertSent: {
    findMany: jest.fn().mockResolvedValue(recentSent),
  },
});

describe('Prioritizer', () => {
  let prioritizer, prisma;

  beforeEach(() => {
    prisma = mockPrisma();
    prioritizer = new Prioritizer({ prisma, logger: console });
  });

  it("retourne un résultat vide si aucune alerte", async () => {
    const result = await prioritizer.filter([], {}, { userId: 'u1' });
    expect(result.toSend).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("respecte les heures de silence", async () => {
    // Mock l'heure courante à 22h
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) {
        if (args.length === 0) return new realDate(2026, 2, 4, 22, 0);
        return new realDate(...args);
      }
      static now() {
        return new realDate(2026, 2, 4, 22, 0).getTime();
      }
    };

    const alerts = [
      { rule: 'planning.uncovered_shift_72h', severity: SEVERITY.HIGH, target: { type: 'shift', id: 's1' } },
      { rule: 'planning.uncovered_shift_24h', severity: SEVERITY.CRITICAL, target: { type: 'shift', id: 's2' } },
    ];

    const result = await prioritizer.filter(
      alerts,
      { silenceFromHour: 19, silenceToHour: 7 },
      { userId: 'u1' }
    );

    // CRITICAL passe, HIGH bloqué
    expect(result.toSend).toHaveLength(1);
    expect(result.toSend[0].severity).toBe(SEVERITY.CRITICAL);
    expect(result.skipped[0].reason).toBe('silence_window');

    global.Date = realDate;
  });

  it("respecte le cooldown", async () => {
    prisma.proactiveAlertSent.findMany.mockResolvedValue([
      {
        ruleId: 'planning.uncovered_shift_72h',
        targetType: 'shift',
        targetId: 's1',
        sentAt: new Date(Date.now() - 30 * 60 * 1000), // il y a 30 min
      },
    ]);

    const alerts = [
      {
        rule: 'planning.uncovered_shift_72h',
        severity: SEVERITY.HIGH,
        target: { type: 'shift', id: 's1' },
      },
    ];

    // Le cooldown de cette règle est 240 min, donc 30min < cooldown → skip
    const result = await prioritizer.filter(alerts, {}, { userId: 'u1' });
    expect(result.toSend).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/cooldown/);
  });

  it("trie par sévérité décroissante", async () => {
    const alerts = [
      { rule: 'r1', severity: SEVERITY.LOW, target: { type: 't', id: '1' } },
      { rule: 'r2', severity: SEVERITY.CRITICAL, target: { type: 't', id: '2' } },
      { rule: 'r3', severity: SEVERITY.MED, target: { type: 't', id: '3' } },
    ];
    const result = await prioritizer.filter(alerts, {}, { userId: 'u1' });
    expect(result.toSend.map((a) => a.severity)).toEqual([
      SEVERITY.CRITICAL,
      SEVERITY.MED,
      SEVERITY.LOW,
    ]);
  });

  it("applique le cap horaire (sauf CRITICAL)", async () => {
    const manyMed = Array.from({ length: 8 }, (_, i) => ({
      rule: `r${i}`,
      severity: SEVERITY.MED,
      target: { type: 't', id: `${i}` },
    }));
    const result = await prioritizer.filter(manyMed, {}, { userId: 'u1' });
    expect(result.toSend).toHaveLength(5); // HOURLY_CAP
    expect(result.skipped.filter((s) => s.reason === 'hourly_cap')).toHaveLength(3);
  });

  describe('_inSilenceWindow', () => {
    it('détecte fenêtre wrappée (19h → 7h)', () => {
      expect(prioritizer._inSilenceWindow(new Date(2026, 2, 4, 22), { silenceFromHour: 19, silenceToHour: 7 })).toBe(true);
      expect(prioritizer._inSilenceWindow(new Date(2026, 2, 4, 5), { silenceFromHour: 19, silenceToHour: 7 })).toBe(true);
      expect(prioritizer._inSilenceWindow(new Date(2026, 2, 4, 12), { silenceFromHour: 19, silenceToHour: 7 })).toBe(false);
    });
    it('détecte fenêtre non-wrappée (12h → 14h)', () => {
      expect(prioritizer._inSilenceWindow(new Date(2026, 2, 4, 13), { silenceFromHour: 12, silenceToHour: 14 })).toBe(true);
      expect(prioritizer._inSilenceWindow(new Date(2026, 2, 4, 11), { silenceFromHour: 12, silenceToHour: 14 })).toBe(false);
    });
    it('retourne false si silenceFromHour absent', () => {
      expect(prioritizer._inSilenceWindow(new Date(), {})).toBe(false);
      expect(prioritizer._inSilenceWindow(new Date(), null)).toBe(false);
    });
  });
});
