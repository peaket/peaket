// SCR-038 예매 취소 실제 흐름의 순수 값 시험(BAT-421, docs/review/plans/BAT-421.md §4·§6).
// 정본: docs/design/d5-screen-blueprint.md §5.20·§9.2, docs/frontend.md §4.1·§4.2.4, docs/features/transfer-refund.md §3.1.
// 재인증 purpose·202 세 상태·403/503/422/409 문구·멱등키 규칙·재인증 왕복 표시(계좌 없음)를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorOf, keyForBody, PENDING_KEY, reauthPurposeOf, resultViewOf, sendFailureOf, takePending, writePending } from './cancel-flow.ts';

const PROBLEM = 'https://problems.peaket.example';

test('SCR038_견적의_refundAccountRequired로_purpose를_고른다', () => {
  assert.equal(reauthPurposeOf({ refundAccountRequired: true }), 'ticket-cancel-refund-account');
  assert.equal(reauthPurposeOf({ refundAccountRequired: false }), 'ticket-cancel');
  assert.equal(reauthPurposeOf({}), 'ticket-cancel');
  assert.equal(reauthPurposeOf(null), 'ticket-cancel');
  assert.equal(reauthPurposeOf(undefined), 'ticket-cancel');
  // 값이 아니라 참·거짓으로 정한다. 모르는 값은 '계좌 필요 없음'으로 단정하지 않고 계좌 없는 쪽에 둔다
  assert.equal(reauthPurposeOf({ refundAccountRequired: 'true' }), 'ticket-cancel');
  assert.equal(reauthPurposeOf({ refundAccountRequired: 1 }), 'ticket-cancel');
  // 계좌가 필요한데 계좌 없는 purpose로 보내지 않는다
  assert.notEqual(reauthPurposeOf({ refundAccountRequired: true }), 'ticket-cancel');
});

test('SCR038_202_세_상태를_결과_카드로_가른다', () => {
  const cases = [
    [{ status: 'REFUNDED' }, 'refunded'],
    [{ status: 'REQUESTED' }, 'deferred'],
    [{ status: 'REFUND_PENDING', refundAccountRequired: true }, 'pending-account'],
    [{ status: 'REFUND_PENDING', refundAccountRequired: false }, 'pending'],
    [{ status: 'REFUND_PENDING' }, 'pending'],
    [{ status: 'REFUND_PENDING', refundAccountRequired: 'true' }, 'pending'],
    [{ status: 'UNKNOWN' }, 'pending'],
    [{}, 'pending'],
    [null, 'pending'],
    [undefined, 'pending'],
  ];
  for (const [raw, kind] of cases) assert.equal(resultViewOf(raw), kind, JSON.stringify(raw));
});

