// 발권·검표 v0(docs/features/offline-gate.md §13) 통합 시험. 검표는 온라인 전용이다(K10의 v0): 스캐너가 찍을 때마다 서버에 코드를 보내
// 판정을 받는다. 티켓은 실제 결제 확정(동기 결제 체인, payment §13)으로 발권한다. 실제 PostgreSQL 18·Valkey 컨테이너 + 모놀리스 HTTP(inject)
// + 프로세스 안 PG 시뮬레이터. 시계만 가짜(fakeClock)다. 스태프 배정은 모듈 공개 함수(createTicketAdmin)로 한다.
// 검표 요청의 신원 머리는 팬 대상(x-user-aud fan)의 계정·세션이다. 스캐너 대상 역할은 기기 증명(GAT-170) 전에는 플랫폼이 서비스 시작을 막으므로
// v0 검표는 팬 대상 신원으로 받고 스코프·pid는 보지 않는다. 역할은 토큰에 넣지 않고 요청마다 v0_gate_staff로 본다(offline-gate §13 동작 2, FND-010).
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTicketIssuer } from '../src/modules/ticket/index.js';
import { JSON_CONTENT_TYPE, expectProblem, fanHeaders, type Headers } from './queue-harness.js';
import { SaleHarness, TICKET_CODE_SHAPE, cmp, expectStatus, staffHeaders, sleep, type OrderBody } from './sale-harness.js';
import { refKst } from './seat-harness.js';

let h: SaleHarness;

beforeAll(async () => {
  h = await SaleHarness.start();
});

afterAll(async () => {
  await h?.close();
});

type Ticket = OrderBody['tickets'][number];

/** 회차를 열고 스태프를 배정한 뒤 팬 한 명이 좌석을 사서 티켓을 받는다 */
async function eventWithTickets(o: { pid: string; seats: string[]; staff?: string[] }): Promise<{ eventId: string; tickets: Ticket[]; buyer: string }> {
  const eventId = await h.openSaleEvent();
  if (o.staff?.length) await h.ticketAdmin.assignStaff(eventId, o.staff);
  await h.admit(eventId, [o.pid]);
  const { paid } = await h.buy(eventId, o.pid, o.seats);
  return { eventId, tickets: [...paid.tickets].sort((a, b) => cmp(a.seatId, b.seatId)), buyer: `acc-${o.pid}` };
}

/** 티켓의 입장 칸(entered_at·entered_by) */
async function entry(code: string): Promise<{ enteredAtMs: number | null; enteredBy: string | null }> {
  const t = await h.ticketByCode(code);
  if (!t) throw new Error('시험: 표에 없는 티켓 코드');
  return { enteredAtMs: t.enteredAtMs, enteredBy: t.enteredBy };
}

const NOT_ENTERED = { enteredAtMs: null, enteredBy: null };

/** 형식은 맞지만 발권하지 않은 코드 */
const unknownCode = () => randomBytes(16).toString('base64url');

// ───────────────────────── 발권(§13 동작 1, FR-012) ─────────────────────────

