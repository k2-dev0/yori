// 設定JSONと収集pipelineが共有する公開型。
export interface CollectorProject {
  repository: string;
  project_id: string;
}

export interface CollectorConfig {
  api_url: string;
  token_env: string;
  state_dir: string;
  projects: CollectorProject[];
}

// 設定ファイルのJSONを検証し、repositoryをcanonical形式へ揃えた設定を返す。
export function parseCollectorConfig(_input: unknown): CollectorConfig {
  throw new Error('collector config: 未実装');
}

// 設定ファイルを読み、JSONとして検証する。tokenは環境変数から取得するため保存しない。
export function loadCollectorConfig(_configPath: string): CollectorConfig {
  throw new Error('collector config: 未実装');
}
