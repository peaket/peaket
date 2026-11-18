// core 회차 상태 반영과 다시 하기(R-T41 ③④, BUILD_ORDER GAT-110, BAT-420-rest, 시험 담당 l3-b420-test). DB 없이 메모리 저장소·가짜 시계·core 대역으로 돈다.
// 정본: docs/features/transfer-refund.md §5 'core 회차 상태 반영'(Start 뒤 한 번, 3초)·둘째 줄(실패해도 확정 그대로, core_applied_at 빔, 1분 다시 하기 20건,
// 경고 event-cancellation-core-apply-failed·지표, 확정 뒤 10분 SEV2 event-cancellation-core-apply-overdue 요청마다 한 번)·'core 반영의 구현에서 정한 것' ⑤(10분 경계 포함, 그 바퀴 다시 하기 뒤),
// ADR-0280 결정 1(연기는 판매를 멈추지 않는다), docs/api/guidelines.md §8.1(4xx는 계약 결함이라 오류 로그).
// 시계 값은 정본 값을 글자로 적는다(1분 = 60,000ms, 10분 = 600,000ms, 3초 = 3,000ms). 코드 상수를 가져오지 않는다.
// 실제 PostgreSQL의 잡기 뒤 미루기(SKIP LOCKED)·0016 칸은 test-int/event-cancellations.int.test.ts가 본다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { HttpCoreEventStatus } from '../src/adapters/http-core-event-status.js';
import { eventCancellationDepsFromEnv, requireCoreEventStatusUrl } from '../src/event-cancellation-wiring.js';
import { CoreEventStatusRejected, type CoreEventStatus, type EventCancellationRecord } from '../src/modules/event-cancellations/index.js';
import { approveBy, COMMANDER_A, DRY_RUN, EVENT, fixture, NOW, pendingApproval, recordOf } from './event-cancellation-fixtures.js';

const MIN = 60_000;

type CoreMode = 'ok' | 'down' | 'reject';
/** core 대역: 받은 호출을 적고 mode대로 답한다(down = 연결 실패, reject = 4xx) */
function coreDouble() {
  const state = { mode: 'ok' as CoreMode, calls: [] as Parameters<CoreEventStatus['apply']>[0][], failed: 0 };
  const core: CoreEventStatus = {
    apply: async (q) => {
      state.calls.push({ ...q });
      if (state.mode === 'down') {
        state.failed++;
        throw new Error('connect ECONNREFUSED core-svc');
      }
      if (state.mode === 'reject') {
        state.failed++;
        throw new CoreEventStatusRejected(409);
      }
    },
  };
  return { state, core };
}

/** 공용 fixture에 core 대역·반영 표시(메모리 저장소)·지표를 꽂는다(extra는 fixture가 만든 객체라 더한다) */
function withCore() {
  const f = fixture();
  const c = coreDouble();
  const failures = { n: 0 };
  Object.assign((f.app as unknown as { extra: Record<string, unknown> }).extra, { core: c.core, coreApplies: f.store, coreApplyFailures: { inc: () => void failures.n++ } });
  return { f, c, failures };
}
const warnsOf = (f: ReturnType<typeof fixture>, event: string) => f.warns.filter((w) => (w.obj as { event?: string }).event === event);
const errorsOf = (f: ReturnType<typeof fixture>, event: string) => f.errors.filter((w) => (w.obj as { event?: string }).event === event);

