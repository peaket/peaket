// 티켓 무효 실행기(application/ticket-void.ts, docs/features/payment.md §6 '티켓 무효·재발권', BUILD_ORDER HOT-152, P-T36 ④)를 메모리 가짜 포트로 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { LoggerTicketVoidLog, TicketIssueCallError, type TicketVoidJob, type TicketVoidJobs, TicketVoidRunner } from '../src/modules/booking/index.js';

const ORDER = '0190f3a1-7c2e-7c00-8000-0000000000a1';
const EVENT = '0190f3a1-7c2e-7c00-8000-0000000000a2';
const NOW = 1_794_200_000_000;

function fixture(o: { fail?: Error; jobs?: TicketVoidJob[]; claimOne?: TicketVoidJob; alreadyEntered?: number; done?: boolean } = {}) {
  const clock = fakeClock({ now: NOW });
  const calls: string[] = [];
  const voided: unknown[] = [];
  const results: string[] = [];
  const stops: unknown[] = [];
  const entered: unknown[] = [];
  const job: TicketVoidJob = { orderId: ORDER, eventId: EVENT, issueGeneration: 3, attempts: 1, leaseUntilMs: NOW + 30_000 };
  let list = o.jobs ?? [job];
  const jobs: TicketVoidJobs = {
    claimDue: async () => {
      const out = list;
      list = [];
      return out;
    },
    claim: async () => o.claimOne ?? job,
    done: async () => {
      calls.push('done');
      return o.done ?? true;
    },
    retry: async (i) => {
      calls.push(`retry:${i.code}:${i.nextAtMs - NOW}`);
      return true;
    },
    stop: async (i) => {
      calls.push(`stop:${i.code}`);
      return true;
    },
  };
  const runner = new TicketVoidRunner({
    jobs,
    voider: {
      voidTickets: async (c) => {
        voided.push(c);
        if (o.fail) throw o.fail;
        return { alreadyEntered: o.alreadyEntered ?? 0 };
      },
    },
    log: { stopped: (e) => void stops.push(e), alreadyEntered: (e) => void entered.push(e), runError: () => {} },
    signals: { attempt: (r) => void results.push(r) },
    clock,
    random: () => 0.5,
  });
  return { runner, calls, voided, results, stops, entered };
}

describe('티켓 무효 실행기', () => {
  test('P-T36 ④_틱은 그 세대를 무효로 부르고 끝나면 행을 지운다', async () => {
    const f = fixture();
    await expect(f.runner.tick()).resolves.toBe(1);
    expect(f.voided).toEqual([{ orderId: ORDER, eventId: EVENT, issueGeneration: 3, deadlineMs: 2_000 }]);
    expect(f.calls).toEqual(['done']);
    expect(f.results).toEqual(['voided']);
  });

  test('P-T36 ④_일시 실패는 발권과 같은 간격으로 다시 보낸다 [ASVS v5.0.0-16.5.2]', async () => {
    const f = fixture({ fail: new TicketIssueCallError('UNAVAILABLE') });
    await f.runner.tick();
    expect(f.calls).toEqual(['retry:UNAVAILABLE:2000']);
    expect(f.results).toEqual(['retry']);
  });

  test('P-T36 ④_다시 보내도 같은 실패면 멈추고 로그를 낸다 [ASVS v5.0.0-16.3.4]', async () => {
    const f = fixture({ fail: new TicketIssueCallError('FAILED_PRECONDITION') });
    await f.runner.tick();
    expect(f.calls).toEqual(['stop:FAILED_PRECONDITION']);
    expect(f.results).toEqual(['stopped']);
    expect(f.stops).toEqual([{ orderId: ORDER, code: 'FAILED_PRECONDITION' }]);
  });

  function loggerLines() {
    const lines: Record<string, unknown>[] = [];
    const logger = { warn: (o: Record<string, unknown>) => void lines.push(o), error: (o: Record<string, unknown>) => void lines.push(o) };
    return { lines, log: new LoggerTicketVoidLog(logger as never) };
  }

  test('P-T36 ④_리뷰 고침 H1: 무효가 멈추면 SEV1이다(재발권·좌석 반환이 막혀 사람이 봐야 한다) [ASVS v5.0.0-16.3.4]', () => {
    const { lines, log } = loggerLines();
    log.stopped({ orderId: ORDER, code: 'FAILED_PRECONDITION' });
    expect(lines).toEqual([{ kind: 'ticket-void-stopped', severity: 'SEV1', orderId: ORDER, code: 'FAILED_PRECONDITION', csCase: 'TICKET_NOT_VOIDED' }]);
  });

  test('P-T36 ④_리뷰 고침 M6: 입장 기록이 있는 표를 무효로 했으면 SEV1이고 주문 ID·수만 싣는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', async () => {
    const f = fixture({ alreadyEntered: 2 });
    await f.runner.tick();
    expect(f.entered).toEqual([{ orderId: ORDER, count: 2 }]);
    const { lines, log } = loggerLines();
    log.alreadyEntered({ orderId: ORDER, count: 2 });
    expect(lines).toEqual([{ kind: 'ticket-void-already-entered', severity: 'SEV1', orderId: ORDER, count: 2 }]);
  });

  test('P-T36 ④_리뷰 고침 M6: 입장 기록이 없거나 임대를 잃었으면 이 로그를 내지 않는다', async () => {
    const none = fixture();
    await none.runner.tick();
    expect(none.entered).toEqual([]);
    const lost = fixture({ alreadyEntered: 1, done: false });
    await lost.runner.tick();
    expect(lost.entered).toEqual([]);
  });

  test('P-T36 ④_kick은 그 주문을 곧바로 돈다', async () => {
    const f = fixture();
    await f.runner.runOne(ORDER);
    expect(f.voided).toHaveLength(1);
    expect(f.calls).toEqual(['done']);
  });

  test('P-T36 ④_멈춘 뒤에는 돌지 않는다', async () => {
    const f = fixture();
    await f.runner.stop();
    await expect(f.runner.tick()).resolves.toBe(0);
    expect(f.voided).toEqual([]);
  });
});
