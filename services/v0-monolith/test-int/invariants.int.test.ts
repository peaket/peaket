// v0 결제 뒤 불변식 검사(docs/features/payment.md §13 '불변식 검사', docs/verification.md §2.5, K7·NFR-006).
// 실제 결제(동기 결제 체인)로 v0 DB를 채운 뒤 빌드된 검사기 명령(peaket-invariants, services/invariant-checker/dist/cli.js)을
// 자식 프로세스로 돌린다. 검사 연결은 v0 DB 그대로, 원본 셋은 v0 DB 주소 + search_path=v0_check(뷰 묶음)이고,
// 결제사 원장은 시뮬레이터 GET /sim/ledger 본문이다. 결과 invariants.csv의 S1·S4·P1~P6을 본다.
// 이 파일은 컨테이너를 따로 띄우므로 DB에는 이 파일의 결제만 있다. 시험은 차례로 돈다(둘째가 첫째의 결제 위에 하나를 더한다).
// 셋째는 뷰 묶음(v0_check)이 v0 표를 검사기 칸으로 옮기는 규칙(상태 매핑·md5 UUID)을 회차 하나로 좁혀 직접 본다.
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { expectProblem } from './queue-harness.js';
import { INVARIANT_CLI, SaleHarness, cmp, md5Uuid, runInvariantChecker, sleep, waitUntil, type InvariantRun, type LedgerRecord } from './sale-harness.js';

let h: SaleHarness;

beforeAll(async () => {
  // 검사기 빌드가 없으면 컨테이너를 띄우기 전에 분명히 실패한다
  if (!existsSync(INVARIANT_CLI)) {
    throw new Error(`불변식 검사기 명령이 없다: ${INVARIANT_CLI}. 먼저 'pnpm --filter @peaket/invariant-checker build'로 빌드한다`);
  }
  h = await SaleHarness.start();
});

afterAll(async () => {
  await h?.close();
});

/** v0가 판정하는 불변식(payment §13): 좌석 오버셀·1인 한도·이중 결제·결제-발권 불일치 */
const V0_INVARIANTS = ['S1', 'S4', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

const describeRun = (run: InvariantRun) => `종료 코드 ${run.code}\n${run.stdout}${run.stderr}`;

/** 검사기가 읽는 뷰(v0_check)에 이 시험의 행이 실제로 보이는지(PASS가 빈 표의 통과가 아닌지) */
async function viewCounts(): Promise<Record<string, number>> {
  const q = async (sql: string) => Number((await h.inspect.query<{ n: string }>(sql)).rows[0]!.n);
  return {
    purchase_order: await q('select count(*) as n from v0_check.purchase_order'),
    order_event: await q('select count(*) as n from v0_check.order_event'),
    order_item: await q('select count(*) as n from v0_check.order_item'),
    seat_sale_sold: await q("select count(*) as n from v0_check.seat_sale where status = 'SOLD'"),
    seat_sale_returned: await q("select count(*) as n from v0_check.seat_sale where status = 'RETURNED'"),
    purchase_quota: await q('select count(*) as n from v0_check.purchase_quota where used > 0'),
    payment_approved: await q("select count(*) as n from v0_check.payment where status = 'APPROVED' and approved_at is not null"),
    payment_failed: await q("select count(*) as n from v0_check.payment where status = 'FAILED'"),
    ticket: await q("select count(*) as n from v0_check.ticket where status = 'ISSUED'"),
  };
}

const parseLedger = (text: string): LedgerRecord[] =>
  text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerRecord);