describe('R-T41 ③ 확정 직후 core 반영', () => {
  test('R-T41 ③ 확정이 Start까지 끝낸 뒤 core를 한 번 부르고(요청 ID·종류 CANCEL·연기 시작 없음) 성공하면 core_applied_at을 쓴다. 다시 하기는 더 부르지 않는다', async () => {
    const { f, c } = withCore();
    const id = await pendingApproval(f);
    await approveBy(f, id);
    expect(c.state.calls).toEqual([{ eventId: EVENT, requestId: id, kind: 'CANCEL' }]);
    // 차례: Start(일괄 환불 시작)가 core 반영보다 먼저다
    expect(f.log.indexOf(`start:${id}`)).toBeGreaterThanOrEqual(0);
    expect(f.store.core.get(id)?.appliedAtMs).toBe(NOW);
    await expect(f.app.retryCoreApply(NOW + MIN)).resolves.toEqual({ applied: 0, failed: 0, overdue: 0 });
    expect(c.state.calls).toHaveLength(1);
  });

  test('R-T41 ③ core가 실패해도 확정은 그대로(RUNNING·Start 1번)이고 core_applied_at이 비며, 경고(요청 ID만)·지표가 하나씩 남는다', async () => {
    const { f, c, failures } = withCore();
    c.state.mode = 'down';
    const id = await pendingApproval(f);
    const view = await approveBy(f, id);
    expect(view).toMatchObject({ status: 'RUNNING' });
    expect(f.store.rows.get(id)?.status).toBe('RUNNING');
    expect(f.startCalls).toHaveLength(1);
    // 장애 주입이 실제로 끼어들었다
    expect(c.state.failed).toBe(1);
    expect(f.store.core.get(id)?.appliedAtMs).toBeUndefined();
    const warns = warnsOf(f, 'event-cancellation-core-apply-failed');
    expect(warns.map((w) => w.obj)).toEqual([{ event: 'event-cancellation-core-apply-failed', requestId: id }]);
    expect(failures.n).toBe(1);
  });

  test('R-T41 ③ core가 4xx(계약 결함)로 답하면 경고 대신 오류 로그(상태 코드만)이고 확정은 그대로다', async () => {
    const { f, c } = withCore();
    c.state.mode = 'reject';
    const id = await pendingApproval(f);
    await expect(approveBy(f, id)).resolves.toMatchObject({ status: 'RUNNING' });
    expect(errorsOf(f, 'event-cancellation-core-apply-failed').map((e) => e.obj)).toEqual([{ event: 'event-cancellation-core-apply-failed', requestId: id, status: 409 }]);
    expect(warnsOf(f, 'event-cancellation-core-apply-failed')).toEqual([]);
  });

  test('R-T41 ③ 살아나면 다음 다시 하기가 한 번 반영하고 칸을 쓰며, 그 뒤 바퀴는 부르지 않는다', async () => {
    const { f, c } = withCore();
    c.state.mode = 'down';
    const id = await pendingApproval(f);
    await approveBy(f, id);
    c.state.mode = 'ok';
    await expect(f.app.retryCoreApply(NOW + MIN)).resolves.toEqual({ applied: 1, failed: 0, overdue: 0 });
    expect(c.state.calls).toEqual([
      { eventId: EVENT, requestId: id, kind: 'CANCEL' },
      { eventId: EVENT, requestId: id, kind: 'CANCEL' },
    ]);
    expect(f.store.core.get(id)?.appliedAtMs).toBe(NOW);
    await f.app.retryCoreApply(NOW + 2 * MIN);
    await f.app.retryCoreApply(NOW + 3 * MIN);
    expect(c.state.calls).toHaveLength(2);
  });

  test('R-T41 ④ 연기(POSTPONE) 확정은 판매를 멈추지 않고(판매 중지 호출 0) core에 POSTPONE과 바뀐 시작을 싣는다', async () => {
    const { f, c } = withCore();
    const newStartsAt = new Date(NOW + 30 * 86_400_000);
    const r: EventCancellationRecord = recordOf({
      kind: 'POSTPONE',
      status: 'PENDING_APPROVAL',
      fault: 'ORGANIZER',
      judgementReason: '주최 측 귀책',
      fanNoticeReason: '공연이 연기되었습니다',
      judgedBy: COMMANDER_A.accountId,
      judgedAt: new Date(NOW - 30_000),
      dryRun: DRY_RUN,
      newStartsAt,
    });
    f.store.rows.set(r.requestId, r);
    await approveBy(f, r.requestId);
    expect(f.stopCalls).toEqual([]);
    expect(c.state.calls).toEqual([{ eventId: EVENT, requestId: r.requestId, kind: 'POSTPONE', postponedTo: newStartsAt }]);
  });
});

