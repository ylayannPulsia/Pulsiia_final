// ═══════════════════════════════════════════════════════════════
// PULSIIA — Seed des données de démo
// Crée Groupe Saveurs & Co avec Marie Lambert et son équipe
// ═══════════════════════════════════════════════════════════════

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { addDays, startOfWeek, startOfMonth, addMonths } = require('date-fns');
const { weekPeriodFromDate } = require('../src/lib/period-utils');
const { randomUUID } = require('crypto');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seed Pulsiia — Groupe Saveurs & Co');

  // Clean slate
  await prisma.commMessage.deleteMany();
  await prisma.commChannel.deleteMany();
  await prisma.answer.deleteMany();
  await prisma.surveyResponse.deleteMany();
  await prisma.question.deleteMany();
  await prisma.survey.deleteMany();
  await prisma.payVariable.deleteMany();
  await prisma.absence.deleteMany();
  await prisma.shift.deleteMany();
  await prisma.planningWeek.deleteMany();
  await prisma.uploadedFile.deleteMany();
  await prisma.pushSubscription.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.jobPosition.deleteMany();
  await prisma.operationalPole.deleteMany();
  await prisma.skill.deleteMany();
  await prisma.site.deleteMany();
  await prisma.company.deleteMany();

  // ── Company ──────────────────────────────────────────────────
  const company = await prisma.company.create({
    data: {
      name: 'Groupe Saveurs & Co',
      siret: '12345678900012',
      convention: 'CHR — Hôtels, cafés, restaurants',
    },
  });
  console.log(`✓ Entreprise : ${company.name}`);

  const defaultPoles = ['Cuisine', 'Service', 'Accueil', 'Direction', 'RH', 'Bar', 'Plonge'];
  const defaultPostes = [
    'Serveuse', 'Serveur', 'Cuisinier', 'Cuisinière', 'Manager Cuisine',
    'Hôte d\'accueil', 'Responsable RH', 'Directrice des Ressources Humaines',
    'Barman', 'Sommelier', 'Plongeur', 'Commis de cuisine', 'Chef de rang',
  ];
  await Promise.all([
    ...defaultPoles.map((name) => prisma.operationalPole.create({ data: { companyId: company.id, name } })),
    ...defaultPostes.map((name) => prisma.jobPosition.create({ data: { companyId: company.id, name } })),
  ]);
  console.log(`✓ Catalogue RH : ${defaultPostes.length} postes · ${defaultPoles.length} pôles`);

  const defaultSkills = [
    'HACCP', 'Service client', 'Anglais B2', 'Vin', 'Caisse', 'Paie', 'Planning', 'RH',
    'Management', 'Cuisine chaud', 'Froid', 'Dressage', 'Recrutement', 'Droit social',
  ];
  await Promise.all(
    defaultSkills.map((name) => prisma.skill.create({ data: { companyId: company.id, name } })),
  );
  console.log(`✓ Catalogue compétences : ${defaultSkills.length} entrées`);

  // ── Sites (8 établissements) ─────────────────────────────────
  // 50 comptes au total : 2 siège + Camille (RH Bordeaux) + 47 sur le terrain (manager inclus par site)
  const SITE_DEFS = [
    { name: 'Paris 11', city: 'Paris', postalCode: '75011', targetStaff: 11 },
    { name: 'Lyon Centre', city: 'Lyon', postalCode: '69002', targetStaff: 7 },
    { name: 'Bordeaux', city: 'Bordeaux', postalCode: '33000', targetStaff: 6 },
    { name: 'Marseille Vieux-Port', city: 'Marseille', postalCode: '13001', targetStaff: 7 },
    { name: 'Lille Centre', city: 'Lille', postalCode: '59000', targetStaff: 6 },
    { name: 'Nantes Graslin', city: 'Nantes', postalCode: '44000', targetStaff: 6 },
    { name: 'Toulouse Capitole', city: 'Toulouse', postalCode: '31000', targetStaff: 4 },
    { name: 'Siège Paris', city: 'Paris', postalCode: '75008', targetStaff: 2 },
  ];

  const sites = await Promise.all(
    SITE_DEFS.map((s) => prisma.site.create({
      data: { companyId: company.id, name: s.name, city: s.city, postalCode: s.postalCode },
    })),
  );
  const siteByName = Object.fromEntries(sites.map((s, i) => [SITE_DEFS[i].name, s]));
  console.log(`✓ ${sites.length} sites créés`);

  // ── 50 collaborateurs répartis sur les sites ─────────────────
  const passwordHash = await bcrypt.hash('Pulsiia2026!', 12);
  const AVATAR_COLORS = ['#5B5BF7', '#FF8A5B', '#4FD1C5', '#F472B6', '#FBBF24', '#22C55E', '#EC4899', '#06B6D4', '#8B5CF6', '#F97316'];

  const FIRST_NAMES = {
    f: ['Marie', 'Camille', 'Léa', 'Sophie', 'Nadia', 'Julie', 'Emma', 'Chloé', 'Sarah', 'Inès', 'Manon', 'Clara', 'Laura', 'Anaïs', 'Zoé', 'Pauline', 'Margot', 'Lucie', 'Élise', 'Amélie'],
    m: ['Thomas', 'Antoine', 'Lucas', 'Hugo', 'Nathan', 'Louis', 'Gabriel', 'Raphaël', 'Maxime', 'Julien', 'Alexandre', 'Nicolas', 'Pierre', 'Benjamin', 'Mathieu', 'Florian', 'Kevin', 'David', 'Sébastien', 'Christophe'],
  };
  const LAST_NAMES = ['Martin', 'Bernard', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier', 'Girard', 'Bonnet', 'Dupont', 'Lambert', 'Fontaine', 'Chevalier', 'Robin', 'Garnier', 'Henry', 'Rousseau', 'Blanc', 'Guerin', 'Muller', 'Perrin'];

  const COLLAB_JOBS = [
    { jobTitle: 'Serveuse', pole: 'Service', rate: 12.5, hours: 35, skills: ['Service client', 'Caisse', 'Vin'] },
    { jobTitle: 'Serveur', pole: 'Service', rate: 12.8, hours: 35, skills: ['Service client', 'Caisse', 'Anglais B2'] },
    { jobTitle: 'Chef de rang', pole: 'Service', rate: 14.5, hours: 39, skills: ['Vin', 'Service client', 'Management'] },
    { jobTitle: 'Cuisinier', pole: 'Cuisine', rate: 14.2, hours: 39, skills: ['HACCP', 'Cuisine chaud'] },
    { jobTitle: 'Cuisinière', pole: 'Cuisine', rate: 14.0, hours: 38, skills: ['HACCP', 'Froid', 'Cuisine chaud'] },
    { jobTitle: 'Commis de cuisine', pole: 'Cuisine', rate: 11.8, hours: 35, skills: ['HACCP', 'Plonge'] },
    { jobTitle: 'Barman', pole: 'Bar', rate: 13.2, hours: 35, skills: ['Vin', 'Service client'] },
    { jobTitle: 'Sommelier', pole: 'Bar', rate: 15.0, hours: 39, skills: ['Vin', 'Anglais B2'] },
    { jobTitle: 'Hôte d\'accueil', pole: 'Accueil', rate: 12.6, hours: 35, skills: ['Service client', 'Caisse'] },
    { jobTitle: 'Plongeur', pole: 'Plonge', rate: 11.5, hours: 35, skills: ['HACCP'] },
  ];

  const usedEmails = new Set();
  let nameIdx = 0;
  const pickName = (gender) => {
    const pool = gender === 'f' ? FIRST_NAMES.f : FIRST_NAMES.m;
    const firstName = pool[nameIdx % pool.length];
    const lastName = LAST_NAMES[(nameIdx * 7 + 3) % LAST_NAMES.length];
    nameIdx += 1;
    return { firstName, lastName };
  };
  const slug = (first, last) => `${first}.${last}`.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z.]/g, '');

  const users = [];
  const siteKeys = SITE_DEFS.map((s) => s.name);

  // Direction & RH (comptes de démo conservés)
  const marie = await prisma.user.create({
    data: {
      email: 'marie.lambert@saveurs-co.fr',
      passwordHash,
      firstName: 'Marie', lastName: 'Lambert',
      role: 'DRH', jobTitle: 'Directrice des Ressources Humaines',
      phone: '+33 6 00 11 22 33',
      avatarColor: '#5B5BF7',
      contractType: 'CDI', weeklyHours: 39,
      competences: ['RH', 'Paie', 'Planning', 'Droit social'],
      secondaryRoles: ['Direction', 'RH'],
      companyId: company.id,
      siteId: siteByName['Siège Paris'].id,
    },
  });
  usedEmails.add(marie.email);
  users.push(marie);

  const assistRh = await prisma.user.create({
    data: {
      email: 'julie.mercier@saveurs-co.fr',
      passwordHash,
      firstName: 'Julie', lastName: 'Mercier',
      role: 'RH', jobTitle: 'Assistante RH',
      phone: '+33 6 10 20 30 40',
      avatarColor: '#4FD1C5',
      contractType: 'CDI', weeklyHours: 39,
      competences: ['RH', 'Paie', 'Recrutement'],
      secondaryRoles: ['RH'],
      companyId: company.id,
      siteId: siteByName['Siège Paris'].id,
      managerId: marie.id,
    },
  });
  usedEmails.add(assistRh.email);
  users.push(assistRh);

  const camille = await prisma.user.create({
    data: {
      email: 'camille.rey@saveurs-co.fr',
      passwordHash,
      firstName: 'Camille', lastName: 'Rey',
      role: 'RH', jobTitle: 'Responsable RH terrain',
      phone: '+33 6 71 82 93 04',
      avatarColor: '#4FD1C5',
      contractType: 'CDI', weeklyHours: 39,
      competences: ['RH', 'Paie', 'Planning', 'Recrutement'],
      secondaryRoles: ['RH'],
      companyId: company.id,
      siteId: siteByName.Bordeaux.id,
      managerId: marie.id,
    },
  });
  usedEmails.add(camille.email);
  users.push(camille);

  const managersBySite = {};

  for (const siteName of siteKeys) {
    if (siteName === 'Siège Paris') continue;

    const site = siteByName[siteName];
    const target = SITE_DEFS.find((s) => s.name === siteName).targetStaff;
    const isParis = siteName === 'Paris 11';
    const isBordeaux = siteName === 'Bordeaux';

    let manager;
    if (isParis) {
      manager = await prisma.user.create({
        data: {
          email: 'thomas.martin@saveurs-co.fr',
          passwordHash,
          firstName: 'Thomas', lastName: 'Martin',
          role: 'MANAGER', jobTitle: 'Manager de site',
          phone: '+33 6 12 34 56 78',
          avatarColor: '#FF8A5B',
          hourlyRate: 18.5,
          contractType: 'CDI', weeklyHours: 39,
          competences: ['Management', 'HACCP', 'Planning'],
          secondaryRoles: ['Direction'],
          companyId: company.id,
          siteId: site.id,
          managerId: marie.id,
        },
      });
      usedEmails.add(manager.email);
      users.push(manager);
      managersBySite[siteName] = manager;
    } else if (isBordeaux) {
      manager = await prisma.user.create({
        data: {
          email: 'marc.duval@saveurs-co.fr',
          passwordHash,
          firstName: 'Marc', lastName: 'Duval',
          role: 'MANAGER', jobTitle: 'Manager de site',
          phone: '+33 6 55 44 33 22',
          avatarColor: '#F97316',
          hourlyRate: 17.8,
          contractType: 'CDI', weeklyHours: 39,
          competences: ['Management', 'HACCP'],
          secondaryRoles: ['Cuisine'],
          companyId: company.id,
          siteId: site.id,
          managerId: marie.id,
        },
      });
      usedEmails.add(manager.email);
      users.push(manager);
      managersBySite[siteName] = manager;
    } else {
      const { firstName, lastName } = pickName('m');
      const email = `${slug(firstName, lastName)}@saveurs-co.fr`;
      manager = await prisma.user.create({
        data: {
          email,
          passwordHash,
          firstName,
          lastName,
          role: 'MANAGER',
          jobTitle: 'Manager de site',
          phone: `+33 6 ${String(60 + nameIdx).padStart(2, '0')} ${String(10 + nameIdx).padStart(2, '0')} ${String(20 + nameIdx).padStart(2, '0')} ${String(30 + nameIdx).padStart(2, '0')}`,
          avatarColor: AVATAR_COLORS[nameIdx % AVATAR_COLORS.length],
          hourlyRate: 17.5 + (nameIdx % 3),
          contractType: 'CDI',
          weeklyHours: 39,
          competences: ['Management', 'Planning'],
          secondaryRoles: ['Direction'],
          companyId: company.id,
          siteId: site.id,
          managerId: marie.id,
        },
      });
      usedEmails.add(email);
      users.push(manager);
      managersBySite[siteName] = manager;
    }

    const collabCount = users.filter((u) => u.siteId === site.id && u.role === 'COLLABORATEUR').length;
    const need = target - 1 - collabCount; // -1 manager

    for (let i = 0; i < need; i++) {
      const gender = (nameIdx + i) % 3 === 0 ? 'm' : 'f';
      let firstName;
      let lastName;
      let email;

      if (isParis && i === 0) {
        ({ firstName, lastName } = { firstName: 'Léa', lastName: 'Arnaud' });
        email = 'lea.arnaud@saveurs-co.fr';
      } else if (isParis && i === 1) {
        ({ firstName, lastName } = { firstName: 'Antoine', lastName: 'Petit' });
        email = 'antoine.petit@saveurs-co.fr';
      } else if (siteName === 'Lyon Centre' && i === 0) {
        ({ firstName, lastName } = { firstName: 'Nadia', lastName: 'Kerouane' });
        email = 'nadia.kerouane@saveurs-co.fr';
      } else if (isBordeaux && i === 0) {
        ({ firstName, lastName } = { firstName: 'Sophie', lastName: 'Bernard' });
        email = 'sophie.bernard@saveurs-co.fr';
      } else {
        ({ firstName, lastName } = pickName(gender));
        let base = slug(firstName, lastName);
        let n = 0;
        email = `${base}@saveurs-co.fr`;
        while (usedEmails.has(email)) {
          n += 1;
          email = `${base}${n}@saveurs-co.fr`;
        }
      }

      usedEmails.add(email);
      const job = COLLAB_JOBS[(nameIdx + i) % COLLAB_JOBS.length];
      const contractType = (nameIdx + i) % 5 === 0 ? 'CDD' : 'CDI';

      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          firstName,
          lastName,
          role: 'COLLABORATEUR',
          jobTitle: job.jobTitle,
          phone: `+33 6 ${String(70 + (nameIdx % 90)).padStart(2, '0')} ${String(10 + (nameIdx % 80)).padStart(2, '0')} ${String(20 + (nameIdx % 70)).padStart(2, '0')} ${String(30 + (nameIdx % 60)).padStart(2, '0')}`,
          ...(email === 'lea.arnaud@saveurs-co.fr' ? { iban: 'FR7630006000011234567890189' } : {}),
          avatarColor: AVATAR_COLORS[(nameIdx + i) % AVATAR_COLORS.length],
          hourlyRate: job.rate + ((nameIdx % 10) * 0.1),
          contractType,
          weeklyHours: job.hours,
          competences: job.skills,
          secondaryRoles: [job.pole],
          companyId: company.id,
          siteId: site.id,
          managerId: manager.id,
        },
      });
      users.push(user);
      nameIdx += 1;
    }
  }

  if (users.length !== 50) {
    throw new Error(`Seed : ${users.length} utilisateurs au lieu de 50 — ajuster SITE_DEFS`);
  }

  const thomas = managersBySite['Paris 11'];
  const lea = users.find((u) => u.email === 'lea.arnaud@saveurs-co.fr');
  const nadia = users.find((u) => u.email === 'nadia.kerouane@saveurs-co.fr');
  const antoine = users.find((u) => u.email === 'antoine.petit@saveurs-co.fr');
  const sophie = users.find((u) => u.email === 'sophie.bernard@saveurs-co.fr');

  const countBySite = {};
  for (const u of users) {
    const sn = sites.find((s) => s.id === u.siteId)?.name || '?';
    countBySite[sn] = (countBySite[sn] || 0) + 1;
  }
  console.log(`✓ ${users.length} utilisateurs créés`);
  console.log('  Répartition :', Object.entries(countBySite).map(([k, v]) => `${k} (${v})`).join(' · '));

  // ── Shifts (semaine courante, opérationnels) ─────────────────
  const monday = startOfWeek(new Date(), { weekStartsOn: 1 });
  const SHIFT_SCHEDULE = {
    MATIN: { start: '06:00', end: '14:00' },
    APREM: { start: '14:00', end: '22:00' },
    NUIT: { start: '22:00', end: '06:00' },
    JOURNEE: { start: '09:00', end: '18:00' },
    OFF: { start: null, end: null },
  };
  const shiftsCreated = [];
  const operational = users.filter((u) => ['COLLABORATEUR', 'MANAGER'].includes(u.role) && u.siteId);

  for (const user of operational) {
    const pole = user.secondaryRoles?.[0] || 'Service';
    const restDays = pole === 'Cuisine' ? [0, 3] : pole === 'Direction' ? [] : [3, 6];
    for (let day = 0; day < 7; day++) {
      const date = addDays(monday, day);
      let type;
      if (restDays.includes(day)) type = 'OFF';
      else if (pole === 'Cuisine') type = day % 2 === 0 ? 'MATIN' : 'APREM';
      else if (pole === 'Bar') type = day % 2 === 0 ? 'APREM' : 'NUIT';
      else if (pole === 'Accueil' || pole === 'Plonge') type = 'JOURNEE';
      else type = day % 2 === 0 ? 'APREM' : 'MATIN';

      const times = SHIFT_SCHEDULE[type];
      shiftsCreated.push(await prisma.shift.create({
        data: {
          userId: user.id,
          siteId: user.siteId,
          companyId: company.id,
          date,
          type,
          startTime: times.start,
          endTime: times.end,
        },
      }));
    }
  }
  console.log(`✓ ${shiftsCreated.length} shifts créés`);

  // ── Absences ─────────────────────────────────────────────────
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../uploads'));
  fs.mkdirSync(uploadDir, { recursive: true });
  const arretStored = `${randomUUID()}.pdf`;
  fs.writeFileSync(
    path.join(uploadDir, arretStored),
    '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
  );

  const leaMaladie = await prisma.absence.create({
    data: {
      userId: lea.id,
      companyId: company.id,
      type: 'MALADIE',
      startDate: addDays(monday, 1),
      endDate: addDays(monday, 2),
      days: 2,
      status: 'EN_ATTENTE',
      reason: 'Grippe',
    },
  });

  const arretFile = await prisma.uploadedFile.create({
    data: {
      userId: lea.id,
      companyId: company.id,
      originalName: 'arret_maladie_lea_arnaud.pdf',
      storedName: arretStored,
      mimeType: 'application/pdf',
      size: 5120,
      purpose: 'justificatif_absence',
      relatedId: leaMaladie.id,
      relatedType: 'MALADIE',
    },
  });

  await prisma.absence.update({
    where: { id: leaMaladie.id },
    data: { fileId: arretFile.id },
  });
  await prisma.absence.create({
    data: {
      userId: nadia.id,
      companyId: company.id,
      type: 'CP',
      startDate: addDays(monday, 14),
      endDate: addDays(monday, 21),
      days: 7,
      status: 'APPROUVE',
      approvedAt: new Date(),
    },
  });
  console.log('✓ 2 absences créées');

  // ── Pay Variables (hebdo — 6 mois pour graphique ROI) ────────
  const payVarRows = [];
  for (let m = -5; m <= 0; m += 1) {
    const monthStart = startOfMonth(addMonths(monday, m));
    const weekPeriod = weekPeriodFromDate(startOfWeek(monthStart, { weekStartsOn: 1 }));
    const ramp = Math.round((m + 6) * 15) / 10;
    payVarRows.push(
      { userId: thomas.id, companyId: company.id, period: weekPeriod, type: 'HEURE_NORMALE', value: 35, unit: 'h', source: 'planning_auto', status: 'VALIDE' },
      { userId: thomas.id, companyId: company.id, period: weekPeriod, type: 'HEURE_SUP_125', value: Math.max(1, 2 * ramp), unit: 'h', source: 'planning_auto', status: m === 0 ? 'A_VALIDER' : 'VALIDE' },
      { userId: lea.id, companyId: company.id, period: weekPeriod, type: 'HEURE_NORMALE', value: 35, unit: 'h', source: 'planning_auto', status: 'VALIDE' },
      { userId: lea.id, companyId: company.id, period: weekPeriod, type: 'ABSENCE_MALADIE', value: m >= -1 ? 2 : 1, unit: 'jours', source: 'absence_auto', status: 'VALIDE' },
      { userId: nadia.id, companyId: company.id, period: weekPeriod, type: 'HEURE_NORMALE', value: 38, unit: 'h', source: 'planning_auto', status: 'VALIDE' },
      { userId: nadia.id, companyId: company.id, period: weekPeriod, type: 'MAJORATION_NUIT', value: Math.max(4, 8 * ramp), unit: 'h', source: 'planning_auto', status: 'VALIDE' },
      { userId: antoine.id, companyId: company.id, period: weekPeriod, type: 'HEURE_NORMALE', value: 35, unit: 'h', source: 'planning_auto', status: 'VALIDE' },
      { userId: antoine.id, companyId: company.id, period: weekPeriod, type: 'HEURE_SUP_150', value: m === 0 ? 2 : 1, unit: 'h', source: 'planning_auto', status: m === 0 ? 'ANOMALIE' : 'VALIDE' },
      { userId: sophie.id, companyId: company.id, period: weekPeriod, type: 'HEURE_NORMALE', value: 38, unit: 'h', source: 'planning_auto', status: 'VALIDE' },
    );
    if (m >= -2) {
      payVarRows.push(
        { userId: sophie.id, companyId: company.id, period: weekPeriod, type: 'CONGES_PAYES', value: 1, unit: 'jours', source: 'manuel', status: 'VALIDE' },
        { userId: lea.id, companyId: company.id, period: weekPeriod, type: 'PRIME_ANCIENNETE', value: 65, unit: '€', source: 'manuel', status: 'VALIDE' },
      );
    }
    if (m === 0) {
      payVarRows.push(
        { userId: camille.id, companyId: company.id, period: weekPeriod, type: 'PRIME_ANCIENNETE', value: 120, unit: '€', source: 'manuel', status: 'A_VALIDER' },
      );
    }
  }
  await prisma.payVariable.createMany({ data: payVarRows });
  console.log(`✓ ${payVarRows.length} variables de paie créées (6 mois)`);

  // ── Documents ────────────────────────────────────────────────
  const docSeed = [
    { user: thomas, name: 'Contrat CDI — Thomas Martin', type: 'Contrat CDI', status: 'Signé', purpose: 'document_rh', size: 290000 },
    { user: lea, name: 'Bulletin de paie — Fév. 2026', type: 'Bulletin de paie', status: 'Émis', purpose: 'document_bulletin', size: 96000 },
    { user: nadia, name: 'Avenant — Augmentation', type: 'Avenant', status: 'En attente signature', purpose: 'document_rh', size: 118000 },
    { user: camille, name: 'Bulletin de paie — Fév. 2026', type: 'Bulletin de paie', status: 'Émis', purpose: 'document_bulletin', size: 94000 },
    { user: antoine, name: 'Contrat CDD — Antoine Petit', type: 'Contrat CDD', status: 'Signé', purpose: 'document_rh', size: 275000 },
    { user: sophie, name: 'Attestation employeur', type: 'Attestation', status: 'Signé', purpose: 'document_rh', size: 52000 },
    { user: nadia, name: 'Contrat CDI — Nadia Kerouane', type: 'Contrat CDI', status: 'Signé', purpose: 'document_contrat', size: 284000 },
    { user: nadia, name: 'Avenant horaires 38h', type: 'Avenant', status: 'Signé', purpose: 'document_contrat', size: 118000 },
    { user: nadia, name: 'Bulletin février 2026', type: 'Bulletin de paie', status: 'Émis', purpose: 'document_bulletin', size: 96000 },
    { user: nadia, name: 'Attestation employeur', type: 'Attestation', status: 'Signé', purpose: 'document_perso', size: 52000 },
  ];

  const uploadsDir = path.resolve(__dirname, '../uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const pdfStub = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\nxref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n0\n%%EOF\n');

  for (const d of docSeed) {
    const storedName = `${randomUUID()}.pdf`;
    fs.writeFileSync(path.join(uploadsDir, storedName), pdfStub);
    await prisma.uploadedFile.create({
      data: {
        userId: d.user.id,
        companyId: company.id,
        originalName: d.name,
        storedName,
        mimeType: 'application/pdf',
        size: d.size,
        purpose: d.purpose,
        relatedType: d.type,
        notes: d.status,
      },
    });
  }
  console.log(`✓ ${docSeed.length} documents créés`);

  // ── Communication ────────────────────────────────────────────
  const channels = await Promise.all([
    prisma.commChannel.create({ data: { companyId: company.id, slug: 'general', label: '# Général', description: 'Tous les collaborateurs' }}),
    prisma.commChannel.create({ data: { companyId: company.id, slug: 'paris', label: '# Paris 11', description: 'Cuisine + Service Paris' }}),
    prisma.commChannel.create({ data: { companyId: company.id, slug: 'lyon', label: '# Lyon', description: 'Équipe Lyon' }}),
    prisma.commChannel.create({ data: { companyId: company.id, slug: 'bordeaux', label: '# Bordeaux', description: 'Équipe Bordeaux' }}),
    prisma.commChannel.create({ data: { companyId: company.id, slug: 'marseille', label: '# Marseille', description: 'Équipe Marseille' }}),
    prisma.commChannel.create({ data: { companyId: company.id, slug: 'lille', label: '# Lille', description: 'Équipe Lille' }}),
    prisma.commChannel.create({ data: { companyId: company.id, slug: 'nantes', label: '# Nantes', description: 'Équipe Nantes' }}),
    prisma.commChannel.create({ data: { companyId: company.id, slug: 'toulouse', label: '# Toulouse', description: 'Équipe Toulouse' }}),
    prisma.commChannel.create({ data: { companyId: company.id, slug: 'rh', label: '# Annonces RH', description: 'Diffusé à tous' }}),
    prisma.commChannel.create({ data: { companyId: company.id, slug: 'planning', label: '# Planning & absences', description: 'Managers + RH' }}),
  ]);
  const chanBySlug = Object.fromEntries(channels.map((c) => [c.slug, c]));

  const msgGeneral1 = await prisma.commMessage.create({
    data: {
      channelId: chanBySlug.general.id,
      userId: marie.id,
      text: '📋 <strong>Planning semaine S+2 disponible.</strong> Consultez votre planning dans l\'onglet « Mon planning ».',
      pinned: true,
    },
  });
  await prisma.commMessage.create({
    data: {
      channelId: chanBySlug.general.id,
      userId: nadia.id,
      text: 'Bonjour, est-ce qu\'il est possible d\'échanger mon shift du sam 8 ? Je suis disponible dimanche à la place 🙏',
    },
  });
  const msgGeneral3 = await prisma.commMessage.create({
    data: {
      channelId: chanBySlug.general.id,
      userId: thomas.id,
      text: '@Nadia je peux faire dimanche si tu prends mon sam 22 mars 💪',
    },
  });
  await prisma.commMessage.create({
    data: {
      channelId: chanBySlug.general.id,
      userId: thomas.id,
      text: 'Confirmé pour dimanche 👍',
      parentId: msgGeneral3.id,
    },
  });

  await prisma.commMessage.create({
    data: {
      channelId: chanBySlug.paris.id,
      userId: thomas.id,
      text: '🍽️ Équipe — brief avant service à 13h30 ce midi. Présence obligatoire.',
    },
  });
  await prisma.commMessage.create({
    data: {
      channelId: chanBySlug.paris.id,
      userId: lea.id,
      text: 'Je suis en arrêt maladie jusqu\'au 7 mars. Bon courage à l\'équipe 🤒',
    },
  });
  await prisma.commMessage.create({
    data: {
      channelId: chanBySlug.rh.id,
      userId: marie.id,
      text: '📣 <strong>Clôture pré-paie</strong> — Validez vos variables avant vendredi 18h.',
      pinned: true,
    },
  });
  await prisma.commMessage.create({
    data: {
      channelId: chanBySlug.planning.id,
      userId: marie.id,
      text: '📅 Poste découvert samedi 8 mars matin (Paris 11) suite à l\'absence de Léa A.',
    },
  });
  console.log('✓ Canaux & messages de communication créés');

  // ── Survey ───────────────────────────────────────────────────
  const { computeEndsAt } = require('../src/lib/survey-schedule');
  const durationDays = 7;
  const survey = await prisma.survey.create({
    data: {
      companyId: company.id,
      weekStart: monday,
      weekLabel: `Semaine du ${monday.toLocaleDateString('fr-FR')}`,
      status: 'ACTIVE',
      durationDays,
      endsAt: computeEndsAt(monday, durationDays),
      onlyOnWorkShifts: true,
      isCustom: false,
      questions: {
        create: [
          { text: 'Comment vous sentez-vous ce matin ?', order: 1, type: 'SCALE' },
          { text: 'Votre charge de travail est-elle supportable ?', order: 2, type: 'SCALE' },
          { text: 'Vous sentez-vous soutenu·e par votre équipe ?', order: 3, type: 'SCALE' },
          { text: 'Disposez-vous des ressources nécessaires ?', order: 4, type: 'SCALE' },
          { text: 'Votre relation avec votre manager est-elle sereine ?', order: 5, type: 'SCALE' },
          { text: 'Vous sentez-vous reconnu·e dans votre travail ?', order: 6, type: 'SCALE' },
          { text: 'L\'ambiance générale est-elle positive ?', order: 7, type: 'SCALE' },
          { text: 'Avez-vous pu faire des pauses suffisantes ?', order: 8, type: 'SCALE' },
          { text: 'Votre niveau de stress est-il maîtrisable ?', order: 9, type: 'SCALE' },
          { text: 'Vous sentez-vous en sécurité au travail ?', order: 10, type: 'SCALE' },
          { text: 'Le rythme de travail est-il soutenable ?', order: 11, type: 'SCALE' },
          { text: 'Avez-vous des remarques à faire ?', order: 12, type: 'TEXT', optional: true },
        ],
      },
    },
    include: { questions: true },
  });
  console.log('✓ Survey actuel créé');
  console.log('   (aucune réponse QCM pré-remplie — chaque collaborateur répond lui-même)');

  console.log('\n🎉 Seed terminé — 50 collaborateurs sur 8 sites');
  console.log('   DRH      : marie.lambert@saveurs-co.fr / Pulsiia2026!');
  console.log('   Manager  : thomas.martin@saveurs-co.fr / Pulsiia2026!');
  console.log('   RH       : camille.rey@saveurs-co.fr / Pulsiia2026!');
  console.log('   Collab   : lea.arnaud@saveurs-co.fr / Pulsiia2026!');
  console.log('   (tous les comptes @saveurs-co.fr → mot de passe Pulsiia2026!)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
