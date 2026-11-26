// R-T20 ②: 계좌 입력 요청 첫 발송·재발송(F-07-15 I-02, transfer-refund §11, notify §9).
// 첫 요청은 계좌 대기가 된 틱, 그 뒤 다음 영업일 10:00·그다음 영업일 10:00, 그 뒤 7일마다다.
// 기준 트리에는 account-request 모듈이 없어 각 시험이 실행 중 import에서 실패한다(파일째 실패 아님).
import { describe, expect, test } from 'vitest';
import { WeekendBusinessCalendar } from '../src/modules/refund/domain/refund-policy.js';

const KST = 9 * 60 * 60 * 1000;
const kst = (s: string) => Date.parse(`${s}+09:00`);
const iso = (ms: number) => new Date(ms).toISOString();
const calendar = (holidays: string[] = []) => new WeekendBusinessCalendar(holidays);

interface Calendar {
  isBusinessDay(k: string): boolean;
}
interface NoticeRow {
  id: string;
  orderId: string;
  eventId: string;
  accountId: string;
  amount: number;
  requiredAtMs: number;
  sentCount: number;
  nextAtMs?: number;
}
interface Outbox {
  topic: string;
  key: string;
  payload: Uint8Array;
}
interface Source {
  listDue(nowMs: number, limit: number): Promise<readonly NoticeRow[]>;
  claim(i: { id: string; expectedCount: number; nextAtMs: number; outbox: Outbox; nowMs: number }): Promise<boolean>;
}
type NextFn = (i: { requiredAtMs: number; sentCount: number; calendar: Calendar }) => number;
type AppCtor = new (i: { refunds: Source; compensations: Source; calendar: Calendar; clock: { now(): number } }) => {
  run(limit?: number): Promise<{ sent: number; skipped?: number }>;
};

const loadNext = async (): Promise<NextFn> => {
  // @ts-ignore 구현 전에는 모듈이 없다. 구현이 만들면 같은 import가 통한다
  const m = (await import('../src/modules/refund/domain/account-request.js')) as { nextAccountNoticeAt: NextFn };
  return m.nextAccountNoticeAt;
};
const loadApp = async (): Promise<AppCtor> => {
  // @ts-ignore 구현 전에는 모듈이 없다
  const m = (await import('../src/modules/refund/application/account-request-notices.js')) as { AccountRequestNotices: AppCtor };
  return m.AccountRequestNotices;
};

describe('R-T20 ② 계좌 요청 일정', () => {
  test('R-T20 ② 첫 요청은 즉시, 다음은 다음 영업일·그다음 영업일 10:00이고 그 뒤 7일마다다', async () => {
    const next = await loadNext();
    const required = kst('2026-11-24T15:00:00');
    const c = calendar();
    expect(iso(next({ requiredAtMs: required, sentCount: 0, calendar: c }))).toBe('2026-11-24T06:00:00.000Z');
    expect(iso(next({ requiredAtMs: required, sentCount: 1, calendar: c }))).toBe('2026-11-25T01:00:00.000Z');
    expect(iso(next({ requiredAtMs: required, sentCount: 2, calendar: c }))).toBe('2026-11-26T01:00:00.000Z');
    expect(iso(next({ requiredAtMs: required, sentCount: 3, calendar: c }))).toBe('2026-12-03T01:00:00.000Z');
    expect(iso(next({ requiredAtMs: required, sentCount: 4, calendar: c }))).toBe('2026-12-10T01:00:00.000Z');
  });

  test('R-T20 ② 금요일 15시에 대기하면 월·화 10:00이고, 월요일이 공휴일이면 화·수다', async () => {
    const next = await loadNext();
    const friday = kst('2026-11-27T15:00:00');
    expect(iso(next({ requiredAtMs: friday, sentCount: 1, calendar: calendar() }))).toBe('2026-11-30T01:00:00.000Z');
    expect(iso(next({ requiredAtMs: friday, sentCount: 2, calendar: calendar() }))).toBe('2026-12-01T01:00:00.000Z');
    const holiday = calendar(['2026-11-30']);
    expect(iso(next({ requiredAtMs: friday, sentCount: 1, calendar: holiday }))).toBe('2026-12-01T01:00:00.000Z');
    expect(iso(next({ requiredAtMs: friday, sentCount: 2, calendar: holiday }))).toBe('2026-12-02T01:00:00.000Z');
  });

  test('R-T20 ② 10:00 −1ms에는 아직 보내지 않고 10:00에 보낸다', async () => {
    const next = await loadNext();
    const required = kst('2026-11-24T15:00:00');
    const due = next({ requiredAtMs: required, sentCount: 1, calendar: calendar() });
    expect(due).toBe(kst('2026-11-25T10:00:00'));
    expect(due - 1).toBeLessThan(due);
    expect(KST).toBe(9 * 60 * 60 * 1000);
  });
});

class FakeSource implements Source {
  readonly rows: NoticeRow[];
  readonly claimed: Array<{ id: string; expectedCount: number; nextAtMs: number; outbox: Outbox }> = [];
  failClaim = false;
  constructor(rows: NoticeRow[]) {
    this.rows = rows;
  }
  async listDue(nowMs: number, limit: number): Promise<readonly NoticeRow[]> {
    return this.rows.filter((r) => r.requiredAtMs <= nowMs && (r.nextAtMs === undefined || r.nextAtMs <= nowMs)).slice(0, limit);
  }
  async claim(i: { id: string; expectedCount: number; nextAtMs: number; outbox: Outbox; nowMs: number }): Promise<boolean> {
    if (this.failClaim) return false;
    const row = this.rows.find((r) => r.id === i.id);
    if (!row || row.sentCount !== i.expectedCount) return false;
    row.sentCount += 1;
    row.nextAtMs = i.nextAtMs;
    this.claimed.push({ id: i.id, expectedCount: i.expectedCount, nextAtMs: i.nextAtMs, outbox: i.outbox });
    return true;
  }
}

