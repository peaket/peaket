// branch-watch.mjs(작업 가지 수 경고와 develop 병합 방식 주간 점검)의 공개 함수를 가짜 GitHub API로 돌려 보는 시험(D-T49, FND-160). 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_WORK_BRANCHES_PER_TEAM,
  WEEKLY_WINDOW_DAYS,
  parseCodeowners,
  ownersOf,
  unsupportedPatterns,
  workBranchesByTeam,
  countWarnings,
  headFromMergeSubject,
  mergeWarnings,
  runCount,
  runWeekly,
} from './branch-watch.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'peaket/peaket';

// 팀 이름
const ARCH = '@peaket/architecture';
const FE = '@peaket/frontend-platform';
const PLAT = '@peaket/platform';
const QUEUE = '@peaket/queue';
const PURCHASE = '@peaket/purchase';

// 규칙 목록을 깊게 굳힌다(시험끼리 함께 쓰므로 구현이 고치면 드러나게)
const freezeRules = (rules) => Object.freeze(rules.map((r) => Object.freeze({ pattern: r.pattern, owners: Object.freeze([...r.owners]) })));
// 저장소 CODEOWNERS의 줄 몇 개를 본뜬 규칙(넓은 줄에서 좁은 줄 차례)
const RULES = freezeRules([
  { pattern: '*', owners: [ARCH] },
  { pattern: '/apps/', owners: [FE] },
  { pattern: '/apps/widgets/queue/', owners: [QUEUE] },
  { pattern: '/services/', owners: [PLAT] },
  { pattern: '/services/queue-svc/', owners: [QUEUE] },
  { pattern: '/services/purchase-svc/', owners: [PURCHASE] },
  { pattern: '/services/v0-monolith/', owners: [QUEUE, PURCHASE] },
]);
// 같은 규칙을 CODEOWNERS 글로(runCount용)
const CODEOWNERS = `# 시험용 CODEOWNERS
*                          ${ARCH}

/apps/                     ${FE}
/apps/widgets/queue/       ${QUEUE}
/services/                 ${PLAT}
/services/queue-svc/       ${QUEUE}
/services/purchase-svc/    ${PURCHASE}
/services/v0-monolith/     ${QUEUE} ${PURCHASE}
`;

// 팀마다 파일 하나씩
const Q1 = 'services/queue-svc/src/main.ts'; // 대기열
const Q2 = 'apps/widgets/queue/src/index.ts'; // 대기열(좁은 줄)
const P1 = 'services/purchase-svc/src/main.ts'; // 구매
const V0 = 'services/v0-monolith/src/main.ts'; // 대기열과 구매 둘
const DOC = 'docs/devops.md'; // 기본값 '*'

// 순수 함수용 PR
const pr = (number, head, files, fork = false) => ({ number, head, fork, files });
// GitHub API·사건 파일 꼴의 PR(owner가 null이면 head.repo가 null)
const ghPr = (number, ref, owner = REPO) => ({ number, head: { ref, repo: owner === null ? null : { full_name: owner } } });
const event = (number, ref, owner = REPO) => ({ action: 'opened', pull_request: ghPr(number, ref, owner) });
const openPath = (page) => `/repos/${REPO}/pulls?state=open&per_page=100&page=${page}`;
const filesPath = (number, page) => `/repos/${REPO}/pulls/${number}/files?per_page=100&page=${page}`;
const commitPullsPath = (sha) => `/repos/${REPO}/commits/${sha}/pulls`;
const fileItems = (...names) => names.map((filename) => ({ filename, status: 'modified' }));

// 경고 글(명세에 글자 그대로 적힌 꼴)
const teamWarn = (team, numbers, max = 3) =>
  `팀 ${team}의 열린 작업 가지가 ${numbers.length}개다(${max}개 이하, docs/devops.md §2.2.1): ${numbers.map((n) => `#${n}`).join(', ')}`;
const squashWarn = (sha, head) => `${sha.slice(0, 7)} ${head}: develop에 병합 커밋으로 들어왔다(작업 가지는 스쿼시, §2.2.6)`;
const unknownWarn = (sha) => `${sha.slice(0, 7)}: 들어온 가지를 알 수 없는 병합 커밋이다(§2.2.6)`;

// 40자리 가짜 커밋 해시. 앞 7자리를 쉽게 알아보게 head 뒤를 'e'로 채운다
const fakeSha = (head) => (head + 'e'.repeat(40)).slice(0, 40);

