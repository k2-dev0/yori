import type { Pool } from 'pg';
import { countIncompleteDocuments } from './reindex.js';

// M8の運用metrics。project scopeの集計だけを返し、message/document本文・credential・検索条件は含めない。

export interface GenerationMetrics {
  generation_id: string;
  dimensions: number;
  documents: number;
  vectors: number;
  estimated_vector_bytes: number;
}

export interface ProjectMetrics {
  project_id: string;
  generations: GenerationMetrics[];
  reindex: { pending_documents: number };
  search_duration_ms: { samples: number; p50: number; p95: number };
  // 直近の完了済み検索のうち、元を辿った候補が代表になった件数と、派生を後ろへ回した件数。
  provenance: { searches: number; origin_adopted: number; derived_demoted: number };
  ann_recommendation: AnnRecommendation;
  jobs: Record<'pending' | 'running' | 'completed' | 'failed' | 'blocked_policy', number>;
}

// 近似索引（HNSW）へ切り替えるべきかの判断材料。判定だけを返し、切替自体は行わない。
export interface AnnRecommendation {
  recommended: boolean;
  reasons: string[];
  thresholds: { min_samples: number; sample_window: number; vector_p95_ms: number; documents: number };
  // vector_p95_msはsampleが1件もないときnull。
  observed: { samples: number; vector_p95_ms: number | null; documents: number };
}

const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'blocked_policy'] as const;

// 切替基準の暫定値。最終調整は実測後に行う。
const ANN_MIN_SAMPLES = 50;
// 「直近」の範囲。active世代でvector経路の時間を記録済みのsampleを新しい順にこの件数まで見る。
const ANN_SAMPLE_WINDOW = 200;
// 元を辿る処理の働きを数える、直近の完了済み検索の件数。
const PROVENANCE_SEARCH_WINDOW = 500;
const ANN_VECTOR_P95_THRESHOLD_MS = 100;
const ANN_DOCUMENT_THRESHOLD = 20_000;

// p95超過と文書数超過は独立した条件で、どちらかを満たせば推奨する。
// sample不足は時間の条件を評価できないことを示すだけで、文書数超過による推奨は打ち消さない。
function buildAnnRecommendation(observed: AnnRecommendation['observed']): AnnRecommendation {
  const reasons: string[] = [];
  const enoughSamples = observed.samples >= ANN_MIN_SAMPLES;
  if (!enoughSamples) {
    reasons.push('insufficient_samples');
  }
  if (enoughSamples && observed.vector_p95_ms !== null && observed.vector_p95_ms > ANN_VECTOR_P95_THRESHOLD_MS) {
    reasons.push('vector_p95_exceeded');
  }
  if (observed.documents > ANN_DOCUMENT_THRESHOLD) {
    reasons.push('document_count_exceeded');
  }
  return {
    recommended: reasons.includes('vector_p95_exceeded') || reasons.includes('document_count_exceeded'),
    reasons,
    thresholds: {
      min_samples: ANN_MIN_SAMPLES,
      sample_window: ANN_SAMPLE_WINDOW,
      vector_p95_ms: ANN_VECTOR_P95_THRESHOLD_MS,
      documents: ANN_DOCUMENT_THRESHOLD,
    },
    observed,
  };
}