describe('R-T41 ③ 다시 하기(1분·20건·10분 SEV2)', () => {
  /** Start까지 끝낸 확정 뒤 요청(RUNNING, refundJobState 있음)을 확정 시각 순서대로 넣는다 */
  const seedApproved = (f: ReturnType<typeof fixture>, n: number, approvedAtMs: number, over: Partial<EventCancellationRecord> = {}): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = recordOf({ eventId: randomUUID(), status: 'RUNNING', fault: 'ORGANIZER', approvedBy: 'op', approvedAt: new Date(approvedAtMs + i), refundJobState: 'RUNNING', ...over });
      f.store.rows.set(r.requestId, r);
      ids.push(r.requestId);
    }
    return ids;
  };

  test('R-T41 ③ 한 바퀴는 20건까지만 부르고(21건째는 다음 바퀴), 잡은 행은 1분 뒤(정각 포함)에 다시 본다: 59,999ms 뒤 0건, 60,000ms 뒤 20건', async () => {
    const { f, c } = withCore();
    c.state.mode = 'down';
    const ids = seedApproved(f, 21, NOW - 5 * MIN);
    const t = NOW;
    await expect(f.app.retryCoreApply(t)).resolves.toMatchObject({ applied: 0, failed: 20 });
    expect(c.state.calls.map((x) => x.requestId)).toEqual(ids.slice(0, 20));
    await expect(f.app.retryCoreApply(t)).resolves.toMatchObject({ failed: 1 });
    expect(c.state.calls.at(-1)?.requestId).toBe(ids[20]);
    c.state.calls.length = 0;
    await f.app.retryCoreApply(t + 59_999);
    expect(c.state.calls).toEqual([]);
    await f.app.retryCoreApply(t + 60_000);
    expect(c.state.calls.map((x) => x.requestId)).toEqual(ids.slice(0, 20));
  });

  test('R-T41 ③ 대상: Start까지 끝낸 APPROVED·RUNNING·PAUSED·REFUND_WINDOW·COMPLETED만이고, Start 전(refundJobState 없음)·PENDING_APPROVAL·REJECTED는 부르지 않는다', async () => {
    const { f, c } = withCore();
    const yes = ['APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED'].map((status) => seedApproved(f, 1, NOW - MIN, { status: status as EventCancellationRecord['status'] })[0]!);
    seedApproved(f, 1, NOW - MIN, { status: 'RUNNING', refundJobState: null });
    seedApproved(f, 1, NOW - MIN, { status: 'PENDING_APPROVAL', refundJobState: null });
    seedApproved(f, 1, NOW - MIN, { status: 'REJECTED' });
    await f.app.retryCoreApply(NOW);
    expect(c.state.calls.map((x) => x.requestId).sort()).toEqual([...yes].sort());
  });

  test('R-T41 ③ 경계: 확정 + 9분 59초에는 SEV2가 0, 확정 + 10분 정각에 요청마다 1번(오류 로그 severity SEV2), 그 뒤 바퀴에서는 0이다', async () => {
    const { f, c } = withCore();
    c.state.mode = 'down';
    const t0 = NOW;
    const [a, b] = seedApproved(f, 2, t0);
    // seedApproved는 확정 시각을 1ms씩 어긋나게 둔다(a = t0, b = t0 + 1)
    const overdue = () => errorsOf(f, 'event-cancellation-core-apply-overdue').map((e) => e.obj);
    f.clock.now = t0 + 9 * MIN + 59_000;
    await expect(f.app.retryCoreApply(f.clock.now)).resolves.toMatchObject({ overdue: 0 });
    expect(overdue()).toEqual([]);
    f.clock.now = t0 + 10 * MIN;
    await expect(f.app.retryCoreApply(f.clock.now)).resolves.toMatchObject({ overdue: 1 });
    expect(overdue()).toEqual([{ event: 'event-cancellation-core-apply-overdue', severity: 'SEV2', requestId: a, eventId: f.store.rows.get(a!)!.eventId }]);
    f.clock.now = t0 + 10 * MIN + 1;
    await expect(f.app.retryCoreApply(f.clock.now)).resolves.toMatchObject({ overdue: 1 });
    expect(overdue().map((o) => (o as { requestId: string }).requestId)).toEqual([a, b]);
    f.clock.now = t0 + 11 * MIN;
    await expect(f.app.retryCoreApply(f.clock.now)).resolves.toMatchObject({ overdue: 0 });
    f.clock.now = t0 + 60 * MIN;
    await f.app.retryCoreApply(f.clock.now);
    expect(overdue()).toHaveLength(2);
    // 장애 주입이 실제로 끼어들었다
    expect(c.state.failed).toBeGreaterThan(0);
  });

  test('R-T41 ③ 10분 정각 바퀴의 다시 하기가 성공하면 SEV2를 남기지 않는다(그 바퀴의 다시 하기가 끝난 뒤에 본다)', async () => {
    const { f, c } = withCore();
    const [a] = seedApproved(f, 1, NOW);
    f.clock.now = NOW + 10 * MIN;
    await expect(f.app.retryCoreApply(f.clock.now)).resolves.toEqual({ applied: 1, failed: 0, overdue: 0 });
    expect(c.state.calls.map((x) => x.requestId)).toEqual([a]);
    expect(errorsOf(f, 'event-cancellation-core-apply-overdue')).toEqual([]);
  });

  test('R-T41 ③ core 대역이나 반영 표시가 없으면 다시 하기는 아무것도 하지 않는다(local·ci 주소 없음)', async () => {
    const f = fixture();
    seedApproved(f, 3, NOW - 20 * MIN);
    await expect(f.app.retryCoreApply(NOW)).resolves.toEqual({ applied: 0, failed: 0, overdue: 0 });
  });
});