const row = (over: Partial<NoticeRow> = {}): NoticeRow => ({
  id: '0194b000-0000-7000-8000-000000000101',
  orderId: '0194b000-0000-7000-8000-000000000201',
  eventId: '0194b000-0000-7000-8000-000000000301',
  accountId: '0194b000-0000-7000-8000-000000000401',
  amount: 66_000,
  requiredAtMs: kst('2026-11-24T15:00:00'),
  sentCount: 0,
  ...over,
});
const decode = (m: { payload: Uint8Array }) => JSON.parse(Buffer.from(m.payload).toString('utf8')) as Record<string, unknown>;

describe('R-T20 ② 계좌 요청 훑기', () => {
  test('R-T20 ② 첫 요청은 그 틱에 나가고 다음 시각을 남긴다', async () => {
    const App = await loadApp();
    const refunds = new FakeSource([row()]);
    const app = new App({ refunds, compensations: new FakeSource([]), calendar: calendar(), clock: { now: () => kst('2026-11-24T15:00:10') } });
    const r = await app.run(50);
    expect(r).toMatchObject({ sent: 1 });
    expect(refunds.claimed).toHaveLength(1);
    const payload = decode(refunds.claimed[0]!.outbox);
    expect(refunds.claimed[0]!.outbox.topic).toBe('trade.orders');
    expect(payload).toMatchObject({ type: 'REFUND_ACCOUNT_REQUESTED', cancellationId: row().id, orderId: row().orderId, eventId: row().eventId, accountId: row().accountId, refundAmount: 66_000 });
    expect(payload.eventKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(refunds.claimed[0]!.nextAtMs).toBe(kst('2026-11-25T10:00:00'));
    expect(JSON.stringify(payload)).not.toMatch(/123-456|계좌번호/);
  });

  test('R-T20 ② 같은 회차는 두 번 보내지 않고 다음 영업일 10:00에 다시 본다', async () => {
    const App = await loadApp();
    const refunds = new FakeSource([row()]);
    const app = new App({ refunds, compensations: new FakeSource([]), calendar: calendar(), clock: { now: () => kst('2026-11-24T15:00:10') } });
    await app.run(50);
    await app.run(50);
    expect(refunds.claimed).toHaveLength(1);
    expect(refunds.rows[0]!.sentCount).toBe(1);
    expect(await new App({ refunds, compensations: new FakeSource([]), calendar: calendar(), clock: { now: () => kst('2026-11-25T09:59:59.999') } }).run(50)).toMatchObject({ sent: 0 });
    const due = await new App({ refunds, compensations: new FakeSource([]), calendar: calendar(), clock: { now: () => kst('2026-11-25T10:00:00') } }).run(50);
    expect(due).toMatchObject({ sent: 1 });
    expect(refunds.claimed).toHaveLength(2);
  });

  test('R-T20 ② 배상 대기 요청은 배상 종류와 배상 ID를 싣는다', async () => {
    const App = await loadApp();
    const compensations = new FakeSource([row({ id: '0194b000-0000-7000-8000-000000000501', amount: 4_750 })]);
    const app = new App({ refunds: new FakeSource([]), compensations, calendar: calendar(), clock: { now: () => kst('2026-11-24T15:00:10') } });
    expect(await app.run(50)).toMatchObject({ sent: 1 });
    const payload = decode(compensations.claimed[0]!.outbox);
    expect(payload).toMatchObject({ type: 'COMPENSATION_ACCOUNT_REQUESTED', compensationId: '0194b000-0000-7000-8000-000000000501', refundAmount: 4_750 });
    expect(payload).not.toHaveProperty('cancellationId');
  });

  test('R-T20 ② 다른 파드가 먼저 보냈으면(claim 0행) 세지 않고 보내지 않는다', async () => {
    const App = await loadApp();
    const refunds = new FakeSource([row()]);
    refunds.failClaim = true;
    const app = new App({ refunds, compensations: new FakeSource([]), calendar: calendar(), clock: { now: () => kst('2026-11-24T15:00:10') } });
    expect(await app.run(50)).toMatchObject({ sent: 0, skipped: 1 });
    expect(refunds.rows[0]!.sentCount).toBe(0);
  });

  test('R-T20 ② 한 행이 실패해도 다른 행은 이어 간다', async () => {
    const App = await loadApp();
    const refunds = new FakeSource([row({ id: 'a' }), row({ id: 'b' })]);
    let calls = 0;
    const claim = refunds.claim.bind(refunds);
    refunds.claim = async (i) => {
      calls += 1;
      if (calls === 1) throw new Error('db down');
      return claim(i);
    };
    const app = new App({ refunds, compensations: new FakeSource([]), calendar: calendar(), clock: { now: () => kst('2026-11-24T15:00:10') } });
    const r = await app.run(50);
    expect(r.sent).toBe(1);
    expect(refunds.claimed).toHaveLength(1);
  });
});
