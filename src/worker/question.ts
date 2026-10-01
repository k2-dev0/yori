import { CHUNK_MAX_TOKENS, CHUNK_TARGET_TOKENS, SEARCH_QUESTION_CHUNK_LIMIT } from './contract.js';

export interface QuestionChunks {
  chunks: string[];
  // 上限件数より後ろに、検索へ使わなかった入力が残っている。
  truncated: boolean;
}

// 長い検索質問を、保存側の文書と同じ大きさの連続した区切りへ分ける。区切る長さ以下は原文1件のまま返す。
export function splitQuestionIntoChunks(tokenizer: { encode: (text: string) => { ids: number[] } }, question: string): QuestionChunks {
  const tokenCount = (text: string): number => tokenizer.encode(text).ids.length;
  if (tokenCount(question) <= CHUNK_MAX_TOKENS) {
    return { chunks: [question], truncated: false };
  }
  const chunks: string[] = [];
  let offset = 0;
  while (offset < question.length && chunks.length < SEARCH_QUESTION_CHUNK_LIMIT) {
    let low = offset + 1;
    let high = question.length;
    let end = low;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const fits = tokenCount(question.slice(offset, middle)) <= CHUNK_TARGET_TOKENS;
      end = fits ? middle : end;
      [low, high] = fits ? [middle + 1, high] : [low, middle - 1];
    }
    // サロゲートペアの途中では切らない。
    const splitsPair = end < question.length && /[\uD800-\uDBFF]/.test(question[end - 1] ?? '') && end - 1 > offset;
    end = splitsPair ? end - 1 : end;
    chunks.push(question.slice(offset, end));
    offset = end;
  }
  return { chunks, truncated: offset < question.length };
}
