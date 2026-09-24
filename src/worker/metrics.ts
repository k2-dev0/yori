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
  jobs: Record<'pending' | 'running' | 'completed' | 'failed' | 'blocked_policy', number>;
}

const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'blocked_policy'] as const;

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
    search_duration_ms: {
      samples: durationRow?.samples ?? 0,
      p50: durationRow?.p50 ?? 0,
      p95: durationRow?.p95 ?? 0,
    },
    jobs,
  };
}
