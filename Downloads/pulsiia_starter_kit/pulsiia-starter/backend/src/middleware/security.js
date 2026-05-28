// middleware/security.js — HTTPS prod, Helmet, rate-limit auth

function configureTrustProxy(app) {
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }
}

/** Redirige HTTP → HTTPS derrière un reverse proxy (Railway, Render, Nginx…). */
function forceHttps(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();

  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto.split(',')[0].trim() !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
}

function helmetOptions() {
  const base = {
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  };

  if (process.env.NODE_ENV === 'production') {
    return {
      ...base,
      hsts: {
        maxAge: 31_536_000,
        includeSubDomains: true,
        preload: true,
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    };
  }

  return base;
}

module.exports = { configureTrustProxy, forceHttps, helmetOptions };
