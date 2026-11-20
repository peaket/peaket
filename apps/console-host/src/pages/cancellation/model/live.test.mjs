// SCR-047 회차 취소 판정·미리보기·진행률의 순수 값 시험(BAT-421, docs/review/plans/BAT-421.md §4·§6).
// 정본: docs/design/d5-screen-blueprint.md §7.8, docs/features/payment.md §6, docs/features/transfer-refund.md §5,
// docs/security/asvs/transfer-refund.md v5.0.0-3.2.2.
// dryRun(열린 객체) 디코더·진행률 done/total·accountPending 따로·409/403 문구·내부 값 미표시를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailView, errorOf, pauseReasonText, percentOf, previewOf, progressOf, stateLabel } from './live.ts';

const DRY_RUN = {
  targetOrders: 1152,
  refundTotal: 34_650_000,
  compensationTargets: 98,
  compensationTotal: 3_465_000,
  perPg: [
    { pg: 'TOSS', orders: 800, estimatedSeconds: 420, secret: '내부' },
    { pg: 'PORTONE', orders: 352, estimatedSeconds: 180 },
  ],
  secret: '내부 값',
  nested: { deep: true },
};

test('SCR047_미리보기의_다섯_값과_결제사별_몫을_해석한다', () => {
  const p = previewOf(DRY_RUN);
  assert.deepEqual(p, {
    targetOrders: 1152,
    refundTotal: 34_650_000,
    compensationTargets: 98,
    compensationTotal: 3_465_000,
    perPg: [
      { pg: 'TOSS', orders: 800, estimatedSeconds: 420 },
      { pg: 'PORTONE', orders: 352, estimatedSeconds: 180 },
    ],
  });
  assert.deepEqual(Object.keys(p).sort(), ['compensationTargets', 'compensationTotal', 'perPg', 'refundTotal', 'targetOrders']);
  // 모르는 키는 미리보기 값에 남지 않는다(JSON 전체를 그리지 않는다)
  assert.equal('secret' in p, false);
  assert.equal('nested' in p, false);
  assert.equal('secret' in p.perPg[0], false);
  assert.deepEqual(Object.keys(p.perPg[0]).sort(), ['estimatedSeconds', 'orders', 'pg']);

  // 모양이 틀리면 부분 값을 그리지 않고 null이다
  assert.equal(previewOf(null), null);
  assert.equal(previewOf('x'), null);
  assert.equal(previewOf({ ...DRY_RUN, perPg: undefined }), null, 'perPg가 없으면 미리보기 없음');
  assert.equal(previewOf({ ...DRY_RUN, targetOrders: '1152' }), null, '숫자가 아닌 대상 주문');
  assert.equal(previewOf({ ...DRY_RUN, refundTotal: -1 }), null, '음수 금액');
  assert.equal(previewOf({ ...DRY_RUN, perPg: [{ pg: 'TOSS', orders: 800 }] }), null, '결제사 몫이 모자람');
  assert.equal(previewOf({ ...DRY_RUN, perPg: [{ pg: 'TOSS', orders: 1, estimatedSeconds: '420' }] }), null, '문자열 소요 시간');
  assert.equal(previewOf({ ...DRY_RUN, perPg: [{ pg: '', orders: 1, estimatedSeconds: 1 }] }), null, '빈 결제사 이름');
});

