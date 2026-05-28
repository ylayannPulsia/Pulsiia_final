// ============================================================
//  Pulsiia — PM2 Ecosystem Config
//  Calibré pour MVP ~30 utilisateurs (DEV1-S Scaleway)
// ============================================================
module.exports = {
  apps: [
    // ── Backend API ──────────────────────────────────────────
    {
      name: 'pulsiia-api',
      script: './backend/src/index.js',
      cwd: '/home/pulsiia/app',

      // 3 instances sur DEV1-M (3 vCPU) — prod stable
      instances: 3,
      exec_mode: 'cluster',

      autorestart: true,
      watch: false,
      max_memory_restart: '512M',

      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },

      out_file:        '/var/log/pulsiia/api-out.log',
      error_file:      '/var/log/pulsiia/api-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs:      true,
      kill_timeout:    5000,
      listen_timeout:  10000,
    },

    // ── Frontend (proxy → backend) ───────────────────────────
    {
      name: 'pulsiia-frontend',
      script: './frontend/server.js',
      cwd: '/home/pulsiia/app',

      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      watch: false,
      max_memory_restart: '256M',

      env_production: {
        NODE_ENV:    'production',
        PORT:        3000,
        BACKEND_URL: 'http://127.0.0.1:3001',
      },

      out_file:        '/var/log/pulsiia/frontend-out.log',
      error_file:      '/var/log/pulsiia/frontend-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs:      true,
      kill_timeout:    3000,
      listen_timeout:  8000,
    },
  ],
};
