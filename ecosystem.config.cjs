/**
 * PM2 process file. Run from backend directory:
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart swarna-grow-crm-api
 *   pm2 logs swarna-grow-crm-api
 */
module.exports = {
  apps: [
    {
      name: 'swarna-grow-crm-api',
      cwd: __dirname,
      script: 'src/server.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '750M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
