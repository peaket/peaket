// R-T45 ④: SCR-047 재개 조건(F-07-15 I-06, transfer-refund §5 '재개 조건의 응답 모양').
// 최근 5분 호출·실패, 서킷 상태, 표본 없음, 서킷 조회 실패를 본다.
// 기준 트리에는 resume-condition 모듈과 resume 칸이 없어 실패한다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { EventCancellations } from '../src/modules/event-cancellations/application/event-cancellations.js';
import { MemoryEventCancellationStore } from '../src/modules/event-cancellations/adapters/memory-store.js';
import { resumeConditionOf } from '../src/modules/event-cancellations/domain/resume-condition.js';
import type { EventRefundJobProgress, EventRefundReader } from '../src/modules/event-cancellations/domain/ports.js';
import { EVENT, JOB, NOW, recordOf } from './event-cancellation-fixtures.js';

const base = { pg: 'TOSS' as const, calls: 0, failures: 0, circuitState: 'closed' as const };

describe('R-T45 ④ 재개 조건 함수', () => {
  test('R-T45 ④ 최근 5분 호출이 0이면 표본 없음이고 실패율은 null이다', () => {
    expect(resumeConditionOf(base)).toMatchObject({ state: 'NO_SAMPLE', failureRateBp: null, calls: 0, failures: 0, windowSeconds: 300 });
  });

  test('R-T45 ④ 실패율 500bp는 기준에 닿고 499bp는 충족이다', () => {
    expect(resumeConditionOf({ ...base, calls: 20, failures: 1 })).toMatchObject({ state: 'FAILURE_RATE_HIGH', failureRateBp: 500 });
    expect(resumeConditionOf({ ...base, calls: 201, failures: 10 })).toMatchObject({ state: 'ELIGIBLE', failureRateBp: 497 });
  });

  test('R-T45 ④ 서킷이 열렸으면 호출이 없어도 서킷 열림이다', () => {
    expect(resumeConditionOf({ ...base, calls: 0, failures: 0, circuitState: 'open' })).toMatchObject({ state: 'CIRCUIT_OPEN' });
  });

  test('R-T45 ④ half_open은 계속하고, 서킷 상태를 모르면 충족으로 올리지 않는다', () => {
    expect(resumeConditionOf({ ...base, calls: 5, failures: 0, circuitState: 'half_open' })).toMatchObject({ state: 'ELIGIBLE' });
    expect(resumeConditionOf({ ...base, calls: 5, failures: 0, circuitState: null })).toMatchObject({ state: 'CIRCUIT_UNAVAILABLE', circuitState: null });
  });
});

const jobWith = (over: Partial<EventRefundJobProgress> = {}): EventRefundJobProgress => ({
  ...JOB,
  state: 'PAUSED',
  perPg: JOB.perPg.map((p) => (p.pg === 'TOSS' ? { ...p, state: 'PAUSED', pauseReason: 'AUTO_FAILURE_RATE', recentCalls: 20, recentFailures: 2 } : { ...p, recentCalls: 0, recentFailures: 0 })),
  ...over,
});

const make = (q: { job?: EventRefundJobProgress; circuits?: { items: { pg: 'TOSS' | 'PORTONE' | 'SIMULATOR'; state: 'closed' | 'half_open' | 'open' }[] }; circuitsThrow?: boolean }) => {
  const store = new MemoryEventCancellationStore();
  const row = recordOf({ requestId: randomUUID(), status: 'PAUSED', refundJobState: 'PAUSED' });
  store.rows.set(row.requestId, row);
  const reader: EventRefundReader = { preview: async () => ({ targetOrders: 0, refundTotal: 0, compensationTargets: 0, compensationTotal: 0, perPg: [] }), job: async () => q.job };
  const circuits = {
    list: async () => {
      if (q.circuitsThrow) throw new Error('payment down');
      return q.circuits ?? { items: [] };
    },
  };
  const svc = new EventCancellations(store, undefined, () => NOW, undefined, undefined, { reader, circuits });
  return { svc, row };
};

describe('R-T45 ④ 관제 상세의 재개 조건', () => {
  test('R-T45 ④ 결제사 몫마다 서킷·최근 5분 실패율·판정을 싣는다', async () => {
    const { svc, row } = make({ job: jobWith(), circuits: { items: [{ pg: 'TOSS', state: 'closed' }, { pg: 'PORTONE', state: 'open' }] } });
    const view = (await svc.get(row.requestId)) as unknown as { progress: { perPg: Array<{ pg: string; resume: Record<string, unknown> }> } };
    const toss = view.progress.perPg.find((p) => p.pg === 'TOSS')!;
    expect(toss.resume).toMatchObject({ circuitState: 'closed', calls: 20, failures: 2, failureRateBp: 1000, windowSeconds: 300, state: 'FAILURE_RATE_HIGH' });
    const portone = view.progress.perPg.find((p) => p.pg === 'PORTONE')!;
    expect(portone.resume).toMatchObject({ circuitState: 'open', calls: 0, failures: 0, failureRateBp: null, state: 'CIRCUIT_OPEN' });
  });

  test('R-T45 ④ 서킷 조회가 실패해도 상세는 열리고 그 몫만 상태를 모른다', async () => {
    const { svc, row } = make({ job: jobWith(), circuitsThrow: true });
    const view = (await svc.get(row.requestId)) as unknown as { progress: { perPg: Array<{ pg: string; resume: Record<string, unknown> }> } };
    expect(view.progress.perPg.find((p) => p.pg === 'TOSS')!.resume).toMatchObject({ circuitState: null, state: 'CIRCUIT_UNAVAILABLE' });
  });
});
