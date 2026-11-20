// SCR-044 회차 취소·연기 요청의 순수 값 시험(BAT-421, docs/review/plans/BAT-421.md §4·§6).
// 정본: docs/design/d5-screen-blueprint.md §6.12, docs/features/transfer-refund.md §5,
// docs/security/asvs/transfer-refund.md v5.0.0-3.2.2.
// 폼 검사·KST→ISO·상태 이름 아홉·진행률 합계·오류 문구·내부 값 미표시를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorOf, kstLocalToIso, statusView, validateRequest } from './live.ts';

const CURRENT = Date.parse('2026-10-26T08:00:00.000Z'); // 2026-10-26 17:00 KST
const base = { kind: 'POSTPONE', newStartsAtLocal: '2026-10-31T18:00', reason: '공연장 사정', evidenceRef: '', faultOpinion: 'NONE' };

test('SCR044_연기_일시는_KST를_ISO로_바꾸고_지금_시작보다_이르면_막는다', () => {
  assert.equal(kstLocalToIso('2026-10-31T18:00'), '2026-10-31T09:00:00.000Z');
  assert.equal(kstLocalToIso('2026-10-31 18:00'), '2026-10-31T09:00:00.000Z');
  for (const bad of ['', '2026-10-31', '2026-10-31T18:00:00', '2026-13-01T10:00', '2026-02-30T18:00', '2026-10-31T24:00', '2026-10-31T18:60', 'not-a-date']) {
    assert.equal(kstLocalToIso(bad), null, bad);
  }

  const ok = validateRequest(base, CURRENT);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.body, { kind: 'POSTPONE', newStartsAt: '2026-10-31T09:00:00.000Z', reason: '공연장 사정' });
    assert.equal('faultOpinion' in ok.body, false, '의견 없음은 싣지 않는다');
  }

  // 같은 순간·이른 순간·빈 값은 칸 오류다
  for (const [what, at] of [
    ['같은 값', '2026-10-26T17:00'],
    ['이른 값', '2026-10-26T16:59'],
    ['빈 값', ''],
  ]) {
    const r = validateRequest({ ...base, newStartsAtLocal: at }, CURRENT);
    assert.equal(r.ok, false, what);
    if (!r.ok) {
      assert.equal(r.field, 'newStartsAt', what);
      assert.match(r.message, /바뀐 일시/, what);
    }
  }

  // 취소에는 바뀐 일시를 싣지 않는다(폼에 남아 있어도)
  const cancel = validateRequest({ ...base, kind: 'CANCEL', newStartsAtLocal: '2026-11-30T18:00' }, CURRENT);
  assert.equal(cancel.ok, true);
  if (cancel.ok) {
    assert.equal(cancel.body.kind, 'CANCEL');
    assert.equal('newStartsAt' in cancel.body, false);
  }

  // 사유 1~1,000자, 증빙 참조 1~200자 [가정]
  assert.equal(validateRequest({ ...base, reason: '가' }, CURRENT).ok, true);
  assert.equal(validateRequest({ ...base, reason: '가'.repeat(1000) }, CURRENT).ok, true);
  for (const [what, reason] of [
    ['사유 없음', '   '],
    ['사유 1,001자', '가'.repeat(1001)],
  ]) {
    const r = validateRequest({ ...base, reason }, CURRENT);
    assert.equal(r.ok, false, what);
    if (!r.ok) assert.equal(r.field, 'reason', what);
  }
  assert.equal(validateRequest({ ...base, evidenceRef: '증빙-'.repeat(40) }, CURRENT).ok, true, '증빙 200자');
  const longEvidence = validateRequest({ ...base, evidenceRef: '가'.repeat(201) }, CURRENT);
  assert.equal(longEvidence.ok, false);
  if (!longEvidence.ok) assert.equal(longEvidence.field, 'evidenceRef');

  // 한국어 귀책 의견은 API 열거값으로 바꾸고, 모르는 값은 싣지 않는다
  const organizer = validateRequest({ ...base, faultOpinion: '주최 측 귀책' }, CURRENT);
  assert.equal(organizer.ok, true);
  if (organizer.ok) assert.equal(organizer.body.faultOpinion, 'ORGANIZER');
  const force = validateRequest({ ...base, faultOpinion: '불가항력' }, CURRENT);
  assert.equal(force.ok, true);
  if (force.ok) assert.equal(force.body.faultOpinion, 'FORCE_MAJEURE');
  const unknown = validateRequest({ ...base, faultOpinion: '모름' }, CURRENT);
  assert.equal(unknown.ok, true);
  if (unknown.ok) assert.equal('faultOpinion' in unknown.body, false);
});