describe('R-T41 HttpCoreEventStatus', () => {
  const requestId = randomUUID();
  const eventId = randomUUID();
  const make = (status: number) => {
    const seen: Record<string, unknown>[] = [];
    const a = new HttpCoreEventStatus({ request: async (r: Record<string, unknown>) => (seen.push(r), new Response(status === 204 ? null : '{}', { status })) } as never, 'it-token');
    return { a, seen };
  };
  test('R-T41 내부 경로 POST /internal/v1/events/{eventId}/cancellation-status를 공유 토큰·3초 상한으로 부르고 본문은 requestId·kind(연기면 postponedTo ISO)뿐이다', async () => {
    const { a, seen } = make(204);
    await a.apply({ eventId, requestId, kind: 'CANCEL' });
    const to = new Date('2026-12-24T10:00:00.000Z');
    await a.apply({ eventId, requestId, kind: 'POSTPONE', postponedTo: to });
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/internal/v1/events/{eventId}/cancellation-status', params: { eventId }, timeoutCapMs: 3_000, headers: { 'x-peaket-internal-token': 'it-token' } });
    expect(JSON.parse(seen[0]!.body as string)).toEqual({ requestId, kind: 'CANCEL' });
    expect(JSON.parse(seen[1]!.body as string)).toEqual({ requestId, kind: 'POSTPONE', postponedTo: '2026-12-24T10:00:00.000Z' });
  });
  test('R-T41 2xx만 반영이고 4xx는 CoreEventStatusRejected(상태 코드), 5xx는 그 밖의 오류다', async () => {
    for (const s of [200, 204]) await expect(make(s).a.apply({ eventId, requestId, kind: 'CANCEL' }), String(s)).resolves.toBeUndefined();
    for (const s of [400, 401, 404, 409]) await expect(make(s).a.apply({ eventId, requestId, kind: 'CANCEL' }), String(s)).rejects.toMatchObject({ name: 'CoreEventStatusRejected', status: s });
    for (const s of [500, 503]) {
      const e = await make(s).a.apply({ eventId, requestId, kind: 'CANCEL' }).catch((err: unknown) => err);
      expect(e, String(s)).toBeInstanceOf(Error);
      expect(e, String(s)).not.toBeInstanceOf(CoreEventStatusRejected);
    }
  });
});

describe('R-T41 ③ 시작 조립(PEAKET_CORE_HTTP_URL)', () => {
  test('R-T41 ③ 주소가 없으면 prod·production·staging·demo·PEAKET_ENV 없음·빈 값은 시작 실패이고, local·ci만 경고 글 하나로 시작한다. 주소가 있으면 어느 환경이든 통과다', () => {
    for (const envName of ['prod', 'production', 'staging', 'demo', '']) expect(() => requireCoreEventStatusUrl({ PEAKET_ENV: envName }), envName).toThrow(/PEAKET_CORE_HTTP_URL/);
    expect(() => requireCoreEventStatusUrl({}), 'PEAKET_ENV 없음').toThrow(/PEAKET_CORE_HTTP_URL/);
    expect(() => requireCoreEventStatusUrl({ PEAKET_ENV: 'prod', PEAKET_CORE_HTTP_URL: '   ' }), '공백 주소').toThrow(/PEAKET_CORE_HTTP_URL/);
    for (const envName of ['local', 'ci']) {
      const w = requireCoreEventStatusUrl({ PEAKET_ENV: envName });
      expect(typeof w, envName).toBe('string');
      expect(w, envName).toMatch(/PEAKET_CORE_HTTP_URL/);
    }
    for (const envName of ['prod', 'staging', 'demo', 'local', 'ci']) expect(requireCoreEventStatusUrl({ PEAKET_ENV: envName, PEAKET_CORE_HTTP_URL: 'http://core-svc:8080' }), envName).toBeUndefined();
  });

  test('R-T41 ③ eventCancellationDepsFromEnv는 주소가 있을 때만 core 반영 어댑터(HttpCoreEventStatus)를 넣는다', () => {
    const withUrl = eventCancellationDepsFromEnv({ env: { PEAKET_CORE_HTTP_URL: 'http://core-svc:8080' }, internalToken: 't' } as never);
    expect(withUrl.core).toBeInstanceOf(HttpCoreEventStatus);
    const without = eventCancellationDepsFromEnv({ env: {}, internalToken: 't' } as never);
    expect(without.core).toBeUndefined();
  });
});

