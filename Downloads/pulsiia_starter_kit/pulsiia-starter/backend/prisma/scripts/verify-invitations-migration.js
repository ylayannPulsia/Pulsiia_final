// Vérifie que la migration invitations multi-sociétés est bien en place
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const userCount = await prisma.user.count();
    const invitationCount = await prisma.companyInvitation.count();
    const indexes = await prisma.$queryRaw`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'User' AND indexname LIKE '%email%'
      ORDER BY indexname
    `;

    const hasCompanyEmailUnique = indexes.some((r) => r.indexname === 'User_companyId_email_key');
    const hasEmailIdx = indexes.some((r) => r.indexname === 'User_email_idx');
    const oldGlobalUnique = indexes.some((r) => r.indexname === 'User_email_key');

    console.log('✓ Migration invitations — état de la base');
    console.log('  Utilisateurs:', userCount);
    console.log('  Invitations en attente / historique:', invitationCount);
    console.log('  Index e-mail:', indexes.map((r) => r.indexname).join(', ') || '(aucun)');
    console.log('  Contrainte (companyId, email):', hasCompanyEmailUnique ? 'OK' : 'MANQUANTE');
    console.log('  Index email (login):', hasEmailIdx ? 'OK' : 'MANQUANTE');
    if (oldGlobalUnique) {
      console.warn('  ⚠ Ancien index User_email_key encore présent (non bloquant si companyId_email existe)');
    }

    if (!hasCompanyEmailUnique) {
      process.exitCode = 1;
      console.error('\n✗ Exécutez: npx prisma db execute --file prisma/migrations/20260528120000_company_invitations/migration.sql');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
