// Conventional Commits 1.0.0 제목 규칙(docs/devops.md §2.2.5·§2.2.6, 시험 D-T41).
// PR 제목 검사(branch-policy.mjs)와 버전 계산(release-plan.mjs)이 함께 쓴다. 검사가 통과시킨 제목을
// 버전 계산이 다르게 읽지 않게 하려고 한 곳에 둔다(openspec 변경 add-release-workflows).
export const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style', 'revert'];
// <종류>[(범위)][!]: <설명>
const TITLE = /^([a-z]+)(?:\(([^()\s][^()]*)\))?(!)?: (\S.*)/;
// 꼬리말은 줄머리에서 시작한다. 명세는 BREAKING-CHANGE도 같은 뜻으로 받는다
const BREAKING = /^BREAKING[ -]CHANGE: /m;

// 형식에 맞으면 { type, scope, bang, breaking, description }, 아니면 null
export function parseTitle(title, body = '') {
  const m = TITLE.exec(title);
  if (!m) return null;
  return { type: m[1], scope: m[2] ?? null, bang: Boolean(m[3]), breaking: Boolean(m[3]) || BREAKING.test(body ?? ''), description: m[4] };
}

// PR 제목 검사의 오류 목록(빈 목록이면 통과)
export function titleErrors(title, body) {
  const c = parseTitle(title, body);
  if (!c) return [`PR 제목 '${title}'이 '<종류>[(범위)][!]: <설명>' 형식이 아니다`];
  if (!TYPES.includes(c.type)) return [`PR 제목의 종류 '${c.type}'는 허용 목록(${TYPES.join(', ')})에 없다`];
  if (c.breaking && !c.bang) return ['본문에 BREAKING CHANGE 꼬리말이 있으면 제목에도 !를 붙인다(예: feat(queue)!: …)'];
  return [];
}
