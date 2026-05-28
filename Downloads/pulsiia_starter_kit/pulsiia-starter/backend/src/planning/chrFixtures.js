// Fixtures — cas limites règles CHR (Couche 1)
const EMP_A = { id: 'emp-a', firstName: 'Alice', weeklyHours: 35, absences: [] };
const EMP_B = { id: 'emp-b', firstName: 'Bob', weeklyHours: 35, absences: [] };

const FIXTURES = {
  shift14h: {
    employeeId: 'emp-a',
    date: '2026-03-10',
    type: 'JOURNEE',
    startTime: '06:00',
    endTime: '20:00',
  },
  shiftLegal8h: {
    employeeId: 'emp-a',
    date: '2026-03-10',
    type: 'MATIN',
    startTime: '06:00',
    endTime: '14:00',
  },
  shiftNight: {
    employeeId: 'emp-a',
    date: '2026-03-11',
    type: 'NUIT',
    startTime: '22:00',
    endTime: '06:00',
  },
  shiftAfterNight: {
    employeeId: 'emp-a',
    date: '2026-03-12',
    type: 'MATIN',
    startTime: '06:00',
    endTime: '14:00',
  },
  weekStart: new Date('2026-03-09T00:00:00'),
};

module.exports = { EMP_A, EMP_B, FIXTURES };
