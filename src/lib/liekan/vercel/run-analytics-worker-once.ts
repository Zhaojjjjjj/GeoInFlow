/**
 * Vercel edition: bounded one-shot version of the Liekan analytics worker.
 *
 * Mirrors src/liekan-worker/analytics-main.ts: registers the same pg-boss
 * handlers and runs one pump cycle, then keeps polling for a bounded budget
 * so queued analysis work drains in bursts. Invoked from
 * /api/cron/analytics-worker. The caller must set the internal process role
 * to 'analytics-worker' before importing this module.
 */
import { PgBoss } from 'pg-boss';
import prisma from '@/lib/prisma';
import { QUEUE_SCHEMA } from '@/lib/liekan/log-ingestion/queue';
import {
  ANALYTICS_QUEUE,
  pumpAnalyticsHot,
  type AnalyticsRefreshJob,
} from '@/lib/liekan/upstream/analytics-hot';
import { analyticsRedis } from '@/lib/liekan/upstream/analytics-redis';
import { probeAnalysisExpansion } from '@/lib/liekan/upstream/analysis-expansion';
import { withAnalysisPermit } from '@/lib/liekan/upstream/analysis-background';
import {
  pumpAnalysisBuilds,
  processAnalysisBuild,
} from '@/lib/liekan/upstream/analysis-build-queue';
import {
  ANALYSIS_BUILD_QUEUE,
  ANALYSIS_QUERY_QUEUE,
} from '@/lib/liekan/upstream/analysis-query-model';
import {
  pumpAnalysisQueries,
  processAnalysisQueryDelivery,
} from '@/lib/liekan/upstream/analysis-queries';
import {
  bootstrapAnalysisHistory,
  reconcileAnalysisRollups,
} from '@/lib/liekan/upstream/analysis-rollups-worker';
import { pumpDashboardDemand } from '@/lib/liekan/upstream/dashboard-snapshots';
import {
  GEO_SNAPSHOT_QUEUE,
  processGeoSnapshotJob,
  reconcileGeoSnapshots,
  type GeoSnapshotJob,
} from '@/lib/liekan/upstream/geo-weight-snapshots';
import {
  processAnalyticsRefresh,
  readAnalyticsHotStrongVersion,
} from '@/liekan-worker/analytics-refresh';

export async function runAnalyticsWorkerOnce(budgetMs = 50_000) {
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    schema: QUEUE_SCHEMA,
    migrate: false,
    max: 2,
    schedule: false,
    supervise: true,
  });
  boss.on('error', () => {});
  let stopped = false;

  await boss.start();

  await boss.work<GeoSnapshotJob>(
    GEO_SNAPSHOT_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
    async jobs => {
      for (const job of jobs)
        if (!stopped)
          await withAnalysisPermit('interactive', () => processGeoSnapshotJob(job.data, boss));
    },
  );
  await boss.work<AnalyticsRefreshJob>(
    ANALYTICS_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
    async jobs => {
      for (const job of jobs)
        if (!stopped) await withAnalysisPermit('preheat', () => processAnalyticsRefresh(job.data));
    },
  );
  await boss.work<{ id: string }>(
    ANALYSIS_QUERY_QUEUE,
    { localConcurrency: 2, batchSize: 1, pollingIntervalSeconds: 1, includeMetadata: true },
    async jobs => {
      for (const job of jobs) if (!stopped) await processAnalysisQueryDelivery(job, boss);
    },
  );
  await boss.work<{ id: string; kind: 'history' | 'incremental' }>(
    ANALYSIS_BUILD_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 1 },
    async jobs => {
      for (const job of jobs)
        if (!stopped)
          await processAnalysisBuild(job.data.id, job.data.kind, { shouldStop: () => stopped });
    },
  );

  // One pump cycle, mirroring the resident worker's maintenance interval.
  try {
    await bootstrapAnalysisHistory();
    await reconcileAnalysisRollups();
    await pumpDashboardDemand();
    await pumpAnalysisQueries(boss);
    await pumpAnalysisBuilds(boss);
    await pumpAnalyticsHot(boss, readAnalyticsHotStrongVersion);
  } catch {
    /* A failed pass leaves persistent demand for the next burst. */
  }
  void reconcileGeoSnapshots(boss).catch(() => {});
  void probeAnalysisExpansion().catch(() => {});

  await new Promise(resolve => setTimeout(resolve, budgetMs));
  stopped = true;
  await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
  analyticsRedis.close();
  await prisma.client.$disconnect().catch(() => {});
  return { worker: 'analytics', budgetMs, stopped };
}