describe('발권', () => {
  test('FR012_결제가확정되면좌석마다티켓이하나씩생기고_코드는22자base64url로서로다르며_같은주문좌석으로다시발권하면있던티켓을준다 [ASVS v5.0.0-11.5.1]', async () => {
    const seats = ['R-1', 'R-2', 'R-3', 'S-1'];
    const { eventId, tickets, buyer } = await eventWithTickets({ pid: 'is1', seats });
    expect(tickets.map((t) => t.seatId)).toEqual([...seats].sort(cmp));
    for (const t of tickets) {
      expect(t.code).toMatch(TICKET_CODE_SHAPE);
      expect(Buffer.from(t.code, 'base64url').length).toBe(16);
    }
    expect(new Set(tickets.map((t) => t.code)).size).toBe(seats.length);
    const rows = await h.ticketRows({ eventId });
    expect(rows.map((r) => ({ ticketId: r.ticketId, seatId: r.seatId, code: r.code, accountId: r.accountId, status: r.status }))).toEqual(
      tickets.map((t) => ({ ...t, accountId: buyer, status: 'ISSUED' })),
    );
    // 같은 주문·좌석으로 다시 부르면 새로 만들지 않고 있던 티켓을 준다(결과는 좌석 순서)
    const orderId = rows[0]!.orderId;
    const issuer = createTicketIssuer(h.database);
    const order = (await h.orderRow(orderId))!;
    const again = await issuer.issue({ orderId, eventId, accountId: buyer, seatIds: order.seatIds, nowMs: h.clock.now() + 60_000 });
    expect(again).toEqual(order.seatIds.map((seatId) => tickets.find((t) => t.seatId === seatId)));
    expect(await h.ticketRows({ eventId })).toEqual(rows);
    expect(await issuer.ticketsOf(orderId)).toEqual(expect.arrayContaining(tickets));
    expect(await issuer.ticketsOf(randomUUID())).toEqual([]);
  });
});

// ───────────────────────── 검표(§13 동작 2, FR-035, K10) ─────────────────────────