test('SCR047_퍼센트는_done나누기_total이고_계좌_대기는_따로_센다', () => {
  assert.equal(percentOf({ done: 737, total: 1152 }), 63);
  // failed를 분자에 넣지 않는다(넣으면 99가 된다)
  assert.equal(percentOf({ done: 737, total: 1152, failed: 403, accountPending: 2 }), 63);
  assert.equal(percentOf({ done: 0, total: 10, failed: 10, accountPending: 0 }), 0);
  assert.equal(percentOf({ done: 10, total: 10 }), 100);
  assert.equal(percentOf({ done: 2000, total: 1000 }), 100);
  assert.equal(percentOf({ done: 0, total: 0 }), 0, '0으로 나누지 않는다');
  assert.equal(percentOf(null), 0);

  const progress = progressOf({
    total: 1152,
    done: 737,
    failed: 403,
    accountPending: 12,
    perPg: [
      { pg: 'TOSS', state: 'RUNNING', pauseReason: null, done: 500, failed: 200, unknown: 1, secret: 1 },
      { pg: 'PORTONE', state: 'PAUSED', pauseReason: 'AUTO_FAILURE_RATE', done: 237, failed: 203, unknown: 0 },
      'not-an-object',
      { pg: '', done: 1 },
    ],
    unknown: 'x',
  });
  assert.deepEqual(progress, {
    total: 1152,
    done: 737,
    failed: 403,
    accountPending: 12,
    perPg: [
      { pg: 'TOSS', state: 'RUNNING', pauseReason: null, done: 500, failed: 200, unknown: 1 },
      { pg: 'PORTONE', state: 'PAUSED', pauseReason: 'AUTO_FAILURE_RATE', done: 237, failed: 203, unknown: 0 },
    ],
  });
  assert.deepEqual(Object.keys(progress).sort(), ['accountPending', 'done', 'failed', 'perPg', 'total']);
  // 완료 판정은 done+failed+accountPending = total이다(화면이 이 셋을 그대로 쓴다)
  assert.equal(progress.done + progress.failed + progress.accountPending, progress.total);
  // 계좌 대기 2건도 따로 센다(퍼센트 분자에는 넣지 않는다)
  const withTwo = progressOf({ total: 10, done: 7, failed: 1, accountPending: 2 });
  assert.equal(withTwo.accountPending, 2);
  assert.equal(withTwo.done + withTwo.failed + withTwo.accountPending, withTwo.total);

  // accountPending이 없는 옛 응답은 0이고, 모양이 틀리면 진행률 없음이다
  assert.equal(progressOf({ total: 10, done: 5, failed: 5 }).accountPending, 0);
  assert.equal(progressOf({ total: 10, done: 5, failed: 5, accountPending: '2' }), null);
  assert.equal(progressOf({ total: 10, done: 5 }), null);
  assert.equal(progressOf(null), null);
});

test('SCR047_409_셋과_403_판정자_본인을_가른다', () => {
  const cases = [
    [{ status: 409, type: 'judgement-required' }, 'judgement-required', '아직 판정하지 않았습니다. 귀책을 판정한 뒤 확정할 수 있습니다'],
    [{ status: 409, type: 'preview-required' }, 'preview-required', '미리보기가 없습니다. 다시 판정해 미리보기를 만든 뒤 확정해 주세요'],
    [{ status: 409, type: 'already-approved' }, 'already-approved', '이미 확정된 요청입니다'],
    [{ status: 403, type: 'approver-ineligible' }, 'approver-ineligible', '판정한 분은 두 번째 승인을 할 수 없습니다'],
    [{ status: 503, type: 'sale-stop-unavailable' }, 'sale-stop-unavailable', '판매를 멈추지 못해 확정하지 않았습니다. 잠시 뒤 다시 시도해 주세요'],
    [{ status: 503, type: 'event-refund-unavailable' }, 'event-refund-unavailable', '일괄 환불을 시작하지 못했습니다. 잠시 뒤 다시 시도해 주세요'],
    [{ status: 403, type: 'reauth-required' }, 'reauth', '다시 인증해야 합니다. 비밀번호·인증 앱 코드와 패스키로 확인해 주세요'],
    [{ status: 503, type: 'reauth-unavailable' }, 'reauth-unavailable', '지금은 다시 로그인한 확인을 하지 못했습니다. 잠시 뒤 다시 로그인해 주세요'],
    [{ status: 403, type: 'rejection-not-allowed' }, 'rejection-not-allowed', '판정 전 반려는 commander만 할 수 있습니다'],
    [{ status: 400, type: 'invalid-body' }, 'invalid-body', '판정 내용을 다시 확인해 주세요. 팬 통지 사유는 꼭 적어야 합니다'],
    [{ status: 404, type: 'not-found' }, 'not-found', '찾을 수 없습니다'],
    [{ status: 403, type: 'role' }, 'forbidden', '이 작업을 할 권한이 없습니다'],
    [{ status: 409, type: 'new-state' }, 'conflict', '지금 상태에서는 할 수 없습니다. 새로 고친 뒤 다시 시도해 주세요'],
    [{ status: 500, type: 'internal' }, 'other', '처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요'],
  ];
  for (const [problem, kind, text] of cases) {
    assert.deepEqual(errorOf(problem), { kind, text }, `${problem.status} ${problem.type}`);
  }
  assert.equal(errorOf({ status: 409, type: 'https://problems.peaket.example/preview-required' }).kind, 'preview-required');
  const leaked = errorOf({ status: 409, type: 'judgement-required', title: '<b>서버</b>', detail: '계좌 110-123' });
  assert.equal(leaked.text.includes('<b>'), false);
  assert.equal(leaked.text.includes('110-123'), false);
});

