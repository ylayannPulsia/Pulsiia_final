// Validation express-validator — réponses en français
const { validationResult } = require('express-validator');

const FIELD_LABELS = {
  email: 'E-mail',
  password: 'Mot de passe',
  currentPassword: 'Mot de passe actuel',
  newPassword: 'Nouveau mot de passe',
  refreshToken: 'Jeton de rafraîchissement',
  userId: 'Utilisateur',
  siteId: 'Site',
  type: 'Type',
  status: 'Statut',
  period: 'Période',
  month: 'Mois',
  from: 'Date de début',
  to: 'Date de fin',
  date: 'Date',
  startDate: 'Date de début',
  endDate: 'Date de fin',
  format: 'Format',
  limit: 'Limite',
  weeks: 'Nombre de semaines',
  reason: 'Motif',
  motif: 'Motif',
  refuseReason: 'Motif de refus',
  id: 'Identifiant',
  answers: 'Réponses',
};

function frenchFieldLabel(path) {
  if (!path) return 'Champ';
  const key = String(path).replace(/\[\d+\]/g, '').split('.').pop();
  return FIELD_LABELS[key] || key;
}

function toFrenchDetail(err) {
  const field = err.path ?? err.param;
  const label = frenchFieldLabel(field);
  if (err.msg && typeof err.msg === 'string' && !/^Invalid/i.test(err.msg)) {
    return { champ: field, message: err.msg };
  }
  if (err.type === 'field') {
    if (err.path === 'email') return { champ: field, message: 'Adresse e-mail invalide.' };
    if (err.path === 'password' || err.path === 'currentPassword') {
      return { champ: field, message: 'Mot de passe requis.' };
    }
    if (err.path === 'newPassword') return { champ: field, message: 'Le mot de passe doit contenir au moins 8 caractères.' };
  }
  return { champ: field, message: `${label} invalide.` };
}

/**
 * Envoie 400 si la validation échoue. Retourne true si OK, false si erreur déjà envoyée.
 */
function handleValidation(req, res) {
  const result = validationResult(req);
  if (result.isEmpty()) return true;

  res.status(400).json({
    error: 'Données invalides.',
    details: result.array().map(toFrenchDetail),
  });
  return false;
}

module.exports = { handleValidation, toFrenchDetail };
