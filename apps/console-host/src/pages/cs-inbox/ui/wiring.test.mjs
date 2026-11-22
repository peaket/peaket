// SCR-045 실제 화면의 배선 시험(F-06-2 GAT-280, R-T51 ②⑥). 시험 담당 lane3-f062-test.
// 정본: docs/features/transfer-refund.md §11 R-T51 ②(PATCH가 If-Match와 함께, 메모가 비면 보내지 않고 오류 요약으로 초점)·⑥(메모 초안은 브라우저 저장소 0, 서버 글은 글자 노드로만),
// docs/design/d5-screen-blueprint.md §7.6 상태 표('먼저 고친 건' [다시 불러오기], '없는 건', '빈 화면', 'viewer'), docs/frontend.md §2.2(생성 호출만, 화면 늦은 가져오기),
// docs/security/asvs/transfer-refund.md 'F-06-2 GAT-280 계획 메모'(1.2.1·3.2.2 글자 노드).
// 서버와 실제로 주고받는 흐름은 services/ops-svc/test/cs-inbox-screen-link.test.ts(생성 클라이언트 → 실제 ops-svc)가 본다. 이 파일은 화면 소스가 그 호출만 쓰는지를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const connected = read('./ConnectedPage.tsx');
const page = read('./Page.tsx');
const viewer = read('./ViewerNotice.tsx');
const model = read('../model/live.ts');
const router = read('../../../app/router.tsx');
const ops = read('../../../../../../packages/api-client/src/gen/endpoints/ops/ops.ts');
const operations = read('../../../../../../packages/api-client/src/gen/operations.ts');
const count = (src, re) => (src.match(re) ?? []).length;
const methodOf = (name) => {
  const at = ops.indexOf(`export const ${name} = async`);
  assert.ok(at >= 0, `${name} 생성 함수가 없다`);
  return /\bmethod: '([A-Z]+)'/.exec(ops.slice(at, at + 2_000))?.[1];
};

