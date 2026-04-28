const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function upsertMany(model, items, key = 'id') {
  for (const item of items) {
    await model.upsert({
      where: { [key]: item[key] },
      update: {},
      create: item,
    });
  }
}

async function main() {
  console.log('🌱 Seeding database...');

  // Sites
  await upsertMany(prisma.site, [
    { id: 'site-siege', nom: 'Siège', adresse: '12 rue de la Paix', ville: 'Paris' },
    { id: 'site-p11', nom: 'Paris 11', adresse: '45 bd Voltaire', ville: 'Paris' },
    { id: 'site-p18', nom: 'Paris 18', adresse: '8 rue Ordener', ville: 'Paris' },
    { id: 'site-lyon', nom: 'Lyon Centre', adresse: '3 place Bellecour', ville: 'Lyon' },
    { id: 'site-bx', nom: 'Bordeaux', adresse: "22 cours de l'Intendance", ville: 'Bordeaux' },
  ]);

  const hash = (pwd) => bcrypt.hashSync(pwd, 10);

  // Users
  await upsertMany(prisma.user, [
    { id: 'user-marie', email: 'marie.lambert@pulsiia.fr', password: hash('Pulsiia2026!'), nom: 'Lambert', prenom: 'Marie', role: 'RH', poste: 'Directrice RH', telephone: '06 12 34 56 78', siteId: 'site-siege' },
    { id: 'user-thomas', email: 'thomas.martin@pulsiia.fr', password: hash('Pulsiia2026!'), nom: 'Martin', prenom: 'Thomas', role: 'MANAGER', poste: 'Chef de rang', siteId: 'site-p11' },
    { id: 'user-lea', email: 'lea.anders@pulsiia.fr', password: hash('Collab2026!'), nom: 'Anders', prenom: 'Léa', role: 'COLLABORATEUR', poste: 'Serveuse', siteId: 'site-p11' },
    { id: 'user-marc', email: 'marc.dupont@pulsiia.fr', password: hash('Collab2026!'), nom: 'Dupont', prenom: 'Marc', role: 'COLLABORATEUR', poste: 'Cuisinier', siteId: 'site-p11' },
    { id: 'user-sara', email: 'sara.benali@pulsiia.fr', password: hash('Collab2026!'), nom: 'Benali', prenom: 'Sara', role: 'COLLABORATEUR', poste: 'Hôtesse', siteId: 'site-p18' },
    { id: 'user-kevin', email: 'kevin.moreau@pulsiia.fr', password: hash('Collab2026!'), nom: 'Moreau', prenom: 'Kévin', role: 'COLLABORATEUR', poste: 'Barman', siteId: 'site-lyon' },
    { id: 'user-julie', email: 'julie.petit@pulsiia.fr', password: hash('Collab2026!'), nom: 'Petit', prenom: 'Julie', role: 'COLLABORATEUR', poste: 'Serveuse', siteId: 'site-bx' },
    { id: 'user-alex', email: 'alex.rousseau@pulsiia.fr', password: hash('Collab2026!'), nom: 'Rousseau', prenom: 'Alex', role: 'COLLABORATEUR', poste: 'Cuisinier', siteId: 'site-p18' },
    { id: 'user-nadia', email: 'nadia.cohen@pulsiia.fr', password: hash('Collab2026!'), nom: 'Cohen', prenom: 'Nadia', role: 'COLLABORATEUR', poste: 'Manager salle', siteId: 'site-p11' },
  ], 'email');

  // Absences
  await upsertMany(prisma.absence, [
    { id: 'abs-1', userId: 'user-lea', type: 'MALADIE', dateDebut: '2026-03-05', dateFin: '2026-03-07', statut: 'EN_ATTENTE', motif: 'Grippe' },
    { id: 'abs-2', userId: 'user-marc', type: 'CONGES_PAYES', dateDebut: '2026-03-10', dateFin: '2026-03-14', statut: 'APPROUVE' },
    { id: 'abs-3', userId: 'user-sara', type: 'RTT', dateDebut: '2026-03-06', dateFin: '2026-03-06', statut: 'APPROUVE' },
    { id: 'abs-4', userId: 'user-kevin', type: 'CONGES_PAYES', dateDebut: '2026-03-20', dateFin: '2026-03-27', statut: 'EN_ATTENTE' },
  ]);

  // Planning shifts
  await upsertMany(prisma.planningShift, [
    { id: 'sh-1', userId: 'user-lea', siteId: 'site-p11', date: '2026-03-08', heureDebut: '09:00', heureFin: '17:00', poste: 'Service', statut: 'REMPLACEMENT_REQUIS' },
    { id: 'sh-2', userId: 'user-marc', siteId: 'site-p11', date: '2026-03-08', heureDebut: '10:00', heureFin: '18:00', poste: 'Cuisine', statut: 'CONFIRME' },
    { id: 'sh-3', userId: 'user-sara', siteId: 'site-p18', date: '2026-03-05', heureDebut: '08:00', heureFin: '16:00', poste: 'Accueil', statut: 'CONFIRME' },
    { id: 'sh-4', userId: 'user-nadia', siteId: 'site-p11', date: '2026-03-05', heureDebut: '11:00', heureFin: '23:00', poste: 'Manager', statut: 'CONFIRME' },
    { id: 'sh-5', userId: 'user-kevin', siteId: 'site-lyon', date: '2026-03-06', heureDebut: '18:00', heureFin: '02:00', poste: 'Bar', statut: 'CONFIRME' },
  ]);

  // Variables prépaie
  await upsertMany(prisma.prepaieVariable, [
    { id: 'pp-1', userId: 'user-marc', periode: 'mars-2026', type: 'Heures supplémentaires', montant: 320, statut: 'A_VALIDER' },
    { id: 'pp-2', userId: 'user-lea', periode: 'mars-2026', type: 'Prime transport', montant: 75, statut: 'VALIDE' },
    { id: 'pp-3', userId: 'user-nadia', periode: 'mars-2026', type: 'Prime ancienneté', montant: 150, statut: 'VALIDE' },
    { id: 'pp-4', userId: 'user-sara', periode: 'mars-2026', type: 'Heures supplémentaires', montant: 420, statut: 'ANOMALIE', anomalie: 'Volume inhabituel (+40%)' },
    { id: 'pp-5', userId: 'user-kevin', periode: 'mars-2026', type: 'Prime de nuit', montant: 200, statut: 'A_VALIDER' },
    { id: 'pp-6', userId: 'user-alex', periode: 'mars-2026', type: 'Prime transport', montant: 50, statut: 'VALIDE' },
    { id: 'pp-7', userId: 'user-julie', periode: 'mars-2026', type: 'Heures supplémentaires', montant: 180, statut: 'A_VALIDER' },
  ]);

  // Documents
  await upsertMany(prisma.document, [
    { id: 'doc-1', userId: 'user-lea', nom: 'Bulletin de salaire', type: 'Bulletin', periode: 'Février 2026', taille: '124 Ko' },
    { id: 'doc-2', userId: 'user-lea', nom: 'Bulletin de salaire', type: 'Bulletin', periode: 'Janvier 2026', taille: '118 Ko' },
    { id: 'doc-3', userId: 'user-lea', nom: 'Contrat de travail CDI', type: 'Contrat', taille: '245 Ko' },
    { id: 'doc-4', userId: 'user-marc', nom: 'Bulletin de salaire', type: 'Bulletin', periode: 'Février 2026', taille: '131 Ko' },
    { id: 'doc-5', userId: 'user-marc', nom: 'Contrat de travail CDI', type: 'Contrat', taille: '238 Ko' },
    { id: 'doc-6', userId: 'user-sara', nom: 'Attestation employeur', type: 'Attestation', taille: '89 Ko' },
  ]);

  // Campagne QCM
  const campagneExists = await prisma.qcmCampagne.findUnique({ where: { id: 'qcm-1' } });
  if (!campagneExists) {
    await prisma.qcmCampagne.create({
      data: {
        id: 'qcm-1',
        titre: 'Baromètre bien-être Q1 2026',
        description: 'Évaluation trimestrielle du bien-être des équipes',
        statut: 'ACTIVE',
        dateDebut: '2026-03-01',
        dateFin: '2026-03-31',
        questions: {
          create: [
            { ordre: 1, type: 'rating', texte: 'Comment évaluez-vous votre bien-être général au travail cette semaine ?' },
            { ordre: 2, type: 'rating', texte: 'Votre charge de travail est-elle adaptée ?' },
            { ordre: 3, type: 'yesno', texte: 'Avez-vous eu des difficultés relationnelles ?' },
            { ordre: 4, type: 'text', texte: 'Y a-t-il quelque chose à partager avec les RH ?' },
          ],
        },
      },
    });
  }

  // Notifications
  await upsertMany(prisma.notification, [
    { id: 'notif-1', userId: 'user-marie', titre: 'Absence maladie', message: "Léa A. a déclaré une absence maladie du 5 au 7 mars", type: 'URGENT', lu: false },
    { id: 'notif-2', userId: 'user-marie', titre: 'Poste découvert', message: 'Sam 8 matin · Paris 11 · 1 remplaçant identifié', type: 'ALERTE', lu: false },
    { id: 'notif-3', userId: 'user-marie', titre: 'Variables prépaie', message: '7 variables à valider pour mars 2026', type: 'INFO', lu: false },
  ]);

  // Messages
  await upsertMany(prisma.message, [
    { id: 'msg-1', auteurId: 'user-marie', titre: '🌟 Bienvenue sur Pulsiia !', contenu: 'Votre espace RH unifié est maintenant actif.', type: 'ANNONCE' },
    { id: 'msg-2', auteurId: 'user-marie', titre: 'Fermeture exceptionnelle 15 mars', contenu: "L'établissement Paris 11 sera fermé le 15 mars 2026.", type: 'ANNONCE' },
  ]);

  console.log('✅ Seed terminé !');
  console.log('');
  console.log('  Comptes de test :');
  console.log('  RH     → marie.lambert@pulsiia.fr  / Pulsiia2026!');
  console.log('  Collab → lea.anders@pulsiia.fr     / Collab2026!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
