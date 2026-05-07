'use strict';

class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

class AuthError extends AppError {
  constructor(message = 'Non authentifié', code = 'AUTH_REQUIRED') {
    super(message, 401, code);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Accès interdit', code = 'FORBIDDEN') {
    super(message, 403, code);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Données invalides', code = 'VALIDATION_ERROR') {
    super(message, 422, code);
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Ressource', code = 'NOT_FOUND') {
    super(`${resource} introuvable`, 404, code);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflit de données', code = 'CONFLICT') {
    super(message, 409, code);
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Trop de tentatives, réessayez dans quelques minutes', code = 'RATE_LIMIT') {
    super(message, 429, code);
  }
}

module.exports = { AppError, AuthError, ForbiddenError, ValidationError, NotFoundError, ConflictError, RateLimitError };