test('SCR038_403·503·422·409를_정본_문구로_가른다', () => {
  const cases = [
    [{ status: 403, type: 'reauth-required' }, 'reauth', '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 로그인해 주세요'],
    [{ status: 403, type: 'not-payer' }, 'not-payer', '결제한 분만 취소할 수 있습니다'],
    [{ status: 503, type: 'reauth-unavailable' }, 'reauth-unavailable', '지금은 다시 로그인한 확인을 하지 못했습니다. 잠시 뒤 다시 로그인해 주세요'],
    [{ status: 503, type: 'dependency-unavailable' }, 'dependency', '환급액을 계산하지 못했습니다. 잠시 뒤 다시 시도해 주세요'],
    [{ status: 422, type: 'refund-account-required' }, 'account-required', '환불받을 계좌를 입력해 주세요. 계좌를 넣으면 다시 시도할 수 있습니다'],
    [{ status: 400, type: 'invalid-body' }, 'account-invalid', '은행과 계좌번호, 예금주를 다시 확인해 주세요'],
    [{ status: 409, type: 'transfer-pending' }, 'transfer', '양도 요청을 철회한 뒤 취소할 수 있습니다'],
    [{ status: 409, type: 'entry-started' }, 'entry-started', '공연이 시작되어 취소할 수 없습니다'],
    [{ status: 409, type: 'event-cancelled' }, 'event-cancelled', '회차 취소가 확정되어 공제 없이 일괄 환불합니다. 예매 내역에서 진행 상태를 확인해 주세요'],
    [{ status: 409, type: 'cancellation-conflict' }, 'conflict', '이미 처리 중입니다. 예매 내역에서 확인해 주세요'],
    [{ status: 404, type: 'not-found' }, 'not-found', '찾을 수 없습니다'],
    [{ status: 500, type: 'internal' }, 'other', '취소하지 못했습니다. 잠시 뒤 다시 시도해 주세요'],
  ];
  for (const [problem, kind, text] of cases) {
    assert.deepEqual(errorOf(problem), { kind, text }, `${problem.status} ${problem.type}`);
  }
  // 서버가 문제 type을 주소 전체로 줘도 끝 이름으로 가른다
  assert.equal(errorOf({ status: 409, type: `${PROBLEM}/event-cancelled` }).kind, 'event-cancelled');
  assert.equal(errorOf({ status: 422, type: `${PROBLEM}/refund-account-required` }).kind, 'account-required');
  // 모르는 409는 conflict, 모르는 422는 other로 둔다(계좌 오류로 오해하지 않는다)
  assert.equal(errorOf({ status: 409, type: 'new-conflict' }).kind, 'conflict');
  assert.equal(errorOf({ status: 422, type: 'new-rule' }).kind, 'other');
  // 서버 title·detail은 화면 문구에 섞이지 않는다
  const leaked = errorOf({ status: 422, type: 'refund-account-required', title: '<b>서버 제목</b>', detail: '계좌 110-123-456789' });
  assert.equal(leaked.text.includes('서버 제목'), false);
  assert.equal(leaked.text.includes('110-123'), false);
  assert.equal(leaked.text.includes('<b>'), false);
});

test('SCR038_계좌를_더한_다시_보내기는_새_키다', () => {
  let made = 0;
  const make = () => `key-${++made}`;
  const first = keyForBody(null, {}, make);
  assert.deepEqual(first, { body: '{}', key: 'key-1' });

  const same = keyForBody(first, {}, make);
  assert.equal(same.key, 'key-1', '같은 본문은 같은 키');
  assert.equal(made, 1, '같은 본문에 키를 새로 만들지 않는다');

  const withAccount = { refundAccount: { bankCode: '88', accountNumber: '110123456789', holderName: '김환불' } };
  const changed = keyForBody(first, withAccount, make);
  assert.equal(changed.key, 'key-2', '계좌를 더한 새 본문은 새 키');
  assert.equal(made, 2);

  const again = keyForBody(changed, { ...withAccount }, make);
  assert.equal(again.key, 'key-2', '같은 새 본문의 다시 보내기는 같은 키');
  assert.equal(made, 2);
});

test('SCR038_재인증_왕복_표시에는_계좌가_없다', () => {
  const store = new Map();
  const session = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
  // 계좌를 함께 넘겨도 표시에는 티켓·키만 남는다(재인증 왕복 동안 저장하지 않는다)
  writePending(session, { ticketId: 'tkt-1', key: 'key-1', refundAccount: { bankCode: '88', accountNumber: '110-123-456789', holderName: '김환불' } });
  const raw = store.get(PENDING_KEY);
  assert.equal(typeof raw, 'string');
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['key', 'ticketId']);
  assert.equal(raw.includes('110-123'), false);
  assert.equal(raw.includes('김환불'), false);
  assert.equal(raw.includes('refundAccount'), false);
  assert.deepEqual(takePending(session), { ticketId: 'tkt-1', key: 'key-1' });
  assert.equal(store.has(PENDING_KEY), false, '꺼낸 표시는 지운다');
  assert.equal(takePending(session), null);

  // 모양이 틀린 값은 null이고 늘 지운다
  store.set(PENDING_KEY, '{not json');
  assert.equal(takePending(session), null);
  assert.equal(store.size, 0);
  store.set(PENDING_KEY, JSON.stringify({ ticketId: 't1', key: 'k1', accountNumber: '110-123' }));
  assert.deepEqual(takePending(session), { ticketId: 't1', key: 'k1' });
  assert.equal(store.size, 0);
  store.set(PENDING_KEY, JSON.stringify({ ticketId: '', key: 'k1' }));
  assert.equal(takePending(session), null);

  // 저장소를 못 써도 던지지 않는다
  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.doesNotThrow(() => writePending(broken, { ticketId: 't1', key: 'k1' }));
  assert.equal(takePending(broken), null);
});