// 가짜 GitHub API: 부른 경로를 calls에 남기고 respond(path)의 값을 돌려준다(respond가 던지면 그대로 던진다)
function fakeApi(respond) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    return respond(path);
  };
  return { api, calls };
}
// 경로 → 응답 표. 값이 Error면 던지고, 표에 없는 경로도 던진다(명세 밖 경로를 부르면 드러나게)
const table = (routes) => (path) => {
  if (!Object.hasOwn(routes, path)) throw new Error(`가짜 API에 없는 경로: ${path}`);
  const v = routes[path];
  if (v instanceof Error) throw v;
  return structuredClone(v);
};
const uniqSorted = (xs) => [...new Set(xs)].sort();
// 글 안에 수 n이 앞뒤가 숫자가 아닌 자리에 있는가(다른 수의 일부로 맞지 않게)
const hasNumber = (text, n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(text);
// Map → 객체. 센 PR이 없는 팀은 Map에 넣지 않으므로(명세) 빈 배열 항목이 없는지도 본다
function plain(map) {
  assert.ok(map instanceof Map, 'Map을 돌려줘야 한다');
  for (const [team, numbers] of map) assert.ok(numbers.length > 0, `센 PR이 없는 팀이 Map에 들어 있다: ${team}`);
  return Object.fromEntries(map);
}

// ── parseCodeowners ──

test('FND160_DT49_CODEOWNERS 읽기는 빈 줄과 주석 줄을 건너뛰고 줄 차례대로 패턴과 주인을 낸다', () => {
  const text = `# 머리 주석
# 둘째 주석

*                    ${ARCH}

# 화면
/apps/               ${FE}
/services/v0-monolith/   ${QUEUE} ${PURCHASE}
`;
  assert.deepEqual(parseCodeowners(text), [
    { pattern: '*', owners: [ARCH] },
    { pattern: '/apps/', owners: [FE] },
    { pattern: '/services/v0-monolith/', owners: [QUEUE, PURCHASE] },
  ]);
});

test('FND160_DT49_CODEOWNERS 읽기는 줄 끝 주석을 버리고 주인 없는 줄을 건너뛴다', () => {
  const text = `/infra/      ${PLAT}   # 인프라는 플랫폼 팀
/orphan/
/only-comment/   # 주인이 없다
/data/ @peaket/data
`;
  assert.deepEqual(parseCodeowners(text), [
    { pattern: '/infra/', owners: [PLAT] },
    { pattern: '/data/', owners: ['@peaket/data'] },
  ]);
});

test('FND160_DT49_CODEOWNERS 읽기는 CRLF·들여 쓴 주석·공백만 있는 줄·탭 칸·들여 쓴 규칙·탭 뒤 줄 끝 주석을 받는다', () => {
  const text = [
    '  # 들여 쓴 주석',
    '\t# 탭으로 들여 쓴 주석 @peaket/x',
    ' \t ',
    `/apps/\t${FE}`,
    `/services/v0-monolith/\t \t${QUEUE}\t${PURCHASE}`,
    '   /data/ @peaket/data',
    `/infra/ ${PLAT} # 설명`,
    '/x/\t@peaket/x\t# 탭 뒤 설명',
    '',
  ].join('\r\n');
  assert.deepEqual(parseCodeowners(text), [
    { pattern: '/apps/', owners: [FE] },
    { pattern: '/services/v0-monolith/', owners: [QUEUE, PURCHASE] },
    { pattern: '/data/', owners: ['@peaket/data'] },
    { pattern: '/infra/', owners: [PLAT] },
    { pattern: '/x/', owners: ['@peaket/x'] },
  ]);
});

// ── ownersOf ──

test('FND160_DT49_주인 찾기는 맞는 규칙 가운데 마지막 것을 쓴다', () => {
  assert.deepEqual(ownersOf(Q2, RULES), [QUEUE]);
  assert.deepEqual(ownersOf('apps/web/src/page.tsx', RULES), [FE]);
  assert.deepEqual(ownersOf(V0, RULES), [QUEUE, PURCHASE]);
  assert.deepEqual(ownersOf('services/new-svc/src/main.ts', RULES), [PLAT]);
  assert.deepEqual(ownersOf(DOC, RULES), [ARCH]);
  // 좁은 줄이 먼저 있으면 뒤의 넓은 줄이 이긴다(가장 좁은 줄이 아니라 마지막 줄)
  const reversed = [
    { pattern: '/apps/widgets/queue/', owners: [QUEUE] },
    { pattern: '/apps/', owners: [FE] },
  ];
  assert.deepEqual(ownersOf(Q2, reversed), [FE]);
});

test("FND160_DT49_주인 찾기에서 '/d/'는 그 폴더 아래 모든 파일에만 맞는다", () => {
  const rules = [{ pattern: '/apps/', owners: [FE] }];
  assert.deepEqual(ownersOf('apps/a.ts', rules), [FE]);
  assert.deepEqual(ownersOf('apps/x/y/z.ts', rules), [FE]);
  assert.deepEqual(ownersOf('apps-old/a.ts', rules), []);
  assert.deepEqual(ownersOf('web/apps/a.ts', rules), []);
});

test("FND160_DT49_주인 찾기에서 '/f'는 그 파일 하나 또는 'f/' 아래 파일에 맞는다", () => {
  const rules = [
    { pattern: '/package.json', owners: [PLAT] },
    { pattern: '/tools', owners: ['@peaket/tools'] },
  ];
  assert.deepEqual(ownersOf('package.json', rules), [PLAT]);
  assert.deepEqual(ownersOf('package.json.bak', rules), []);
  assert.deepEqual(ownersOf('packages/a/package.json', rules), []);
  assert.deepEqual(ownersOf('tools', rules), ['@peaket/tools']);
  assert.deepEqual(ownersOf('tools/ci/a.mjs', rules), ['@peaket/tools']);
  assert.deepEqual(ownersOf('toolsx/a.mjs', rules), []);
});

test("FND160_DT49_주인 찾기에서 '*'는 모든 파일에 맞고 맞는 규칙이 없으면 빈 배열이다", () => {
  const star = [{ pattern: '*', owners: [ARCH] }];
  assert.deepEqual(ownersOf('README.md', star), [ARCH]);
  assert.deepEqual(ownersOf('a/b/c/d.ts', star), [ARCH]);
  assert.deepEqual(ownersOf('README.md', []), []);
  assert.deepEqual(ownersOf('docs/a.md', [{ pattern: '/infra/', owners: [PLAT] }]), []);
});

test("FND160_DT49_주인 찾기는 글롭과 앞 '/'가 없는 패턴을 어떤 파일에도 맞추지 않는다", () => {
  const rules = [
    { pattern: '*', owners: [ARCH] },
    { pattern: '*.md', owners: ['@peaket/glob-ext'] },
    { pattern: 'docs/', owners: ['@peaket/no-slash-dir'] },
    { pattern: 'docs/devops.md', owners: ['@peaket/no-slash-file'] },
    { pattern: '/docs/*.md', owners: ['@peaket/glob-in-dir'] },
    { pattern: '/docs/*', owners: ['@peaket/glob-star'] },
    { pattern: '/docs/**/devops.md', owners: ['@peaket/glob-deep'] },
    { pattern: '**', owners: ['@peaket/glob-all'] },
  ];
  assert.deepEqual(ownersOf('docs/devops.md', rules), [ARCH]);
  assert.deepEqual(ownersOf('README.md', rules), [ARCH]);
  assert.deepEqual(ownersOf('docs/devops.md', rules.slice(1)), []);
});

test("FND160_DT49_주인 찾기에서 '/d/**'는 '/d/'와 같다", () => {
  const rules = [{ pattern: '/apps/**', owners: [FE] }];
  assert.deepEqual(ownersOf('apps/a.ts', rules), [FE]);
  assert.deepEqual(ownersOf('apps/x/y/z.ts', rules), [FE]);
  assert.deepEqual(ownersOf('apps-old/a.ts', rules), []);
  assert.deepEqual(ownersOf('web/apps/a.ts', rules), []);
  // 마지막 맞는 줄이 이기는 것도 같다
  const mixed = [
    { pattern: '/apps/', owners: [FE] },
    { pattern: '/apps/widgets/queue/**', owners: [QUEUE] },
  ];
  assert.deepEqual(ownersOf(Q2, mixed), [QUEUE]);
  assert.deepEqual(ownersOf('apps/web/page.tsx', mixed), [FE]);
});

test("FND160_DT49_주인 찾기에서 '/d/'·'/d/**'는 이름이 d인 파일 그 자체에는 맞지 않고 '/d'는 맞는다", () => {
  assert.deepEqual(ownersOf('apps', [{ pattern: '/apps/', owners: [FE] }]), []);
  assert.deepEqual(ownersOf('apps', [{ pattern: '/apps/**', owners: [FE] }]), []);
  assert.deepEqual(ownersOf('apps', [{ pattern: '/apps', owners: [FE] }]), [FE]);
});

// ── unsupportedPatterns ──

test("FND160_DT49_세지 못하는 패턴은 '*'·'/경로'·'/경로/'·'/경로/**' 밖의 꼴만 규칙 차례로 겹치지 않게 낸다", () => {
  const rules = freezeRules([
    { pattern: '*', owners: [ARCH] },
    { pattern: 'docs/', owners: ['@peaket/a'] },
    { pattern: '/apps/', owners: [FE] },
    { pattern: '*.md', owners: ['@peaket/a'] },
    { pattern: '/package.json', owners: [PLAT] },
    { pattern: '/a/*/b', owners: ['@peaket/a'] },
    { pattern: '/apps/**', owners: [FE] },
    { pattern: 'docs/', owners: ['@peaket/b'] }, // 같은 패턴은 한 번만
    { pattern: '/x/**/y', owners: ['@peaket/a'] },
    { pattern: '*.md', owners: ['@peaket/b'] },
    { pattern: '/tools', owners: [PLAT] },
  ]);
  assert.deepEqual(unsupportedPatterns(rules), ['docs/', '*.md', '/a/*/b', '/x/**/y']);
  assert.deepEqual(unsupportedPatterns(RULES), []);
  assert.deepEqual(unsupportedPatterns([]), []);
});

test("FND160_DT49_'?'·'[…]'·'*' 글롭과 빈 경로('/'·'/**')도 세지 못하는 패턴이고 ownersOf도 맞추지 않는다", () => {
  const patterns = ['/a?b', '/a[bc]/', '/docs/*', '**', '/docs/**/devops.md', '/', '/**'];
  assert.deepEqual(unsupportedPatterns(patterns.map((pattern) => ({ pattern, owners: [FE] }))), patterns);
  for (const p of patterns) {
    for (const path of ['docs/devops.md', 'README.md', 'axb', 'ab/x.ts']) {
      assert.deepEqual(ownersOf(path, [{ pattern: p, owners: [FE] }]), [], `${p} ↔ ${path}`);
    }
  }
});

test('FND160_DT49_저장소 CODEOWNERS에는 세지 못하는 패턴이 없다', () => {
  const rules = parseCodeowners(readFileSync(join(repoRoot, '.github', 'CODEOWNERS'), 'utf8'));
  assert.deepEqual(unsupportedPatterns(rules), []);
});

test("FND160_DT49_저장소 CODEOWNERS로 v0-monolith는 두 팀, 위젯 대기열은 좁은 줄, 문서는 기본값 '*'의 주인이다", () => {
  const rules = parseCodeowners(readFileSync(join(repoRoot, '.github', 'CODEOWNERS'), 'utf8'));
  assert.deepEqual(rules[0], { pattern: '*', owners: [ARCH] });
  for (const r of rules) {
    assert.ok(!r.pattern.startsWith('#'), `주석 줄이 규칙으로 들어왔다: ${r.pattern}`);
    assert.ok(r.owners.length > 0, `주인 없는 규칙: ${r.pattern}`);
    for (const o of r.owners) assert.match(o, /^@peaket\/[a-z-]+$/, `주인 꼴이 아니다: ${r.pattern} ${o}`);
  }
  assert.deepEqual(ownersOf('services/v0-monolith/src/main.ts', rules), [QUEUE, PURCHASE]);
  assert.deepEqual(ownersOf('apps/widgets/queue/src/index.ts', rules), [QUEUE]);
  assert.deepEqual(ownersOf('apps/web/src/page.tsx', rules), [FE]);
  assert.deepEqual(ownersOf('docs/devops.md', rules), [ARCH]);
  assert.deepEqual(ownersOf('docs/perf-ledger/run.json', rules), [PLAT]);
  assert.deepEqual(ownersOf('tools/ci/branch-watch.mjs', rules), [PLAT]);
  assert.deepEqual(ownersOf('tools/other.mjs', rules), [ARCH]);
  assert.deepEqual(ownersOf('services/queue-svc/src/main.ts', rules), [QUEUE]);
  assert.deepEqual(ownersOf('services/brand-new-svc/main.go', rules), [PLAT]);
  assert.deepEqual(ownersOf('packages/contracts/src/a.ts', rules), [ARCH]);
  assert.deepEqual(ownersOf('package.json', rules), [PLAT]);
  assert.deepEqual(ownersOf('.github/workflows/ci.yml', rules), [PLAT]);
});

// ── workBranchesByTeam ──

test('FND160_DT49_②③ 팀별 작업 가지는 작업 가지만 세고 포크는 빼며 두 팀 파일을 바꾼 PR은 두 팀에 하나씩 센다', () => {
  const prs = [
    pr(5, 'feature/a', [Q1]),
    pr(2, 'bugfix/b', [Q2, P1]), // ③ 두 팀
    pr(9, 'feature/c', [Q1], true), // ② 포크
    pr(3, 'release/1.0.0', [Q1]),
    pr(4, 'merge/release-1.0.0-to-develop', [Q1]),
    pr(7, 'hotfix/1.0.1', [P1]),
    pr(6, 'chore/e', [Q1]),
    pr(8, 'feature/d', [DOC]),
  ];
  assert.deepEqual(plain(workBranchesByTeam(prs, RULES)), {
    [QUEUE]: [2, 5],
    [PURCHASE]: [2],
    [ARCH]: [8],
  });
});

test('FND160_DT49_③ 팀별 작업 가지 번호는 수 크기 차례이고 한 PR이 같은 팀 파일을 여럿 바꿔도 한 번만 들며 센 PR이 없는 팀은 Map에 없다', () => {
  const prs = [
    pr(100, 'feature/x', [Q1, Q2]),
    pr(9, 'feature/y', [Q1]),
    pr(20, 'bugfix/z', [V0]), // 주인 둘(대기열·구매)
    pr(7, 'release/1.0.0', ['services/new-svc/a.ts']), // 플랫폼 팀: 작업 가지가 아니라 세지 않는다
    pr(8, 'feature/fork', ['apps/web/a.ts'], true), // 화면 팀: 포크라 세지 않는다
  ];
  const map = workBranchesByTeam(prs, RULES);
  assert.deepEqual([...map.keys()].sort(), [PURCHASE, QUEUE]);
  // 글자 차례로 정렬하면 [100, 20, 9]가 된다
  assert.deepEqual(plain(map), {
    [QUEUE]: [9, 20, 100],
    [PURCHASE]: [20],
  });
});

test("FND160_DT49_가지 종류는 '/'까지 맞아야 한다(features/x·feature-x는 작업 가지가 아니고 releases/는 통과 가지가 아니다)", () => {
  const map = workBranchesByTeam([pr(1, 'features/x', [Q1]), pr(2, 'feature-x', [Q1]), pr(3, 'feature/y', [Q1])], RULES);
  assert.deepEqual(plain(map), { [QUEUE]: [3] });
  const S = fakeSha('4a4a4a4');
  assert.deepEqual(mergeWarnings([{ sha: S, subject: 'x', prHead: 'releases/1.0.0' }]), [squashWarn(S, 'releases/1.0.0')]);
});

// ── countWarnings ──

test('FND160_DT49_① 같은 팀 작업 가지 넷이면 그 팀 경고', () => {
  const current = pr(4, 'feature/q4', [Q1]);
  const prs = [pr(3, 'feature/q3', [Q2]), pr(1, 'feature/q1', [Q1]), pr(4, 'feature/q4', [Q1]), pr(2, 'bugfix/q2', [Q1])];
  assert.deepEqual(countWarnings(current, prs, RULES), [
    '팀 @peaket/queue의 열린 작업 가지가 4개다(3개 이하, docs/devops.md §2.2.1): #1, #2, #3, #4',
  ]);
});

test('FND160_DT49_① 같은 팀 작업 가지 셋까지는 경고하지 않는다(이번 PR이 목록에 있으면 두 번 세지 않는다)', () => {
  const current = pr(3, 'feature/q3', [Q1]);
  const prs = [pr(1, 'feature/q1', [Q1]), pr(2, 'feature/q2', [Q2]), pr(3, 'feature/q3', [Q1])];
  assert.deepEqual(countWarnings(current, prs, RULES), []);
});

test('FND160_DT49_① 이번 PR이 열린 PR 목록에 없으면 더해서 센다', () => {
  const current = pr(9, 'feature/q9', [Q2]);
  const prs = [pr(1, 'feature/q1', [Q1]), pr(2, 'feature/q2', [Q1]), pr(3, 'bugfix/q3', [Q1])];
  assert.deepEqual(countWarnings(current, prs, RULES), [teamWarn(QUEUE, [1, 2, 3, 9])]);
});

test('FND160_DT49_① 목록에 이번 PR과 번호가 같은 항목이 있으면 그 항목으로 센다', () => {
  // 이번 PR은 대기열·구매 파일을 바꾸지만 목록의 #4는 구매 파일만 바꾼다 → 대기열은 #1~#3 셋이라 경고 없음
  const current = pr(4, 'feature/q4', [Q1, P1]);
  const prs = [pr(1, 'feature/q1', [Q1]), pr(2, 'feature/q2', [Q1]), pr(3, 'feature/q3', [Q1]), pr(4, 'feature/q4', [P1])];
  assert.deepEqual(countWarnings(current, prs, RULES), []);
});

test('FND160_DT49_② 포크 PR은 세지 않는다', () => {
  const current = pr(4, 'feature/q4', [Q1]);
  const three = [pr(1, 'feature/q1', [Q1]), pr(2, 'feature/q2', [Q1]), pr(3, 'feature/fork', [Q1], true), current];
  assert.deepEqual(countWarnings(current, three, RULES), []);
  const four = [...three, pr(5, 'bugfix/q5', [Q2])];
  assert.deepEqual(countWarnings(current, four, RULES), [teamWarn(QUEUE, [1, 2, 4, 5])]);
});

test('FND160_DT49_③ 두 팀 파일을 바꾸는 PR은 두 팀에 하나씩 세고 경고는 팀 이름 차례다', () => {
  const current = pr(7, 'feature/both', [Q1, P1]);
  const prs = [
    pr(1, 'feature/q1', [Q1]),
    pr(2, 'feature/q2', [Q1]),
    pr(3, 'feature/q3', [Q2]),
    pr(4, 'feature/p4', [P1]),
    pr(5, 'feature/p5', [P1]),
    pr(6, 'bugfix/p6', [P1]),
    current,
  ];
  assert.deepEqual(countWarnings(current, prs, RULES), [
    teamWarn(PURCHASE, [4, 5, 6, 7]),
    teamWarn(QUEUE, [1, 2, 3, 7]),
  ]);
});

test('FND160_DT49_이번 PR이 바꾸지 않은 팀은 넘쳐도 경고하지 않는다', () => {
  const current = pr(5, 'feature/q5', [Q1]);
  const prs = [pr(1, 'feature/p1', [P1]), pr(2, 'feature/p2', [P1]), pr(3, 'feature/p3', [P1]), pr(4, 'feature/p4', [P1]), current];
  assert.deepEqual(countWarnings(current, prs, RULES), []);
});

test('FND160_DT49_이번 PR이 작업 가지가 아니거나 포크면 경고하지 않는다', () => {
  const prs = [pr(1, 'feature/q1', [Q1]), pr(2, 'feature/q2', [Q1]), pr(3, 'feature/q3', [Q1]), pr(4, 'feature/q4', [Q1])];
  for (const current of [
    pr(5, 'release/1.0.0', [Q1]),
    pr(5, 'hotfix/1.0.1', [Q1]),
    pr(5, 'merge/release-1.0.0-to-develop', [Q1]),
    pr(5, 'chore/q5', [Q1]),
    pr(5, 'feature/q5', [Q1], true),
  ]) {
    assert.deepEqual(countWarnings(current, [...prs, current], RULES), [], `${current.head} fork=${current.fork}`);
  }
});

test('FND160_DT49_상한 max를 바꿀 수 있고 기본값은 3이다', () => {
  assert.equal(MAX_WORK_BRANCHES_PER_TEAM, 3);
  const current = pr(2, 'feature/q2', [Q1]);
  const two = [pr(1, 'feature/q1', [Q1]), current];
  assert.deepEqual(countWarnings(current, two, RULES, 1), [teamWarn(QUEUE, [1, 2], 1)]);
  assert.deepEqual(countWarnings(current, two, RULES, 2), []);
  const four = [pr(1, 'feature/q1', [Q1]), pr(3, 'feature/q3', [Q1]), pr(4, 'feature/q4', [Q1]), current];
  assert.deepEqual(countWarnings(current, four, RULES, 5), []);
  assert.deepEqual(countWarnings(current, four, RULES), countWarnings(current, four, RULES, 3));
  assert.deepEqual(countWarnings(current, four, RULES), [teamWarn(QUEUE, [1, 2, 3, 4])]);
});

// ── headFromMergeSubject ──

test('FND160_DT49_병합 커밋 제목에서 들어온 가지를 읽는다', () => {
  assert.equal(headFromMergeSubject('Merge pull request #12 from peaket/feature/x'), 'feature/x');
  assert.equal(headFromMergeSubject('Merge pull request #8 from someone/bugfix/y'), 'bugfix/y');
  assert.equal(
    headFromMergeSubject('Merge pull request #7 from peaket/merge/release-1.5.0-to-develop'),
    'merge/release-1.5.0-to-develop',
  );
  assert.equal(headFromMergeSubject("Merge branch 'release/1.0.0' into develop"), 'release/1.0.0');
  assert.equal(headFromMergeSubject("Merge branch 'release/1.0.0'"), 'release/1.0.0');
  assert.equal(headFromMergeSubject("Merge remote-tracking branch 'origin/hotfix/1.0.1'"), 'hotfix/1.0.1');
  assert.equal(headFromMergeSubject("Merge remote-tracking branch 'origin/hotfix/1.0.1' into develop"), 'hotfix/1.0.1');
  assert.equal(headFromMergeSubject("Merge remote-tracking branch 'upstream/release/1.0.0' into develop"), 'release/1.0.0');
});

test('FND160_DT49_모르는 꼴의 병합 커밋 제목은 null이다', () => {
  assert.equal(headFromMergeSubject('feat(queue): 대기열 진입을 더한다 (#12)'), null);
  assert.equal(headFromMergeSubject('Revert "feat: x"'), null);
  assert.equal(headFromMergeSubject("Merge tag 'v1.0.0'"), null);
  assert.equal(headFromMergeSubject('Merge pull request #12 from feature-x'), null);
  assert.equal(headFromMergeSubject(''), null);
});

// ── mergeWarnings ──

test('FND160_DT49_④⑤ develop 병합 커밋 가운데 작업 가지는 경고하고 release·hotfix·merge는 통과한다(커밋 차례)', () => {
  const A = '0123456789abcdef0123456789abcdef01234567';
  const merges = [
    { sha: A, subject: 'Merge pull request #10 from peaket/feature/x', prHead: 'feature/x' }, // ④
    { sha: fakeSha('b000001'), subject: 'Merge pull request #11 from peaket/release/1.0.0', prHead: 'release/1.0.0' }, // ⑤
    { sha: fakeSha('c000002'), subject: 'Merge pull request #12 from peaket/hotfix/1.0.1', prHead: 'hotfix/1.0.1' }, // ⑤
    { sha: fakeSha('d000003'), subject: 'x', prHead: 'merge/release-1.0.0-to-develop' }, // ⑤
    { sha: fakeSha('e000004'), subject: 'Merge pull request #13 from peaket/bugfix/y', prHead: null }, // ④ 제목으로
    { sha: fakeSha('f000005'), subject: "Merge branch 'release/1.1.0' into develop", prHead: null }, // ⑤ 제목으로
    { sha: fakeSha('a000006'), subject: "Merge remote-tracking branch 'origin/hotfix/1.0.2'", prHead: null }, // ⑤ 제목으로
    { sha: fakeSha('a000007'), subject: 'Merge pull request #14 from peaket/chore/z', prHead: 'chore/z' }, // 그 밖의 가지
  ];
  assert.deepEqual(mergeWarnings(merges), [
    '0123456 feature/x: develop에 병합 커밋으로 들어왔다(작업 가지는 스쿼시, §2.2.6)',
    squashWarn(fakeSha('e000004'), 'bugfix/y'),
    squashWarn(fakeSha('a000007'), 'chore/z'),
  ]);
});

test('FND160_DT49_④ 들어온 가지는 API가 준 prHead가 제목보다 먼저다', () => {
  const S1 = fakeSha('1a1a1a1');
  const S2 = fakeSha('2b2b2b2');
  assert.deepEqual(
    mergeWarnings([
      { sha: S1, subject: "Merge branch 'release/1.0.0' into develop", prHead: 'feature/a' },
      { sha: S2, subject: 'Merge pull request #3 from peaket/feature/b', prHead: 'release/1.0.0' },
    ]),
    [squashWarn(S1, 'feature/a')],
  );
});

test('FND160_DT49_들어온 가지를 모르는 병합 커밋도 경고한다', () => {
  const S = 'abcdef0123456789abcdef0123456789abcdef01';
  assert.deepEqual(mergeWarnings([{ sha: S, subject: 'chore: 무엇을 고친다', prHead: null }]), [
    'abcdef0: 들어온 가지를 알 수 없는 병합 커밋이다(§2.2.6)',
  ]);
  assert.deepEqual(mergeWarnings([]), []);
});

test('FND160_DT49_prHead가 빈 글이면 없는 것으로 보고 제목에서 읽는다', () => {
  const S1 = fakeSha('1c1c1c1');
  const S2 = fakeSha('2d2d2d2');
  const S3 = fakeSha('3f3f3f3');
  assert.deepEqual(
    mergeWarnings([
      { sha: S1, subject: 'Merge pull request #3 from peaket/feature/b', prHead: '' },
      { sha: S2, subject: "Merge branch 'release/1.0.0' into develop", prHead: '' },
      { sha: S3, subject: 'chore: x', prHead: '' },
    ]),
    [squashWarn(S1, 'feature/b'), unknownWarn(S3)],
  );
});

// ── runCount ──

test('FND160_DT49_① count는 열린 PR과 작업 가지 PR의 바뀐 파일을 API로 읽어 넷째 PR에서 그 팀 경고를 낸다', async () => {
  const { api, calls } = fakeApi(
    table({
      [openPath(1)]: [
        ghPr(1, 'feature/q1'),
        ghPr(2, 'bugfix/q2'),
        ghPr(3, 'feature/q3'),
        ghPr(4, 'feature/q4'),
        ghPr(5, 'release/1.0.0'),
        ghPr(6, 'merge/release-1.0.0-to-develop'),
      ],
      [filesPath(1, 1)]: fileItems(Q1),
      [filesPath(2, 1)]: fileItems(Q2),
      [filesPath(3, 1)]: fileItems(Q1),
      [filesPath(4, 1)]: fileItems(Q1, Q2),
    }),
  );
  const r = await runCount({ event: event(4, 'feature/q4'), repo: REPO, api, codeowners: CODEOWNERS });
  assert.deepEqual(r.warnings, [
    '팀 @peaket/queue의 열린 작업 가지가 4개다(3개 이하, docs/devops.md §2.2.1): #1, #2, #3, #4',
  ]);
  // 작업 가지 PR(#1~#4)의 파일만 읽고 release·merge PR(#5·#6)의 파일은 읽지 않는다
  assert.deepEqual(uniqSorted(calls), uniqSorted([openPath(1), filesPath(1, 1), filesPath(2, 1), filesPath(3, 1), filesPath(4, 1)]));
});

test('FND160_DT49_② count는 포크 PR(head.repo가 다른 저장소이거나 null)을 세지 않고 그 파일도 읽지 않는다', async () => {
  const { api, calls } = fakeApi(
    table({
      [openPath(1)]: [
        ghPr(1, 'feature/q1'),
        ghPr(2, 'feature/q2'),
        ghPr(3, 'feature/q3', 'someone/peaket'),
        ghPr(5, 'feature/q5', null),
        ghPr(4, 'feature/q4'),
      ],
      [filesPath(1, 1)]: fileItems(Q1),
      [filesPath(2, 1)]: fileItems(Q1),
      [filesPath(4, 1)]: fileItems(Q1),
    }),
  );
  const r = await runCount({ event: event(4, 'feature/q4'), repo: REPO, api, codeowners: CODEOWNERS });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(uniqSorted(calls), uniqSorted([openPath(1), filesPath(1, 1), filesPath(2, 1), filesPath(4, 1)]));
});

test('FND160_DT49_① count는 열린 PR 목록에 없는 이번 PR의 파일도 읽어 더해 센다', async () => {
  const { api, calls } = fakeApi(
    table({
      [openPath(1)]: [ghPr(1, 'feature/q1'), ghPr(2, 'bugfix/q2'), ghPr(3, 'feature/q3')],
      [filesPath(1, 1)]: fileItems(Q1),
      [filesPath(2, 1)]: fileItems(Q1),
      [filesPath(3, 1)]: fileItems(Q2),
      [filesPath(9, 1)]: fileItems(Q1),
    }),
  );
  const r = await runCount({ event: event(9, 'feature/q9'), repo: REPO, api, codeowners: CODEOWNERS });
  assert.deepEqual(r.warnings, [teamWarn(QUEUE, [1, 2, 3, 9])]);
  assert.deepEqual(uniqSorted(calls), uniqSorted([openPath(1), filesPath(1, 1), filesPath(2, 1), filesPath(3, 1), filesPath(9, 1)]));
});

test('FND160_DT49_③ count는 두 팀 주인 파일을 바꾸는 PR을 두 팀에 하나씩 센다', async () => {
  const { api } = fakeApi(
    table({
      [openPath(1)]: [1, 2, 3, 4, 5, 6, 7].map((n) => ghPr(n, `feature/n${n}`)),
      [filesPath(1, 1)]: fileItems(Q1),
      [filesPath(2, 1)]: fileItems(Q1),
      [filesPath(3, 1)]: fileItems(Q2),
      [filesPath(4, 1)]: fileItems(P1),
      [filesPath(5, 1)]: fileItems(P1),
      [filesPath(6, 1)]: fileItems(P1),
      [filesPath(7, 1)]: fileItems(V0), // services/v0-monolith/의 주인은 대기열·구매 둘
    }),
  );
  const r = await runCount({ event: event(7, 'feature/n7'), repo: REPO, api, codeowners: CODEOWNERS });
  assert.deepEqual(r.warnings, [teamWarn(PURCHASE, [4, 5, 6, 7]), teamWarn(QUEUE, [1, 2, 3, 7])]);
});

test('FND160_DT49_count는 이번 PR이 작업 가지가 아니거나 포크면 API를 부르지 않고 빈 경고를 낸다', async () => {
  for (const ev of [
    event(5, 'release/1.0.0'),
    event(5, 'hotfix/1.0.1'),
    event(5, 'merge/release-1.0.0-to-develop'),
    event(5, 'feature/x', 'someone/peaket'),
    event(5, 'bugfix/y', null),
  ]) {
    const { api, calls } = fakeApi(() => {
      throw new Error('API를 부르면 안 된다');
    });
    const r = await runCount({ event: ev, repo: REPO, api, codeowners: CODEOWNERS });
    const label = `${ev.pull_request.head.ref} ${JSON.stringify(ev.pull_request.head.repo)}`;
    assert.deepEqual(r.warnings, [], label);
    assert.deepEqual(calls, [], label);
  }
});

test('FND160_DT49_① count는 쪽을 page=1부터 읽고 100개보다 적게 온 쪽에서 멈춘다', async () => {
  const others = Array.from({ length: 96 }, (_, i) => ghPr(1000 + i, 'release/9.9.9'));
  const hundredQueueFiles = fileItems(...Array.from({ length: 100 }, (_, i) => `services/queue-svc/src/f${i}.ts`));
  const { api, calls } = fakeApi(
    table({
      [openPath(1)]: [ghPr(1, 'feature/q1'), ghPr(2, 'feature/q2'), ...others, ghPr(3, 'feature/q3'), ghPr(4, 'feature/q4')],
      [openPath(2)]: [ghPr(5, 'feature/q5')],
      [filesPath(1, 1)]: hundredQueueFiles,
      [filesPath(1, 2)]: fileItems(Q2),
      [filesPath(2, 1)]: hundredQueueFiles,
      [filesPath(2, 2)]: [],
      [filesPath(3, 1)]: fileItems(Q1),
      [filesPath(4, 1)]: fileItems(Q1),
      [filesPath(5, 1)]: fileItems(Q2),
    }),
  );
  const r = await runCount({ event: event(4, 'feature/q4'), repo: REPO, api, codeowners: CODEOWNERS });
  assert.deepEqual(r.warnings, [teamWarn(QUEUE, [1, 2, 3, 4, 5])]);
  assert.deepEqual(
    uniqSorted(calls),
    uniqSorted([
      openPath(1),
      openPath(2),
      filesPath(1, 1),
      filesPath(1, 2),
      filesPath(2, 1),
      filesPath(2, 2),
      filesPath(3, 1),
      filesPath(4, 1),
      filesPath(5, 1),
    ]),
  );
});

test('FND160_DT49_count는 쪽을 30쪽까지만 읽고 30쪽에 닿아도 경고하지 않는다', async () => {
  const fullOpenPage = (page) =>
    Array.from({ length: 100 }, (_, i) => (page === 1 && i === 0 ? ghPr(4, 'feature/q4') : ghPr(10000 + page * 100 + i, 'release/9.9.9')));
  const fullFilesPage = (page) => fileItems(...Array.from({ length: 100 }, (_, i) => `services/queue-svc/p${page}/f${i}.ts`));
  const { api, calls } = fakeApi((path) => {
    let m = path.match(/^\/repos\/peaket\/peaket\/pulls\?state=open&per_page=100&page=(\d+)$/);
    if (m) return fullOpenPage(Number(m[1]));
    m = path.match(/^\/repos\/peaket\/peaket\/pulls\/4\/files\?per_page=100&page=(\d+)$/);
    if (m) return fullFilesPage(Number(m[1]));
    throw new Error(`가짜 API에 없는 경로: ${path}`);
  });
  const r = await runCount({ event: event(4, 'feature/q4'), repo: REPO, api, codeowners: CODEOWNERS });
  assert.deepEqual(r.warnings, []); // 대기열 팀 작업 가지는 #4 하나다
  const pages = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.deepEqual(uniqSorted(calls.filter((p) => p.includes('state=open'))), uniqSorted(pages.map(openPath)));
  assert.deepEqual(uniqSorted(calls.filter((p) => p.includes('/pulls/4/files'))), uniqSorted(pages.map((n) => filesPath(4, n))));
});

test('FND160_DT49_⑥ count는 API 읽기가 실패하면 읽지 못했다는 경고 하나만 내고 던지지 않는다', async () => {
  // 열린 PR 목록부터 실패
  const down = fakeApi(() => {
    throw new Error('HTTP 502 서버 오류');
  });
  const r1 = await runCount({ event: event(4, 'feature/q4'), repo: REPO, api: down.api, codeowners: CODEOWNERS });
  assert.equal(r1.warnings.length, 1, JSON.stringify(r1.warnings));
  assert.ok(r1.warnings[0].startsWith('작업 가지 수를 읽지 못했다: '), r1.warnings[0]);
  assert.ok(r1.warnings[0].includes('HTTP 502 서버 오류'), r1.warnings[0]);

  // 목록은 읽었지만 한 PR의 파일 읽기가 실패하면 팀 경고 없이 실패 경고 하나만
  const partly = fakeApi(
    table({
      [openPath(1)]: [1, 2, 3, 4].map((n) => ghPr(n, `feature/q${n}`)),
      [filesPath(1, 1)]: fileItems(Q1),
      [filesPath(2, 1)]: new Error('HTTP 404 찾지 못함'),
      [filesPath(3, 1)]: fileItems(Q1),
      [filesPath(4, 1)]: fileItems(Q1),
    }),
  );
  const r2 = await runCount({ event: event(4, 'feature/q4'), repo: REPO, api: partly.api, codeowners: CODEOWNERS });
  assert.equal(r2.warnings.length, 1, JSON.stringify(r2.warnings));
  assert.ok(r2.warnings[0].startsWith('작업 가지 수를 읽지 못했다: '), r2.warnings[0]);
  assert.ok(r2.warnings[0].includes('HTTP 404 찾지 못함'), r2.warnings[0]);
});

test('FND160_DT49_③ count는 이름을 바꾼 파일(previous_filename)의 옛 경로 팀에도 센다', async () => {
  const renamed = (from, to) => ({ filename: to, previous_filename: from, status: 'renamed' });
  const { api } = fakeApi(
    table({
      [openPath(1)]: [1, 2, 3, 4, 5, 6, 7].map((n) => ghPr(n, `feature/n${n}`)),
      // #1~#3은 구매 파일을 문서로 옮긴다 → 옛 경로로 구매 팀에 든다
      [filesPath(1, 1)]: [renamed('services/purchase-svc/src/a.ts', 'docs/a.md')],
      [filesPath(2, 1)]: [renamed('services/purchase-svc/src/b.ts', 'docs/b.md')],
      [filesPath(3, 1)]: [renamed('services/purchase-svc/src/c.ts', 'docs/c.md')],
      // 이번 PR #4는 대기열 파일을 구매로 옮긴다 → 새 경로로 구매, 옛 경로로 대기열
      [filesPath(4, 1)]: [renamed('services/queue-svc/src/old.ts', 'services/purchase-svc/src/new.ts')],
      [filesPath(5, 1)]: fileItems(Q1),
      [filesPath(6, 1)]: fileItems(Q1),
      [filesPath(7, 1)]: fileItems(Q2),
    }),
  );
  const r = await runCount({ event: event(4, 'feature/n4'), repo: REPO, api, codeowners: CODEOWNERS });
  assert.deepEqual(r.warnings, [teamWarn(PURCHASE, [1, 2, 3, 4]), teamWarn(QUEUE, [4, 5, 6, 7])]);
});

// 세지 못하는 패턴 경고(명세에 글자 그대로 적힌 꼴)
const unsupportedWarn = (pattern) => `CODEOWNERS 패턴 '${pattern}'은 세지 못하는 꼴이라 건너뛴다('*', '/경로', '/경로/', '/경로/**'만 센다)`;
const CODEOWNERS_WITH_GLOBS = `${CODEOWNERS}docs/                      @peaket/docs\n*.md                       @peaket/docs\ndocs/                      @peaket/docs-again\n`;
const fourQueuePrs = () =>
  table({
    [openPath(1)]: [1, 2, 3, 4].map((n) => ghPr(n, `feature/q${n}`)),
    [filesPath(1, 1)]: fileItems(Q1),
    [filesPath(2, 1)]: fileItems(Q1),
    [filesPath(3, 1)]: fileItems(Q2),
    [filesPath(4, 1)]: fileItems(Q1),
  });

test('FND160_DT49_① count는 세지 못하는 CODEOWNERS 패턴 경고를 규칙 차례로 팀 경고보다 먼저 낸다', async () => {
  const { api } = fakeApi(fourQueuePrs());
  const r = await runCount({ event: event(4, 'feature/q4'), repo: REPO, api, codeowners: CODEOWNERS_WITH_GLOBS });
  assert.deepEqual(r.warnings, [unsupportedWarn('docs/'), unsupportedWarn('*.md'), teamWarn(QUEUE, [1, 2, 3, 4])]);
});

test('FND160_DT49_⑥ count는 API가 던져도 세지 못하는 패턴 경고를 내고 그 뒤에 읽지 못했다는 경고를 붙인다', async () => {
  const { api } = fakeApi(() => {
    throw new Error('HTTP 502 서버 오류');
  });
  const r = await runCount({ event: event(4, 'feature/q4'), repo: REPO, api, codeowners: CODEOWNERS_WITH_GLOBS });
  assert.equal(r.warnings.length, 3, JSON.stringify(r.warnings));
  assert.equal(r.warnings[0], unsupportedWarn('docs/'));
  assert.equal(r.warnings[1], unsupportedWarn('*.md'));
  assert.ok(r.warnings[2].startsWith('작업 가지 수를 읽지 못했다: '), r.warnings[2]);
  assert.ok(r.warnings[2].includes('HTTP 502 서버 오류'), r.warnings[2]);
});

test('FND160_DT49_count는 이번 PR이 작업 가지가 아니거나 포크면 세지 못하는 패턴 경고도 내지 않는다', async () => {
  for (const ev of [event(5, 'release/1.0.0'), event(5, 'feature/x', 'someone/peaket'), event(5, 'bugfix/y', null)]) {
    const { api, calls } = fakeApi(() => {
      throw new Error('API를 부르면 안 된다');
    });
    const r = await runCount({ event: ev, repo: REPO, api, codeowners: CODEOWNERS_WITH_GLOBS });
    const label = `${ev.pull_request.head.ref} ${JSON.stringify(ev.pull_request.head.repo)}`;
    assert.deepEqual(r.warnings, [], label);
    assert.deepEqual(calls, [], label);
  }
});

// ── runWeekly ──

test('FND160_DT49_④⑤ weekly는 커밋마다 병합 PR의 머리 가지로 판정해 작업 가지 병합 커밋만 경고한다', async () => {
  const S1 = fakeSha('a1a1a1a');
  const S2 = fakeSha('b2b2b2b');
  const S3 = fakeSha('c3c3c3c');
  const S4 = fakeSha('d4d4d4d');
  const linked = (sha, ref) => [{ number: 1, merge_commit_sha: sha, head: { ref } }];
  const { api, calls } = fakeApi(
    table({
      [commitPullsPath(S1)]: linked(S1, 'feature/x'),
      [commitPullsPath(S2)]: linked(S2, 'release/1.0.0'),
      [commitPullsPath(S3)]: linked(S3, 'hotfix/1.0.1'),
      [commitPullsPath(S4)]: linked(S4, 'merge/release-1.0.0-to-develop'),
    }),
  );
  const merges = [
    { sha: S1, subject: 'Merge pull request #10 from peaket/feature/x' },
    { sha: S2, subject: 'Merge pull request #11 from peaket/release/1.0.0' },
    { sha: S3, subject: 'Merge pull request #12 from peaket/hotfix/1.0.1' },
    { sha: S4, subject: 'Merge pull request #13 from peaket/merge/release-1.0.0-to-develop' },
  ];
  const r = await runWeekly({ repo: REPO, merges, api });
  assert.deepEqual(r.warnings, [squashWarn(S1, 'feature/x')]);
  assert.deepEqual(uniqSorted(calls), uniqSorted([S1, S2, S3, S4].map(commitPullsPath)));
});

test('FND160_DT49_④ weekly는 merge_commit_sha가 그 커밋인 PR의 머리 가지만 쓴다', async () => {
  const S1 = fakeSha('1111aaa');
  const S2 = fakeSha('2222bbb');
  const OTHER = fakeSha('9999fff');
  const { api } = fakeApi(
    table({
      // 그 커밋을 병합한 PR이 아니다 → prHead 없음 → 제목(release)으로 통과
      [commitPullsPath(S1)]: [{ number: 1, merge_commit_sha: OTHER, head: { ref: 'feature/other' } }],
      // 제목은 release지만 그 커밋을 병합한 PR의 머리는 feature
      [commitPullsPath(S2)]: [
        { number: 2, merge_commit_sha: OTHER, head: { ref: 'release/2.0.0' } },
        { number: 3, merge_commit_sha: S2, head: { ref: 'feature/y' } },
      ],
    }),
  );
  const merges = [
    { sha: S1, subject: "Merge branch 'release/1.0.0' into develop" },
    { sha: S2, subject: "Merge branch 'release/1.0.0' into develop" },
  ];
  const r = await runWeekly({ repo: REPO, merges, api });
  assert.deepEqual(r.warnings, [squashWarn(S2, 'feature/y')]);
});

test('FND160_DT49_④ weekly는 연결된 PR이 없으면 제목으로 정하고 제목도 모르면 알 수 없다고 경고한다', async () => {
  const S1 = fakeSha('3333ccc');
  const S2 = fakeSha('4444ddd');
  const S3 = fakeSha('5555eee');
  const { api } = fakeApi(
    table({
      [commitPullsPath(S1)]: [],
      [commitPullsPath(S2)]: [],
      [commitPullsPath(S3)]: [],
    }),
  );
  const merges = [
    { sha: S1, subject: 'Merge pull request #3 from peaket/bugfix/z' },
    { sha: S2, subject: "Merge branch 'hotfix/1.0.1'" },
    { sha: S3, subject: 'chore: 무엇을 고친다' },
  ];
  const r = await runWeekly({ repo: REPO, merges, api });
  assert.deepEqual(r.warnings, [squashWarn(S1, 'bugfix/z'), unknownWarn(S3)]);
});

test('FND160_DT49_⑥ weekly는 병합 PR 읽기가 실패해도 던지지 않고 그 커밋의 경고 앞에 읽지 못했다는 경고를 둔다', async () => {
  const S1 = fakeSha('6666aaa');
  const S2 = fakeSha('7777bbb');
  const S3 = fakeSha('8888ccc');
  const S4 = fakeSha('9999ddd');
  const { api } = fakeApi(
    table({
      [commitPullsPath(S1)]: new Error('HTTP 403 사용 한도'),
      [commitPullsPath(S2)]: new Error('HTTP 403 사용 한도'),
      [commitPullsPath(S3)]: [{ number: 9, merge_commit_sha: S3, head: { ref: 'release/1.0.0' } }],
      [commitPullsPath(S4)]: new Error('HTTP 500 서버 오류'),
    }),
  );
  const merges = [
    { sha: S1, subject: 'Merge pull request #5 from peaket/feature/a' }, // 실패 → 제목으로 feature
    { sha: S2, subject: "Merge branch 'release/1.0.0'" }, // 실패 → 제목으로 release
    { sha: S3, subject: 'Merge pull request #9 from peaket/release/1.0.0' },
    { sha: S4, subject: 'chore: 무엇' }, // 실패 → 제목도 모름
  ];
  const r = await runWeekly({ repo: REPO, merges, api });
  const w = r.warnings;
  assert.equal(w.length, 5, JSON.stringify(w));
  const readFail = (got, sha, why) => {
    assert.ok(got.startsWith(`${sha.slice(0, 7)}: 병합 PR을 읽지 못했다: `), got);
    assert.ok(got.includes(why), got);
  };
  readFail(w[0], S1, 'HTTP 403 사용 한도');
  assert.equal(w[1], squashWarn(S1, 'feature/a'));
  readFail(w[2], S2, 'HTTP 403 사용 한도');
  readFail(w[3], S4, 'HTTP 500 서버 오류');
  assert.equal(w[4], unknownWarn(S4));
});

test('FND160_DT49_weekly 요약에는 검사한 병합 커밋 수, 보는 기간, 경고 글이 들어간다', async () => {
  // 숫자가 경고 글·해시와 겹치지 않게 해시와 가지 이름에 숫자를 쓰지 않는다
  const SA = fakeSha('aaaabbb');
  const SB = fakeSha('ccccddd');
  const SC = fakeSha('ffffaaa');
  const { api } = fakeApi(
    table({
      [commitPullsPath(SA)]: [{ number: 1, merge_commit_sha: SA, head: { ref: 'feature/abc' } }],
      [commitPullsPath(SB)]: [{ number: 2, merge_commit_sha: SB, head: { ref: 'release/abc' } }],
      [commitPullsPath(SC)]: [],
    }),
  );
  const merges = [
    { sha: SA, subject: 'Merge pull request from peaket/feature/abc' },
    { sha: SB, subject: 'Merge pull request from peaket/release/abc' },
    { sha: SC, subject: 'chore: abc' },
  ];
  const r = await runWeekly({ repo: REPO, merges, api, sinceDays: 11 });
  assert.deepEqual(r.warnings, [squashWarn(SA, 'feature/abc'), unknownWarn(SC)]);
  assert.equal(typeof r.summary, 'string');
  assert.ok(hasNumber(r.summary, 3), `병합 커밋 수 3이 없다:\n${r.summary}`);
  assert.ok(hasNumber(r.summary, 11), `기간 11일이 없다:\n${r.summary}`);
  for (const w of r.warnings) assert.ok(r.summary.includes(w), `경고 글이 없다: ${w}\n${r.summary}`);
});

// 요약 칸 시험: '|'·CR·LF가 든 가지 이름을 API가 준 병합 PR의 머리 가지(prHead)로 넣는다(제목 읽기 규칙에 기대지 않는다)
async function weeklyWithHeads(heads) {
  const merges = heads.map((h, i) => ({ sha: fakeSha(`${i + 1}abcdef`), subject: 'chore: 제목으로는 모른다' }));
  const { api } = fakeApi(
    table(Object.fromEntries(merges.map((m, i) => [commitPullsPath(m.sha), [{ number: i + 1, merge_commit_sha: m.sha, head: { ref: heads[i] } }]]))),
  );
  const r = await runWeekly({ repo: REPO, merges, api });
  return { r, merges };
}

test("FND160_DT49_weekly 요약 칸에서 '|'는 '\\|'로, CRLF·LF는 공백 하나로 바꾸고 경고 목록은 그대로 둔다", async () => {
  const heads = ['feature/a|b', 'feature/e\r\nf', 'feature/g\nh'];
  const { r, merges } = await weeklyWithHeads(heads);
  // 경고 목록(::warning:: 줄의 재료)은 바꾸지 않는다
  assert.deepEqual(
    r.warnings,
    merges.map((m, i) => squashWarn(m.sha, heads[i])),
  );
  const cellOf = (i, head) => squashWarn(merges[i].sha, head);
  assert.ok(r.summary.includes(cellOf(0, 'feature/a\\|b')), r.summary);
  assert.ok(!r.summary.includes('feature/a|b'), `'|'를 바꾸지 않았다:\n${r.summary}`);
  // CRLF는 줄바꿈 하나라 공백 하나가 된다
  assert.ok(r.summary.includes(cellOf(1, 'feature/e f')), JSON.stringify(r.summary));
  assert.ok(!r.summary.includes('feature/e  f'), JSON.stringify(r.summary));
  assert.ok(r.summary.includes(cellOf(2, 'feature/g h')), JSON.stringify(r.summary));
});

test('FND160_DT49_weekly 요약 칸에서 홀로 있는 CR도 공백 하나로 바꾸고(CRLF는 공백 하나) 요약에는 CR이 남지 않는다', async () => {
  const heads = ['feature/c\rd', 'feature/e\r\nf'];
  const { r, merges } = await weeklyWithHeads(heads);
  assert.deepEqual(
    r.warnings,
    merges.map((m, i) => squashWarn(m.sha, heads[i])),
  );
  assert.ok(!r.summary.includes('\r'), `요약에 CR이 있다: ${JSON.stringify(r.summary)}`);
  assert.ok(r.summary.includes(squashWarn(merges[0].sha, 'feature/c d')), JSON.stringify(r.summary));
  assert.ok(r.summary.includes(squashWarn(merges[1].sha, 'feature/e f')), JSON.stringify(r.summary));
});

test('FND160_DT49_⑤ weekly 기간을 주지 않으면 요약에 기본 8일이 들어간다', async () => {
  assert.equal(WEEKLY_WINDOW_DAYS, 8);
  const SA = fakeSha('abcabca');
  const { api } = fakeApi(table({ [commitPullsPath(SA)]: [{ number: 1, merge_commit_sha: SA, head: { ref: 'release/abc' } }] }));
  const r = await runWeekly({ repo: REPO, merges: [{ sha: SA, subject: 'Merge pull request from peaket/release/abc' }], api });
  assert.deepEqual(r.warnings, []);
  assert.ok(hasNumber(r.summary, WEEKLY_WINDOW_DAYS), `기본 기간 8이 없다:\n${r.summary}`);
});

test('FND160_DT49_weekly는 병합 커밋이 없으면 API를 부르지 않고 경고 없이 0개와 기본 기간을 요약한다', async () => {
  const { api, calls } = fakeApi(() => {
    throw new Error('API를 부르면 안 된다');
  });
  const r = await runWeekly({ repo: REPO, merges: [], api });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(calls, []);
  assert.ok(hasNumber(r.summary, 0), `병합 커밋 수 0이 없다:\n${r.summary}`);
  assert.ok(hasNumber(r.summary, WEEKLY_WINDOW_DAYS), `기본 기간 8이 없다:\n${r.summary}`);
});
