import type { Pool, PoolClient } from 'pg';
import { DEFAULT_JOB_LEASE_MS, JOB_NOTIFY_CHANNEL, claimJobs, recoverDocumentBuilds, recoverExpiredJobs, renewJobLease, type ClaimedJob, type JobKind } from '../jobs/queue.js';
import type { WorkerConfig } from './config.js';
import { processJob } from './process.js';

// 検索laneはroute_search→execute_searchを1並列で扱い、利用者の待つ検索を分類・文書構築の後ろに並べない。
// 外部処理laneはclassify_message・build_documents・judge_continuityを1並列で扱う。各laneの並列数は増やさない。
const EXTERNAL_KINDS: readonly JobKind[] = ['classify_message', 'build_documents', 'judge_continuity'];
const SEARCH_KINDS: readonly JobKind[] = ['route_search', 'execute_search'];
const RECOVER_INTERVAL_MS = 30_000;

export interface RunWorkerOptions {
  pool: Pool;
  config: WorkerConfig;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

// job登録の通知で待機中のlaneを起こす。通知は取りこぼし得るため、poll間隔での再確認は残す。
class JobWaker {
  private readonly waiters = new Set<() => void>();

  wakeAll(): void {
    for (const wake of [...this.waiters]) {
      wake();
    }
  }

  add(wake: () => void): () => void {
    this.waiters.add(wake);
    return () => this.waiters.delete(wake);
  }
}

// 待機の正常満了・abort・job通知のどれでも、timerとlistenerを解放してから解決する。
function sleep(ms: number, signal: AbortSignal, waker?: JobWaker): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let removeWaker: () => void = () => undefined;
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      removeWaker();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (waker !== undefined) {
      removeWaker = waker.add(finish);
    }
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

// 専用接続でLISTENし、通知のたびに全laneを起こす。接続障害時はpoll間隔後に張り直し、abortで解放する。
async function listenForJobs(pool: Pool, signal: AbortSignal, waker: JobWaker, retryMs: number): Promise<void> {
  while (!signal.aborted) {
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      const connected = client;
      let onAbort: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => {
        onAbort = resolve;
        connected.once('error', () => resolve());
        connected.once('end', () => resolve());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      connected.on('notification', (message) => {
        if (message.channel === JOB_NOTIFY_CHANNEL) {
          waker.wakeAll();
        }
      });
      await connected.query(`LISTEN ${JOB_NOTIFY_CHANNEL}`);
      // LISTEN開始前に登録されたjobを取りこぼさないよう、開始時にも一度起こす。
      waker.wakeAll();
      await ended;
      signal.removeEventListener('abort', onAbort);
      await connected.query(`UNLISTEN ${JOB_NOTIFY_CHANNEL}`).catch(() => undefined);
      connected.removeAllListeners('notification');
      connected.release();
      client = undefined;
    } catch (error) {
      console.error(`worker: job通知の待受失敗: ${errorName(error)}`);
      if (client !== undefined) {
        client.removeAllListeners('notification');
        client.release(true);
      }
      await sleep(retryMs, signal);
    }
  }
}

// 検索laneと外部処理laneを各1並列で走らせ、長い処理中はleaseを延長する。
// SIGTERM/SIGINTでは新規claimを止め、処理中jobの完了を待ってから抜ける。
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const leaseMs = options.config.leaseMs ?? DEFAULT_JOB_LEASE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const waker = new JobWaker();

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
        await sleep(pollIntervalMs, signal, waker);
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
        await recoverDocumentBuilds(options.pool);
      } catch (error) {
        console.error(`worker: 期限切れjobの回収失敗: ${errorName(error)}`);
      }
      await sleep(RECOVER_INTERVAL_MS, signal);
    }
  };

  await Promise.all([
    runLane(EXTERNAL_KINDS),
    runLane(SEARCH_KINDS),
    recoverLoop(),
    listenForJobs(options.pool, signal, waker, Math.max(pollIntervalMs, 1_000)),
  ]);
}