test('SCR038_503_reauth-unavailable은_토큰을_버리고_새_재인증을_받는다', () => {
  // 503 reauth-unavailable은 확인기(공개키·jti 저장소)를 못 쓴 것이라 같은 토큰으로 다시 보내지 않는다.
  // 화면이 실제로 쓰는 상태 전이(토큰 폐기·마지막 확인 화면 소멸·멱등 키 유지)를 값으로 직접 단언한다.
  for (const kind of ['reauth-unavailable', 'reauth']) {
    assert.deepEqual(sendFailureOf(kind, 'tok-old'), { token: null, awaitingConfirm: false, resetAttempt: false, needAccount: false }, kind);
  }
  // 422 refund-account-required도 토큰을 버리고 계좌 칸을 연다
  assert.deepEqual(sendFailureOf('account-required', 'tok-old'), { token: null, awaitingConfirm: false, resetAttempt: false, needAccount: true });
  // 400 invalid-body는 재인증 앞에서 막혀 토큰을 쓰지 않았다. 토큰은 지키고 키만 버린다(계좌만 고쳐 같은 토큰으로 다시 보낸다)
  assert.deepEqual(sendFailureOf('account-invalid', 'tok-old'), { token: 'tok-old', awaitingConfirm: true, resetAttempt: true, needAccount: false });
  // 409·404·의존성 오류는 토큰을 버리고, 같은 본문·같은 키로 다시 보낼 수 있게 키는 지킨다(RV-04)
  for (const kind of ['transfer', 'entry-started', 'event-cancelled', 'conflict', 'not-payer', 'not-found', 'dependency', 'other']) {
    const failed = sendFailureOf(kind, 'tok-old');
    assert.equal(failed.token, null, `${kind}: 토큰을 버린다`);
    assert.equal(failed.awaitingConfirm, false, `${kind}: 마지막 확인 화면을 닫는다`);
    assert.equal(failed.resetAttempt, false, `${kind}: 같은 본문은 같은 키로 다시 보낸다`);
  }
  // 토큰이 없던 때도 null로 두고 확인 화면을 열지 않는다
  assert.deepEqual(sendFailureOf('reauth-unavailable', null), { token: null, awaitingConfirm: false, resetAttempt: false, needAccount: false });
});

test('SCR038_5xx_오류는_문의용_traceId만_보인다', () => {
  // G3: 5xx는 서버 title·detail 대신 문의용 traceId만 그린다(frontend §4.1 '오류 모양')
  const reauth = errorOf({ status: 503, type: 'reauth-unavailable', traceId: 'trc-503', title: '서버 제목', detail: '서버 설명' });
  assert.equal(reauth.kind, 'reauth-unavailable');
  assert.equal(reauth.traceId, 'trc-503');
  assert.equal(reauth.text.includes('trc-503'), false, '본문 문구에 섞지 않는다');
  assert.equal(reauth.text.includes('서버 제목'), false);
  assert.equal(reauth.text.includes('서버 설명'), false);
  assert.equal(errorOf({ status: 503, type: 'dependency-unavailable', traceId: 'trc-dep' }).traceId, 'trc-dep');
  const internal = errorOf({ status: 500, type: `${PROBLEM}/internal`, traceId: 'trc-500' });
  assert.equal(internal.kind, 'other');
  assert.equal(internal.traceId, 'trc-500');
  // 4xx에는 traceId를 붙이지 않는다(문의용 번호는 서버 오류에만)
  for (const problem of [
    { status: 403, type: 'reauth-required', traceId: 'trc-403' },
    { status: 409, type: 'transfer-pending', traceId: 'trc-409' },
    { status: 422, type: 'refund-account-required', traceId: 'trc-422' },
    { status: 400, type: 'invalid-body', traceId: 'trc-400' },
  ]) {
    assert.equal(errorOf(problem).traceId, undefined, `${problem.status} ${problem.type}`);
  }
  // 모양이 틀린 값은 버린다
  for (const traceId of ['', 7, null, undefined, {}, ['trc']]) {
    assert.equal(errorOf({ status: 503, type: 'dependency-unavailable', traceId }).traceId, undefined, JSON.stringify(traceId));
  }
});
