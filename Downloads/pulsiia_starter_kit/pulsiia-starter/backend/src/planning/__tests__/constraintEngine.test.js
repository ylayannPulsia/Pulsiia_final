const {
  validateShift,
  validatePlanning,
  weeklyHours,
  checkDailyRest,
  detectSurcharges,
  CHR_RULES,
} = require('../constraintEngine');
const { EMP_A, FIXTURES } = require('../chrFixtures');

describe('constraintEngine', () => {
  test('refuse un shift de 14h (max 10h/jour)', () => {
    const { valid, violations } = validateShift(EMP_A, FIXTURES.shift14h, []);
    expect(valid).toBe(false);
    expect(violations.some((v) => v.includes('10h'))).toBe(true);
  });

  test('accepte un shift matin légal 8h', () => {
    const { valid } = validateShift(EMP_A, FIXTURES.shiftLegal8h, []);
    expect(valid).toBe(true);
  });

  test('repos insuffisant entre nuit et matin (< 11h)', () => {
    const rest = checkDailyRest(FIXTURES.shiftNight, FIXTURES.shiftAfterNight);
    expect(rest).toBeLessThan(CHR_RULES.MIN_DAILY_REST);
    const { valid } = validateShift(EMP_A, FIXTURES.shiftAfterNight, [FIXTURES.shiftNight]);
    expect(valid).toBe(false);
  });

  test('weeklyHours calcule correctement', () => {
    const shifts = [
      FIXTURES.shiftLegal8h,
      { ...FIXTURES.shiftLegal8h, date: '2026-03-11' },
    ];
    expect(weeklyHours(shifts)).toBe(16);
  });

  test('detectSurcharges — majoration nuit', () => {
    const s = detectSurcharges(FIXTURES.shiftNight);
    expect(s.night).toBe(true);
  });

  test('validatePlanning — semaine 48h+ refusée', () => {
    const shifts = [];
    for (let i = 0; i < 7; i++) {
      shifts.push({
        employeeId: 'emp-a',
        date: `2026-03-${String(9 + i).padStart(2, '0')}`,
        type: 'MATIN',
        startTime: '06:00',
        endTime: '14:00',
      });
    }
    const result = validatePlanning([EMP_A], { shifts }, FIXTURES.weekStart);
    expect(result.valid).toBe(false);
  });

  test('validatePlanning — planning conforme 5 jours', () => {
    const shifts = [];
    for (let i = 0; i < 5; i++) {
      shifts.push({
        employeeId: 'emp-a',
        date: `2026-03-${String(9 + i).padStart(2, '0')}`,
        type: 'MATIN',
        startTime: '06:00',
        endTime: '14:00',
      });
    }
    const result = validatePlanning([EMP_A], { shifts }, FIXTURES.weekStart);
    expect(result.valid).toBe(true);
  });
});
