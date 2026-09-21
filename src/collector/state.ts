// SQLite stateのハンドル。state_dir配下のDBを開いている間だけ保持する。
export interface CollectorState {
  readonly stateDir: string;
}

// 本文を含まない診断レコード。固定codeと参照byte offsetだけを保持する。
export interface CollectorDiagnostic {
  code: string;
  byteOffset: number | null;
}

// state_dirとSQLiteファイルを作成（0700/0600）し、schemaを用意して開く。
export function openCollectorState(_stateDir: string): CollectorState {
  throw new Error('collector state: 未実装');
}

export function closeCollectorState(_state: CollectorState): void {
  throw new Error('collector state: 未実装');
}

export function listCollectorDiagnostics(_state: CollectorState): CollectorDiagnostic[] {
  throw new Error('collector state: 未実装');
}
