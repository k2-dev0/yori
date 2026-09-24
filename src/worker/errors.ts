// workerの外部処理・適用で共有するエラー分類。HTTP・DBの境界を越えて扱いを固定する。

// 送信承認が無い/失効した。jobはblocked_policyとして保持する。
export class PolicyBlockedError extends Error {}

// jobのlease所有を失った、または所有を確認できない。公開もjob状態変更もしない。
export class LeaseLostError extends Error {}

// 応答待ちの間に原文revision・desired_revision・世代・入力hashが変化した。
// 公開せず、lease期限後の回収へ委ねる。
export class StaleApplyError extends Error {}

// 既存active generationが現在のprovider specと一致しない。自動切替しない恒久エラー。
export class GenerationMismatchError extends Error {}
