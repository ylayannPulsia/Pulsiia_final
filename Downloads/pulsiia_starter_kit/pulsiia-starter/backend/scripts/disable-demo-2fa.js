// Désactive la 2FA sur le compte démo DRH (dev uniquement)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.user.updateMany({
    where: { email: 'marie.lambert@saveurs-co.fr' },
    data: {
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorPendingSecret: null,
    },
  });
  console.log(`2FA désactivée sur marie.lambert@saveurs-co.fr (${result.count} compte(s))`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