test('SCR044_상태_아홉을_d5_이름으로_가른다', () => {
  const cases = [
    ['REQUESTED', '판정 대기', 'primary'],
    ['JUDGED', '재판정 대기', 'primary'],
    ['PENDING_APPROVAL', '확정 대기(2인 승인)', 'primary'],
    ['APPROVED', '확정', 'success'],
    ['RUNNING', '확정 · 환불 진행 중', 'success'],
    ['PAUSED', '일시정지', 'warning'],
    ['REFUND_WINDOW', '연기 확정 · 환급 신청 기간', 'warning'],
    ['COMPLETED', '완료', 'success'],
    ['REJECTED', '반려', 'danger'],
  ];
  for (const [status, label, tone] of cases) {
    const v = statusView({ status });
    assert.equal(v.label.startsWith(label), true, `${status}: ${v.label}`);
    assert.equal(v.tone, tone, status);
    assert.equal(v.progress, null, status);
    // 파트너 응답에 없는 미리보기·결제사별 몫·판정자는 화면 값에 없다
    assert.deepEqual(Object.keys(v).sort(), ['dueText', 'label', 'progress', 'tone'], status);
  }
  assert.equal(statusView({ status: 'PAUSED', pausedBy: 'AUTOMATIC' }).label, '일시정지(자동)');
  assert.equal(statusView({ status: 'PAUSED', pausedBy: 'OPERATOR' }).label, '일시정지(운영자)');
  assert.equal(statusView({ status: 'REQUESTED', judgementDueAt: null }).dueText, '1영업일');
  assert.match(statusView({ status: 'REQUESTED', judgementDueAt: '2026-10-27T09:00:00.000Z' }).dueText, /^1영업일 · .+ KST$/);
  assert.equal(statusView({ status: 'JUDGED', judgementDueAt: null }).dueText, null, '판정 뒤에는 기한을 쓰지 않는다');

  // 진행률은 합계(total·done·failed)만이고 failed를 완료로 세지 않는다
  const running = statusView({ status: 'RUNNING', refundProgress: { total: 1152, done: 737, failed: 3 } });
  assert.deepEqual(running.progress, { total: 1152, done: 737, failed: 3, percent: 63 });
  assert.match(running.label, /63%$/);
  assert.equal(statusView({ status: 'RUNNING', refundProgress: { total: 0, done: 0, failed: 0 } }).progress.percent, 0, '0으로 나누지 않는다');
  assert.equal(statusView({ status: 'RUNNING', refundProgress: { total: 10, done: '5', failed: 0 } }).progress, null, '모양 틀린 값은 진행률 없음');

  // 모르는 상태는 '알 수 없음'이고 색만으로 말하지 않는다
  const unknown = statusView({ status: 'NEW_STATE' });
  assert.equal(unknown.label, '알 수 없음');
  assert.equal(unknown.progress, null);
});

test('SCR044_409·404·422·403을_정본_문구로_가른다', () => {
  const active = errorOf({ status: 409, type: 'event-cancellation-active', extensions: { requestId: 'req-1' } });
  assert.deepEqual(active, { kind: 'active', text: '이미 요청한 회차입니다', requestId: 'req-1' });
  // 기존 요청 ID가 본문 쪽에 있어도 싣는다
  assert.equal(errorOf({ status: 409, type: 'event-cancellation-active', requestId: 'req-2' }).requestId, 'req-2');
  assert.equal('requestId' in errorOf({ status: 409, type: 'event-cancellation-active' }), false);

  const cases = [
    [{ status: 409, type: 'event-ended' }, 'ended', '종료된 회차는 요청할 수 없습니다'],
    [{ status: 404, type: 'not-found' }, 'not-found', '찾을 수 없습니다'],
    [{ status: 422, type: 'postponement-date-invalid' }, 'date-invalid', '바뀐 일시는 지금 공연 시작보다 늦어야 합니다'],
    [{ status: 403, type: 'partner_member' }, 'member', '회차 취소·연기 요청은 파트너 관리자만 할 수 있습니다'],
    [{ status: 403, type: 'reauth-required' }, 'reauth', '다시 인증해야 합니다. 파트너 관리자로 다시 로그인한 뒤 시도해 주세요'],
    [{ status: 409, type: 'new-state' }, 'conflict', '지금 상태에서는 요청할 수 없습니다. 새로 고친 뒤 다시 시도해 주세요'],
    [{ status: 500, type: 'internal' }, 'other', '요청을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요'],
  ];
  for (const [problem, kind, text] of cases) {
    assert.deepEqual(errorOf(problem), { kind, text }, `${problem.status} ${problem.type}`);
  }
  // 문제 type이 주소 전체여도 끝 이름으로 가른다
  assert.equal(errorOf({ status: 403, type: 'https://problems.peaket.example/partner_member' }).kind, 'member');
  // 서버 title·detail은 문구에 섞이지 않는다
  const leaked = errorOf({ status: 409, type: 'event-ended', title: '<b>서버</b>', detail: '공연 ID 0193' });
  assert.equal(leaked.text.includes('<b>'), false);
  assert.equal(leaked.text.includes('0193'), false);
});

test('[ASVS v5.0.0-3.2.2] transfer-refund:v5.0.0-3.2.2 SCR044_사유·증명·반려_사유는_텍스트로만_그린다', () => {
  // 서버가 준 글은 해석하지 않고 글자 그대로 옮긴다(화면이 React 텍스트 노드로 그린다)
  const reason = '<img src=x onerror=alert(1)>';
  const r = validateRequest({ ...base, reason }, CURRENT);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.body.reason, reason);

  // 상태 값에 내부 미리보기·결제사별 몫·판정자가 섞이지 않는다
  const sv = statusView({ status: 'RUNNING', dryRun: { targetOrders: 1 }, perPg: [{ pg: 'TOSS' }], judgedBy: { displayName: '수진' }, refundProgress: { total: 1, done: 1, failed: 0 } });
  assert.equal('dryRun' in sv, false);
  assert.equal('perPg' in sv, false);
  assert.equal('judgedBy' in sv, false);
  assert.deepEqual(Object.keys(sv.progress).sort(), ['done', 'failed', 'percent', 'total']);

  // 반려 사유·팬 통지 사유도 고정 문구가 아니라 서버 글을 그대로 두고, 해석은 화면이 하지 않는다
  assert.equal(errorOf({ status: 500 }).text.includes('<'), false);
});