test('R-T51 ② 화면은 생성 호출 셋(목록·상세·갱신)과 세션 읽기만 쓰고 fetch를 만들지 않는다', () => {
  assert.equal(methodOf('listOpsCases'), 'GET');
  assert.equal(methodOf('getOpsCase'), 'GET');
  assert.equal(methodOf('updateOpsCase'), 'PATCH');
  assert.match(operations, /updateOpsCase: \{[^}]*method: "PATCH",path: "\/v1\/ops\/cases\/\{caseId\}"[^}]*ifMatch: true/);
  const used = [...connected.matchAll(/const \{ (\w+) \} = await ops\(\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(used, ['getMyOpsAuthSession', 'getOpsCase', 'listOpsCases', 'updateOpsCase']);
  assert.match(connected, /const ops = \(\) => import\('@peaket\/api-client\/endpoints\/ops'\)/);
  assert.doesNotMatch(connected, /\bfetch\s*\(/);
  assert.doesNotMatch(connected, /XMLHttpRequest|EventSource|WebSocket/);
  assert.match(connected, /ensureConsoleApi\(\)/);
});

test('R-T51 ② 갱신은 한 곳에서만 보내고 늘 읽은 판을 If-Match로 싣는다', () => {
  assert.equal(count(connected, /updateOpsCase\(/g), 1);
  assert.match(connected, /updateOpsCase\(c\.caseId, body, \{ headers: \{ 'If-Match': ifMatchOf\(version\) \} \}\)/);
  // 판은 상세의 ETag에서 읽고(없으면 본문 version), 갱신 응답의 ETag로 다시 바꾼다
  assert.match(connected, /versionOfEtag\(r\.headers\.get\('etag'\)\) \?\? c\?\.version \?\? null/);
  assert.match(connected, /versionOfEtag\(r\.headers\.get\('etag'\)\) \?\? next\?\.version \?\? null/);
  assert.match(connected, /onPatch=\{\(body, done\) => void patch\(selected\.c, selected\.version, body, done\)\}/);
});

test('R-T51 ② 메모가 비면 보내지 않고 오류 요약으로 초점을 옮기며, 요약은 메모 칸으로 간다', () => {
  const resolveAt = connected.indexOf('const resolve = ');
  assert.ok(resolveAt > 0);
  const resolveSrc = connected.slice(resolveAt, resolveAt + 600);
  assert.match(resolveSrc, /if \(note\.trim\(\) === ''\) \{\s*showNoteError\('결과 메모를 적어 주세요'\);\s*return;\s*\}/);
  assert.ok(resolveSrc.indexOf("showNoteError('결과 메모를 적어 주세요')") < resolveSrc.indexOf('void patch('), '빈 메모 확인이 보내기보다 먼저다');
  assert.match(connected, /requestAnimationFrame\(\(\) => summaryRef\.current\?\.focus\(\)\)/);
  assert.match(connected, /role="alert" tabIndex=\{-1\} ref=\{p\.summaryRef\}/);
  assert.match(connected, /onClick=\{\(\) => p\.noteRef\.current\?\.focus\(\)\}/);
  // 서버가 422 case-result-note-required로 돌려줘도 같은 요약이다
  assert.match(connected, /else if \(mapped\.kind === 'note-required'\) showNoteError\(mapped\.text\)/);
});

test('R-T51 ③ 412(먼저 고친 건)는 안내와 [다시 불러오기]이고, 쓰던 메모는 화면 상태에만 남는다', () => {
  assert.match(connected, /if \(mapped\.kind === 'stale' \|\| mapped\.kind === 'precondition-required'\) setStale\(true\)/);
  assert.ok(connected.includes('다른 곳에서 이 건을 먼저 고쳤습니다. 다시 불러온 뒤 고쳐 주세요.'));
  assert.match(connected, /onClick=\{p\.onReload\}>\s*다시 불러오기/);
  assert.match(connected, /onReload=\{\(\) => void loadDetail\(selected\.c\.caseId\)\}/);
  // 412 갈래는 메모를 비우지 않는다(해결 성공 때만 비운다)
  assert.equal(count(connected, /setNote\(''\)/g), 2, '건을 바꿀 때와 해결 성공 때만 비운다');
  assert.match(connected, /if \(body\.status === 'RESOLVED'\) setNote\(''\)/);
});

test('R-T51 ①④⑤ 빈 화면·없는 건·viewer 안내는 d5 §7.6 글이다', () => {
  assert.ok(connected.includes('처리할 건이 없습니다'));
  assert.ok(connected.includes('없는 건입니다'));
  assert.ok(connected.includes('접수 번호를 확인해 주세요.'));
  assert.match(connected, /if \(mapped\.kind === 'not-found'\) setDetail\(\{ kind: 'missing' \}\)/);
  assert.match(connected, /if \(viewer\) return <ViewerNotice \/>/);
  assert.match(connected, /if \(s\?\.role === 'viewer'\) setViewer\(true\)/);
  assert.ok(viewer.includes('CS 처리함은 CS 담당자와 operator·commander가 씁니다'));
  assert.ok(viewer.includes('정산 건의 건수는 정산 지급에서 봅니다'));
  assert.match(viewer, /<Link to="\/settlements"/);
  // operator는 CS 건에 처리 버튼이 없다(버튼 묶음은 canActOn 뒤에만)
  assert.match(connected, /const act = canActOn\(p\.role, c\.kind\) && c\.status !== 'RESOLVED'/);
  assert.match(connected, /\{act \? \(/);
  assert.match(connected, /\{hasUrgent\(items\) \? \(\s*<div className="banner banner-danger" role="alert">/);
});

test('R-T51 ⑥ cs-inbox 폴더의 운영 소스에 브라우저 저장소·innerHTML이 0이고 서버 글은 글자 노드로만 그린다', () => {
  const dir = new URL('./', import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/^board-/.test(f));
  assert.deepEqual(files.sort(), ['ConnectedPage.tsx', 'Page.tsx', 'ViewerNotice.tsx']);
  for (const [name, src] of [...files.map((f) => [f, read(`./${f}`)]), ['live.ts', model]]) {
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/, name);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/, name);
  }
  // 메모·대상·세부는 JSX 글자로만 넣는다
  assert.match(connected, /<dd style=\{\{ whiteSpace: 'pre-wrap' \}\}>\{c\.resultNote\}<\/dd>/);
  assert.match(connected, /<dd className="mono t-xs">\{c\.targetRef\}<\/dd>/);
  assert.match(connected, /<td className="mono t-xs">\{c\.targetRef\}<\/td>/);
});

test('R-T51 ② 미리보기 빌드의 ?state=만 보드이고 그 밖은 실제 화면이며, 목록·상세 경로는 같은 늦은 덩어리다', () => {
  assert.match(page, /return __PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>/);
  const lazies = [...router.matchAll(/path: '(cs\/inbox(?:\/:caseId)?)', lazy: \(\) => import\(\/\* webpackChunkName: "([\w-]+)" \*\/ '@\/pages\/cs-inbox'\)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(lazies, [
    ['cs/inbox', 'scr-045'],
    ['cs/inbox/:caseId', 'scr-045'],
  ]);
});

// F-06-2 리뷰 RV-02 반영(정본 73fa48514, 시험 담당 lane3-f062-test): 배정 풀기는 assignee: null이고 빈 글은 400 invalid-body다(R-T49 ⑦, openapi updateOpsCase assignee)
test('R-T49 ⑦ 화면의 [배정 풀기]는 assignee: null을 보내고 assignee에 빈 글을 보내지 않는다', () => {
  assert.match(connected, /p\.onPatch\(\{ assignee: null \}, '배정을 풀었습니다'\)/);
  assert.doesNotMatch(connected, /assignee: ''/);
});
