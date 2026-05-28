const {
  computeContractLimits,
  normalizePlanningRules,
  shiftDefaultsFromRules,
} = require('../labor-contract');

describe('labor-contract', () => {
  test('temps plein 39h — max légal 48h', () => {
    const lim = computeContractLimits({ weeklyHours: 39, contractType: 'CDI' }, normalizePlanningRules({}));
    expect(lim.contractWeeklyHours).toBe(39);
    expect(lim.maxWeeklyHoursLegal).toBe(48);
    expect(lim.maxWeeklyHoursPlanning).toBe(48);
    expect(lim.overtimeThreshold).toBe(39);
  });

  test('mi-temps 24h — max planifiable plafonné', () => {
    const lim = computeContractLimits({ weeklyHours: 24, contractType: 'CDI' }, normalizePlanningRules({}));
    expect(lim.isPartTime).toBe(true);
    expect(lim.maxWeeklyHoursPlanning).toBeLessThanOrEqual(48);
    expect(lim.maxWeeklyHoursPlanning).toBeCloseTo(31.9, 0);
  });

  test('shift nuit désactivé dans les templates', () => {
    const rules = normalizePlanningRules({
      shiftTemplates: { NUIT: { enabled: false, start: '22:00', end: '06:00' } },
    });
    const defaults = shiftDefaultsFromRules(rules);
    expect(defaults.NUIT.start).toBe('22:00');
    expect(rules.shiftTemplates.NUIT.enabled).toBe(false);
  });
});
