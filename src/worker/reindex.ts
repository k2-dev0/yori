import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { WorkerConfig } from './config.js';
import { PolicyBlockedError } from './errors.js';
import {
  acquireCompanyGenerationLock,
  createCandidateGeneration,
  generationSpecMatches,
  loadGenerationById,
  VoyageEmbeddingProvider,
  type EmbeddingGeneration,
} from './embedding.js';
import { VoyageCallError } from './voyage.js';

// M8の再索引。current provider specのcandidate generationへ現在searchableなdesired_revisionだけを
// batchで埋め込み、全件のembedding/publication/input_hashが揃った時だけproject pointerを原子的に切り替える。
// 旧activeはcutoverまで変更せず、失敗時はresume可能なrunを残す。

const REINDEX_LOCK_NAMESPACE = 20261001;
const REINDEX_BATCH_SIZE = 64;
const MAX_SCAN_PASSES = 10;
const NO_PROGRESS_LIMIT = 2;

interface ProjectRow {
  id: string;
  company_id: string;
  active_generation_id: string | null;
}

interface RunRow {
  id: string;
  source_generation_id: string | null;
  target_generation_id: string;
}

interface ResumableRun {
  runId: string;
  target: EmbeddingGeneration;
}

// cursorはDBのtimestamptz精度（マイクロ秒）を失わない文字列表現で保持し、そのまま::timestamptzへ戻す。
// node-postgresのJS Dateへ変換すると桁が丸められ、同一timestamptzの末尾行を再取得し続ける。
interface DocumentCursor {
  createdAtText: string;
  id: string;
}

interface DocumentRow {
  id: string;
  desired_revision: number;
  created_at_text: string;
  content: string;
  content_hash: Buffer;
  target_hash: Buffer | null;
  target_revision: number | null;
  target_stale: boolean | null;
}

interface EmbedOutcome {
  kind: 'ok' | 'policy' | 'retryable' | 'permanent';
  code: string;
  embedded: number;
}

export interface ReindexResult {
  ok: boolean;
  code: string;
  runId: string | null;
  targetGenerationId: string | null;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

// 同じprojectの同時reindexを直列化する。取得できない場合は何も変更せず拒否する。
export async function reindexProject(pool: Pool, projectId: string, config: WorkerConfig): Promise<ReindexResult> {
  const lockClient = await pool.connect();
  const lock = await lockClient.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS locked', [
    REINDEX_LOCK_NAMESPACE,
    projectId,
  ]);
  if (lock.rows[0]?.locked !== true) {
    lockClient.release();
    return { ok: false, code: 'reindex_in_progress', runId: null, targetGenerationId: null };
  }
  try {
    return await runProjectReindex(pool, projectId, config);
  } finally {
    await lockClient
      .query('SELECT pg_advisory_unlock($1::int, hashtext($2))', [REINDEX_LOCK_NAMESPACE, projectId])
      .catch(() => undefined);
    lockClient.release();
  }
}

async function runProjectReindex(pool: Pool, projectId: string, config: WorkerConfig): Promise<ReindexResult> {
  const projectResult = await pool.query<ProjectRow>(
    'SELECT id, company_id, active_generation_id FROM projects WHERE id = $1',
    [projectId],
  );
  const project = projectResult.rows[0];
  if (project === undefined) {
    return { ok: false, code: 'project_not_found', runId: null, targetGenerationId: null };
  }

  let run = await findResumableRun(pool, project, config);
  if (run === null) {
    const created = await createRun(pool, project, config);
    run = created ?? (await findResumableRun(pool, project, config));
    if (run === null) {
      return { ok: false, code: 'reindex_conflict', runId: null, targetGenerationId: null };
    }
  }
  const { runId, target } = run;
  await markRunRunning(pool, runId);

  let noProgress = 0;
  for (let pass = 0; pass < MAX_SCAN_PASSES; pass += 1) {
    let outcome: EmbedOutcome;
    try {
      outcome = await embedMissing(pool, { project, target, config });
    } catch (error) {
      // 想定外の失敗でもrunをpendingへ戻し、次回のreindexで安全にresumeできるようにする。
      await markRunPending(pool, runId, 'reindex_failed');
      throw error;
    }
    if (outcome.kind === 'policy') {
      await markRunBlocked(pool, runId, outcome.code);
      return { ok: false, code: outcome.code, runId, targetGenerationId: target.id };
    }
    if (outcome.kind === 'retryable') {
      await markRunPending(pool, runId, outcome.code);
      return { ok: false, code: outcome.code, runId, targetGenerationId: target.id };
    }
    if (outcome.kind === 'permanent') {
      await markRunPermanentlyFailed(pool, runId, target.id, outcome.code);
      return { ok: false, code: outcome.code, runId, targetGenerationId: target.id };
    }
    const cutover = await tryCutover(pool, {
      project,
      runId,
      targetGenerationId: target.id,
      sourceGenerationId: project.active_generation_id,
    });
    if (cutover === 'switched') {
      return { ok: true, code: 'completed', runId, targetGenerationId: target.id };
    }
    if (cutover === 'source_changed') {
      // project pointerがrun開始時のsourceと変わっている。上書きせずresume可能なまま終了する。
      await markRunPending(pool, runId, 'source_changed');
      return { ok: false, code: 'source_changed', runId, targetGenerationId: target.id };
    }
    if (outcome.embedded === 0) {
      noProgress += 1;
      if (noProgress >= NO_PROGRESS_LIMIT) {
        break;
      }
    } else {
      noProgress = 0;
    }
  }
  await markRunPending(pool, runId, 'reindex_incomplete');
  return { ok: false, code: 'reindex_incomplete', runId, targetGenerationId: target.id };
}

