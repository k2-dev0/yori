// 文書本文と検索質問から、原文に明示された識別子だけを同じ規則で抽出する。
// 推定・補完はせず、文字大小を変えずに完全一致検索できる形で返す。

export interface EntityReference {
  entityType: 'file' | 'function' | 'issue' | 'pull_request';
  entityKey: string;
}

// 拡張子付きのpath/ファイル名。./・../の複数階層・/・hidden directoryの先頭表記を保持し、
// URL内部の部分pathや末尾の句読点をentity_keyへ含めない。先頭を捨てた部分文字列も抽出しない。
const FILE_REFERENCE =
  /(?<![A-Za-z0-9_/.:-])((?:(?:\.\.\/)+|\.\/|\/)?(?:\.[A-Za-z0-9_][A-Za-z0-9_.-]*|[A-Za-z0-9_][A-Za-z0-9_.-]*)(?:\/(?:\.[A-Za-z0-9_][A-Za-z0-9_.-]*|[A-Za-z0-9_][A-Za-z0-9_.-]*))*\.[A-Za-z][A-Za-z0-9]{0,9})(?![A-Za-z0-9_/-])(?!\.[A-Za-z0-9_/-])/g;
// name()形式の関数呼出し。
const FUNCTION_REFERENCE = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\(\)/g;
// Issue #123形式。PRと区別するため接頭語を含めて読む。
const ISSUE_REFERENCE = /\bIssue\s+#(\d+)\b/g;
const PR_REFERENCE = /\bPR\s+#(\d+)\b/g;

function compareReferences(left: EntityReference, right: EntityReference): number {
  if (left.entityType !== right.entityType) {
    return left.entityType < right.entityType ? -1 : 1;
  }
  if (left.entityKey === right.entityKey) {
    return 0;
  }
  return left.entityKey < right.entityKey ? -1 : 1;
}

// 明示された識別子だけを重複なく決定的な順序で返す。Issue/PRは種別ごとの#番号を完全一致keyにする。
export function extractEntityReferences(content: string): EntityReference[] {
  const references: EntityReference[] = [];
  const add = (entityType: EntityReference['entityType'], entityKey: string): void => {
    if (!references.some((reference) => reference.entityType === entityType && reference.entityKey === entityKey)) {
      references.push({ entityType, entityKey });
    }
  };
  for (const match of content.matchAll(FILE_REFERENCE)) {
    add('file', match[1]);
  }
  for (const match of content.matchAll(FUNCTION_REFERENCE)) {
    add('function', `${match[1]}()`);
  }
  for (const match of content.matchAll(ISSUE_REFERENCE)) {
    add('issue', `#${match[1]}`);
  }
  for (const match of content.matchAll(PR_REFERENCE)) {
    add('pull_request', `#${match[1]}`);
  }
  return references.sort(compareReferences);
}
