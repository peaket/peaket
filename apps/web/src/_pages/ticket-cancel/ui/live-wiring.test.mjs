// SCR-038 실제 화면의 배선 시험(BAT-421, docs/review/plans/BAT-421.md §4·§6).
// 정본: docs/frontend.md §4.1·§4.2.4·§4.3, docs/design/d5-screen-blueprint.md §5.20·§9.2,
// docs/security/asvs/transfer-refund.md v5.0.0-3.2.2·v5.0.0-3.5.3.
// 생성 호출·재인증 토큰·멱등 키·POST만 쓰기·계좌를 저장소/주소/로그에 남기지 않기·미리보기 분기를 소스로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const live = read('./TicketCancelLive.tsx');
const page = read('./TicketCancelPage.tsx');
const reauthReturn = read('../../../shared/lib/reauth-return.ts');
const tickets = read('../../../../../../packages/api-client/src/gen/endpoints/tickets/tickets.ts');

const count = (src, re) => (src.match(re) ?? []).length;
const methodOf = (src, name) => {
  const at = src.indexOf(`export const ${name} = async`);
  assert.ok(at >= 0, `${name} 생성 함수가 없다`);
  const block = src.slice(at, at + 2_000);
  return /\bmethod: '([A-Z]+)'/.exec(block)?.[1];
};