describe('검표 POST /v0/events/{eventId}/scans', () => {
  test('FR035_K10_배정된스태프가처음찍으면200ADMIT이고티켓ID좌석입장시각이며_표에입장시각과찍은스태프가남는다 [ASVS v5.0.0-8.2.1]', async () => {
    const { eventId, tickets } = await eventWithTickets({ pid: 'sc1', seats: ['R-1'], staff: ['staff-a1', 'staff-b1'] });
    const t = tickets[0]!;
    h.clock.advance(60_000);
    const t1 = h.clock.now();
    const r = await h.scan(eventId, { code: t.code }, staffHeaders('staff-a1'));
    expect({ status: r.status, contentType: r.contentType }, r.raw).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    expect(r.body).toEqual({ result: 'ADMIT', ticketId: t.ticketId, seatId: 'R-1', enteredAt: refKst(t1) });
    expect(r.raw).not.toContain(t.code);
    expect(await entry(t.code)).toEqual({ enteredAtMs: t1, enteredBy: 'staff-a1' });
  });

  test('OT23_FR035_K10_스캐너A가통과시킨티켓을2분뒤스캐너B가찍으면ALREADY_ENTERED이고_첫입장시각과스태프가그대로다', async () => {
    const { eventId, tickets } = await eventWithTickets({ pid: 'sc2', seats: ['S-1', 'S-2'], staff: ['staff-a2', 'staff-b2'] });
    const t = tickets[0]!;
    const t1 = h.clock.now();
    const first = await h.scan(eventId, { code: t.code }, staffHeaders('staff-a2'));
    expect(first.body).toEqual({ result: 'ADMIT', ticketId: t.ticketId, seatId: t.seatId, enteredAt: refKst(t1) });
    h.clock.advance(2 * 60_000);
    const second = await h.scan(eventId, { code: t.code }, staffHeaders('staff-b2'));
    expect({ status: second.status, contentType: second.contentType }, second.raw).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    expect(second.body).toEqual({ result: 'ALREADY_ENTERED', ticketId: t.ticketId, seatId: t.seatId, enteredAt: refKst(t1) });
    // 같은 스캐너가 다시 찍어도 같다
    const third = await h.scan(eventId, { code: t.code }, staffHeaders('staff-a2', { session: 'ses-staff-a2-relogin' }));
    expect(third.body).toEqual({ result: 'ALREADY_ENTERED', ticketId: t.ticketId, seatId: t.seatId, enteredAt: refKst(t1) });
    expect(await entry(t.code)).toEqual({ enteredAtMs: t1, enteredBy: 'staff-a2' });
    // 같은 주문의 다른 티켓은 따로 판정한다
    const other = await h.scan(eventId, { code: tickets[1]!.code }, staffHeaders('staff-b2'));
    expect(other.body).toMatchObject({ result: 'ADMIT', ticketId: tickets[1]!.ticketId });
  });

  test('OT23_K10_같은코드를여러스캐너가동시에찍어도ADMIT은하나이고_나머지는같은입장시각의ALREADY_ENTERED다 [ASVS v5.0.0-2.3.4]', async () => {
    const staff = ['staff-c1', 'staff-c2', 'staff-c3', 'staff-c4'];
    const { eventId, tickets } = await eventWithTickets({ pid: 'sc3', seats: ['R-1', 'R-2', 'R-3'], staff });
    for (const t of tickets) {
      const who = Array.from({ length: 8 }, (_, i) => staff[i % staff.length]!);
      const rs = await Promise.all(who.map((s) => h.scan(eventId, { code: t.code }, staffHeaders(s))));
      expect(rs.map((r) => r.status), rs.map((r) => r.raw).join(' | ')).toEqual(who.map(() => 200));
      const admits = rs.map((r, i) => (r.body?.result === 'ADMIT' ? i : -1)).filter((i) => i >= 0);
      expect(admits, rs.map((r) => r.raw).join(' | ')).toHaveLength(1);
      expect(rs.filter((r) => r.body?.result === 'ALREADY_ENTERED')).toHaveLength(who.length - 1);
      const enteredAt = rs[admits[0]!]!.body.enteredAt as string;
      for (const r of rs) expect(r.body).toEqual({ result: r.body.result, ticketId: t.ticketId, seatId: t.seatId, enteredAt });
      expect(await entry(t.code)).toEqual({ enteredAtMs: Date.parse(enteredAt), enteredBy: who[admits[0]!] });
    }
  });

  test('FR035_없는코드는INVALID이고_다른회차티켓은WRONG_EVENT이며_둘다티켓의다른값을싣지않고입장으로남기지않는다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-14.1.1]', async () => {
    const a = await eventWithTickets({ pid: 'sc4', seats: ['R-1'], staff: ['staff-d1'] });
    const b = await eventWithTickets({ pid: 'sc5', seats: ['S-1'], staff: ['staff-d1'] });
    const t = a.tickets[0]!;
    // 형식은 맞는 없는 코드: 1자(경계)·64자(경계)·발권한 코드의 앞 21자·바꾼 한 자
    const flipped = `${t.code.slice(0, -1)}${t.code.endsWith('A') ? 'B' : 'A'}`;
    for (const code of [unknownCode(), 'a', '-', 'abc', 'x'.repeat(64), t.code.slice(0, -1), flipped, t.code.toLowerCase() === t.code ? t.code.toUpperCase() : t.code.toLowerCase()]) {
      const r = await h.scan(a.eventId, { code }, staffHeaders('staff-d1'));
      expect({ status: r.status, contentType: r.contentType }, r.raw).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
      expect(r.body).toEqual({ result: 'INVALID' });
    }
    const wrong = await h.scan(b.eventId, { code: t.code }, staffHeaders('staff-d1'));
    expect({ status: wrong.status, contentType: wrong.contentType }, wrong.raw).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    expect(wrong.body).toEqual({ result: 'WRONG_EVENT' });
    for (const secret of [t.code, t.ticketId, t.seatId, a.buyer, a.eventId]) expect(wrong.raw).not.toContain(secret);
    expect(await entry(t.code)).toEqual(NOT_ENTERED);
    // 맞는 회차에서는 처음 입장이다
    expect((await h.scan(a.eventId, { code: t.code }, staffHeaders('staff-d1'))).body).toMatchObject({ result: 'ADMIT', ticketId: t.ticketId });
  });

  test('FR035_배정되지않은스태프와다른회차에만배정된스태프는403배정안됨이고_코드가맞든틀리든판정하지않으며입장으로남기지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const a = await eventWithTickets({ pid: 'sc6', seats: ['R-1'], staff: ['staff-e1'] });
    const other = await h.openSaleEvent();
    await h.ticketAdmin.assignStaff(other, ['staff-elsewhere']);
    const t = a.tickets[0]!;
    for (const who of ['staff-nobody', 'staff-elsewhere', 'acc-sc6']) {
      for (const code of [t.code, unknownCode()]) {
        const r = await h.scan(a.eventId, { code }, staffHeaders(who));
        expectProblem(r, 403, 'not-assigned');
        expect(r.raw).not.toContain(code);
        expect(r.raw).not.toContain(t.ticketId);
      }
    }
    expect(await entry(t.code)).toEqual(NOT_ENTERED);
  });

  test('FR035_배정은요청마다DB로판정해_배정하자마자통과하고배정을지우면바로403이며_같은배정을다시넣어도그대로다 [ASVS v5.0.0-8.2.1]', async () => {
    const { eventId, tickets } = await eventWithTickets({ pid: 'sc7', seats: ['R-1', 'R-2', 'R-3'] });
    expectProblem(await h.scan(eventId, { code: tickets[0]!.code }, staffHeaders('staff-late')), 403, 'not-assigned');
    await h.ticketAdmin.assignStaff(eventId, ['staff-late']);
    await h.ticketAdmin.assignStaff(eventId, ['staff-late']);
    const staffRows = await h.inspect.query('select account_id from v0_gate_staff where event_id = $1', [eventId]);
    expect(staffRows.rows).toEqual([{ account_id: 'staff-late' }]);
    expect((await h.scan(eventId, { code: tickets[0]!.code }, staffHeaders('staff-late'))).body).toMatchObject({ result: 'ADMIT' });
    // 배정을 지우면(시험이 표에서 직접 지운다) 다음 요청부터 막힌다(토큰·캐시에 역할을 두지 않는다)
    await h.inspect.query('delete from v0_gate_staff where event_id = $1 and account_id = $2', [eventId, 'staff-late']);
    expectProblem(await h.scan(eventId, { code: tickets[1]!.code }, staffHeaders('staff-late')), 403, 'not-assigned');
    expect(await entry(tickets[1]!.code)).toEqual(NOT_ENTERED);
    await h.ticketAdmin.assignStaff(eventId, ['staff-late']);
    expect((await h.scan(eventId, { code: tickets[1]!.code }, staffHeaders('staff-late'))).body).toMatchObject({ result: 'ADMIT' });
  });

  test('FR035_검표는팬대상신원만받아_스캐너와파트너와관제대상과모르는대상과신원없음과세션없음과계정없음은배정된계정이라도401이고입장으로남기지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const { eventId, tickets } = await eventWithTickets({ pid: 'sc8', seats: ['R-1'], staff: ['staff-f1'] });
    const code = tickets[0]!.code;
    // 스캐너 대상 역할은 기기 증명(GAT-170) 전에는 쓰지 않는다. 배정된 계정이라도 스캐너 대상 신원 머리로는 401이다(offline-gate §13 동작 2)
    const cases: [string, Headers][] = [
      ['신원 머리 없음', {}],
      ['스캐너 대상(배정된 계정)', staffHeaders('staff-f1', { aud: 'scanner' })],
      ['스캐너 대상에 스코프·pid', staffHeaders('staff-f1', { aud: 'scanner', scope: 'ticket:buy', pid: 'staff-f1-pid' })],
      ['파트너 대상', staffHeaders('staff-f1', { aud: 'partner' })],
      ['관제 대상', staffHeaders('staff-f1', { aud: 'ops' })],
      ['모르는 대상', staffHeaders('staff-f1', { aud: 'gate' })],
      ['세션 없음', { 'x-user-id': 'staff-f1', 'x-user-aud': 'fan' }],
      ['계정 없음', { 'x-session-id': 'ses-x', 'x-user-aud': 'fan' }],
      ['대상 없음', { 'x-user-id': 'staff-f1', 'x-session-id': 'ses-staff-f1' }],
    ];
    for (const [label, headers] of cases) {
      const r = await h.scan(eventId, { code }, headers);
      expectStatus(r, 401, label);
      expect(r.raw).not.toContain(code);
      expect(r.raw).not.toContain(tickets[0]!.ticketId);
    }
    expect(await entry(code)).toEqual(NOT_ENTERED);
    // 같은 계정의 팬 대상 신원으로는 판정한다(막힌 시도가 티켓을 망가뜨리지 않았다)
    expect((await h.scan(eventId, { code }, staffHeaders('staff-f1'))).body).toMatchObject({ result: 'ADMIT', ticketId: tickets[0]!.ticketId });
  });

  test('FR035_팬대상신원이면스코프와pid를보지않고게이트웨이계정의배정만본다_배정된계정은스코프나pid가없거나있어도판정받고_배정안된팬신원은403이다 [ASVS v5.0.0-8.2.1]', async () => {
    const { eventId, tickets, buyer } = await eventWithTickets({ pid: 'sf1', seats: ['R-1', 'R-2', 'R-3', 'S-1'], staff: ['staff-f2'] });
    const [t1, t2, t3, t4] = tickets as [Ticket, Ticket, Ticket, Ticket];
    const at = h.clock.now();
    // 스코프·pid 없음(기본), ticket:buy와 pid 있음, 다른 스코프만 있음: 모두 배정된 계정이라 판정을 받는다
    const ok: [string, Headers, Ticket][] = [
      ['스코프·pid 없음', staffHeaders('staff-f2'), t1],
      ['ticket:buy와 pid', staffHeaders('staff-f2', { scope: 'ticket:buy', pid: 'staff-f2-pid' }), t2],
      ['다른 스코프만', staffHeaders('staff-f2', { scope: 'ticket:read' }), t3],
    ];
    for (const [label, headers, t] of ok) {
      const r = await h.scan(eventId, { code: t.code }, headers);
      expect({ label, status: r.status, contentType: r.contentType, body: r.body }, r.raw).toEqual({
        label,
        status: 200,
        contentType: JSON_CONTENT_TYPE,
        body: { result: 'ADMIT', ticketId: t.ticketId, seatId: t.seatId, enteredAt: refKst(at) },
      });
      // 찍은 스태프는 게이트웨이가 넘긴 계정 ID다(pid가 아니다)
      expect(await entry(t.code), label).toEqual({ enteredAtMs: at, enteredBy: 'staff-f2' });
    }
    // 팬 대상이지만 배정되지 않은 계정: 구매자 본인, 배정된 계정의 pid만 같은 다른 계정, 모르는 계정
    const denied: [string, Headers][] = [
      ['구매자 팬 신원', fanHeaders('sf1')],
      ['pid만 배정된 계정과 같음', staffHeaders('staff-other', { scope: 'ticket:buy', pid: 'staff-f2' })],
      ['배정 안 된 계정', staffHeaders('staff-nobody-2')],
    ];
    for (const [label, headers] of denied) {
      const r = await h.scan(eventId, { code: t4.code }, headers);
      expectProblem(r, 403, 'not-assigned');
      expect(r.raw, label).not.toContain(t4.code);
      expect(r.raw, label).not.toContain(t4.ticketId);
    }
    expect(buyer).toBe('acc-sf1');
    expect(await entry(t4.code)).toEqual(NOT_ENTERED);
  });

  test('FR035_코드형식이틀리거나허용밖칸이있으면400이고_입장으로남기지않으며오류문구에코드가없다 [ASVS v5.0.0-2.2.1]', async () => {
    const { eventId, tickets } = await eventWithTickets({ pid: 'sc9', seats: ['R-1'], staff: ['staff-g1'] });
    const code = tickets[0]!.code;
    const bodies: [string, unknown][] = [
      ['빈 코드', { code: '' }],
      ['65자', { code: 'x'.repeat(65) }],
      ['공백', { code: `${code.slice(0, 10)} ${code.slice(11)}` }],
      ['줄바꿈', { code: `${code}\n` }],
      ['base64 기호', { code: 'ab+cd/ef==' }],
      ['비ASCII', { code: '입장코드' }],
      ['숫자', { code: 1234 }],
      ['null', { code: null }],
      ['빈 객체', {}],
      ['허용 밖 칸', { code, eventId }],
      ['배열 본문', [code]],
    ];
    for (const [label, body] of bodies) {
      const r = await h.scan(eventId, body, staffHeaders('staff-g1'));
      expectStatus(r, 400, label);
      expect(r.raw, `${label}: 오류 문구에 코드`).not.toContain(code);
    }
    expectStatus(await h.http('POST', `/v0/events/${eventId}/scans`, staffHeaders('staff-g1'), undefined, 'not json'), 400, 'JSON 아님');
    expect(await entry(code)).toEqual(NOT_ENTERED);
    // 64자까지는 형식이 맞다(없는 코드라 INVALID)
    expect((await h.scan(eventId, { code: 'x'.repeat(64) }, staffHeaders('staff-g1'))).body).toEqual({ result: 'INVALID' });
    expect((await h.scan(eventId, { code }, staffHeaders('staff-g1'))).body).toMatchObject({ result: 'ADMIT' });
  });

  test('FR035_코드는본문으로만받아_쿼리에만있으면판정하지않고입장으로남기지않는다 [ASVS v5.0.0-14.2.1]', async () => {
    const { eventId, tickets } = await eventWithTickets({ pid: 'sc10', seats: ['S-1'], staff: ['staff-h1'] });
    const code = tickets[0]!.code;
    const url = `/v0/events/${eventId}/scans?code=${encodeURIComponent(code)}`;
    expectStatus(await h.http('POST', url, staffHeaders('staff-h1'), {}), 400, '쿼리 + 빈 본문');
    const noBody = await h.http('POST', url, staffHeaders('staff-h1'));
    expect(noBody.status, noBody.raw).toBeGreaterThanOrEqual(400);
    expect(noBody.status, noBody.raw).toBeLessThan(500);
    expect(noBody.raw).not.toContain(code);
    expect(await entry(code)).toEqual(NOT_ENTERED);
  });

  test('FR035_회차ID형식이틀리면400이다 [ASVS v5.0.0-2.2.1]', async () => {
    for (const bad of ['bad id', 'z'.repeat(65), 'a.b', "e'1"]) {
      expectStatus(await h.scan(encodeURIComponent(bad), { code: unknownCode() }, staffHeaders('staff-any')), 400, bad);
    }
  });

  test('FR035_검표응답과오류문구와서비스로그에티켓코드가실리지않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const logFrom = h.logLines.length;
    const a = await eventWithTickets({ pid: 'sc11', seats: ['R-1', 'R-2'], staff: ['staff-i1'] });
    const b = await eventWithTickets({ pid: 'sc12', seats: ['S-1'], staff: ['staff-i2'] });
    const codes = [...a.tickets, ...b.tickets].map((t) => t.code);
    const raws = [
      (await h.scan(a.eventId, { code: a.tickets[0]!.code }, staffHeaders('staff-i1'))).raw,
      (await h.scan(a.eventId, { code: a.tickets[0]!.code }, staffHeaders('staff-i1'))).raw,
      (await h.scan(a.eventId, { code: b.tickets[0]!.code }, staffHeaders('staff-i1'))).raw,
      (await h.scan(a.eventId, { code: a.tickets[1]!.code }, staffHeaders('staff-i2'))).raw,
      (await h.scan(a.eventId, { code: a.tickets[1]!.code, x: 1 }, staffHeaders('staff-i1'))).raw,
      (await h.scan(a.eventId, { code: a.tickets[1]!.code }, fanHeaders('sc11'))).raw,
    ];
    for (const raw of raws) for (const code of codes) expect(raw, `응답에 코드: ${raw}`).not.toContain(code);
    await sleep(50);
    const logs = h.logText(logFrom);
    expect(logs.length).toBeGreaterThan(0);
    for (const code of codes) expect(logs, '서비스 로그에 티켓 코드').not.toContain(code);
  });
});
