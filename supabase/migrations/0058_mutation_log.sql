-- Cross-worker idempotency for /api/mutate.
--
-- Until now the mutate route deduped client retries with an in-memory Map,
-- which only works because pm2 ran a SINGLE forked Node worker. We're moving
-- to pm2 cluster mode (one worker per core) so concurrent requests stop
-- queueing on one event loop. Under cluster, a retried POST (the mainland↔HK
-- link kills the first response after the write committed, client resends the
-- same requestId) round-robins to a DIFFERENT worker whose Map never saw it —
-- and the non-idempotent kinds (appendComponent, createOutsourceBlock,
-- createReturn) would double-apply.
--
-- This table is the shared, durable idempotency store. The route writes the
-- response here keyed by requestId after each mutation, and replays it if the
-- same requestId arrives again within the TTL. The in-memory Map stays as a
-- same-worker fast path; this is the cross-worker backstop.
--
-- MANUAL MIGRATION (see AGENTS.md): apply this to Supabase by hand. The route
-- degrades gracefully to Map-only if the table is absent, so a deploy that
-- lands before this runs is correct-on-a-single-worker but unsafe under
-- cluster — apply this BEFORE switching pm2 to cluster mode.
create table if not exists mutation_log (
  request_id text primary key,
  status     int  not null,
  body       jsonb not null,
  created_at timestamptz not null default now()
);

-- Entries are only useful for the ~60s retry window; index created_at so a
-- periodic cleanup (or pg_cron) can prune cheaply. Reads are by primary key.
create index if not exists mutation_log_created_at_idx on mutation_log (created_at);
