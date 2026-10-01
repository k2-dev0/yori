import { resolveRepositoryFromCwd } from '../collector/remote.js';
import { fetchCollectorSetup } from '../collector/setup.js';
import { CentralApiError } from './central.js';
import type { McpConfig } from './config.js';

const UNRESOLVED_MESSAGE = 'project_idを省略しましたが、作業ディレクトリのrepositoryから案件を解決できません';

// tool入力でproject_idが省略された時だけ使う。collectorと同じくgit remoteのcanonical repositoryをsetup APIへ問い合わせる。
export async function resolveProjectIdFromCwd(config: McpConfig, cwd: string): Promise<string> {
  const repository = resolveRepositoryFromCwd(cwd);
  const setup = repository === null ? null : await fetchCollectorSetup({ api_url: config.apiUrl, token: config.token, repository });
  if (setup === null) {
    throw new CentralApiError(UNRESOLVED_MESSAGE);
  }
  return setup.projectId;
}