// 同project・同source・current specの未完了runだけをresumeする。それ以外の未完了runは
// targetともどもfailedにし、新しいcandidateを作れるようにする。
async function findResumableRun(pool: Pool, project: ProjectRow, config: WorkerConfig): Promise<ResumableRun | null> {
  const result = await pool.query<RunRow>(
    `SELECT id, source_generation_id, target_generation_id
       FROM reindex_runs
      WHERE project_id = $1 AND status IN ('pending', 'running', 'blocked_policy')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [project.id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  const target = await loadGenerationById(pool, { companyId: project.company_id, generationId: row.target_generation_id });
  if (
    target !== null &&
    target.status !== 'failed' &&
    generationSpecMatches(target, config) &&
    row.source_generation_id === project.active_generation_id
  ) {
    return { runId: row.id, target };
  }
  await markRunPermanentlyFailed(pool, row.id, row.target_generation_id, 'spec_changed');
  return null;
}

async function createRun(pool: Pool, project: ProjectRow, config: WorkerConfig): Promise<ResumableRun | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await createCandidateGeneration(client, project.company_id, config);
    const runId = uuidv7();
    await client.query(
      `INSERT INTO reindex_runs (id, company_id, project_id, source_generation_id, target_generation_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [runId, project.company_id, project.id, project.active_generation_id, target.id],
    );
    await client.query('COMMIT');
    return { runId, target };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // 同時作成は未完了runのUNIQUE制約で検出し、呼出元が既存runの再読込へ回る。
    if ((error as { code?: string }).code === '23505') {
      return null;
    }
    throw error;
  } finally {
    client.release();
  }
}

async function markRunRunning(pool: Pool, runId: string): Promise<void> {
  await pool.query(
    `UPDATE reindex_runs SET status = 'running', error_code = NULL, updated_at = now()
      WHERE id = $1 AND status <> 'completed'`,
    [runId],
  );
}

async function markRunBlocked(pool: Pool, runId: string, errorCode: string): Promise<void> {
  await pool.query(
    `UPDATE reindex_runs SET status = 'blocked_policy', error_code = $2, updated_at = now()
      WHERE id = $1 AND status <> 'completed'`,
    [runId, errorCode],
  );
}

async function markRunPending(pool: Pool, runId: string, errorCode: string): Promise<void> {
  await pool.query(
    `UPDATE reindex_runs SET status = 'pending', error_code = $2, updated_at = now()
      WHERE id = $1 AND status <> 'completed'`,
    [runId, errorCode],
  );
}

