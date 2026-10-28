/**
 * Vercel edition: bounded one-shot version of the Liekan log worker.
 *
 * The Docker worker (src/liekan-worker/main.ts) is a long-running pg-boss
 * consumer. Vercel functions cannot run forever, so this module registers the
 * same queue handlers, wakes the same singleton maintenance jobs, runs the
 * one-shot maintenance passes, then keeps polling for a bounded budget so
 * queued jobs drain in bursts. It is invoked from /api/cron/log-worker,
 * triggered by Vercel Cron or the scheduled GitHub Actions workflow.
 */
import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import prisma from '@/lib/prisma';
import {
  HISTORY_REPAIR_ENGINE,
  HISTORY_REPAIR_QUEUE,
} from '@/lib/liekan/contracts/history-repair';
import { processBrowserRisk } from '@/lib/liekan/upstream/browser-risk';
import {
  initializeCrawlerRegistry,
  withPublishedRegistry,
} from '@/lib/liekan/upstream/crawler-registry-context';
import {
  processHistoryRepairJob,
  reconcileHistoryRepairs,
} from '@/lib/liekan/upstream/history-repair';
import { pruneTrafficObservations } from '@/lib/liekan/upstream/observation-retention';
import { LiekanError, query, transaction } from '@/lib/liekan/upstream/server';
import { maintainGeography } from '@/lib/liekan/geography/update';
import { DOCUMENT_JOB_SECONDS } from '@/lib/liekan/crawlers/document-sources';
import { processCrawlerAnalysis } from '@/lib/liekan/crawlers/worker';
import { processCrawlerCheck } from '@/lib/liekan/crawler-control/diagnostics';
import { processCrawlerDeployment } from '@/lib/liekan/crawler-control/deployments';
import { maintainCrawlerRecords } from '@/lib/liekan/crawler-control/retention';
import { cleanupExpiredAuthorizations } from '@/lib/liekan/log-ingestion/cloudflare';
import { reconcilePermissions } from '@/lib/liekan/log-ingestion/maintenance';
import { maintainProvider } from '@/lib/liekan/log-ingestion/provider';
import {
  BROWSER_RISK_QUEUE,
  CRAWLER_ANALYSIS_QUEUE,
  CRAWLER_CHECK_QUEUE,
  CRAWLER_CONTROL_QUEUE,
  CRAWLER_SOURCE_RETRY,
  DOCUMENT_QUEUE,
  LOG_QUEUE,
  PROVIDER_QUEUE,
  QUEUE_SCHEMA,
  RANGE_QUEUE,
} from '@/lib/liekan/log-ingestion/queue';
import { recoverBatches } from '@/lib/liekan/log-ingestion/recovery';
import { refreshRanges } from '@/lib/liekan/log-ingestion/ranges';
import { processBatch } from '@/lib/liekan/log-ingestion/service';
import { refreshDocumentSources } from '@/lib/liekan/upstream/crawler-maintenance';

const HISTORY_REPAIR_WORK_QUEUE = HISTORY_REPAIR_QUEUE;

async function recordHealth(workerId: string) {
  await transaction(tx =>
    tx.$executeRawUnsafe(
      'INSERT INTO liekan_worker_state(id,heartbeat_at,version) VALUES($1,now(),$2) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),version=EXCLUDED.version',
      workerId,
      HISTORY_REPAIR_ENGINE,
    ),
  );
}

async function reconcileOnce(workerId: string) {
  await transaction(async tx => {
    await tx.$executeRawUnsafe(
      'INSERT INTO liekan_worker_state(id,heartbeat_at,version) VALUES($1,now(),$2) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),version=EXCLUDED.version',
      workerId,
      HISTORY_REPAIR_ENGINE,
    );
    await tx.$executeRawUnsafe('DELETE FROM liekan_log_grant WHERE expires_at<now()');
    await tx.$executeRawUnsafe(
      "DELETE FROM liekan_geography_ingress WHERE bucket<now()-interval '90 days'",
    );
    await tx.$executeRawUnsafe(
      "DELETE FROM liekan_ingest_batch WHERE state!='pending' AND received_at<now()-interval '30 days'",
    );
    await tx.$executeRawUnsafe(
      "DELETE FROM liekan_worker_state WHERE heartbeat_at<now()-interval '1 day'",
    );
  });
  const sources = await query(
    "SELECT id,state,credential_hash FROM liekan_log_source WHERE kind='cloudflare' AND provider_config IS NOT NULL ORDER BY last_maintenance_at NULLS FIRST LIMIT 100",
  );
  for (const source of sources) {
    await maintainProvider(
      source.id,
      source.state === 'disconnected' || !source.credential_hash
        ? 'disconnect'
        : source.state === 'configuring'
          ? 'configure'
          : 'health',
      workerId,
    ).catch(() => {});
  }
}

