const { generatePlanning, buildDefaultShiftSlots } = require('../optimizer');
const { validatePlanning } = require('../constraintEngine');

const WEEK_START = new Date('2026-03-09T00:00:00');

function makeEmployees(n) {
  const roles = ['Cuisine', 'Service', 'Service', 'Accueil', 'Cuisine', 'Service', 'Plonge', 'Service'];
  return Array.from({ length: n }, (_, i) => ({
    id: `emp-${i}`,
    firstName: `User${i}`,
    lastName: 'Test',
    department: roles[i % roles.length],
    weeklyHours: 35,
    competences: [],
    absences: [],
  }));
}

describe('optimizer', () => {
  test('génère un planning pour 8 salariés et 10+ postes', () => {
    const employees = makeEmployees(8);
    const slots = buildDefaultShiftSlots(WEEK_START, {
      minStaffPerShift: { Cuisine: 1, Service: 1, Accueil: 1 },
    }).slice(0, 12);

    const result = generatePlanning({
      employees,
      shifts: slots,
      absences: [],
      extraConstraints: {},
      weekStart: WEEK_START,
      planningRules: { minStaffPerShift: { Cuisine: 1, Service: 1, Accueil: 1 } },
    });

    expect(result.planning.shifts.length).toBe(8 * 7);
    expect(result.stats.totalShifts).toBeGreaterThan(0);
    expect(result.stats.coverageRate).toBeGreaterThan(0);
  });

  test('respecte excludeEmployees (repos samedi)', () => {
    const employees = makeEmployees(4);
    const thomas = employees[0];
    thomas.firstName = 'Thomas';

    const slots = buildDefaultShiftSlots(WEEK_START, {
      minStaffPerShift: { Service: 1 },
    }).slice(0, 6);

    const result = generatePlanning({
      employees,
      shifts: slots,
      absences: [],
      extraConstraints: {
        excludeEmployees: [{ employeeId: thomas.id, days: ['saturday'] }],
      },
      weekStart: WEEK_START,
      planningRules: { minStaffPerShift: { Service: 1 } },
    });

    const sat = result.planning.shifts.find(
      (s) => s.employeeId === thomas.id && s.date === '2026-03-14',
    );
    expect(sat?.type).toBe('OFF');
  });

  test('planning généré passe validatePlanning (légalité)', () => {
    const employees = makeEmployees(6);
    const slots = buildDefaultShiftSlots(WEEK_START, {
      minStaffPerShift: { Service: 1 },
    }).slice(0, 10);

    const result = generatePlanning({
      employees,
      shifts: slots,
      absences: [],
      extraConstraints: {},
      weekStart: WEEK_START,
      planningRules: { minStaffPerShift: { Service: 1 } },
    });

    const validation = validatePlanning(employees, result.planning, WEEK_START);
    expect(validation.violations.filter((v) => v.message?.includes('10h')).length).toBe(0);
  });
});
