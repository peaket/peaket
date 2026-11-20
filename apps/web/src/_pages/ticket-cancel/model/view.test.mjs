// SCR-038 견적·결과 해석과 서버 글의 텍스트 처리 시험(BAT-421, docs/review/plans/BAT-421.md §4·§6).
// 정본: docs/design/d5-screen-blueprint.md §5.20·§9.2, docs/security/asvs/transfer-refund.md v5.0.0-3.2.2.
// 모르는 칸·모양 틀린 값은 화면 값으로 옮기지 않고, 서버 title·detail은 화면 문구에 섞지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { errorOf } from './cancel-flow.ts';
import { quoteView, resultView, resultViewOf, refundMethodText } from './view.ts';

const live = readFileSync(new URL('../ui/TicketCancelLive.tsx', import.meta.url), 'utf8');
const viewSource = readFileSync(new URL('./view.ts', import.meta.url), 'utf8');
const flowSource = readFileSync(new URL('./cancel-flow.ts', import.meta.url), 'utf8');

test('RV-09 결과 판정과 재인증 503 문구는 한 곳에만 둔다', () => {
  // 결과 판정은 cancel-flow.ts 한 벌만 두고 view.ts가 가져다 쓴다
  assert.match(viewSource, /import \{ resultViewOf, type CancelResultKind \} from '\.\/cancel-flow\.ts'/);
  assert.equal((viewSource.match(/export function resultViewOf/g) ?? []).length, 0, 'view.ts에 결과 판정을 복제하지 않는다');
  // 503 문구는 공용 reauth-failure.ts의 REAUTH_UNAVAILABLE만 쓴다
  assert.match(flowSource, /import \{ REAUTH_UNAVAILABLE \} from '\.\.\/\.\.\/\.\.\/shared\/lib\/reauth-failure\.ts'/);
  assert.equal((flowSource.match(/지금은 다시 로그인한 확인을 하지 못했습니다/g) ?? []).length, 0, '문구를 복제하지 않는다');
});

test('SCR038_견적_응답은_아는_칸만_옮기고_모양_틀린_값은_버린다', () => {
  const raw = {
    ticketId: 'tkt-1',
    daysBefore: 5,
    within24h: false,
    deductionRate: 0.2,
    basis: '공연 5일 전',
    ticketPrice: 154000,
    deductionAmount: 30800,
    refundAmount: 123200,
    refundAfterEntryClose: false,
    refundAccountRequired: false,
    title: '<b>서버 제목</b>',
    detail: '계좌 110-123-456789',
    unknown: { nested: true },
  };
  const q = quoteView(raw);
  assert.deepEqual(Object.keys(q).sort(), [
    'basis',
    'daysBefore',
    'deductionAmount',
    'deductionRate',
    'refundAccountRequired',
    'refundAfterEntryClose',
    'refundAmount',
    'ticketId',
    'ticketPrice',
    'within24h',
  ]);
  assert.equal(q.deductionRate, 0.2);
  assert.equal(q.refundAccountRequired, false);
  assert.equal(q.refundAfterEntryClose, false);
  // 모르는 칸은 담기지 않는다
  assert.equal('title' in q, false);
  assert.equal('detail' in q, false);
  assert.equal('unknown' in q, false);

  const bad = quoteView({ ticketId: 7, daysBefore: -1, deductionRate: '0.2', ticketPrice: 1.5, deductionAmount: Number.NaN, refundAmount: -1, refundAccountRequired: 'true', refundAfterEntryClose: 1 });
  assert.equal(bad.ticketId, '');
  assert.equal(bad.daysBefore, 0);
  assert.equal(bad.deductionRate, 0);
  assert.equal(bad.ticketPrice, 0);
  assert.equal(bad.deductionAmount, 0);
  assert.equal(bad.refundAmount, 0);
  assert.equal(bad.refundAccountRequired, false, '모르는 값을 계좌 필요로 그리지 않는다');
  assert.equal(bad.refundAfterEntryClose, false);

  const empty = quoteView(null);
  assert.equal(empty.ticketId, '');
  assert.equal(empty.refundAccountRequired, false);
});

