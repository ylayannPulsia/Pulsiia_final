jest.mock('../pulseAdapter', () => ({
  extractIntent: jest.fn(async (text, employees) => ({
    intent: {
      excludeEmployees: employees
        .filter((e) => e.firstName === 'Thomas')
        .map((e) => ({ employeeId: e.id, days: ['saturday'] })),
      priorityCoverage: [],
      minimizeOvertime: false,
      customRules: [text],
    },
    usedAi: true,
    usage: { input_tokens: 50, output_tokens: 80 },
  })),
  explainPlanning: jest.fn(async () => ({
    explanation: 'Planning généré pour la semaine. Couverture : 94%. Thomas est en repos samedi.',
    usedAi: true,
    usage: { input_tokens: 100, output_tokens: 60 },
  })),
  isHaikuAvailable: () => true,
  HAIKU_MODEL: 'claude-haiku-4-5-mock',
}));

const { orchestrate } = require('../planningOrchestrator');

describe('planningOrchestrator', () => {
  const employees = [
    { id: 'e1', firstName: 'Thomas', lastName: 'Martin', department: 'Service', weeklyHours: 35, absences: [] },
    { id: 'e2', firstName: 'Sophie', lastName: 'Durand', department: 'Service', weeklyHours: 35, absences: [] },
    { id: 'e3', firstName: 'Antoine', lastName: 'Petit', department: 'Cuisine', weeklyHours: 35, absences: [] },
  ];
  const weekStart = new Date('2026-03-09T00:00:00');

  test('flux E2E avec prompt naturel', async () => {
    const result = await orchestrate({
      naturalInput: 'évite Thomas samedi, couvre bien vendredi soir',
      employees,
      absences: [],
      weekStart,
      planningRules: { minStaffPerShift: { Service: 1, Cuisine: 1 } },
    });

    expect(result.mode).toBe('hybrid');
    expect(result.explanation).toContain('Thomas');
    expect(result.planning.shifts.length).toBeGreaterThan(0);

    const thomasSat = result.planning.shifts.find(
      (s) => s.employeeId === 'e1' && s.date === '2026-03-14',
    );
    expect(thomasSat?.type).toBe('OFF');
  });
});
