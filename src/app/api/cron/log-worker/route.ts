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
  const { runLogWorkerOnce } = await import('@/lib/liekan/vercel/run-log-worker-once');
  const result = await runLogWorkerOnce(budgetSeconds * 1000);
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
