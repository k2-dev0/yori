import type { Pool } from 'pg';
import { DEFAULT_JOB_LEASE_MS, claimJobs, recoverExpiredJobs, renewJobLease, type ClaimedJob, type JobKind } from '../jobs/queue.js';
import type { WorkerConfig } from './config.js';
import { processJob } from './process.js';

// route/search laneはroute_searchだけ、外部処理laneはclassify_message・build_documents・execute_searchを
// 1並列で扱う。検索はbuildより優先度が高いが、同じ外部処理laneで順に処理し並列数を増やさない。
const EXTERNAL_KINDS: readonly JobKind[] = ['classify_message', 'build_documents', 'execute_search'];
const ROUTE_KINDS: readonly JobKind[] = ['route_search'];
const RECOVER_INTERVAL_MS = 30_000;

export interface RunWorkerOptions {
  pool: Pool;
  config: WorkerConfig;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

// 待機の正常満了・abortのどちらでも、timerとabort listenerを解放してから解決する。
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

// route laneとclassify laneを各1並列で走らせ、長い処理中はleaseを延長する。
// SIGTERM/SIGINTでは新規claimを止め、処理中jobの完了を待ってから抜ける。
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const leaseMs = options.config.leaseMs ?? DEFAULT_JOB_LEASE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  const runLane = async (kinds: readonly JobKind[]): Promise<void> => {
    while (!signal.aborted) {
      let job: ClaimedJob | undefined;
      try {
        [job] = await claimJobs(options.pool, { kinds, limit: 1, leaseMs });
      } catch (error) {
        console.error(`worker: claim失敗: ${errorName(error)}`);
        await sleep(pollIntervalMs, signal);
        continue;
      }
      if (job === undefined) {
        await sleep(pollIntervalMs, signal);
        continue;
      }
      const renewal = setInterval(() => {
        void renewJobLease(options.pool, { jobId: job!.id, leaseToken: job!.leaseToken, leaseMs }).catch(() => undefined);
      }, Math.max(1_000, Math.floor(leaseMs / 2)));
      try {
        await processJob(options.pool, job, options.config);
      } catch (error) {
        console.error(`worker: ${job.kind} ${job.id}: ${errorName(error)}`);
      } finally {
        clearInterval(renewal);
      }
    }
  };

  const recoverLoop = async (): Promise<void> => {
    while (!signal.aborted) {
      try {
        await recoverExpiredJobs(options.pool);
      } catch (error) {
        console.error(`worker: 期限切れjobの回収失敗: ${errorName(error)}`);
      }
      await sleep(RECOVER_INTERVAL_MS, signal);
    }
  };

  await Promise.all([runLane(EXTERNAL_KINDS), runLane(ROUTE_KINDS), recoverLoop()]);
}
