/* eslint-disable no-console */
/**
 * One-time database bootstrap for the Vercel edition.
 *
 * Run this once from a trusted machine after creating the PostgreSQL
 * database (for example a Supabase project) and before the first Vercel
 * deployment serves traffic:
 *
 *   DATABASE_URL=<session-pooler-or-direct-url> pnpm vercel:bootstrap
 *
 * Set DIRECT_DATABASE_URL to the direct (non-pooled) connection string when
 * the runtime DATABASE_URL goes through a transaction pooler; migrations
 * need a session-level connection. The script reuses the exact steps the
 * Docker entrypoint runs on first install: upstream Prisma migrations,
 * Liekan SQL migrations, the bundled official demo import, and the pg-boss
 * queue bootstrap. Every step is idempotent, so re-running is safe.
 */
import { spawnSync } from 'node:child_process';

if (!process.env.DATABASE_URL && !process.env.DIRECT_DATABASE_URL) {
  console.error('Set DATABASE_URL (or DIRECT_DATABASE_URL) first. See README-VERCEL.md.');
  process.exit(1);
}

const directUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
// Supabase hostnames also resolve to IPv6 addresses, which some networks
// (e.g. GitHub-hosted runners) cannot route: ENETUNREACH. Make every
// spawned Node process prefer IPv4 DNS results.
const nodeOptions = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first']
  .filter(Boolean)
  .join(' ');
const env = { ...process.env, DATABASE_URL: directUrl, NODE_OPTIONS: nodeOptions };

const steps = [
  // The standalone scripts import a bundled client at generated/prisma/
  // client.js, which a fresh checkout (e.g. CI) does not have yet: it is
  // built from the generated TypeScript client in two steps.
  ['pnpm', ['exec', 'prisma', 'generate'], 'Generate Prisma client'],
  ['node', ['scripts/build-prisma-client.js'], 'Bundle Prisma client for scripts'],
  ['node', ['scripts/check-db.js'], 'Upstream migrations (prisma migrate deploy)'],
  ['node', ['scripts/liekan-migrate.mjs'], 'Liekan SQL migrations'],
  ['node', ['scripts/liekan-seed-demo.mjs', '--automatic'], 'Official demo import'],
  ['node', ['scripts/liekan-queue-bootstrap.mjs'], 'Queue bootstrap (pg-boss)'],
];

for (const [cmd, args, label] of steps) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (result.status !== 0) {
    console.error(`Bootstrap step failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nBootstrap complete. Default login: admin / liekan (change it after signing in).');
