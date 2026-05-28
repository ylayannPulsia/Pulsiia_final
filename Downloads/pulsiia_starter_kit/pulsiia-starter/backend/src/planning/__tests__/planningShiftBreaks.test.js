const {
  shiftNetMinutes,
  applyBreakToShift,
  buildSplitShiftsFromSlot,
} = require('../planningShiftBreaks');

describe('planningShiftBreaks', () => {
  test('shiftNetMinutes subtracts breakMin', () => {
    const mins = shiftNetMinutes({
      type: 'JOURNEE',
      startTime: '09:00',
      endTime: '17:00',
      breakMin: 30,
    });
    expect(mins).toBe(450);
  });

  test('applyBreakToShift adds pause for long shifts', () => {
    const out = applyBreakToShift({
      type: 'JOURNEE',
      startTime: '09:00',
      endTime: '18:00',
    }, { breakPolicy: { enabled: true, defaultBreakMin: 30, minShiftMinutesForBreak: 360 } });
    expect(out.breakMin).toBe(30);
    expect(out.breakStart).toMatch(/^\d{2}:\d{2}$/);
  });

  test('buildSplitShiftsFromSlot creates two segments', () => {
    const segments = buildSplitShiftsFromSlot(
      { date: '2026-06-01', type: 'JOURNEE', startTime: '11:00' },
      { id: 'u1', jobTitle: 'Serveur' },
      {},
    );
    expect(segments).toHaveLength(2);
    expect(segments[0].startTime).toBe('09:00');
    expect(segments[1].startTime).toBe('17:00');
  });
});