test('SCR047_상태_아홉과_멈춤_사유를_글로_가른다', () => {
  const labels = [
    ['REQUESTED', '판정 대기'],
    ['JUDGED', '재판정 대기'],
    ['PENDING_APPROVAL', '확정 대기'],
    ['APPROVED', '확정'],
    ['RUNNING', '진행 중'],
    ['PAUSED', '일시정지'],
    ['REFUND_WINDOW', '환급 신청 기간'],
    ['COMPLETED', '완료'],
    ['REJECTED', '반려'],
  ];
  for (const [status, label] of labels) assert.equal(stateLabel(status), label, status);
  assert.equal(stateLabel('NEW_STATE'), '알 수 없음');
  for (const [code, text] of [
    ['AUTO_FAILURE_RATE', '1분 취소 실패율이 기준을 넘었습니다'],
    ['AUTO_FAILED_AMOUNT', '실패 금액이 기준을 넘었습니다'],
    ['AUTO_CONSECUTIVE_FAILURES', '연속 실패가 기준을 넘었습니다'],
    ['AUTO_CIRCUIT_OPEN', '결제사 차단기가 열렸습니다'],
    ['AUTO_REJECT_RATE', '취소 거절이 많아 작업 전체를 멈췄습니다'],
    ['MANUAL', '운영자가 멈췄습니다'],
  ]) {
    assert.equal(pauseReasonText(code), text, code);
  }
  assert.equal(pauseReasonText(null), '멈춘 사유를 알 수 없습니다');
  assert.equal(pauseReasonText('NEW'), '멈춘 사유를 알 수 없습니다');
});

test('[ASVS v5.0.0-3.2.2] transfer-refund:v5.0.0-3.2.2 SCR047_파트너_사유·판정_사유·미리보기_숫자는_텍스트로만_그린다', () => {
  // 이 모양은 openapi EventCancellationRequest이고, ops-svc가 실제 HTTP로 이 칸들을 답하는지는
  // services/ops-svc/test/partner-event-cancellation-http.test.ts 'RV-01'이 실제 응답으로 확인한다(흉내 낸 fixture가 아니다).
  const raw = {
    requestId: 'req-1',
    eventId: 'evt-1',
    title: '10/26 회차',
    kind: 'POSTPONE',
    status: 'PENDING_APPROVAL',
    fault: 'ORGANIZER',
    fanNoticeReason: '<img src=x onerror=alert(1)>',
    partnerReason: '<script>alert(1)</script>',
    faultOpinion: 'FORCE_MAJEURE',
    evidenceRef: 's3://bucket/evidence.pdf',
    newStartsAt: '2026-10-31T09:00:00.000Z',
    requestedAt: '2026-10-26T09:00:00.000Z',
    judgedBy: { displayName: '수진', adminAccountId: 'adm-1', email: 'secret@example.com' },
    dryRun: DRY_RUN,
    progress: { total: 10, done: 5, failed: 3, accountPending: 2 },
    secret: '내부 값',
  };
  const d = detailView(raw);
  assert.deepEqual(Object.keys(d).sort(), [
    'dryRun',
    'eventId',
    'evidenceRef',
    'fanNoticeReason',
    'fault',
    'faultOpinion',
    'judgedBy',
    'judgedById',
    'kind',
    'newStartsAt',
    'partnerReason',
    'progress',
    'requestId',
    'requestedAt',
    'status',
    'title',
  ]);
  assert.equal('secret' in d, false);
  // 서버 글은 해석하지 않고 그대로 둔다(화면이 React 텍스트 노드로 그린다)
  assert.equal(d.fanNoticeReason, '<img src=x onerror=alert(1)>');
  assert.equal(d.partnerReason, '<script>alert(1)</script>');
  // 판정자는 표시 이름과 계정 ID만 옮기고 이메일 같은 다른 칸은 버린다
  assert.equal(d.judgedBy, '수진');
  assert.equal(d.judgedById, 'adm-1');
  assert.equal(JSON.stringify(d).includes('secret@example.com'), false);
  // 미리보기는 해석된 값만 담고 모르는 키를 버린다
  assert.equal(JSON.stringify(d.dryRun).includes('내부 값'), false);
  assert.equal('secret' in d.dryRun, false);
  // 모양이 틀린 값은 화면 값으로 올리지 않는다
  assert.equal(detailView({ dryRun: { targetOrders: '1' }, progress: { total: '10' } }).dryRun, null);
  assert.equal(detailView({ dryRun: { targetOrders: '1' }, progress: { total: '10' } }).progress, null);
  assert.equal(detailView({ judgedBy: { adminAccountId: 'adm-1' } }).judgedBy, '삭제된 계정');
  assert.equal(detailView({ kind: 'OTHER' }).kind, null);
  assert.equal(detailView({ fault: 'OTHER' }).fault, null);
});
