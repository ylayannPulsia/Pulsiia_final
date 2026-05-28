// ============================================================
//  Pulsiia — Billing Service
//  Modèle : 6€/employé actif/mois + 30j essai gratuit
// ============================================================
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PRICE_PER_EMPLOYEE = 6.0; // €
const TRIAL_DAYS = 30;

/**
 * Crée un abonnement (essai gratuit 30j) pour une société
 */
async function createSubscription(companyId) {
  const trialStartDate = new Date();
  const trialEndDate = new Date();
  trialEndDate.setDate(trialEndDate.getDate() + TRIAL_DAYS);

  return prisma.subscription.create({
    data: {
      companyId,
      status: 'TRIAL',
      trialStartDate,
      trialEndDate,
      pricePerEmployee: PRICE_PER_EMPLOYEE,
    },
  });
}

/**
 * Compte les employés actifs d'une société
 */
async function countActiveEmployees(companyId) {
  return prisma.user.count({
    where: {
      companyId,
      isActive: true,
      role: { not: 'ADMIN' }, // On ne facture pas les admins
    },
  });
}

/**
 * Retourne le statut d'abonnement d'une société
 */
async function getSubscriptionStatus(companyId) {
  const subscription = await prisma.subscription.findUnique({
    where: { companyId },
    include: {
      invoices: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
  });

  if (!subscription) return null;

  const now = new Date();
  const employeeCount = await countActiveEmployees(companyId);
  const monthlyAmount = employeeCount * subscription.pricePerEmployee;

  // Vérifie si la période d'essai est expirée
  const isTrialExpired = subscription.status === 'TRIAL' && now > subscription.trialEndDate;
  const trialDaysLeft = subscription.status === 'TRIAL'
    ? Math.max(0, Math.ceil((subscription.trialEndDate - now) / (1000 * 60 * 60 * 24)))
    : 0;

  return {
    subscription,
    employeeCount,
    monthlyAmount,
    isTrialExpired,
    trialDaysLeft,
    pricePerEmployee: subscription.pricePerEmployee,
  };
}

/**
 * Génère la facture mensuelle pour une société
 */
async function generateMonthlyInvoice(companyId) {
  const subscription = await prisma.subscription.findUnique({ where: { companyId } });
  if (!subscription || subscription.status === 'CANCELLED') {
    throw new Error('Aucun abonnement actif pour cette société');
  }

  const employeeCount = await countActiveEmployees(companyId);
  const totalAmount = employeeCount * subscription.pricePerEmployee;

  const periodStart = new Date();
  periodStart.setDate(1);
  periodStart.setHours(0, 0, 0, 0);

  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  periodEnd.setDate(0); // dernier jour du mois

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30); // paiement sous 30j

  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      subscriptionId: subscription.id,
      periodStart,
      periodEnd,
      employeeCount,
      pricePerEmployee: subscription.pricePerEmployee,
      totalAmount,
      status: 'PENDING',
      dueDate,
    },
  });

  // Met à jour la période courante de l'abonnement
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      status: 'ACTIVE',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    },
  });

  return invoice;
}

/**
 * Marque une facture comme payée
 */
async function markInvoicePaid(invoiceId) {
  return prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: 'PAID',
      paidAt: new Date(),
    },
  });
}

/**
 * Liste toutes les sociétés avec leur statut de facturation (vue ADMIN Pulsiia)
 */
async function getAllCompanyBilling() {
  const companies = await prisma.company.findMany({
    include: {
      subscription: true,
      _count: {
        select: {
          users: {
            where: { isActive: true, role: { not: 'ADMIN' } },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return companies.map((c) => {
    const employeeCount = c._count.users;
    const monthlyAmount = c.subscription
      ? employeeCount * c.subscription.pricePerEmployee
      : 0;
    const now = new Date();
    const trialDaysLeft = c.subscription?.status === 'TRIAL'
      ? Math.max(0, Math.ceil((new Date(c.subscription.trialEndDate) - now) / (1000 * 60 * 60 * 24)))
      : null;

    return {
      id: c.id,
      name: c.name,
      employeeCount,
      monthlyAmount,
      subscription: c.subscription,
      trialDaysLeft,
    };
  });
}

module.exports = {
  createSubscription,
  countActiveEmployees,
  getSubscriptionStatus,
  generateMonthlyInvoice,
  markInvoicePaid,
  getAllCompanyBilling,
  PRICE_PER_EMPLOYEE,
  TRIAL_DAYS,
};
