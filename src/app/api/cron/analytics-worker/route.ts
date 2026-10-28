import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const budgetSeconds = Math.min(
    Math.max(Number(process.env.WORKER_BURST_SECONDS || 50) || 50, 5),
    280,
  );
  // The analytics pipeline branches on the internal process role; set it
  // before importing the worker module, mirroring src/liekan-worker/analytics.ts.
  const { setInternalProcessRole } = await import('@/lib/liekan/upstream/process-role');
  setInternalProcessRole('analytics-worker');
  const { runAnalyticsWorkerOnce } = await import(
    '@/lib/liekan/vercel/run-analytics-worker-once'
  );
  const result = await runAnalyticsWorkerOnce(budgetSeconds * 1000);
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