export async function loadProjectMetrics(pool: Pool, projectId: string): Promise<ProjectMetrics | null> {
  const project = await pool.query<{ id: string; active_generation_id: string | null }>(
    'SELECT id, active_generation_id FROM projects WHERE id = $1',
    [projectId],
  );
  const projectRow = project.rows[0];
  if (projectRow === undefined) {
    return null;
  }

  // そのprojectのdocumentに実在するembedding/publicationの世代と、active/最新未完了runの世代を集める。
  const vectorRows = await pool.query<{ generation_id: string; vectors: number }>(
    `SELECT e.generation_id, count(*)::int AS vectors
       FROM document_embeddings e
       JOIN search_documents d ON d.id = e.document_id
      WHERE d.project_id = $1
      GROUP BY e.generation_id`,
    [projectId],
  );
  const documentRows = await pool.query<{ generation_id: string; documents: number }>(
    `SELECT p.generation_id, count(DISTINCT p.document_id)::int AS documents
       FROM document_publications p
       JOIN search_documents d ON d.id = p.document_id
      WHERE d.project_id = $1 AND d.is_searchable
      GROUP BY p.generation_id`,
    [projectId],
  );
  const runRows = await pool.query<{ source_generation_id: string | null; target_generation_id: string }>(
    `SELECT source_generation_id, target_generation_id
       FROM reindex_runs
      WHERE project_id = $1 AND status IN ('pending', 'running', 'blocked_policy')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [projectId],
  );
  const run = runRows.rows[0];

  const generationIds = new Set<string>();
  if (projectRow.active_generation_id !== null) {
    generationIds.add(projectRow.active_generation_id);
  }
  for (const row of vectorRows.rows) {
    generationIds.add(row.generation_id);
  }
  for (const row of documentRows.rows) {
    generationIds.add(row.generation_id);
  }
  if (run !== undefined) {
    if (run.source_generation_id !== null) {
      generationIds.add(run.source_generation_id);
    }
    generationIds.add(run.target_generation_id);
  }

  const vectors = new Map(vectorRows.rows.map((row) => [row.generation_id, row.vectors]));
  const documents = new Map(documentRows.rows.map((row) => [row.generation_id, row.documents]));
  const generations: GenerationMetrics[] = [];
  if (generationIds.size > 0) {
    const dimensionRows = await pool.query<{ id: string; dimensions: number }>(
      'SELECT id, dimensions FROM embedding_generations WHERE id = ANY($1::uuid[])',
      [[...generationIds]],
    );
    for (const generation of dimensionRows.rows) {
      const vectorCount = vectors.get(generation.id) ?? 0;
      generations.push({
        generation_id: generation.id,
        dimensions: generation.dimensions,
        documents: documents.get(generation.id) ?? 0,
        vectors: vectorCount,
        estimated_vector_bytes: vectorCount * (4 * generation.dimensions + 8),
      });
    }
  }

  // cutover・no-opと同じcompleteness契約（embedding/publication/hash/stale/source現行性）で残件を数える。
  const pendingDocuments = run === undefined ? 0 : await countIncompleteDocuments(pool, projectId, run.target_generation_id);

  // sample全行をNodeへ読まず、project scopeのcount/p50/p95をSQL集約1行で得る。0件は0。
  const duration = await pool.query<{ samples: number; p50: number; p95: number }>(
    `SELECT count(*)::int AS samples,
            COALESCE(percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p50,
            COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95
       FROM search_duration_samples
      WHERE project_id = $1`,
    [projectId],
  );
  const durationRow = duration.rows[0];

  // active世代の直近sampleだけでvector経路のp95を集約する。列追加前のNULL sampleは数えない。
  const activeGenerationId = projectRow.active_generation_id;
  const vectorDuration = await pool.query<{ samples: number; p95: number | null }>(
    `SELECT count(*)::int AS samples,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY recent.vector_duration_ms)::int AS p95
       FROM (
         SELECT vector_duration_ms
           FROM search_duration_samples
          WHERE project_id = $1 AND generation_id = $2 AND vector_duration_ms IS NOT NULL
          ORDER BY created_at DESC, id DESC
          LIMIT $3
       ) recent`,
    [projectId, activeGenerationId, ANN_SAMPLE_WINDOW],
  );
  const vectorDurationRow = vectorDuration.rows[0];

  // 保存済みの検索結果から数える。代表になった候補の経路と、派生を後ろへ回した警告だけを見て、本文は読まない。
  const provenance = await pool.query<{ searches: number; origin_adopted: number; derived_demoted: number }>(
    `SELECT count(*)::int AS searches,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(recent.result->'candidate_evaluations', '[]'::jsonb)) e
               WHERE e->>'adopted' = 'true' AND e->'retrieval_kinds' ? 'provenance'))::int AS origin_adopted,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(recent.result->'warnings', '[]'::jsonb)) w
               WHERE w->>'code' = 'derived_candidates_demoted'))::int AS derived_demoted
       FROM (
         SELECT result FROM search_requests
          WHERE project_id = $1 AND status = 'completed' AND result IS NOT NULL
          ORDER BY updated_at DESC, id DESC
          LIMIT $2
       ) recent`,
    [projectId, PROVENANCE_SEARCH_WINDOW],
  );

  const jobRows = await pool.query<{ status: string; count: number }>(
    `SELECT j.status, count(*)::int AS count
       FROM jobs j
       JOIN sessions s
         ON s.id = COALESCE(j.session_id, (SELECT m.session_id FROM messages m WHERE m.id = j.message_id))
      WHERE s.project_id = $1
      GROUP BY j.status`,
    [projectId],
  );
  const jobs = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as ProjectMetrics['jobs'];
  for (const row of jobRows.rows) {
    if ((JOB_STATUSES as readonly string[]).includes(row.status)) {
      jobs[row.status as keyof ProjectMetrics['jobs']] = row.count;
    }
  }

  return {
    project_id: projectId,
    generations,
    reindex: { pending_documents: pendingDocuments },
    provenance: provenance.rows[0] ?? { searches: 0, origin_adopted: 0, derived_demoted: 0 },
    search_duration_ms: {
      samples: durationRow?.samples ?? 0,
      p50: durationRow?.p50 ?? 0,
      p95: durationRow?.p95 ?? 0,
    },
    ann_recommendation: buildAnnRecommendation({
      samples: vectorDurationRow?.samples ?? 0,
      vector_p95_ms: vectorDurationRow?.p95 ?? null,
      documents: activeGenerationId === null ? 0 : (documents.get(activeGenerationId) ?? 0),
    }),
    jobs,
  };
}