export async function runLogWorkerOnce(budgetMs = 50_000) {
  const workerId = randomUUID();
  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    schema: QUEUE_SCHEMA,
    migrate: false,
    max: 8,
    schedule: false,
    supervise: true,
  });
  boss.on('error', () => {});
  let stopped = false;

  await initializeCrawlerRegistry();
  await boss.start();

  await boss.work<{ runId: string }>(
    HISTORY_REPAIR_WORK_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2 },
    async jobs => {
      for (const job of jobs) await processHistoryRepairJob(job.data);
    },
  );
  await boss.work<{ batchId: string }>(
    LOG_QUEUE,
    { localConcurrency: 4, batchSize: 1, pollingIntervalSeconds: 1 },
    async jobs => {
      for (const job of jobs) {
        try {
          await processBatch(job.data.batchId);
        } catch (error) {
          if (error instanceof LiekanError && [401, 403, 404, 409].includes(error.status)) {
            await transaction(tx =>
              tx.$executeRawUnsafe(
                "UPDATE liekan_ingest_batch SET state='failed',payload=NULL,errors='[{\"reason\":\"source-or-event-invalid\"}]'::jsonb WHERE id=$1::uuid AND state='pending'",
                job.data.batchId,
              ),
            );
          } else throw new Error('Log batch processing failed');
        }
      }
    },
  );
  await boss.work<{ sourceId: string; action: 'configure' | 'disconnect' | 'health' }>(
    PROVIDER_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async jobs => {
      for (const job of jobs) await maintainProvider(job.data.sourceId, job.data.action, workerId);
    },
  );
  await boss.work(RANGE_QUEUE, { batchSize: 1 }, async () => {
    await withPublishedRegistry(() => refreshRanges());
  });
  await boss.work(DOCUMENT_QUEUE, { batchSize: 1, localConcurrency: 1 }, async () => {
    await withPublishedRegistry(() => refreshDocumentSources());
  });
  await boss.work(
    CRAWLER_ANALYSIS_QUEUE,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
    async () => {
      await withPublishedRegistry(() => processCrawlerAnalysis(workerId));
    },
  );
  await boss.work(
    CRAWLER_CHECK_QUEUE,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
    async () => {
      await processCrawlerCheck(workerId);
    },
  );
  await boss.work(
    CRAWLER_CONTROL_QUEUE,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
    async () => {
      await processCrawlerDeployment(workerId);
    },
  );
  await boss.work(
    BROWSER_RISK_QUEUE,
    { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 },
    async () => {
      await processBrowserRisk();
    },
  );

  // Wake the singleton maintenance jobs, mirroring the resident worker.
  await boss
    .send(
      BROWSER_RISK_QUEUE,
      {},
      {
        singletonKey: 'observe',
        singletonSeconds: 10,
        expireInSeconds: 300,
        retentionSeconds: 3600,
        retryLimit: 2,
      },
    )
    .catch(() => {});
  for (const queue of [CRAWLER_ANALYSIS_QUEUE, CRAWLER_CHECK_QUEUE, CRAWLER_CONTROL_QUEUE]) {
    await boss
      .send(
        queue,
        {},
        {
          singletonKey: 'wake',
          singletonSeconds: 2,
          expireInSeconds: 300,
          retentionSeconds: 3600,
          retryLimit: 2,
        },
      )
      .catch(() => {});
  }
  await boss
    .send(
      RANGE_QUEUE,
      {},
      {
        singletonKey: 'official',
        singletonSeconds: 3600,
        expireInSeconds: 600,
        ...CRAWLER_SOURCE_RETRY,
      },
    )
    .catch(() => {});
  await boss
    .send(
      DOCUMENT_QUEUE,
      {},
      {
        singletonKey: 'documents',
        singletonSeconds: 3600,
        expireInSeconds: DOCUMENT_JOB_SECONDS,
        retentionSeconds: 7 * 86400,
        ...CRAWLER_SOURCE_RETRY,
      },
    )
    .catch(() => {});

  // One-shot maintenance passes that the resident worker runs on timers.
  await recordHealth(workerId).catch(() => {});
  await recoverBatches().catch(() => {});
  await reconcilePermissions().catch(() => {});
  await reconcileHistoryRepairs().catch(() => {});
  await reconcileOnce(workerId).catch(() => {});
  await cleanupExpiredAuthorizations(workerId).catch(() => {});
  await maintainCrawlerRecords().catch(() => {});
  await pruneTrafficObservations().catch(() => {});
  // Geography updates write to a managed volume on Docker; on Vercel the
  // filesystem is ephemeral, so failures here are expected and non-fatal.
  await maintainGeography().catch(() => {});

  // Keep polling so the registered handlers can drain queued jobs.
  await new Promise(resolve => setTimeout(resolve, budgetMs));
  stopped = true;
  await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
  await prisma.client.$disconnect().catch(() => {});
  return { worker: 'log', budgetMs, stopped };
}
