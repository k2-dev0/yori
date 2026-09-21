import type { EventSource } from '../api/contract.js';
import type { CollectorConfig } from './config.js';

// hook JSONのうち収集に必要なfield。prompt等の本文は使わない。
export interface CollectorHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
}

export interface CollectFromHookInput {
  source: EventSource;
  hook: CollectorHookInput;
  config: CollectorConfig;
  token: string;
}

// hookを契機にtranscriptの差分を読み、SQLiteへ保存して未送信分の送信を試みる。
export async function collectFromHook(_input: CollectFromHookInput): Promise<void> {
  throw new Error('collector collect: 未実装');
}

export interface FlushCollectorInput {
  config: CollectorConfig;
  token: string;
}

// 保留sourceの対応表を再確認して未読分を取り込み、未送信のoutboxを再送する。
export async function flushCollector(_input: FlushCollectorInput): Promise<void> {
  throw new Error('collector collect: 未実装');
}
