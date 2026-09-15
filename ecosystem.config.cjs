// pm2 process manager config — keeps the API and web dev server running,
// auto-restarting them if either crashes or the machine wakes from an
// unexpected interruption. Not committed as project-wide config for other
// devs necessarily, but safe to keep in the repo since it has no secrets
// (real values live in each app's own .env / .env.local).
module.exports = {
  apps: [
    {
      // pm2 on Windows can't spawn a .cmd file directly (Node's child_process
      // needs shell:true for that, which pm2 doesn't set) — routing through
      // cmd.exe /c, a real .exe, avoids the "spawn EINVAL" error.
      name: 'champpower-api',
      cwd: './apps/api',
      script: 'cmd.exe',
      args: '/c npx tsx watch --env-file=.env src/index.ts',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_restarts: 50,
      restart_delay: 2000,
    },
    {
      name: 'champpower-web',
      cwd: './apps/web',
      script: 'cmd.exe',
      args: '/c npx vite --host',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_restarts: 50,
      restart_delay: 2000,
    },
  ],
};