test('SCR038_실제_경로는_생성_호출과_X-Reauth-Token을_쓴다', () => {
  for (const name of ['getTicket', 'getTicketCancellationQuote', 'createTicketCancellation']) {
    assert.match(live, new RegExp(`OPERATIONS\\.${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(live, /client\.send\(OPERATIONS\.createTicketCancellation/);
  assert.match(live, /headers: \{ 'X-Reauth-Token': reauthToken \}/);
  assert.match(live, /idempotencyKey: attempt\.key/);
  assert.match(live, /withFanRefresh\(/);
  assert.match(live, /browserApiClient\(\)/);
  assert.match(live, /fanApiAvailable\(\)/);
  // 실행부는 첫 화면이 아니라 필요할 때 가져온다
  assert.equal(count(live, /import\('@peaket\/api-client'\)/g), 3, 'api-client 늦은 import');
  assert.equal(count(live, /import\('@\/shared\/api'\)/g), 3, 'shared/api 늦은 import');
  // 티켓·견적을 먼저 읽고, 견적의 참·거짓으로 재인증 purpose를 정한다
  assert.ok(live.indexOf('OPERATIONS.getTicket,') < live.indexOf('OPERATIONS.getTicketCancellationQuote'), '티켓을 먼저 읽는다');
  assert.match(live, /setNeedAccount\(qv\.refundAccountRequired\)/);
  assert.match(live, /needAccount \? 'ticket-cancel-refund-account' : reauthPurposeOf\(quote\)/);
});

test('[ASVS v5.0.0-3.5.3] transfer-refund:v5.0.0-3.5.3 SCR038_취소는_POST로만_보낸다', () => {
  assert.equal(methodOf(tickets, 'getTicketCancellationQuote'), 'GET');
  assert.equal(methodOf(tickets, 'createTicketCancellation'), 'POST');
  // 화면이 직접 fetch를 만들지 않는다(재인증 왕복만 같은 출처 앱 서버의 양식·토큰 경로다)
  assert.doesNotMatch(live, /\bfetch\s*\(/);
  assert.match(reauthReturn, /form\.method = 'post'/);
  assert.match(reauthReturn, /fetchImpl\('\/reauth\/token', \{ method: 'POST'/);
  assert.match(live, /submitReauthForm\(provider, `\/my\/tickets\/\$\{encodeURIComponent\(ticketId\)\}\/cancel`, purpose\)/);
  assert.match(live, /pickupReauthToken\(\)/);
  // GET(티켓·견적)으로 상태를 바꾸는 호출을 하지 않는다
  assert.equal(count(live, /OPERATIONS\.createTicketCancellation/g), 1);
  assert.equal(methodOf(tickets, 'getTicket'), 'GET');
});

test('SCR038_계좌_칸은_재인증_뒤에_견적이_필요할_때만_보이고_본문에만_실린다', () => {
  // 계좌 칸은 견적이 필요하고 재인증에서 돌아와 확인하는 중일 때만 그린다(d5 §5.20 ⑤ → ⑦).
  // 재인증 왕복은 전체 페이지 이동이라 미리 적은 계좌가 사라지므로, 돌아온 뒤에 받는다.
  assert.match(live, /\{needAccount && token && awaitingConfirm \? \(\s*<section/);
  assert.equal(count(live, /\{needAccount \? \(\s*<section/g), 0, '재인증 전에 계좌 칸을 그리지 않는다');
  assert.match(live, /needAccount \? '입력한 환불 계좌' : '원결제 수단'/);
  // 은행 목록은 공용 표만 쓰고 화면에 복제하지 않는다
  assert.match(live, /REFUND_BANKS\.map\(\(b\) => \(\{ value: b\.code, label: b\.label \}\)\)/);
  assert.doesNotMatch(live, /신한은행|국민은행|카카오뱅크/);
  // 계좌는 요청 본문에만 실리고, 저장 표시·주소·로그로 내보내지 않는다
  assert.match(live, /refundAccountShape\(body\.refundAccount\)/);
  assert.match(live, /body\.refundAccount = shape\.value/);
  assert.match(live, /writePending\(tabStore, \{ ticketId, key: keyRef\.current \}\)/);
  assert.doesNotMatch(live, /sessionStorage\.setItem\([^)]*(?:account|refund)/i);
  assert.doesNotMatch(live, /\bconsole\.(?:log|info|warn|error)\s*\(/);
  assert.doesNotMatch(live, /location\.(?:search|hash)[^\n]*account/i);
  assert.doesNotMatch(live, /searchParams[^\n]*account/i);
});

test('SCR038_재인증_뒤에만_POST하고_503은_새_재인증을_받는다', () => {
  // 보내는 함수는 토큰을 인자로 받고, 화면에서 부르는 곳은 재인증을 마친 분기 하나뿐이다
  assert.match(live, /async \(reauthToken: string\) =>/);
  assert.match(live, /\{token && awaitingConfirm \? \(\s*<>\s*<p/);
  assert.equal(count(live, /void send\(/g), 1, 'send 호출은 재인증 뒤 한 곳뿐이다');
  assert.match(live, /void send\(token\)/);
  assert.match(live, /if \(r\.kind === 'token'\) \{\s*setToken\(r\.token\);\s*setAwaitingConfirm\(true\);/);
  // 403 reauth-required·503 reauth-unavailable은 토큰만 버리고 새 재인증을 받는다.
  // 같은 본문이므로 멱등 키·본문 지문은 그대로 둔다(처리기가 던지면 키 행이 남지 않는다, RV-04).
  assert.match(live, /setToken\(null\);\s*setAwaitingConfirm\(false\);/);
  assert.doesNotMatch(
    live,
    /if \(mapped\.kind === 'reauth' \|\| mapped\.kind === 'reauth-unavailable'\) \{\s*attemptRef\.current = null;\s*keyRef\.current = null;/,
    '403·503에서 같은 멱등 키를 버리지 않는다',
  );
  // 400은 재인증 앞에서 막히므로 계좌만 고쳐 같은 토큰으로 다시 보낼 수 있다
  assert.match(live, /mapped\.kind === 'account-invalid'/);
  // 재인증으로 떠나기 전 멱등 키를 만들고 표시를 남긴다
  assert.match(live, /keyRef\.current \?\?= crypto\.randomUUID\(\)/);
  assert.match(live, /writePending\(tabStore, \{ ticketId, key: keyRef\.current \}\)/);
});

test('SCR038_202_세_상태와_409_안내를_화면이_쓴다', () => {
  for (const text of ['환급 완료', '환급 보류', '환급 대기', '환급 지연']) {
    assert.ok(live.includes(text), `결과 카드에 '${text}'가 없다`);
  }
  assert.match(live, /result\.kind === 'refunded'/);
  assert.match(live, /result\.kind === 'deferred'/);
  assert.match(live, /result\.kind === 'pending-account'/);
  assert.match(live, /result\.kind === 'pending'/);
  // SCR-060 안내는 pending-account에만
  const notice = live.indexOf('환급할 때 알림으로 계좌를 다시 받습니다');
  assert.ok(live.lastIndexOf("result.kind === 'pending-account'", notice) > 0);
  // 409 안내 링크: 양도 요청 중은 양도 화면, 나머지는 예매 내역
  assert.match(live, /error\.kind === 'transfer' \?/);
  assert.match(live, /href=\{`\/my\/tickets\/\$\{encodeURIComponent\(ticketId\)\}\/transfer`\}/);
  assert.match(live, /error\.kind === 'event-cancelled' \|\| error\.kind === 'conflict' \|\| error\.kind === 'entry-started' \|\| error\.kind === 'not-payer'/);
  assert.match(live, /href="\/my\/tickets"/);
  // 공제율은 서버 비율(0.2)을 퍼센트(20%)로 보인다
  assert.match(live, /Math\.round\(quote\.deductionRate \* 100\)/);
  // 환급 수단은 '원결제 수단'으로만 쓰고 카드 끝 4자리는 그리지 않는다
  assert.match(live, /'원결제 수단'/);
  assert.doesNotMatch(live, /끝 ?\d{4}|카드\(끝/);
});

test('SCR038_미리보기는_?state와_목업_티켓으로_남고_UUID만_실제_화면이다', () => {
  assert.match(page, /const TICKET_ID = \/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\//);
  assert.match(page, /if \(!getTicket\(ticketId\)\) \{/);
  assert.match(page, /if \(!TICKET_ID\.test\(ticketId\)\) notFound\(\);/);
  assert.match(page, /return <TicketCancelLive ticketId=\{ticketId\} \/>;/);
  assert.match(page, /resolvePreviewState\(sp, SCR038_STATES, fallback\)/);
  assert.match(page, /<PreviewSwitcher/);
  assert.match(page, /REFUND_BANKS/);
  // 실제 화면은 목업 좌석·요금 상수를 쓰지 않는다
  assert.doesNotMatch(live, /CANCEL_SEATS|FEE_TABLE|tkt-lumen/);
});
