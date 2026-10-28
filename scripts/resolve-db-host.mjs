/* eslint-disable no-console */
/**
 * Print an /etc/hosts line pinning the DATABASE_URL hostname to an IPv4
 * address:  "<ipv4> <hostname>".
 *
 * Used by the bootstrap GitHub Actions workflow: Supabase hostnames also
 * publish AAAA records, GitHub-hosted runners have no IPv6 route
 * (connect ENETUNREACH), and not every driver in the stack honors
 * --dns-result-order=ipv4first. Pinning the host in /etc/hosts is the
 * deterministic fix. Usage:
 *
 *   DATABASE_URL=... node scripts/resolve-db-host.mjs | sudo tee -a /etc/hosts
 */
import { resolve4 } from 'node:dns';

const raw = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!raw) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const host = new URL(raw).hostname;
resolve4(host, (err, addresses) => {
  if (err || !addresses?.length) {
    console.error(`Could not resolve an IPv4 address for ${host}: ${err?.message ?? 'none'}`);
    if (host.startsWith('db.') && host.endsWith('.supabase.co')) {
      console.error(
        'That is the Supabase DIRECT host, which is IPv6-only. Use the Session pooler ' +
          'connection string instead (host ....pooler.supabase.com, port 5432, user postgres.<project-ref>).',
      );
    }
    process.exit(1);
  }
  console.log(`${addresses[0]} ${host}`);
});