// ---- BAT-420-rest 리뷰 반영 재현(시험 담당 l3-b420-test, 2026-11-19) ----
// 정본: docs/features/transfer-refund.md §5 'core 반영의 구현에서 정한 것' ⑥(같은 회차는 확정 시각 차례로만, 뒤 요청이 반영되면 앞 요청은 core_apply_superseded_at,
// 잡기는 core_apply_next_at 차례(빈 값 먼저), 4xx(401 제외)는 다음 볼 시각 10분 뒤·5xx·무응답은 1분 뒤), §11 R-T41 ⑥, §5 'core 회차 상태 반영' 첫 줄(Start 뒤).

/** 요청마다 답을 고르는 core 대역(호출 차례를 적는다) */
function scriptedCore(answerOf: (requestId: string) => 'ok' | 'down' | number) {
  const calls: string[] = [];
  const core: CoreEventStatus = {
    apply: async (q) => {
      calls.push(q.requestId);
      const a = answerOf(q.requestId);
      if (a === 'ok') return;
      if (a === 'down') throw new Error('connect ECONNREFUSED core-svc');
      if (a >= 400 && a <= 499) throw new CoreEventStatusRejected(a);
      throw new Error(`core-svc 회차 상태 반영 ${a}`);
    },
  };
  return { calls, core };
}
function withScripted(answerOf: (requestId: string) => 'ok' | 'down' | number) {
  const f = fixture();
  const c = scriptedCore(answerOf);
  Object.assign((f.app as unknown as { extra: Record<string, unknown> }).extra, { core: c.core, coreApplies: f.store, coreApplyFailures: { inc: () => undefined } });
  return { f, c };
}
const approvedRecord = (over: Partial<EventCancellationRecord>) => recordOf({ status: 'RUNNING', fault: 'ORGANIZER', approvedBy: 'op', refundJobState: 'RUNNING', ...over });

