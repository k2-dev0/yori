import { zstdDecompressSync } from 'node:zlib';
import type { TranscriptMessageRecord, TranscriptRecord } from '../transcript.js';

// デスクトップ版が書く会話fileの版。発言行の構造は3と4で同じ。
export const SUPPORTED_DEEPSEEK_HARNESS_VERSIONS: readonly number[] = [3, 4];

// 会話fileは追記のたびにzstdのフレームが足される。先頭から順に展開し、壊れたフレームに当たればそこで止める。
// 書込み途中で欠けた末尾のフレームは、Nodeの版によって読まれないか、展開できた分だけ返る。
// どちらでも、改行で終わらない末尾行は行を読む側が未完として扱う。
export function decompressDeepSeekTranscript(compressed: Buffer): Buffer {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < compressed.length) {
    try {
      // info指定の戻り値は型定義にない。engine.bytesWrittenは、このフレームで消費した圧縮側のbytes。
      const frame = zstdDecompressSync(compressed.subarray(offset), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      if (frame.engine.bytesWritten === 0) {
        break;
      }
      frames.push(frame.buffer);
      offset += frame.engine.bytesWritten;
    } catch {
      break;
    }
  }
  return Buffer.concat(frames);
}

interface DeepSeekSessionMetadata {
  sessionId: string;
  cwd: string;
  version: number;
  delegationDepth: number;
  isSeeded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function deepSeekSessionMetadata(line: string): DeepSeekSessionMetadata | null {
  const value = parseJson(line);
  if (
    value === null ||
    value.type !== 'session' ||
    typeof value.id !== 'string' ||
    typeof value.cwd !== 'string' ||
    typeof value.version !== 'number' ||
    typeof value.delegationDepth !== 'number' ||
    typeof value.isSeeded !== 'boolean'
  ) {
    return null;
  }
  return {
    sessionId: value.id,
    cwd: value.cwd,
    version: value.version,
    delegationDepth: value.delegationDepth,
    isSeeded: value.isSeeded,
  };
}

function textOf(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const texts = content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  return texts.length === 0 ? null : texts.join('');
}

function timestampOf(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface DeepSeekTranscriptParser {
  parseLine(line: string): TranscriptRecord[];
}

// DeepSeek Harnessはturn/endで初めてassistant turnの完了が確定するため、parserがturn内の
// 最後のtext-bearing assistant messageだけを一時保持する。reasoning/tool系blockは再帰的に読まない。
export function createDeepSeekTranscriptParser(options: { repository?: string } = {}): DeepSeekTranscriptParser {
  let sessionId: string | null = null;
  let accepted = false;
  let transcriptVersion = '';
  const pendingAssistants = new Map<string, TranscriptMessageRecord>();

  return {
    parseLine(line: string): TranscriptRecord[] {
      const value = parseJson(line);
      if (value === null) {
        return [{ kind: 'invalid' }];
      }
      if (value.type === 'session') {
        const metadata = deepSeekSessionMetadata(line);
        accepted =
          metadata !== null &&
          SUPPORTED_DEEPSEEK_HARNESS_VERSIONS.includes(metadata.version) &&
          metadata.delegationDepth === 0 &&
          metadata.isSeeded === false &&
          (options.repository === undefined || metadata.cwd === options.repository);
        sessionId = accepted && metadata !== null ? metadata.sessionId : null;
        transcriptVersion = metadata === null ? '' : String(metadata.version);
        pendingAssistants.clear();
        return accepted && metadata !== null
          ? [{ kind: 'session', source_session_id: metadata.sessionId, transcript_version: String(metadata.version) }]
          : [{ kind: 'ignored' }];
      }
      if (!accepted || sessionId === null) {
        return [{ kind: 'ignored' }];
      }
      if (value.type === 'user/message') {
        const data = value.data;
        if (!isRecord(data) || data.role !== 'user' || !isRecord(data.source) || data.source.kind !== 'user' || typeof data.id !== 'string') {
          return [{ kind: 'ignored' }];
        }
        const text = textOf(data.content);
        const occurredAt = timestampOf(value.time);
        if (text === null || occurredAt === null) {
          return [{ kind: 'ignored' }];
        }
        return [
          {
            kind: 'message',
            source_session_id: sessionId,
            transcript_version: transcriptVersion,
            source_message_id: data.id,
            occurred_at: occurredAt,
            role: 'user',
            text,
          },
        ];
      }
      if (value.type === 'assistant/message') {
        const data = value.data;
        const message = isRecord(data) && isRecord(data.message) ? data.message : null;
        if (
          !isRecord(data) ||
          message === null ||
          message.role !== 'assistant' ||
          !isRecord(message.source) ||
          message.source.kind !== 'model' ||
          typeof message.id !== 'string' ||
          (typeof data.turn !== 'number' && typeof data.turn !== 'string')
        ) {
          return [{ kind: 'ignored' }];
        }
        const text = textOf(message.content);
        const occurredAt = timestampOf(value.time);
        if (text !== null && occurredAt !== null) {
          pendingAssistants.set(String(data.turn), {
            kind: 'message',
            source_session_id: sessionId,
            transcript_version: transcriptVersion,
            source_message_id: message.id,
            occurred_at: occurredAt,
            role: 'assistant',
            ...(typeof message.source.model === 'string' ? { model_id: message.source.model } : {}),
            text,
          });
        }
        return [{ kind: 'ignored' }];
      }
      if (value.type === 'turn/end') {
        const data = value.data;
        if (!isRecord(data) || (typeof data.turn !== 'number' && typeof data.turn !== 'string')) {
          return [{ kind: 'ignored' }];
        }
        const turn = String(data.turn);
        const assistant = pendingAssistants.get(turn);
        pendingAssistants.delete(turn);
        return isRecord(data.reason) && data.reason.kind === 'completed' && assistant !== undefined
          ? [assistant]
          : [{ kind: 'ignored' }];
      }
      return [{ kind: 'ignored' }];
    },
  };
}
