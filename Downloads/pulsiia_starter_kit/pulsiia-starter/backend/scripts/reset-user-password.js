// Réinitialise le mot de passe d'un utilisateur (prod / support)
// Usage:
//   EMAIL=user@example.com NEW_PASSWORD='MotDePasseSecur1!' node scripts/reset-user-password.js
//   DATABASE_URL="postgresql://..." EMAIL=... NEW_PASSWORD=... node scripts/reset-user-password.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const email = process.env.EMAIL?.trim().toLowerCase();
const newPassword = process.env.NEW_PASSWORD;

if (!email || !newPassword) {
  console.error('Variables requises : EMAIL et NEW_PASSWORD (min. 8 caractères).');
  process.exit(1);
}
if (newPassword.length < 8) {
  console.error('NEW_PASSWORD doit contenir au moins 8 caractères.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL manquant (définir dans .env ou en variable d\'environnement).');
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`Aucun utilisateur avec l'e-mail : ${email}`);
    process.exit(1);
  }
  if (!user.isActive) {
    console.error(`Compte inactif : ${email}`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    }),
    prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
  ]);

  console.log(`Mot de passe mis à jour pour ${email} (${user.firstName} ${user.lastName}, rôle ${user.role}).`);
  console.log('Sessions et jetons de réinitialisation en cours ont été révoqués.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
