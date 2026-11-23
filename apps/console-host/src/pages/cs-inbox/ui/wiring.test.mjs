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

// F-06-7 GAT-280(시험 담당 lane3-f067-test): 이의 심사 패널이 넷째 생성 호출(createOpsCaseVerificationAppealDecision)을 더한다(계획 §4 화면, B-T28 ⑦)
test('R-T51 ② B-T28 ⑦ 화면은 생성 호출 넷(목록·상세·갱신·이의 결정)과 세션 읽기만 쓰고 fetch를 만들지 않는다', () => {
  assert.equal(methodOf('listOpsCases'), 'GET');
  assert.equal(methodOf('getOpsCase'), 'GET');
  assert.equal(methodOf('updateOpsCase'), 'PATCH');
  assert.match(operations, /updateOpsCase: \{[^}]*method: "PATCH",path: "\/v1\/ops\/cases\/\{caseId\}"[^}]*ifMatch: true/);
  const used = [...connected.matchAll(/const \{ (\w+) \} = await ops\(\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(used, ['createOpsCaseVerificationAppealDecision', 'getMyOpsAuthSession', 'getOpsCase', 'listOpsCases', 'updateOpsCase']);
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

// F-06-7 GAT-280 B-T28 ⑦(시험 담당 lane3-f067-test): SCR-045 이의 심사 패널의 배선. 서버와 실제로 주고받는 흐름은 services/ops-svc/test/cs-inbox-screen-link.test.ts가 본다.
// 정본: openapi createOpsCaseVerificationAppealDecision(POST, If-Match·Idempotency-Key), docs/design/d5-screen-blueprint.md §7.6 '이의 결정 확인'·'이의 결정 처리 중' 글,
// 계획 docs/review/plans/F-06-7.md §4 화면(생성 호출 한 곳, 대화상자 role="dialog"·aria-modal·처음 초점 [취소]·Esc 취소, 키는 대화상자를 열 때 crypto.randomUUID(),
// 패널은 appealPanelOf 값으로만 그리고 결정 처리기는 202 뒤 상세를 다시 읽는다)와 §11 ⑦(처리기 몸을 잘라 본다). 패널 값 자체는 model/live.test.mjs가 값마다 본다.
// 시험 리뷰 1 TR-01 반영: 파일 전체의 글자 수가 아니라 결정 처리기 몸(결정 호출을 담은 함수)을 잘라 그 안의 차례를 본다.
const decisionHandler = () => {
  const call = connected.indexOf('createOpsCaseVerificationAppealDecision(');
  assert.ok(call > 0, '결정 생성 함수를 부르는 곳이 없다');
  const starts = [...connected.slice(0, call).matchAll(/const \w+ = (?:useCallback\()?async\b/g)];
  assert.ok(starts.length > 0, '결정 호출을 담은 처리기(const … = async)가 없다');
  const from = starts.at(-1).index;
  const tail = connected.slice(call);
  const close = tail.search(/\n  \}(?:, \[[^\]]*\]\))?;\n/);
  return { body: connected.slice(from, close > 0 ? call + close : call + 2_000), at: call - from };
};

test('B-T28 ⑦ 이의 결정은 생성 함수 하나(POST …/verification-appeal-decision, 멱등·If-Match)로 한 곳에서만 보내고 If-Match·Idempotency-Key를 싣는다', () => {
  assert.equal(methodOf('createOpsCaseVerificationAppealDecision'), 'POST');
  assert.match(operations, /createOpsCaseVerificationAppealDecision: \{[^}]*method: "POST",path: "\/v1\/ops\/cases\/\{caseId\}\/verification-appeal-decision"[^}]*idempotent: true[^}]*ifMatch: true/);
  assert.equal(count(connected, /createOpsCaseVerificationAppealDecision\(/g), 1);
  const at = connected.indexOf('createOpsCaseVerificationAppealDecision(');
  const call = connected.slice(at, at + 400);
  assert.match(call, /'If-Match': ifMatchOf\(/);
  assert.match(call, /'Idempotency-Key': /);
  assert.match(connected, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(connected, /\bfetch\s*\(/);
});

test('B-T28 ⑦ 결정 처리기: 빈 메모면 보내기 전에 오류 요약으로 가고, 보낸 뒤 decisionKeyAfter로 키를 정하며 상세를 다시 읽는다', () => {
  const { body, at } = decisionHandler();
  const before = body.slice(0, at);
  const after = body.slice(at);
  assert.match(before, /\.trim\(\) === ''/, '처리기 안에서 메모를 보내기 전에 본다');
  assert.match(before, /showNoteError\('결과 메모를 적어 주세요'\)/);
  assert.ok(before.lastIndexOf("showNoteError('결과 메모를 적어 주세요')") > before.search(/\.trim\(\) === ''/), '빈 메모면 오류 요약을 띄운다');
  assert.match(body, /decisionKeyAfter\(/, '결정 시도 뒤 키를 decisionKeyAfter로 정한다');
  assert.match(after, /loadDetail\(|getOpsCase\(/, '202 뒤 상세를 다시 읽는다');
});

test('B-T28 ⑦ 패널은 appealPanelOf 값으로 그리고(칸·글·호출 줄·배너), 결정 확인은 d5 §7.6 대화상자다', () => {
  assert.match(connected, /appealPanelOf\(/);
  assert.match(connected, /verificationAppealOf\(/);
  for (const prop of ['fields', 'contentNotice', 'evidenceNotice', 'rows', 'banner', 'canDecide']) assert.match(connected, new RegExp(`\\.${prop}\\b`), prop);
  // 패널 글은 model이 만든다(화면 파일에 안내 글을 따로 두지 않는다)
  for (const text of ['판정 근거가 남아 있지 않아 사유 범주로만 판단합니다', '다시 보내도 같은 답이라 멈췄습니다. 관제에 알려 주세요']) {
    assert.ok(model.includes(text), `live.ts: ${text}`);
    assert.equal(connected.includes(text), false, `ConnectedPage가 글을 따로 둔다: ${text}`);
  }
  for (const text of [
    '이의 인정',
    '이의 기각',
    '이의를 인정할까요? 대기 순번이 돌아가고 사람 라벨이 남습니다. 판정 근거가 차단 기기 목록이면 그 기기를 목록에서 지웁니다',
    '이의를 기각할까요? 이 대기 참여가 끝납니다. 계정 제재는 아닙니다',
  ]) assert.ok(connected.includes(text), text);
  assert.match(connected, /role="dialog"/);
  assert.match(connected, /aria-modal/);
  assert.match(connected, /'Escape'/);
  // 409 처리 중은 대화상자 안 안내와 [다시 불러오기]이고 같은 키를 지킨다(d5 §7.6 '이의 결정 처리 중')
  assert.match(connected, /'in-progress'/);
});
