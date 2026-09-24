// record_caseの固定順本文と長さwarning。空の任意項目は出力しない。
export const RECOMMENDED_CASE_REPORT_LENGTH = 600;

export interface CaseReportInput {
  problem: string;
  cause?: string;
  investigation_steps?: string[];
  action: string;
  failed_attempts?: string[];
  confirmation_status: string;
  constraints?: string[];
  related_files_or_prs?: string[];
}

function present(items: readonly string[] | undefined): string[] {
  return (items ?? []).filter((item) => item.length > 0);
}

export function buildCaseReportText(input: CaseReportInput): string {
  const lines = [`問題：${input.problem}`];
  if (input.cause !== undefined && input.cause.length > 0) {
    lines.push(`原因：${input.cause}`);
  }
  const investigation = present(input.investigation_steps);
  if (investigation.length > 0) {
    lines.push(`調査手順：${investigation.join('、')}`);
  }
  lines.push(`対応：${input.action}`);
  const failedAttempts = present(input.failed_attempts);
  if (failedAttempts.length > 0) {
    lines.push(`失敗した試み：${failedAttempts.join('、')}`);
  }
  lines.push(`確認状態：${input.confirmation_status}`);
  const constraints = present(input.constraints);
  if (constraints.length > 0) {
    lines.push(`制約：${constraints.join('、')}`);
  }
  const related = present(input.related_files_or_prs);
  if (related.length > 0) {
    lines.push(`関連ファイル・PR：${related.join('、')}`);
  }
  return lines.join('\n');
}

export function caseReportWarnings(text: string): string[] {
  const length = [...text].length;
  if (length <= RECOMMENDED_CASE_REPORT_LENGTH) {
    return [];
  }
  return [`対応記録が${length}文字です。推奨上限${RECOMMENDED_CASE_REPORT_LENGTH}文字を超えています`];
}
