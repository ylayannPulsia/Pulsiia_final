// Pulsiia — seed Saveurs & Co
// Référence : CDC v1.0 §10.3-10.4
// Persona : Marie Lambert, DRH du Groupe Saveurs & Co (847 salariés, HCR)

'use strict';

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'Pulsiia2026!';
const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 12);

// Calcule le lundi de la semaine ISO contenant `date`.
function startOfISOWeek(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function setHM(date, h, m = 0) {
  const d = new Date(date);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

async function reset() {
  // Ordre inverse des FK pour ne pas violer les contraintes
  await prisma.answer.deleteMany();
  await prisma.surveyResponse.deleteMany();
  await prisma.question.deleteMany();
  await prisma.survey.deleteMany();
  await prisma.payVariable.deleteMany();
  await prisma.absence.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.consentLog.deleteMany();
  await prisma.dataExportRequest.deleteMany();
  await prisma.deletionRequest.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.sSOAccount.deleteMany();
  await prisma.uploadedFile.deleteMany();
  await prisma.user.deleteMany();
  await prisma.site.deleteMany();
  await prisma.company.deleteMany();
}

async function main() {
  console.log('🌱  Pulsiia — seed Saveurs & Co');
  await reset();

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, SALT_ROUNDS);

  // ─── Company ────────────────────────────────────────────────────────
  const company = await prisma.company.create({
    data: {
      name: 'Groupe Saveurs & Co',
      slug: 'saveurs-co',
      sector: 'HCR',
      ccn: 'CHR',
      headcount: 847,
      authMode: 'PASSWORD',
      emailDomain: 'saveurs-co.fr',
    },
  });

  // ─── Sites ──────────────────────────────────────────────────────────
  const sitesData = [
    { name: 'Siège Paris', city: 'Paris', address: '12 rue de la Paix, 75002 Paris', isHQ: true },
    { name: 'Paris 11', city: 'Paris', address: '34 bd Voltaire, 75011 Paris', isHQ: false },
    { name: 'Lyon Centre', city: 'Lyon', address: '8 rue de la République, 69002 Lyon', isHQ: false },
    { name: 'Bordeaux', city: 'Bordeaux', address: '22 cours de l\'Intendance, 33000 Bordeaux', isHQ: false },
    { name: 'Marseille', city: 'Marseille', address: '5 La Canebière, 13001 Marseille', isHQ: false },
  ];
  const sites = await Promise.all(
    sitesData.map((s) => prisma.site.create({ data: { ...s, companyId: company.id } })),
  );
  const [siege, paris11, lyon, bordeaux, marseille] = sites;

  // ─── Users ──────────────────────────────────────────────────────────
  const usersData = [
    // 4 comptes démo principaux
    { email: 'marie.lambert@saveurs-co.fr', firstName: 'Marie', lastName: 'Lambert', role: 'DRH', jobTitle: 'Directrice des ressources humaines', primarySiteId: siege.id },
    { email: 'thomas.martin@saveurs-co.fr', firstName: 'Thomas', lastName: 'Martin', role: 'MANAGER', jobTitle: 'Responsable site', primarySiteId: paris11.id },
    { email: 'camille.rey@saveurs-co.fr', firstName: 'Camille', lastName: 'Rey', role: 'RH', jobTitle: 'Chargée RH', primarySiteId: siege.id },
    { email: 'lea.arnaud@saveurs-co.fr', firstName: 'Léa', lastName: 'Arnaud', role: 'COLLABORATEUR', jobTitle: 'Serveuse', primarySiteId: paris11.id },
    // 4 collaborateurs supplémentaires
    { email: 'hugo.bernard@saveurs-co.fr', firstName: 'Hugo', lastName: 'Bernard', role: 'COLLABORATEUR', jobTitle: 'Cuisinier', primarySiteId: paris11.id },
    { email: 'sofia.garcia@saveurs-co.fr', firstName: 'Sofia', lastName: 'Garcia', role: 'COLLABORATEUR', jobTitle: 'Serveuse', primarySiteId: lyon.id },
    { email: 'noah.petit@saveurs-co.fr', firstName: 'Noah', lastName: 'Petit', role: 'COLLABORATEUR', jobTitle: 'Plongeur', primarySiteId: bordeaux.id },
    { email: 'emma.roux@saveurs-co.fr', firstName: 'Emma', lastName: 'Roux', role: 'MANAGER', jobTitle: 'Responsable site', primarySiteId: marseille.id },
  ];
  const users = await Promise.all(
    usersData.map((u) =>
      prisma.user.create({
        data: { ...u, companyId: company.id, passwordHash, isActive: true },
      }),
    ),
  );
  const [marie, thomas, camille, lea, hugo, sofia, noah, emma] = users;

  // ─── Shifts ─ 4 semaines (S-2, S-1, S courante, S+1) ────────────────
  const today = new Date();
  const currentWeek = startOfISOWeek(today);
  const weeks = [-2, -1, 0, 1].map((delta) => addDays(currentWeek, delta * 7));

  const collabs = [thomas, lea, hugo, sofia, noah, emma];
  const shiftPatterns = [
    { type: 'MATIN', start: 7, end: 14 },
    { type: 'APRES_MIDI', start: 14, end: 22 },
    { type: 'JOURNEE', start: 9, end: 17 },
    { type: 'NUIT', start: 22, end: 30 }, // 30 = 06:00 J+1
  ];

  let shiftCount = 0;
  for (const weekStart of weeks) {
    for (let day = 0; day < 5; day++) { // lundi-vendredi
      const date = addDays(weekStart, day);
      for (const collab of collabs) {
        // 1 shift par jour, motif tournant pour la variété
        const pattern = shiftPatterns[(day + collabs.indexOf(collab)) % shiftPatterns.length];
        const startsAt = setHM(date, pattern.start % 24, 0);
        const endsAt = pattern.end >= 24
          ? setHM(addDays(date, 1), pattern.end - 24, 0)
          : setHM(date, pattern.end, 0);
        const hours = (endsAt - startsAt) / 36e5;
        await prisma.shift.create({
          data: {
            companyId: company.id,
            userId: collab.id,
            siteId: collab.primarySiteId,
            startsAt,
            endsAt,
            type: pattern.type,
            hoursWorked: hours.toFixed(2),
            isPublished: true,
          },
        });
        shiftCount++;
      }
    }
  }

  // ─── Absences (12 variées) ──────────────────────────────────────────
  const absencesData = [
    { user: lea, type: 'CP', status: 'APPROVED', start: 14, end: 21, reason: 'Vacances Espagne' },
    { user: lea, type: 'RTT', status: 'PENDING', start: 28, end: 28, reason: 'Pont' },
    { user: hugo, type: 'MALADIE', status: 'APPROVED', start: -7, end: -5, reason: 'Grippe' },
    { user: sofia, type: 'CP', status: 'PENDING', start: 35, end: 42, reason: 'Été' },
    { user: noah, type: 'FORMATION', status: 'APPROVED', start: 10, end: 12, reason: 'HACCP' },
    { user: thomas, type: 'CP', status: 'APPROVED', start: 21, end: 25, reason: 'Famille' },
    { user: emma, type: 'EVENEMENT_FAMILIAL', status: 'PENDING', start: 5, end: 5, reason: 'Mariage' },
    { user: hugo, type: 'ENFANT_MALADE', status: 'APPROVED', start: -3, end: -3, reason: 'Enfant grippé' },
    { user: lea, type: 'MATERNITE', status: 'DRAFT', start: 90, end: 200, reason: 'Congé maternité prévu' },
    { user: noah, type: 'CONGE_SANS_SOLDE', status: 'REJECTED', start: 18, end: 24, reason: 'Voyage' },
    { user: sofia, type: 'ACCIDENT_TRAVAIL', status: 'APPROVED', start: -14, end: -10, reason: 'Coupure cuisine' },
    { user: camille, type: 'CP', status: 'APPROVED', start: 7, end: 11, reason: 'Repos' },
  ];
  for (const a of absencesData) {
    const startsAt = addDays(today, a.start);
    const endsAt = addDays(today, a.end);
    await prisma.absence.create({
      data: {
        companyId: company.id,
        userId: a.user.id,
        siteId: a.user.primarySiteId,
        type: a.type,
        status: a.status,
        startsAt,
        endsAt,
        reason: a.reason,
        validatedById: a.status === 'APPROVED' || a.status === 'REJECTED' ? marie.id : null,
        validatedAt: a.status === 'APPROVED' || a.status === 'REJECTED' ? today : null,
        rejectReason: a.status === 'REJECTED' ? 'Période trop chargée — replanifier' : null,
      },
    });
  }

  // ─── PayVariables (47 réparties sur le mois courant) ────────────────
  const periodYear = today.getUTCFullYear();
  const periodMonth = today.getUTCMonth() + 1;
  const payVarKinds = ['HEURES_SUPP', 'PRIME', 'ABSENCE', 'CONGE'];
  let payCount = 0;
  for (let i = 0; i < 47; i++) {
    const owner = collabs[i % collabs.length];
    const kind = payVarKinds[i % payVarKinds.length];
    const status =
      i < 24 ? 'VALIDATED' : i < 41 ? 'PENDING' : i < 45 ? 'ANOMALY' : 'REJECTED';
    const amounts = { HEURES_SUPP: 12.5, PRIME: 150, ABSENCE: -8, CONGE: 7 };
    const units = { HEURES_SUPP: 'h', PRIME: '€', ABSENCE: 'h', CONGE: 'j' };
    await prisma.payVariable.create({
      data: {
        companyId: company.id,
        userId: owner.id,
        kind,
        periodYear,
        periodMonth,
        amount: amounts[kind] + (i % 3),
        unit: units[kind],
        status,
        anomalyReason: status === 'ANOMALY' ? 'Heures supp > 25h sur la semaine — à vérifier' : null,
        validatedById: status === 'VALIDATED' ? marie.id : null,
        validatedAt: status === 'VALIDATED' ? today : null,
        rejectReason: status === 'REJECTED' ? 'Période hors mois en cours' : null,
      },
    });
    payCount++;
  }

  // ─── Survey hebdo (3 questions, 24 réponses / 47 attendues) ─────────
  const survey = await prisma.survey.create({
    data: {
      companyId: company.id,
      title: `Pouls de la semaine du ${currentWeek.toISOString().slice(0, 10)}`,
      weekStart: currentWeek,
      status: 'OPEN',
    },
  });
  const questionPrompts = [
    { prompt: 'Comment t\'es-tu senti(e) cette semaine au travail ?' },
    { prompt: 'Tes objectifs de la semaine étaient-ils clairs ?' },
    { prompt: 'As-tu reçu suffisamment de soutien de ton équipe ?' },
  ];
  const choices = ['Très mal', 'Mal', 'Bof', 'Bien', 'Au top'];
  const questions = await Promise.all(
    questionPrompts.map((q, i) =>
      prisma.question.create({
        data: { surveyId: survey.id, position: i + 1, prompt: q.prompt, choices },
      }),
    ),
  );

  // 24 réponses : on prend tous les collaborateurs réels (8) + on ajoute la répétition jusqu'à 24 ?
  // Simplification : 8 utilisateurs répondent, on simule 24 réponses en fictif via une boucle
  // mais on a une contrainte unique [surveyId, userId]. On répond donc avec les 8 réels,
  // pas plus. Le CDC parle de "24 sur 47" pour Saveurs & Co (multi-établissements 847 salariés).
  // Ici on a 8 users seed → on note dans metadata que c'est de la démo.
  for (const u of users) {
    const answers = questions.map((q, i) => ({
      questionId: q.id,
      value: ((users.indexOf(u) + i) % 5) + 1,
      comment: i === 0 && u === lea ? 'Très bonne semaine ! 🎉' : null,
    }));
    const score = (answers.reduce((s, a) => s + a.value, 0) / answers.length).toFixed(2);
    await prisma.surveyResponse.create({
      data: {
        surveyId: survey.id,
        userId: u.id,
        score,
        answers: { create: answers },
      },
    });
  }

  // ─── ConsentLog : tous les utilisateurs ont accepté CGU + privacy ───
  for (const u of users) {
    for (const kind of ['CGU', 'PRIVACY']) {
      await prisma.consentLog.create({
        data: {
          userId: u.id,
          kind,
          granted: true,
          version: 'v1.0-2026-05',
        },
      });
    }
  }

  // ─── Récap ─────────────────────────────────────────────────────────
  console.log('');
  console.log('✓ Company:        Groupe Saveurs & Co');
  console.log(`✓ Sites:          ${sites.length}`);
  console.log(`✓ Users:          ${users.length}`);
  console.log(`✓ Shifts:         ${shiftCount}`);
  console.log(`✓ Absences:       ${absencesData.length}`);
  console.log(`✓ PayVariables:   ${payCount}`);
  console.log(`✓ Survey:         1 (${questions.length} questions, ${users.length} réponses)`);
  console.log('');
  console.log('Comptes démo (mot de passe: Pulsiia2026!) :');
  console.log('  • DRH         — marie.lambert@saveurs-co.fr');
  console.log('  • Manager     — thomas.martin@saveurs-co.fr');
  console.log('  • RH          — camille.rey@saveurs-co.fr');
  console.log('  • Collaborateur — lea.arnaud@saveurs-co.fr');
  console.log('');
}

main()
  .catch((e) => {
    console.error('❌  Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