describe('불변식 검사기(peaket-invariants)', () => {
  test('NFR006_K7_정상결제몇건과거절1건과결제전주문뒤에검사기를돌리면_S1S4P1~P6이모두PASS이고종료코드0이다 [ASVS v5.0.0-2.3.4]', { timeout: 120_000 }, async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['inv1', 'inv2', 'inv3']);
    await h.buy(e, 'inv1', ['R-1', 'R-2']);
    await h.buy(e, 'inv2', ['S-1']);
    await h.buy(e, 'inv3', ['R-3', 'S-2', 'S-3']);
    // 승인 거절 1건(좌석을 돌려준다)
    const declined = await h.prepareOrder(e, 'inv2', ['R-4']);
    await h.addFault({ op: 'confirm', kind: 'decline', code: 'REJECT_CARD_COMPANY', orderId: declined.order.orderId });
    expectProblem(await h.pay(declined.order.orderId, { paymentKey: declined.paymentKey, amount: declined.order.amount }, declined.headers), 422, 'payment-declined');
    // 결제하지 않은 주문(CREATED, 좌석은 아직 홀드)
    await h.prepareOrder(e, 'inv1', ['S-4']);

    const ledgerText = await h.ledgerText();
    expect(parseLedger(ledgerText)).toHaveLength(3);
    expect(await viewCounts()).toEqual({
      purchase_order: 5,
      order_event: 4 * 3 + 3 + 1,
      order_item: 2 + 1 + 3 + 1 + 1,
      seat_sale_sold: 6,
      seat_sale_returned: 1,
      purchase_quota: 3,
      payment_approved: 3,
      payment_failed: 1,
      ticket: 6,
    });

    const run = await runInvariantChecker({ databaseUrl: h.databaseUrl, ledgerNdjson: ledgerText });
    for (const id of V0_INVARIANTS) expect(run.byId[id], `${id}\n${describeRun(run)}`).toMatchObject({ id, result: 'PASS', violations: '0' });
    expect(run.rows.filter((r) => r.result === 'FAIL').map((r) => r.id), describeRun(run)).toEqual([]);
    expect(run.code, describeRun(run)).toBe(0);
  });

  test('K7_NFR006_승인응답을잃은결제1건을더하면_P6만FAIL위반1이고나머지는PASS이며종료코드1이다', { timeout: 120_000 }, async () => {
    const e = await h.openSaleEvent();
    await h.admit(e, ['inv4', 'inv5']);
    await h.buy(e, 'inv4', ['R-1']);
    const lost = await h.prepareOrder(e, 'inv5', ['S-1', 'S-2']);
    await h.addFault({ op: 'confirm', kind: 'drop', applied: true, orderId: lost.order.orderId });
    expectProblem(await h.pay(lost.order.orderId, { paymentKey: lost.paymentKey, amount: lost.order.amount }, lost.headers), 502, 'payment-failed');
    await h.clearFaults();

    const ledgerText = await h.ledgerText();
    const lostCharge = parseLedger(ledgerText).find((r) => r.order_ref === lost.order.orderId);
    expect(lostCharge, '결제사 원장에 잃은 결제의 승인이 있어야 한다').toMatchObject({ payment_ref: lost.paymentKey, amount: lost.order.amount, status: 'DONE' });
    expect((await h.paymentRows(lost.order.orderId)).map((p) => [p.status, p.approvedAtMs])).toEqual([['FAILED', null]]);

    // P6은 결제사 승인 뒤 정한 시간(여기서는 1초)이 지난 것만 센다. 검사 시각은 실제 시계라, 가짜 시계가 실제보다 앞서 있으면 그만큼 기다린다
    const due = Date.parse(lostCharge!.approved_at!) + 1_000 + 500;
    const wait = due - Date.now();
    expect(wait, '가짜 시계가 실제 시계보다 너무 앞서 있다').toBeLessThan(20_000);
    if (wait > 0) await sleep(wait);

    const run = await runInvariantChecker({ databaseUrl: h.databaseUrl, ledgerNdjson: ledgerText, enqueueWithinSec: 1 });
    expect(run.byId.P6, describeRun(run)).toMatchObject({ id: 'P6', result: 'FAIL', violations: '1' });
    for (const id of V0_INVARIANTS.filter((x) => x !== 'P6')) expect(run.byId[id], `${id}\n${describeRun(run)}`).toMatchObject({ id, result: 'PASS', violations: '0' });
    expect(run.rows.filter((r) => r.result === 'FAIL').map((r) => r.id), describeRun(run)).toEqual(['P6']);
    expect(run.code, describeRun(run)).toBe(1);
  });

  // 위 두 시험의 개수에 섞이지 않게 맨 뒤에 둔다(이 시험은 회차 하나로 좁혀 본다)
  test('NFR006_K7_불변식뷰는v0표를검사기칸으로옮겨_PAYING좌석은PENDING이고APPROVED와CONFIRMED는SOLD이며FAILED는RETURNED이고CREATED는빠지며_회차좌석계정ID는md5UUID다 [ASVS v5.0.0-2.3.4]', { timeout: 120_000 }, async () => {
    const e = await h.openSaleEvent({ limit: 4 });
    await h.admit(e, ['vw-created', 'vw-confirmed', 'vw-failed', 'vw-approved', 'vw-paying']);
    // CREATED(결제 전), CONFIRMED, FAILED(거절), APPROVED(발권 실패로 남음), PAYING(결제사 응답을 기다리는 중)
    const created = await h.prepareOrder(e, 'vw-created', ['S-4']);
    const confirmed = await h.buy(e, 'vw-confirmed', ['R-1', 'R-2']);
    const failed = await h.prepareOrder(e, 'vw-failed', ['S-1']);
    await h.addFault({ op: 'confirm', kind: 'decline', code: 'REJECT_CARD_COMPANY', orderId: failed.order.orderId });
    expectProblem(await h.pay(failed.order.orderId, { paymentKey: failed.paymentKey, amount: failed.order.amount }, failed.headers), 422, 'payment-declined');
    const approved = await h.prepareOrder(e, 'vw-approved', ['R-3']);
    const unblock = await h.blockTicketsFor(e);
    try {
      expect((await h.pay(approved.order.orderId, { paymentKey: approved.paymentKey, amount: approved.order.amount }, approved.headers)).status).toBe(500);
    } finally {
      await unblock();
    }
    const paying = await h.prepareOrder(e, 'vw-paying', ['S-2', 'S-3']);
    // 결제사가 3초 뒤에 답한다. 그동안 주문은 PAYING, 결제 행은 CONFIRMING이다
    await h.addFault({ op: 'confirm', kind: 'delay', ms: 3_000, orderId: paying.order.orderId });
    const inFlight = h.pay(paying.order.orderId, { paymentKey: paying.paymentKey, amount: paying.order.amount }, paying.headers);
    try {
      await waitUntil(() => h.confirmCallsOf(paying.order.orderId).length === 1, 5_000, '결제사 승인 호출');
      expect((await h.orderRow(paying.order.orderId))?.status).toBe('PAYING');

      const ev = md5Uuid(e);
      const seat = (s: string) => md5Uuid(`${e}:${s}`);
      const account = (pid: string) => md5Uuid(`acc-${pid}`);
      const rows = async (sql: string, args: unknown[] = [ev]) => (await h.inspect.query(sql, args)).rows as Record<string, unknown>[];
      const byJson = (xs: Record<string, unknown>[]) => [...xs].sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b)));

      // seat_sale: 주문 좌석에서 만든 판매. CREATED 주문의 좌석(S-4)은 없다
      expect(byJson(await rows('select event_id, seat_id, order_id, status from v0_check.seat_sale where event_id = $1'))).toEqual(
        byJson([
          { event_id: ev, seat_id: seat('R-1'), order_id: confirmed.order.orderId, status: 'SOLD' },
          { event_id: ev, seat_id: seat('R-2'), order_id: confirmed.order.orderId, status: 'SOLD' },
          { event_id: ev, seat_id: seat('S-1'), order_id: failed.order.orderId, status: 'RETURNED' },
          { event_id: ev, seat_id: seat('R-3'), order_id: approved.order.orderId, status: 'SOLD' },
          { event_id: ev, seat_id: seat('S-2'), order_id: paying.order.orderId, status: 'PENDING' },
          { event_id: ev, seat_id: seat('S-3'), order_id: paying.order.orderId, status: 'PENDING' },
        ]),
      );
      // purchase_order: 주문 그대로(CREATED 포함), 계정·회차는 md5 UUID, 금액은 bigint(pg가 글로 준다)
      const orders = [
        [created, 'vw-created', 'CREATED'],
        [confirmed, 'vw-confirmed', 'CONFIRMED'],
        [failed, 'vw-failed', 'FAILED'],
        [approved, 'vw-approved', 'APPROVED'],
        [paying, 'vw-paying', 'PAYING'],
      ] as const;
      const orderRows = await rows('select id, account_id, event_id, status, amount, created_at from v0_check.purchase_order where event_id = $1');
      expect(byJson(orderRows.map((r) => ({ ...r, created_at: (r.created_at as Date).getTime() })))).toEqual(
        byJson(
          await Promise.all(
            orders.map(async ([o, pid, status]) => ({
              id: o.order.orderId,
              account_id: account(pid),
              event_id: ev,
              status,
              amount: String(o.order.amount),
              created_at: (await h.orderRow(o.order.orderId))!.createdAtMs,
            })),
          ),
        ),
      );
      // order_item: 좌석은 '회차:좌석'의 md5 UUID, 티켓 ID는 발권한 것만
      const ids = orders.map(([o]) => o.order.orderId);
      const items = await rows('select order_id, line_no, seat_id, ticket_id from v0_check.order_item where order_id = any($1::uuid[])', [ids]);
      const expectedItems: Record<string, unknown>[] = [];
      for (const id of ids) {
        for (const i of await h.orderItems(id)) expectedItems.push({ order_id: id, line_no: i.lineNo, seat_id: seat(i.seatId), ticket_id: i.ticketId });
      }
      expect(byJson(items)).toEqual(byJson(expectedItems));
      expect(expectedItems.filter((i) => i.ticket_id !== null)).toHaveLength(2);
      // order_event: 이력 그대로
      const events = await rows('select order_id, seq, to_status from v0_check.order_event where order_id = any($1::uuid[])', [ids]);
      const expectedEvents: Record<string, unknown>[] = [];
      for (const id of ids) for (const [seq, to] of await h.orderTrail(id)) expectedEvents.push({ order_id: id, seq, to_status: to });
      expect(byJson(events)).toEqual(byJson(expectedEvents));
      // payment: 결제 행 그대로(결제 전 주문은 없다, 기다리는 중은 CONFIRMING)
      const pays = await rows('select id, order_id, event_id, pg, amount, status, approved_at from v0_check.payment where event_id = $1');
      const expectedPays: Record<string, unknown>[] = [];
      for (const id of ids) {
        for (const p of await h.paymentRows(id)) {
          expectedPays.push({ id: p.paymentId, order_id: id, event_id: ev, pg: 'SIMULATOR', amount: String(p.amount), status: p.status, approved_at: p.approvedAtMs });
        }
      }
      expect(byJson(pays.map((p) => ({ ...p, approved_at: p.approved_at === null ? null : (p.approved_at as Date).getTime() })))).toEqual(byJson(expectedPays));
      expect(expectedPays.map((p) => p.status).sort()).toEqual(['APPROVED', 'APPROVED', 'CONFIRMING', 'FAILED']);
      // ticket: 발권한 티켓(좌석은 md5 UUID)
      expect(byJson(await rows('select id, event_id, seat_id, status from v0_check.ticket where event_id = $1'))).toEqual(
        byJson((await h.ticketRows({ eventId: e })).map((t) => ({ id: t.ticketId, event_id: ev, seat_id: seat(t.seatId), status: 'ISSUED' }))),
      );
      // purchase_quota: 판 좌석 수와 1인 한도. event_sale: 회차의 좌석 수
      expect(byJson(await rows('select account_id, event_id, used, limit_count from v0_check.purchase_quota where event_id = $1'))).toEqual(
        byJson(
          [
            ['vw-created', 0],
            ['vw-confirmed', 2],
            ['vw-failed', 0],
            ['vw-approved', 1],
            ['vw-paying', 2],
          ].map(([pid, used]) => ({ account_id: account(pid as string), event_id: ev, used, limit_count: 4 })),
        ),
      );
      expect(await rows('select event_id, sellable_seats from v0_check.event_sale where event_id = $1')).toEqual([{ event_id: ev, sellable_seats: 8 }]);
      // v0에 없는 것은 빈 뷰다
      for (const v of ['ticket_issue_job', 'payment_cancel', 'order_cancellation']) {
        expect(await rows(`select count(*)::int as n from v0_check.${v}`, []), v).toEqual([{ n: 0 }]);
      }
    } finally {
      // 기다리던 결제가 끝나면 그 좌석은 SOLD가 된다
      const done = await inFlight;
      expect(done.status, done.raw).toBe(200);
    }
    expect((await h.inspect.query("select count(*)::int as n from v0_check.seat_sale where order_id = $1 and status = 'SOLD'", [paying.order.orderId])).rows).toEqual([{ n: 2 }]);
  });
});