async function markRunPermanentlyFailed(pool: Pool, runId: string, targetGenerationId: string, errorCode: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE reindex_runs SET status = 'failed', error_code = $2, completed_at = now(), updated_at = now() WHERE id = $1`,
      [runId, errorCode],
    );
    await client.query(`UPDATE embedding_generations SET status = 'failed', updated_at = now() WHERE id = $1 AND status <> 'failed'`, [
      targetGenerationId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// 現在searchableなdesired_revisionをkeysetでpage走査し、targetで未完了の行だけをbatch埋め込みする。
async function embedMissing(
  pool: Pool,
  input: { project: ProjectRow; target: EmbeddingGeneration; config: WorkerConfig },
): Promise<EmbedOutcome> {
  const provider = new VoyageEmbeddingProvider(pool, input.config);
  let embedded = 0;
  let cursor: DocumentCursor | null = null;
  for (;;) {
    const page = await loadDocumentPage(pool, {
      companyId: input.project.company_id,
      projectId: input.project.id,
      targetGenerationId: input.target.id,
      cursor,
    });
    if (page.length === 0) {
      break;
    }
    const last = page[page.length - 1];
    const nextCursor: DocumentCursor = { createdAtText: last.created_at_text, id: last.id };
    if (
      cursor !== null &&
      cursor.createdAtText === nextCursor.createdAtText &&
      cursor.id === nextCursor.id
    ) {
      // 通常経路ではcursorはpage末尾より必ず進む。進まない異常時だけ無限取得を避けて打ち切る。
      break;
    }
    cursor = nextCursor;
    const missing = page.filter((row) => !hasCompleteTarget(row));
    for (let offset = 0; offset < missing.length; offset += REINDEX_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + REINDEX_BATCH_SIZE);
      let vectors: number[][];
      try {
        vectors = await provider.embedDocuments(batch.map((row) => row.content), input.target);
      } catch (error) {
        if (error instanceof PolicyBlockedError) {
          return { kind: 'policy', code: 'policy_blocked', embedded };
        }
        if (error instanceof VoyageCallError) {
          return { kind: error.retryable ? 'retryable' : 'permanent', code: error.code, embedded };
        }
        throw error;
      }
      embedded += await applyEmbeddings(pool, { project: input.project, target: input.target, items: batch, vectors });
    }
  }
  return { kind: 'ok', code: 'completed', embedded };
}

async function loadDocumentPage(
  pool: Pool,
  input: { companyId: string; projectId: string; targetGenerationId: string; cursor: DocumentCursor | null },
): Promise<DocumentRow[]> {
  const result = await pool.query<DocumentRow>(
    `SELECT d.id, d.desired_revision, d.created_at::text AS created_at_text, r.content, r.content_hash,
            e.input_hash AS target_hash, p.revision AS target_revision, p.stale AS target_stale
       FROM search_documents d
       JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
       LEFT JOIN document_embeddings e
         ON e.document_id = d.id AND e.revision = d.desired_revision AND e.generation_id = $3
       LEFT JOIN document_publications p
         ON p.document_id = d.id AND p.generation_id = $3 AND p.revision = d.desired_revision
      WHERE d.company_id = $1 AND d.project_id = $2 AND d.is_searchable AND r.status <> 'excluded'
        AND ($4::timestamptz IS NULL OR (d.created_at, d.id) > ($4::timestamptz, $5::uuid))
      ORDER BY d.created_at, d.id
      LIMIT $6`,
    [
      input.companyId,
      input.projectId,
      input.targetGenerationId,
      input.cursor?.createdAtText ?? null,
      input.cursor?.id ?? null,
      REINDEX_BATCH_SIZE,
    ],
  );
  return result.rows;
}

function hasCompleteTarget(row: DocumentRow): boolean {
  return (
    row.target_revision === row.desired_revision &&
    row.target_stale === false &&
    row.target_hash !== null &&
    row.target_hash.equals(row.content_hash)
  );
}

// batch適用TX。projectをFOR SHAREし、document/company/project/is_searchable/desired_revision/content_hashを
// 再検証してからembeddingとpublicationを同一TXで公開する。ずれた行は公開せず再走査へ回す。
async function applyEmbeddings(
  pool: Pool,
  input: { project: ProjectRow; target: EmbeddingGeneration; items: readonly DocumentRow[]; vectors: readonly number[][] },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await client.query('SELECT 1 FROM projects WHERE id = $1 AND company_id = $2 FOR SHARE', [
      input.project.id,
      input.project.company_id,
    ]);
    if (project.rows.length === 0) {
      await client.query('ROLLBACK');
      return 0;
    }
    let applied = 0;
    for (let index = 0; index < input.items.length; index += 1) {
      const item = input.items[index];
      const vector = input.vectors[index];
      const current = await client.query<{
        desired_revision: number;
        is_searchable: boolean;
        company_id: string;
        project_id: string;
        content_hash: Buffer;
        status: string;
      }>(
        `SELECT d.desired_revision, d.is_searchable, d.company_id, d.project_id, r.content_hash, r.status
           FROM search_documents d
           JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
          WHERE d.id = $1
          FOR UPDATE OF d`,
        [item.id],
      );
      const row = current.rows[0];
      if (
        row === undefined ||
        row.desired_revision !== item.desired_revision ||
        !row.is_searchable ||
        row.company_id !== input.project.company_id ||
        row.project_id !== input.project.id ||
        row.status === 'excluded' ||
        !row.content_hash.equals(item.content_hash)
      ) {
        continue;
      }
      // 出典の現行性をM4 applyと同じFOR SHAREで再検証する。source消失・改訂済みmessageは公開しない。
      const sources = await client.query<{ message_id: string; message_revision: number; current_revision: number }>(
        `SELECT s.message_id, s.message_revision, m.current_revision
           FROM search_document_sources s
           JOIN messages m ON m.id = s.message_id
          WHERE s.document_id = $1 AND s.revision = $2
          ORDER BY s.display_order
          FOR SHARE OF m`,
        [item.id, item.desired_revision],
      );
      if (
        sources.rows.length === 0 ||
        sources.rows.some((source) => source.current_revision !== source.message_revision)
      ) {
        continue;
      }
      await client.query(
        `INSERT INTO document_embeddings (document_id, revision, generation_id, embedding, input_hash)
         VALUES ($1, $2, $3, $4::vector, $5)
         ON CONFLICT (document_id, revision, generation_id)
         DO UPDATE SET embedding = EXCLUDED.embedding, input_hash = EXCLUDED.input_hash`,
        [item.id, item.desired_revision, input.target.id, vectorLiteral(vector), item.content_hash],
      );
      await client.query(
        `INSERT INTO document_publications (document_id, generation_id, revision, stale)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (document_id, generation_id)
         DO UPDATE SET revision = EXCLUDED.revision, stale = false, updated_at = now()`,
        [item.id, input.target.id, item.desired_revision],
      );
      await client.query(
        `UPDATE search_document_revisions SET status = 'ready', updated_at = now()
          WHERE document_id = $1 AND revision = $2 AND content_hash = $3 AND status <> 'excluded'`,
        [item.id, item.desired_revision, item.content_hash],
      );
      // 旧世代はcutoverまでold publicationを使い続けるため、targetへの公開では
      // 他revisionのready状態をsupersededへ変えない（8.3の「切替まで旧ready版を使える」）。
      applied += 1;
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// cutover TX。company generation lock → project FOR UPDATEの順に取得し、current searchable desired revisionの
// target embedding/publication/stale/input_hash一致を再確認する。不足なら未公開分を掃除してincompleteを返し、
// 再走査または次回resumeへ回す。project pointerがrun開始時のsourceと変わっていれば上書きしない。
async function tryCutover(
  pool: Pool,
  input: { project: ProjectRow; runId: string; targetGenerationId: string; sourceGenerationId: string | null },
): Promise<'switched' | 'incomplete' | 'source_changed'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ensureActiveGenerationの初回generation設定と同じcompany単位lockを先に取り、retire判定とのraceを閉じる。
    await acquireCompanyGenerationLock(client, input.project.company_id);
    const project = await client.query<{ active_generation_id: string | null }>(
      'SELECT active_generation_id FROM projects WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [input.project.id, input.project.company_id],
    );
    if (project.rows.length === 0) {
      await client.query('ROLLBACK');
      return 'incomplete';
    }
    if (project.rows[0].active_generation_id !== input.sourceGenerationId) {
      await client.query('ROLLBACK');
      return 'source_changed';
    }
    // 完全性確認の直前に、対象projectの現在searchableなdesired_revisionが参照するsource messageを
    // 決定的順序でFOR SHAREし、commitまで原文revision更新を待たせる。このsnapshotでsourceの
    // 存在と現行revision一致まで確認する。外部処理はこのTX内で行わない。
    await client.query(
      `SELECT s.message_id, s.message_revision, m.current_revision
         FROM search_documents d
         JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
         JOIN search_document_sources s ON s.document_id = d.id AND s.revision = d.desired_revision
         JOIN messages m ON m.id = s.message_id
        WHERE d.project_id = $1 AND d.is_searchable AND r.status <> 'excluded'
        ORDER BY s.message_id, s.message_revision, s.display_order
        FOR SHARE OF m`,
      [input.project.id],
    );
    // 除外・改訂・staleで現在の検索対象から外れたtarget publicationはcutover前に非公開化する。
    await client.query(
      `DELETE FROM document_publications p
        USING search_documents d
        LEFT JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
       WHERE p.document_id = d.id AND p.generation_id = $2 AND d.project_id = $1
         AND (d.is_searchable = false OR p.stale = true OR p.revision <> d.desired_revision
              OR r.document_id IS NULL OR r.status = 'excluded')`,
      [input.project.id, input.targetGenerationId],
    );
    const missing = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM search_documents d
         JOIN search_document_revisions r ON r.document_id = d.id AND r.revision = d.desired_revision
         LEFT JOIN document_embeddings e
           ON e.document_id = d.id AND e.revision = d.desired_revision AND e.generation_id = $2
         LEFT JOIN document_publications p
           ON p.document_id = d.id AND p.generation_id = $2 AND p.revision = d.desired_revision
        WHERE d.project_id = $1 AND d.is_searchable AND r.status <> 'excluded'
          AND (e.input_hash IS NULL OR e.input_hash <> r.content_hash OR p.document_id IS NULL OR p.stale
               OR NOT EXISTS (
                 SELECT 1 FROM search_document_sources s
                  WHERE s.document_id = d.id AND s.revision = d.desired_revision
               )
               OR EXISTS (
                 SELECT 1 FROM search_document_sources s
                  JOIN messages m ON m.id = s.message_id
                  WHERE s.document_id = d.id AND s.revision = d.desired_revision
                    AND m.current_revision <> s.message_revision
               ))`,
      [input.project.id, input.targetGenerationId],
    );
    if (Number(missing.rows[0]?.count ?? '0') > 0) {
      await client.query('COMMIT');
      return 'incomplete';
    }
    await client.query(`UPDATE embedding_generations SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'candidate'`, [
      input.targetGenerationId,
    ]);
    await client.query('UPDATE projects SET active_generation_id = $2, updated_at = now() WHERE id = $1', [
      input.project.id,
      input.targetGenerationId,
    ]);
    if (input.sourceGenerationId !== null && input.sourceGenerationId !== input.targetGenerationId) {
      await client.query(
        `UPDATE embedding_generations SET status = 'retired', updated_at = now()
          WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM projects WHERE active_generation_id = $1)`,
        [input.sourceGenerationId],
      );
    }
    await client.query(
      `UPDATE reindex_runs SET status = 'completed', error_code = NULL, completed_at = now(), updated_at = now()
        WHERE id = $1 AND status <> 'failed'`,
      [input.runId],
    );
    await client.query('COMMIT');
    return 'switched';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type GenerationDeleteResult = 'deleted' | 'not_found' | 'generation_referenced';

