'use strict';

const { AppError } = require('../utils/errors');

// Gestionnaire d'erreurs global Express (4 arguments obligatoires)
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }

  // Erreurs Prisma connues
  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'Cette valeur existe déjà', code: 'DUPLICATE' });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Ressource introuvable', code: 'NOT_FOUND' });
  }

  // Erreur inattendue — ne pas exposer le détail en production
  if (process.env.NODE_ENV !== 'production') {
    console.error(err);
  }
  res.status(500).json({ error: 'Erreur interne du serveur', code: 'INTERNAL_ERROR' });
}

module.exports = { errorHandler };
