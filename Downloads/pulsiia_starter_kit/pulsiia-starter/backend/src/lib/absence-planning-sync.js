const { startOfDay, endOfDay, eachDayOfInterval, format } = require('date-fns');
const { prisma } = require('../middleware/tenant');

function formatShiftDate(date) {
  return format(date, 'yyyy-MM-dd');
}

/**
 * Met à jour le planning : les jours couverts par une absence approuvée
 * passent en shift ABSENT (remplace MATIN/APREM/NUIT existants).
 */
async function syncAbsenceToPlanningShifts(absence) {
  if (!absence || absence.status !== 'APPROUVE') return { updated: 0, created: 0 };

  const user = await prisma.user.findFirst({
    where: { id: absence.userId, companyId: absence.companyId, isActive: true },
    select: { id: true, siteId: true, companyId: true },
  });
  if (!user?.siteId) return { updated: 0, created: 0 };

  const rangeStart = startOfDay(absence.startDate);
  const rangeEnd = startOfDay(absence.endDate);
  let updated = 0;
  let created = 0;

  for (const day of eachDayOfInterval({ start: rangeStart, end: rangeEnd })) {
    const dayStart = startOfDay(day);
    const dayEnd = endOfDay(day);

    const existing = await prisma.shift.findMany({
      where: {
        userId: absence.userId,
        companyId: absence.companyId,
        date: { gte: dayStart, lte: dayEnd },
      },
    });

    if (existing.length) {
      const nonAbsent = existing.filter((s) => s.type !== 'ABSENT');
      if (nonAbsent.length) {
        await prisma.shift.deleteMany({
          where: { id: { in: nonAbsent.map((s) => s.id) } },
        });
        updated += nonAbsent.length;
      }
      const absentShift = existing.find((s) => s.type === 'ABSENT');
      if (!absentShift) {
        await prisma.shift.create({
          data: {
            userId: absence.userId,
            siteId: user.siteId,
            companyId: absence.companyId,
            date: dayStart,
            type: 'ABSENT',
            notes: absence.type,
          },
        });
        created += 1;
      }
    } else {
      await prisma.shift.create({
        data: {
          userId: absence.userId,
          siteId: user.siteId,
          companyId: absence.companyId,
          date: dayStart,
          type: 'ABSENT',
          notes: absence.type,
        },
      });
      created += 1;
    }
  }

  return { updated, created };
}

module.exports = { syncAbsenceToPlanningShifts };
