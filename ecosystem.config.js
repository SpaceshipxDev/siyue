// pm2 process definition for the production VM (/srv/siyue).
//
// WHY THIS EXISTS — the box was running the app as a SINGLE forked Node
// process (`pm2 start npm -- start`, mode: fork). Node executes JS on one
// thread, so the commerce dashboard's ~2.4s server render blocks the event
// loop and concurrent requests queue: 5 simultaneous loads measured at
// 6–7s each vs ~2.6s solo, even though the box sat idle at load 0.00.
// Cluster mode runs one worker per core and pm2 load-balances :3000 across
// them, so concurrent renders run on parallel event loops.
//
// Deploy (see AGENTS.md — runs on the VM, build happens there, NOT in CI):
//   cd /srv/siyue && git pull && npm run build
//   pm2 delete siyue                       # drop the old fork-mode process
//   pm2 start ecosystem.config.js --update-env
//   pm2 save
// Then clean up the stray duplicate process:
//   pm2 describe siyue-ai && pm2 delete siyue-ai && pm2 save
// Do NOT touch the `caddy` pm2 process — it's the reverse proxy / TLS.
module.exports = {
  apps: [
    {
      name: 'siyue',
      // next start is cluster-safe: workers are stateless HTTP servers and
      // all shared state lives in Supabase. Point at the next binary directly
      // rather than `npm start` so pm2 cluster forks a Node script (not npm).
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      cwd: '/srv/siyue',
      // One worker per vCPU. If the box is RAM-constrained (check `free -m`;
      // each Next worker is ~150–250MB), pin this to a number (e.g. 2) instead.
      instances: 'max',
      exec_mode: 'cluster',
      // Guard a single worker leak from OOM-killing the whole box; pm2 respawns
      // just that worker, the others keep serving.
      max_memory_restart: '900M',
      // .env.local is read by Next at runtime; keep using --update-env on
      // restart so env changes take effect (pm2 caches env at spawn time).
      env: { NODE_ENV: 'production' },
    },
  ],
}