describe('R-T41 ⑥ 같은 회차 요청 사이의 차례와 머리 막힘', () => {
  test('R-T41 ⑥ 같은 회차의 앞 연기 P1이 반영 못 한 채 뒤 요청 P2가 반영되면 다음 바퀴는 P1을 부르지 않는다', async () => {
    const eventId = randomUUID();
    const p1 = approvedRecord({ eventId, kind: 'POSTPONE', newStartsAt: new Date(NOW + 20 * 86_400_000), approvedAt: new Date(NOW - 10 * MIN) });
    const p2 = approvedRecord({ eventId, kind: 'POSTPONE', newStartsAt: new Date(NOW + 30 * 86_400_000), approvedAt: new Date(NOW - 5 * MIN) });
    const { f, c } = withScripted((id) => (id === p1.requestId ? 'down' : 'ok'));
    f.store.rows.set(p1.requestId, p1);
    f.store.rows.set(p2.requestId, p2);
    await f.app.retryCoreApply(NOW);
    expect(c.calls).toEqual([p1.requestId, p2.requestId]);
    expect(f.store.core.get(p2.requestId)?.appliedAtMs).toBe(NOW);
    c.calls.length = 0;
    await f.app.retryCoreApply(NOW + MIN);
    await f.app.retryCoreApply(NOW + 2 * MIN);
    expect(c.calls).toEqual([]);
    expect(f.store.core.get(p1.requestId)?.appliedAtMs).toBeUndefined();
  });

  test('R-T41 ⑥ 같은 바퀴에 둘 다 비어 있으면 확정 시각 차례로 P1 → P2를 부르고 둘 다 반영한다', async () => {
    const eventId = randomUUID();
    const p2 = approvedRecord({ eventId, kind: 'CANCEL', approvedAt: new Date(NOW - 5 * MIN) });
    const p1 = approvedRecord({ eventId, kind: 'POSTPONE', newStartsAt: new Date(NOW + 20 * 86_400_000), approvedAt: new Date(NOW - 10 * MIN) });
    const { f, c } = withScripted(() => 'ok');
    f.store.rows.set(p2.requestId, p2);
    f.store.rows.set(p1.requestId, p1);
    await f.app.retryCoreApply(NOW);
    expect(c.calls).toEqual([p1.requestId, p2.requestId]);
  });

  test('R-T41 ⑥ 늘 4xx(409)인 요청 21건이 있어도 그 뒤 확정한 새 요청은 다음 바퀴에 반영되고, 4xx 행의 다음 볼 시각은 지금 + 600,000ms다', async () => {
    const rejected = Array.from({ length: 21 }, (_, i) => approvedRecord({ eventId: randomUUID(), approvedAt: new Date(NOW - 60 * MIN + i) }));
    const fresh = approvedRecord({ eventId: randomUUID(), approvedAt: new Date(NOW + 30_000) });
    const { f, c } = withScripted((id) => (id === fresh.requestId ? 'ok' : 409));
    for (const r of rejected) f.store.rows.set(r.requestId, r);
    await f.app.retryCoreApply(NOW);
    await f.app.retryCoreApply(NOW);
    expect(new Set(c.calls)).toEqual(new Set(rejected.map((r) => r.requestId)));
    for (const r of rejected) expect(f.store.core.get(r.requestId)?.nextAtMs, r.requestId).toBe(NOW + 600_000);
    f.store.rows.set(fresh.requestId, fresh);
    c.calls.length = 0;
    await f.app.retryCoreApply(NOW + MIN);
    expect(c.calls).toEqual([fresh.requestId]);
    expect(f.store.core.get(fresh.requestId)?.appliedAtMs).toBe(NOW);
  });

  test('R-T41 ⑥ 다음 볼 시각: 5xx·연결 실패·401은 지금 + 60,000ms, 400·404·409는 지금 + 600,000ms다', async () => {
    const answers = { a500: 500, down: 'down', a401: 401, a400: 400, a404: 404, a409: 409 } as const;
    const recs = Object.fromEntries(Object.keys(answers).map((k, i) => [k, approvedRecord({ eventId: randomUUID(), approvedAt: new Date(NOW - 20 * MIN + i) })])) as Record<keyof typeof answers, EventCancellationRecord>;
    const byId = new Map(Object.entries(recs).map(([k, r]) => [r.requestId, answers[k as keyof typeof answers]]));
    const { f } = withScripted((id) => byId.get(id)! as 'down' | number);
    for (const r of Object.values(recs)) f.store.rows.set(r.requestId, r);
    await f.app.retryCoreApply(NOW);
    const next = (k: keyof typeof answers) => f.store.core.get(recs[k].requestId)?.nextAtMs;
    expect({ a500: next('a500'), down: next('down'), a401: next('a401') }).toEqual({ a500: NOW + 60_000, down: NOW + 60_000, a401: NOW + 60_000 });
    expect({ a400: next('a400'), a404: next('a404'), a409: next('a409') }).toEqual({ a400: NOW + 600_000, a404: NOW + 600_000, a409: NOW + 600_000 });
  });
});

describe('R-T41 ③ 확정 직후 반영의 차례(검증 O13)', () => {
  test('R-T41 ③ 확정은 Start를 끝낸 뒤에만 core를 부른다: 한 기록 배열에서 start 다음 core이고, Start가 실패한 확정에서 core 호출 0이다', async () => {
    const f = fixture();
    const core: CoreEventStatus = { apply: async (q) => void f.log.push(`core:${q.requestId}`) };
    Object.assign((f.app as unknown as { extra: Record<string, unknown> }).extra, { core, coreApplies: f.store });
    const id = await pendingApproval(f);
    await approveBy(f, id);
    expect(f.log.filter((l) => /^(start|core):/.test(l))).toEqual([`start:${id}`, `core:${id}`]);

    const g = fixture();
    const coreCalls: string[] = [];
    Object.assign((g.app as unknown as { extra: Record<string, unknown> }).extra, { core: { apply: async (q: { requestId: string }) => void coreCalls.push(q.requestId) }, coreApplies: g.store });
    g.behaviour.startFails = true;
    const id2 = await pendingApproval(g);
    await expect(approveBy(g, id2)).rejects.toThrow();
    // 확정은 PENDING_APPROVAL로 되돌려졌다(다시 확정할 수 있다)
    expect(g.store.rows.get(id2)?.status).toBe('PENDING_APPROVAL');
    // 장애 주입이 끼어들었다: Start를 불렀고 실패했다
    expect(g.startCalls).toHaveLength(1);
    expect(coreCalls).toEqual([]);
  });
});
