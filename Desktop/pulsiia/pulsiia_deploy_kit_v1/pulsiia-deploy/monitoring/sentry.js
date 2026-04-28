/**
 * Sentry — error tracking + performance monitoring
 *
 * À monter dans `src/server.js` du monorepo Pulsiia :
 *
 *   const { initSentry, sentryErrorHandler } = require('./monitoring/sentry');
 *   initSentry(app);
 *   // ... toutes tes routes ...
 *   sentryErrorHandler(app);
 *
 * Filtre automatiquement :
 *  - Les erreurs liées aux refresh tokens expirés (normal)
 *  - Les requêtes /health (volume)
 *  - Les rate-limit 429 (normal)
 */

const Sentry = require('@sentry/node');

function initSentry(app) {
  if (!process.env.SENTRY_DSN) {
    console.warn('[sentry] DSN non configuré — error tracking désactivé');
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
    release: process.env.PULSIIA_VERSION,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    profilesSampleRate: 0.1,

    // Évite de logger des données sensibles
    sendDefaultPii: false,

    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
      Sentry.postgresIntegration(),
    ],

    beforeSend(event, hint) {
      const err = hint?.originalException;

      // Filtre erreurs OAuth refresh (normales, ne pas spammer)
      if (err?.message?.match(/refresh failed|token expired|invalid_grant/)) {
        return null;
      }

      // Filtre rate limits (429)
      if (event.contexts?.response?.status_code === 429) return null;

      // Filtre healthcheck noise
      if (event.request?.url?.endsWith('/health')) return null;

      // Strip secrets dans les contexts
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
        delete event.request.headers['x-api-key'];
      }
      if (event.request?.data) {
        ['password', 'apiKey', 'access_token', 'refresh_token', 'authorization_token']
          .forEach((k) => {
            if (event.request.data[k]) event.request.data[k] = '[FILTERED]';
          });
      }

      return event;
    },
  });

  // Request handler doit être premier middleware
  app.use(Sentry.Handlers.requestHandler({
    user: ['id', 'email', 'role'], // pas de PII sensible
  }));
  app.use(Sentry.Handlers.tracingHandler());
}

function sentryErrorHandler(app) {
  if (!process.env.SENTRY_DSN) return;
  // Doit être avant tous les autres error handlers
  app.use(Sentry.Handlers.errorHandler({
    shouldHandleError(error) {
      // Ne capture pas les 4xx (sauf 401 qui peut indiquer une attaque)
      const status = error.status || error.statusCode || 500;
      if (status >= 500) return true;
      if (status === 401) return true;
      return false;
    },
  }));
}

/**
 * Helper pour capturer manuellement un événement Pulse
 */
function captureBreadcrumb(category, message, data = {}) {
  Sentry.addBreadcrumb({
    category: `pulse.${category}`,
    message,
    level: 'info',
    data,
    timestamp: Date.now() / 1000,
  });
}

function captureToolError(toolName, error, context = {}) {
  Sentry.withScope((scope) => {
    scope.setTag('pulse.tool', toolName);
    scope.setContext('pulse', context);
    Sentry.captureException(error);
  });
}

module.exports = {
  initSentry,
  sentryErrorHandler,
  captureBreadcrumb,
  captureToolError,
  Sentry,
};