test('SCR038_202_결과는_아는_칸만_옮기고_모르는_상태는_쉬게_둔다', () => {
  const raw = {
    cancellationId: 'cnl-1',
    status: 'REFUND_PENDING',
    refundAmount: 123200,
    refundAccountRequired: true,
    title: '서버 제목',
    detail: '서버 설명',
    dryRun: { secret: true },
  };
  const v = resultView(raw);
  assert.deepEqual(v, { kind: 'pending-account', cancellationId: 'cnl-1', refundAmount: 123200, refundAccountRequired: true });
  assert.deepEqual(Object.keys(v).sort(), ['cancellationId', 'kind', 'refundAccountRequired', 'refundAmount']);
  assert.equal('title' in v, false);
  assert.equal('detail' in v, false);
  assert.equal('dryRun' in v, false);

  assert.equal(resultView({ status: 'REFUNDED', cancellationId: 1, refundAmount: -5 }).kind, 'refunded');
  assert.equal(resultView({ status: 'REFUNDED', cancellationId: 1 }).cancellationId, '');
  assert.equal(resultView({ status: 'REFUNDED', refundAmount: -5 }).refundAmount, 0);
  assert.equal(resultViewOf({ status: 'REFUND_PENDING', refundAccountRequired: true }), 'pending-account');
  assert.equal(resultViewOf({ status: 'REFUND_PENDING', refundAccountRequired: false }), 'pending');
  assert.equal(resultViewOf({ status: 'UNKNOWN' }), 'pending');
});

test('RV-13_환급_수단은_계좌를_입력하기_전에는_입력한_계좌로_쓰지_않는다', () => {
  // 견적 ③은 계좌를 받기 전이다. 참·거짓만으로 '입력한' 계좌라고 쓰면 거짓말이 된다(d5 §5.20 ③·⑤→⑦).
  assert.equal(refundMethodText(true, false), '환불 계좌(다시 로그인한 뒤 입력)');
  assert.equal(refundMethodText(true, true), '입력한 환불 계좌');
  assert.equal(refundMethodText(false, false), '원결제 수단');
  assert.equal(refundMethodText(false, true), '원결제 수단');
  // 화면은 이 한 벌을 쓰고, 계좌 입력 여부를 따로 판정한다
  assert.match(
    readFileSync(new URL('../ui/TicketCancelLive.tsx', import.meta.url), 'utf8'),
    /refundMethodText\(needAccount, accountReady\)/,
  );
  assert.doesNotMatch(
    readFileSync(new URL('../ui/TicketCancelLive.tsx', import.meta.url), 'utf8'),
    /needAccount \? '입력한 환불 계좌' : '원결제 수단'/,
  );
});

test('[ASVS v5.0.0-3.2.2] transfer-refund:v5.0.0-3.2.2 SCR038_견적·결과·오류는_서버_글을_텍스트로만_그린다', () => {
  // 모델은 서버 글을 해석하지 않고 글자 그대로 옮긴다(화면이 React 텍스트 노드로 그린다)
  const q = quoteView({ basis: '<img src=x onerror=alert(1)>', refundAccountRequired: false });
  assert.equal(q.basis, '<img src=x onerror=alert(1)>');
  assert.equal(q.refundAccountRequired, false);

  // 서버 title·detail은 화면 문구로 새지 않는다
  const mapped = errorOf({ status: 409, type: 'transfer-pending', title: '<script>alert(1)</script>', detail: '계좌 110-123-456789' });
  assert.equal(mapped.text.includes('<script>'), false);
  assert.equal(mapped.text.includes('110-123'), false);

  // 실제 화면은 HTML로 해석하는 길을 쓰지 않는다
  assert.doesNotMatch(live, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(live, /\.innerHTML\b/);
  assert.doesNotMatch(live, /\b(?:e|err|problem)\.(?:title|detail)\b/);
  // 사용자가 쓴 계좌는 화면 상태·요청 본문에만 있고 저장소로 넘기지 않는다
  assert.match(live, /writePending\(tabStore, \{ ticketId, key: keyRef\.current \}\)/);
  assert.doesNotMatch(live, /sessionStorage\.setItem\([^)]*(?:account|refund)/i);
  // 결과 카드의 SCR-060 안내는 계좌가 필요한 202에만 붙는다
  const notice = live.indexOf('환급할 때 알림으로 계좌를 다시 받습니다');
  assert.ok(notice > 0, 'SCR-060 안내 문구가 없다');
  assert.ok(live.lastIndexOf("result.kind === 'pending-account'", notice) > 0, '안내 문구가 pending-account 분기 밖에 있다');
});
