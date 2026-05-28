// Disponibilité QCM : période + jours travaillés (planning)
const { addDays, startOfDay, endOfDay, isBefore, isAfter } = require('date-fns');
const { prisma } = require('../middleware/tenant');

/** Début de journée locale pour clé de réponse QCM journalier. */
function responseDayKey(day = new Date()) {
  return startOfDay(day);
}

function computeEndsAt(weekStart, durationDays) {
  const start = startOfDay(new Date(weekStart));
  const days = Math.min(14, Math.max(1, Number(durationDays) || 7));
  return endOfDay(addDays(start, days - 1));
}

const WORK_SHIFT_TYPES = ['MATIN', 'APREM', 'NUIT', 'JOURNEE'];

async function userWorksToday(userId, companyId, day = new Date()) {
  const today = startOfDay(day);
  const shift = await prisma.shift.findFirst({
    where: {
      userId,
      companyId,
      date: today,
      type: { in: WORK_SHIFT_TYPES },
    },
  });
  return Boolean(shift);
}

/**
 * @returns {{ available: boolean, reason?: string, message?: string, endsAt?: Date }}
 */
async function getSurveyAvailability(survey, userId, companyId) {
  if (!survey || survey.status !== 'ACTIVE') {
    return { available: false, reason: 'INACTIVE', message: 'Aucun sondage actif.' };
  }

  const now = new Date();
  const start = startOfDay(new Date(survey.weekStart));
  const end = survey.endsAt
    ? endOfDay(new Date(survey.endsAt))
    : computeEndsAt(survey.weekStart, survey.durationDays);

  if (isBefore(now, start)) {
    return {
      available: false,
      reason: 'NOT_STARTED',
      message: 'Le questionnaire commence le '
        + start.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
      endsAt: end,
    };
  }

  if (isAfter(now, end)) {
    return {
      available: false,
      reason: 'ENDED',
      message: 'La période de ce questionnaire est terminée.',
      endsAt: end,
    };
  }

  if (survey.onlyOnWorkShifts !== false) {
    const works = await userWorksToday(userId, companyId, now);
    if (!works) {
      return {
        available: false,
        reason: 'NO_WORK_TODAY',
        message:
          'QCM non disponible : vous ne travaillez pas aujourd\'hui. Revenez un jour où vous êtes planifié au travail.',
        endsAt: end,
      };
    }
  }

  return { available: true, endsAt: end };
}

module.exports = {
  computeEndsAt,
  userWorksToday,
  getSurveyAvailability,
  responseDayKey,
  WORK_SHIFT_TYPES,
};
