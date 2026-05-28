const { parseForceWorkDays, parseExcludeEmployeesFromText, heuristicExtractIntent } = require('../pulseAdapter');
const { applyForceWorkDays, generatePlanning } = require('../optimizer');

describe('forceWorkDays', () => {
  test('parse « travail du jeudi au samedi »', () => {
    const days = parseForceWorkDays('non il faut du travaille du jeudi au samedi stp');
    expect(days).toEqual(['thursday', 'friday', 'saturday']);
  });

  test('parse « je veux des gens samedi et jeudi »', () => {
    const days = parseForceWorkDays('je veux des gens samedi et jeudi stp');
    expect(days).toContain('thursday');
    expect(days).toContain('saturday');
    expect(days).toHaveLength(2);
  });

  test('parse « personne n\'est la samedi »', () => {
    const days = parseForceWorkDays('personne n\'est la samedi');
    expect(days).toEqual(['saturday']);
  });

  const addPhrases = [
    ['ajoute du monde jeudi', ['thursday']],
    ['rajoute des gens samedi', ['saturday']],
    ['renforce l\'equipe vendredi', ['friday']],
    ['couvre le samedi matin', ['saturday']],
    ['besoin de personnel dimanche', ['sunday']],
    ['il faut du monde mardi', ['tuesday']],
    ['place des salaries jeudi et vendredi', ['thursday', 'friday']],
    ['assigne du staff samedi', ['saturday']],
    ['programme des shifts lundi', ['monday']],
    ['supprime les repos du samedi', ['saturday']],
    ['jeudi à samedi il nous faut du monde', ['thursday', 'friday', 'saturday']],
  ];

  test.each(addPhrases)('couverture : « %s »', (phrase, expected) => {
    const days = parseForceWorkDays(phrase);
    for (const d of expected) expect(days).toContain(d);
  });

  const employees = [
    { id: 'e1', firstName: 'Sophie', lastName: 'Bernard', department: 'Service' },
    { id: 'e2', firstName: 'Marc', lastName: 'Dupont', department: 'Cuisine' },
  ];

  const removePhrases = [
    ['retire Sophie du samedi', 'e1', ['saturday']],
    ['supprime Marc jeudi', 'e2', ['thursday']],
    ['enleve Sophie vendredi', 'e1', ['friday']],
    ['met Sophie en repos lundi', 'e1', ['monday']],
    ['virer Marc du planning mardi', 'e2', ['tuesday']],
    ['Sophie off mercredi', 'e1', ['wednesday']],
  ];

  test.each(removePhrases)('exclusion : « %s »', (phrase, empId, expectedDays) => {
    const ex = parseExcludeEmployeesFromText(phrase, employees);
    expect(ex).toHaveLength(1);
    expect(ex[0].employeeId).toBe(empId);
    for (const d of expectedDays) expect(ex[0].days).toContain(d);
    expect(parseForceWorkDays(phrase)).toEqual([]);
  });

  test('met Sophie en repos ne force pas la couverture du jour', () => {
    expect(parseForceWorkDays('met Sophie en repos vendredi')).toEqual([]);
  });

  test('assigne des shifts jeudi–samedi', () => {
    const employees = [
      { id: 'e1', firstName: 'Sophie', department: 'Service', weeklyHours: 35, absences: [] },
      { id: 'e2', firstName: 'Marc', department: 'Cuisine', weeklyHours: 35, absences: [] },
    ];
    const weekStart = new Date('2026-05-25T00:00:00');
    const result = generatePlanning({
      employees,
      shifts: [],
      absences: [],
      extraConstraints: { forceWorkDays: ['thursday', 'friday', 'saturday'] },
      weekStart,
      planningRules: {},
    });

    for (const day of ['2026-05-28', '2026-05-29', '2026-05-30']) {
      const work = result.planning.shifts.filter(
        (s) => s.date === day && s.type !== 'OFF' && s.type !== 'ABSENT',
      );
      expect(work.length).toBeGreaterThan(0);
    }
  });

  test('assigne plusieurs personnes jeudi et samedi (demande DRH)', () => {
    const employees = [
      { id: 'e1', firstName: 'Sophie', department: 'Service', weeklyHours: 35, absences: [] },
      { id: 'e2', firstName: 'Marc', department: 'Cuisine', weeklyHours: 35, absences: [] },
      { id: 'e3', firstName: 'Clara', department: 'Cuisine', weeklyHours: 35, absences: [] },
      { id: 'e4', firstName: 'Lucie', department: 'Service', weeklyHours: 35, absences: [] },
    ];
    const weekStart = new Date('2026-05-25T00:00:00');
    const result = generatePlanning({
      employees,
      shifts: [],
      absences: [],
      extraConstraints: { forceWorkDays: ['thursday', 'saturday'] },
      weekStart,
      planningRules: {},
    });

    for (const day of ['2026-05-28', '2026-05-30']) {
      const work = result.planning.shifts.filter(
        (s) => s.date === day && s.type !== 'OFF' && s.type !== 'ABSENT',
      );
      expect(work.length).toBeGreaterThanOrEqual(2);
    }
  });
});