// 参照がない世代だけを削除する。active project・未完了reindex run・実行中search requestが
// 参照する世代は削除しない。参照の判定とDELETEを同一TXで行う。
export async function deleteGeneration(pool: Pool, generationId: string): Promise<GenerationDeleteResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const generation = await client.query('SELECT 1 FROM embedding_generations WHERE id = $1 FOR UPDATE', [generationId]);
    if (generation.rows.length === 0) {
      await client.query('ROLLBACK');
      return 'not_found';
    }
    const active = await client.query('SELECT 1 FROM projects WHERE active_generation_id = $1 LIMIT 1', [generationId]);
    const runs = await client.query(
      `SELECT 1 FROM reindex_runs
        WHERE (source_generation_id = $1 OR target_generation_id = $1)
          AND status IN ('pending', 'running', 'blocked_policy')
        LIMIT 1`,
      [generationId],
    );
    const requests = await client.query(
      `SELECT 1 FROM search_requests
        WHERE embedding_generation_id = $1 AND status IN ('pending', 'running')
        LIMIT 1`,
      [generationId],
    );
    if (active.rows.length > 0 || runs.rows.length > 0 || requests.rows.length > 0) {
      await client.query('ROLLBACK');
      return 'generation_referenced';
    }
    await client.query('DELETE FROM embedding_generations WHERE id = $1', [generationId]);
    await client.query('COMMIT');
    return 'deleted';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
