// 좌석 v0(docs/features/seat-hold.md §14) 통합 시험: 실제 PostgreSQL 18·Valkey 컨테이너 + 모놀리스 HTTP(inject) + 실제 포트 WebSocket.
// 시계만 가짜(fakeClock)다. 만료 루프는 끄고(expiryIntervalMs false) createSeatAdmin().expire(지금 시각)으로 돌린다.
// 입장은 대기열 v0 HTTP(진입 → 입장 루프 한 칸 → 입장 확정)로 한다(queue-admission §13 동작 5).
// 시험마다 회차 ID를 새로 만들어 서로 섞이지 않는다. 만료는 모든 회차를 보므로, 푼 수를 세는 시험은 남은 홀드를 먼저 푼다.
// 단언은 상태 코드만이 아니라 본문 칸과 표(v0_seat·v0_hold·v0_quota)의 결과까지 본다.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { DELTA_CHANNEL, type SeatDefinition, type SeatEventConfig } from '../src/modules/inventory/index.js';
import { JSON_CONTENT_TYPE, PROBLEM_CONTENT_TYPE, expectProblem, fanHeaders, type Headers } from './queue-harness.js';
import {
  ALLOWED_ORIGIN,
  DELTA_CHANNEL_NAME,
  EXTEND_MS,
  QUIET_MS,
  SECOND_ALLOWED_ORIGIN,
  SeatHarness,
  TTL_MS,
  UUID_PATTERN,
  changesOf,
  ids,
  refKst,
  seatDefs,
  sortedDelta,
  type DeltaMessage,
  type SeatReply,
} from './seat-harness.js';

let h: SeatHarness;

beforeAll(async () => {
  h = await SeatHarness.start();
});

afterAll(async () => {
  await h?.close();
});

afterEach(() => {
  h?.closeSockets();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 조건이 참이 될 때까지 기다린다(변경분 도착 등) */
async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`${what}: ${timeoutMs}ms 안에 되지 않았다`);
    await sleep(20);
  }
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sorted = (xs: string[]) => [...xs].sort();
/**
 * 같은 404 모양인지 견줄 것: 상태 코드·Content-Type과 본문 전체(detail과 확장 칸까지). 요청마다 다른 instance(요청 경로)·traceId만 뺀다.
 * '남의 홀드와 없는 홀드는 똑같이 404 hold-not-found다(그런 홀드가 있는지 알리지 않는다)'(§14 동작 3)라 어느 칸도 달라서는 안 된다
 */
const problemShape = (r: SeatReply) => ({
  status: r.status,
  contentType: r.contentType,
  body: Object.fromEntries(Object.entries((r.body ?? {}) as Record<string, unknown>).filter(([k]) => k !== 'instance' && k !== 'traceId')),
});
/** 거절이 Problem 본문인지(이름 없는 400·401·403) */
const expectStatus = (r: SeatReply, status: number, label: string) =>
  expect({ label, status: r.status, contentType: r.contentType }, r.raw).toEqual({ label, status, contentType: PROBLEM_CONTENT_TYPE });

// ───────────────────────── 좌석 목록과 좌석 열기(§14 동작 1·8, FR-009) ─────────────────────────

describe('좌석 목록 GET /v0/events/{eventId}/seats와 좌석 열기', () => {
  test('FR009_입장한사람은좌석목록을받고_좌석마다정한칸과지금상태가있으며누가잡았는지는싣지않는다 [ASVS v5.0.0-14.1.1]', async () => {
    const defs: SeatDefinition[] = [
      { id: 'VIP-1-1', section: 'VIP', row: '1', number: 1, x: 100, y: 40, grade: 'VIP' },
      { id: 'VIP-1-2', section: 'VIP', row: '1', number: 2, x: 110, y: 40, grade: 'VIP' },
      { id: 'R-12-30', section: 'R', row: '12', number: 30, x: 640, y: 380, grade: 'R' },
      { id: 'S_east-3-7', section: 'S_east', row: '3', number: 7, x: 900, y: 120, grade: 'S' },
    ];
    const e = h.newEventId();
    await h.seatAdmin.open(e, { perPersonLimit: 4 }, defs);
    await h.admit(e, ['viewer', 'holder-q7']);
    const holdId = await h.holdOk(e, ['VIP-1-2'], fanHeaders('holder-q7'));

    const r = await h.seats(e, fanHeaders('viewer'));
    expect({ status: r.status, contentType: r.contentType }, r.raw).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    expect(Object.keys(r.body).sort()).toEqual(['eventId', 'seats']);
    expect(r.body.eventId).toBe(e);
    const want = defs.map((d) => ({ ...d, status: d.id === 'VIP-1-2' ? 'HELD' : 'AVAILABLE' }));
    expect([...(r.body.seats as { id: string }[])].sort(byId)).toEqual([...want].sort(byId));
    // 누가 잡았는지(계정·pid·홀드 ID)는 싣지 않는다
    for (const secret of ['acc-holder-q7', 'holder-q7', holdId]) expect(r.raw).not.toContain(secret);
  });

  test('FR009_FR010_그회차에입장하지않은사람은좌석목록과홀드가403입장안함이고아무것도바꾸지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const e = await h.openEvent(ids('A', 3));
    const other = await h.openEvent(ids('A', 3));
    await h.admit(other, ['elsewhere']); // 다른 회차에만 입장
    // 차례가 왔지만 입장 확정 전인 사람과, 아직 기다리는 사람
    await h.queueAdmin.open(e, { admitPerSecond: 1 });
    expect((await h.http('POST', `/v1/queues/${e}/entries`, fanHeaders('called'))).status).toBe(201);
    h.clock.advance(1000);
    await h.queueAdmin.tick(h.clock.now());
    expect((await h.http('POST', `/v1/queues/${e}/entries`, fanHeaders('waiting'))).status).toBe(201);
    expect((await h.http('GET', `/v1/queues/${e}/entries/me`, fanHeaders('called'))).body).toMatchObject({ status: 'CALLED' });
    expect((await h.http('GET', `/v1/queues/${e}/entries/me`, fanHeaders('waiting'))).body).toMatchObject({ status: 'WAITING' });
    const before = await h.snapshot(e);
    for (const pid of ['stranger', 'waiting', 'called', 'elsewhere']) {
      expectProblem(await h.seats(e, fanHeaders(pid)), 403, 'not-admitted');
      expectProblem(await h.hold(e, ['A-1'], fanHeaders(pid)), 403, 'not-admitted');
    }
    expect(await h.snapshot(e)).toEqual(before);
    expect(before.holds).toEqual([]);
  });

  test('FR009_FR010_좌석을열지않은회차는입장했어도좌석목록과홀드가404좌석없음이다', async () => {
    const e = h.newEventId();
    await h.admit(e, ['p1']);
    expectProblem(await h.seats(e, fanHeaders('p1')), 404, 'seats-not-found');
    expectProblem(await h.hold(e, ['A-1'], fanHeaders('p1')), 404, 'seats-not-found');
    expect(await h.snapshot(e)).toEqual({ seats: [], holds: [], quotas: [] });
  });

  test('FR009_POL011_좌석을다시열면설정이바뀌고새좌석만더해지며_이미잡힌좌석은그대로다', async () => {
    const e = await h.openEvent(['A-1', 'A-2'], { perPersonLimit: 1 });
    await h.admit(e, ['p1']);
    const holdId = await h.holdOk(e, ['A-1'], fanHeaders('p1'));
    expectProblem(await h.hold(e, ['A-2'], fanHeaders('p1')), 422, 'purchase-limit-exceeded');
    await h.seatAdmin.open(e, { perPersonLimit: 3 }, seatDefs(['A-1', 'A-2', 'A-3']));
    expect(await h.seatRows(e)).toEqual([
      { seatId: 'A-1', status: 'HELD', holdId },
      { seatId: 'A-2', status: 'AVAILABLE', holdId: null },
      { seatId: 'A-3', status: 'AVAILABLE', holdId: null },
    ]);
    // 새 한도(3)가 든다
    const r = await h.hold(e, ['A-2', 'A-3'], fanHeaders('p1'));
    expect(r.status, r.raw).toBe(201);
    expect(await h.held(e, 'acc-p1')).toBe(3);
    await h.expectConsistent(e);
    const list = await h.seats(e, fanHeaders('p1'));
    expect((list.body.seats as { id: string; status: string }[]).map((s) => [s.id, s.status]).sort()).toEqual([
      ['A-1', 'HELD'],
      ['A-2', 'HELD'],
      ['A-3', 'HELD'],
    ]);
  });

  test('FR009_좌석열기는경계값을받고_회차ID와한도TTL연장범위와좌석ID가틀리면던지며아무것도열지않는다 [ASVS v5.0.0-2.2.1]', async () => {
    // 경계 안(1인 한도 1~10, TTL 1초~60분, 연장 1초~30분)은 연다
    const okConfigs: SeatEventConfig[] = [
      { perPersonLimit: 1 },
      { perPersonLimit: 10, holdTtlMs: 1_000, extendMs: 1_000 },
      { perPersonLimit: 4, holdTtlMs: 60 * 60 * 1000, extendMs: 30 * 60 * 1000 },
    ];
    for (const config of okConfigs) {
      const e = h.newEventId();
      await h.seatAdmin.open(e, config, seatDefs(['A-1', 'Z'.repeat(64)]));
      expect((await h.seatRows(e)).map((s) => s.seatId), JSON.stringify(config)).toEqual(['A-1', 'Z'.repeat(64)]);
    }
    const attempt = (f: () => Promise<unknown>) => (async () => f())();
    const badConfigs: SeatEventConfig[] = [
      { perPersonLimit: 0 },
      { perPersonLimit: 11 },
      { perPersonLimit: 2.5 },
      { perPersonLimit: Number.NaN },
      { perPersonLimit: 4, holdTtlMs: 999 },
      { perPersonLimit: 4, holdTtlMs: 60 * 60 * 1000 + 1 },
      { perPersonLimit: 4, extendMs: 999 },
      { perPersonLimit: 4, extendMs: 30 * 60 * 1000 + 1 },
    ];
    const tried: string[] = [];
    for (const config of badConfigs) {
      const e = h.newEventId();
      tried.push(e);
      await expect(attempt(() => h.seatAdmin.open(e, config, seatDefs(['A-1']))), JSON.stringify(config)).rejects.toThrow();
    }
    for (const badSeat of ['A 1', '', 'Z'.repeat(65), "A-1'", 'A/1']) {
      const e = h.newEventId();
      tried.push(e);
      await expect(attempt(() => h.seatAdmin.open(e, { perPersonLimit: 4 }, seatDefs(['A-1', badSeat]))), JSON.stringify(badSeat)).rejects.toThrow();
    }
    for (const badEvent of ['bad id', 'bad{x}', 'z'.repeat(65), '', 'bad.id']) {
      tried.push(badEvent);
      await expect(attempt(() => h.seatAdmin.open(badEvent, { perPersonLimit: 4 }, seatDefs(['A-1']))), JSON.stringify(badEvent)).rejects.toThrow();
    }
    const opened = await h.inspect.query<{ n: number }>(
      'select (select count(*) from v0_seat_event where event_id = any($1)) + (select count(*) from v0_seat where event_id = any($1)) as n',
      [tried],
    );
    expect(Number(opened.rows[0]!.n)).toBe(0);
  });
});

// ───────────────────────── 홀드(§14 동작 2, FR-010, POL-011·012, S-T1·3·4·10·30) ─────────────────────────

describe('홀드 POST /v1/events/{eventId}/holds', () => {
  test('FR010_POL012_빈좌석을잡으면_201과홀드모양이고만료는KST로7분뒤이며_좌석과홀드와보유수가함께바뀐다', async () => {
    const e = await h.openEvent(ids('A', 5));
    await h.admit(e, ['p1']);
    const t0 = h.clock.now();
    const r = await h.hold(e, ['A-3', 'A-1'], fanHeaders('p1'));
    expect({ status: r.status, contentType: r.contentType }, r.raw).toEqual({ status: 201, contentType: JSON_CONTENT_TYPE });
    expect(Object.keys(r.body).sort()).toEqual(['expiresAt', 'extendable', 'holdId', 'seatIds']);
    expect(r.body).toEqual({ holdId: expect.stringMatching(UUID_PATTERN), seatIds: expect.any(Array), expiresAt: refKst(t0 + TTL_MS), extendable: true });
    expect(sorted(r.body.seatIds)).toEqual(['A-1', 'A-3']);
    const holdId = r.body.holdId as string;
    expect(await h.holdRows(e)).toEqual([
      { holdId, eventId: e, accountId: 'acc-p1', seatIds: ['A-1', 'A-3'], status: 'HELD', extended: false, heldAtMs: t0, expiresAtMs: t0 + TTL_MS },
    ]);
    expect(await h.seatRows(e)).toEqual([
      { seatId: 'A-1', status: 'HELD', holdId },
      { seatId: 'A-2', status: 'AVAILABLE', holdId: null },
      { seatId: 'A-3', status: 'HELD', holdId },
      { seatId: 'A-4', status: 'AVAILABLE', holdId: null },
      { seatId: 'A-5', status: 'AVAILABLE', holdId: null },
    ]);
    expect(await h.quotaRows(e)).toEqual([{ accountId: 'acc-p1', held: 2 }]);
    // 좌석 목록에도 바로 보인다
    const list = await h.seats(e, fanHeaders('p1'));
    expect((list.body.seats as { id: string; status: string }[]).filter((s) => s.status === 'HELD').map((s) => s.id).sort()).toEqual(['A-1', 'A-3']);
  });

  test('POL012_회차에정한홀드시간이있으면_그만큼뒤에만료된다', async () => {
    const e = await h.openEvent(ids('A', 2), { holdTtlMs: 90_000 });
    await h.admit(e, ['p1']);
    const t0 = h.clock.now();
    const r = await h.hold(e, ['A-1'], fanHeaders('p1'));
    expect(r.status, r.raw).toBe(201);
    expect(r.body.expiresAt).toBe(refKst(t0 + 90_000));
    expect((await h.holdRow(r.body.holdId))?.expiresAtMs).toBe(t0 + 90_000);
  });

  test('ST1_한좌석에25명이동시에잡으면_201은하나이고나머지는모두409이미잡힘이며_좌석은이긴사람것이다 [ASVS v5.0.0-2.3.4]', { timeout: 90_000 }, async () => {
    const e = await h.openEvent(ids('A', 3));
    const people = Array.from({ length: 25 }, (_, i) => `st1-${i + 1}`);
    await h.admit(e, people);
    const listener = await h.listenNotifications();
    await h.warmPool();
    const now = h.clock.now();
    const replies = await Promise.all(people.map((p) => h.hold(e, ['A-2'], fanHeaders(p))));
    const winners = replies.flatMap((r, i) => (r.status === 201 ? [people[i]!] : []));
    expect(winners, replies.map((r) => `${r.status}`).join(',')).toHaveLength(1);
    for (const r of replies) if (r.status !== 201) expectProblem(r, 409, 'seat-already-held');
    const win = replies.find((r) => r.status === 201)!;
    expect(await h.holdRows(e)).toEqual([expect.objectContaining({ holdId: win.body.holdId, accountId: `acc-${winners[0]}`, seatIds: ['A-2'], status: 'HELD' })]);
    expect(await h.quotaRows(e)).toEqual([{ accountId: `acc-${winners[0]}`, held: 1 }]);
    expect(await h.seatStatus(e)).toEqual({ 'A-1': 'AVAILABLE', 'A-2': 'HELD', 'A-3': 'AVAILABLE' });
    await h.expectConsistent(e);
    await h.expectNoOpenTransactions();
    // 커밋된 홀드만 변경분을 낸다(§14 동작 6): 진 24명의 요청은 좌석 변경분이 없다. 표지 홀드 앞의 알림은 이긴 홀드 하나뿐이다
    const marker = { eventId: e, changes: [{ seatId: 'A-3', status: 'HELD' }], atMs: now };
    await h.holdOk(e, ['A-3'], fanHeaders(winners[0]!));
    expect(await SeatHarness.untilMarker(listener.inbox, e, marker)).toEqual([{ eventId: e, changes: [{ seatId: 'A-2', status: 'HELD' }], atMs: now }, marker]);
    await listener.close();
  });

  test('ST4_여러좌석가운데하나가이미잡혀있으면_요청전체가409이미잡힘이고부분홀드가없다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.openEvent(ids('A', 6));
    await h.admit(e, ['pa', 'pb']);
    await h.holdOk(e, ['A-3'], fanHeaders('pb'));
    const before = await h.snapshot(e);
    for (const seats of [
      ['A-1', 'A-3'],
      ['A-3', 'A-1'],
      ['A-1', 'A-2', 'A-3'],
      ['A-2', 'A-4', 'A-5', 'A-3'],
    ]) {
      expectProblem(await h.hold(e, seats, fanHeaders('pa')), 409, 'seat-already-held');
    }
    expect(await h.snapshot(e)).toEqual(before);
    expect(await h.held(e, 'acc-pa')).toBe(0);
    // 막혔던 좌석을 빼면 잡힌다(거절이 다른 좌석을 묶어 두지 않았다)
    await h.holdOk(e, ['A-1', 'A-2', 'A-4', 'A-5'], fanHeaders('pa'));
    await h.expectConsistent(e);
  });

  test('ST4_여러좌석요청과그가운데한좌석요청이동시에오면_어느쪽이이기든하나만201이고부분홀드가없다 [ASVS v5.0.0-2.3.4]', { timeout: 60_000 }, async () => {
    const e = await h.openEvent(ids('A', 12), { perPersonLimit: 10 });
    await h.admit(e, ['pa', 'pb']);
    const groups = [
      ['A-1', 'A-2'],
      ['A-3', 'A-4', 'A-5'],
      ['A-6', 'A-7', 'A-8', 'A-9'],
      ['A-10', 'A-11', 'A-12'],
    ];
    for (const [round, group] of groups.entries()) {
      const contested = group[group.length - 1]!;
      await h.warmPool(4);
      // 라운드마다 계정을 달리해 1인 한도(422)가 결과에 섞이지 않게 한다
      const [many, one] = await Promise.all([
        h.hold(e, group, fanHeaders('pa', { account: `acc-pa-r${round}` })),
        h.hold(e, [contested], fanHeaders('pb', { account: `acc-pb-r${round}` })),
      ]);
      expect([many.status, one.status].filter((s) => s === 201), `${group.join(',')}: ${many.raw} / ${one.raw}`).toHaveLength(1);
      const loser = many.status === 201 ? one : many;
      expectProblem(loser, 409, 'seat-already-held');
      const status = await h.seatStatus(e);
      if (many.status === 201) {
        for (const id of group) expect(status[id], id).toBe('HELD');
      } else {
        expect(status[contested]).toBe('HELD');
        for (const id of group.slice(0, -1)) expect(status[id], `${id}는 부분 홀드되지 않는다`).toBe('AVAILABLE');
      }
      await h.expectConsistent(e);
    }
  });

  test('ST3_POL011_같은계정이10개탭에서동시에한좌석씩잡아도_한도4를넘지않고넘은요청은422한도초과다 [ASVS v5.0.0-2.3.4]', { timeout: 60_000 }, async () => {
    const e = await h.openEvent(ids('A', 12), { perPersonLimit: 4 });
    await h.admit(e, ['st3', 'st3-other']);
    const listener = await h.listenNotifications();
    await h.warmPool(12);
    const now = h.clock.now();
    // 처음에는 이 계정의 보유 수 행이 없다(행이 없을 때의 동시 첫 홀드도 한도를 지켜야 한다)
    expect(await h.quotaRows(e)).toEqual([]);
    const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => h.hold(e, [`A-${i + 1}`], fanHeaders('st3', { session: `ses-st3-tab${i}` }))));
    expect(replies.filter((r) => r.status === 201), replies.map((r) => r.status).join(',')).toHaveLength(4);
    for (const r of replies) if (r.status !== 201) expectProblem(r, 422, 'purchase-limit-exceeded');
    expect(await h.quotaRows(e)).toEqual([{ accountId: 'acc-st3', held: 4 }]);
    const snap = await h.expectConsistent(e);
    expect(snap.holds.filter((x) => x.status === 'HELD')).toHaveLength(4);
    const wonSeats = replies.flatMap((r, i) => (r.status === 201 ? [`A-${i + 1}`] : []));
    expect(snap.seats.filter((s) => s.status === 'HELD').map((s) => s.seatId).sort()).toEqual(sorted(wonSeats));
    await h.expectNoOpenTransactions();
    // 한도로 거절된 6건은 아무 변경분도 내지 않았다(되돌린 트랜잭션은 알리지 않는다, §14 동작 6)
    const marker = { eventId: e, changes: [{ seatId: 'A-12', status: 'HELD' }], atMs: now };
    await h.holdOk(e, ['A-12'], fanHeaders('st3-other'));
    const got = await SeatHarness.untilMarker(listener.inbox, e, marker);
    expect(got.slice(0, -1).map((m) => m.changes).sort((a, b) => (a[0]!.seatId < b[0]!.seatId ? -1 : 1))).toEqual(
      sorted(wonSeats).map((seatId) => [{ seatId, status: 'HELD' }]),
    );
    expect(got.slice(0, -1).every((m) => m.atMs === now)).toBe(true);
    await listener.close();
  });

  test('ST3_POL011_같은계정이크기가다른홀드를동시에보내도_보유수는한도이하이고실패한요청은어떤좌석도잡지않는다 [ASVS v5.0.0-2.3.4]', { timeout: 60_000 }, async () => {
    const limit = 4;
    const sizes = [3, 2, 1, 2, 3, 1, 2, 1];
    const e = await h.openEvent(ids('A', 15), { perPersonLimit: limit });
    await h.admit(e, ['st3b']);
    let next = 1;
    const requests = sizes.map((n) => Array.from({ length: n }, () => `A-${next++}`));
    await h.warmPool(12);
    const replies = await Promise.all(requests.map((seats, i) => h.hold(e, seats, fanHeaders('st3b', { session: `ses-st3b-${i}` }))));
    const held = await h.held(e, 'acc-st3b');
    expect(held).toBeLessThanOrEqual(limit);
    const won = replies.flatMap((r, i) => (r.status === 201 ? [requests[i]!] : []));
    expect(held).toBe(won.reduce((n, s) => n + s.length, 0));
    const status = await h.seatStatus(e);
    replies.forEach((r, i) => {
      if (r.status === 201) return;
      expectProblem(r, 422, 'purchase-limit-exceeded');
      // 보유 수는 시험 동안 늘기만 하므로, 실패한 요청은 끝 보유 수에 더해도 한도를 넘는다
      expect(held + requests[i]!.length, requests[i]!.join(',')).toBeGreaterThan(limit);
      for (const id of requests[i]!) expect(status[id], `${id}는 실패한 요청의 좌석`).toBe('AVAILABLE');
    });
    await h.expectConsistent(e);
  });

  test('POL011_보유수와요청수의합이한도를넘으면422한도초과이고아무것도잡지않으며_놓으면다시잡을수있다', async () => {
    const e = await h.openEvent(ids('A', 6), { perPersonLimit: 2 });
    await h.admit(e, ['p1', 'p2']);
    // 처음부터 한도를 넘는 요청
    expectProblem(await h.hold(e, ['A-1', 'A-2', 'A-3'], fanHeaders('p2')), 422, 'purchase-limit-exceeded');
    expect(await h.held(e, 'acc-p2')).toBe(0);
    const first = await h.holdOk(e, ['A-1'], fanHeaders('p1'));
    const before = await h.snapshot(e);
    expectProblem(await h.hold(e, ['A-2', 'A-3'], fanHeaders('p1')), 422, 'purchase-limit-exceeded');
    expect(await h.snapshot(e)).toEqual(before);
    await h.holdOk(e, ['A-2'], fanHeaders('p1'));
    expect(await h.held(e, 'acc-p1')).toBe(2);
    expectProblem(await h.hold(e, ['A-3'], fanHeaders('p1')), 422, 'purchase-limit-exceeded');
    expect((await h.release(first, fanHeaders('p1'))).status).toBe(204);
    expect(await h.held(e, 'acc-p1')).toBe(1);
    await h.holdOk(e, ['A-3'], fanHeaders('p1'));
    expect(await h.held(e, 'acc-p1')).toBe(2);
    await h.expectConsistent(e);
  });

  test('POL011_한도는회차마다계정마다따로센다', async () => {
    const e1 = await h.openEvent(ids('A', 4), { perPersonLimit: 2 });
    const e2 = await h.openEvent(ids('A', 4), { perPersonLimit: 2 });
    await h.admit(e1, ['p1', 'p2']);
    await h.admit(e2, ['p1']);
    await h.holdOk(e1, ['A-1', 'A-2'], fanHeaders('p1'));
    await h.holdOk(e2, ['A-1', 'A-2'], fanHeaders('p1'));
    await h.holdOk(e1, ['A-3', 'A-4'], fanHeaders('p2'));
    expect(await h.quotaRows(e1)).toEqual([
      { accountId: 'acc-p1', held: 2 },
      { accountId: 'acc-p2', held: 2 },
    ]);
    expect(await h.quotaRows(e2)).toEqual([{ accountId: 'acc-p1', held: 2 }]);
    expectProblem(await h.hold(e2, ['A-3'], fanHeaders('p1')), 422, 'purchase-limit-exceeded');
  });

  test('ST30_같은좌석을두번넣거나그회차에없는좌석을넣으면_422잘못된좌석이고정상좌석과섞여도아무것도잡지않는다 [ASVS v5.0.0-2.2.1]', async () => {
    // 1인 한도 4. A-5는 다른 분(p2)이 잡고 있다
    const e = await h.openEvent(ids('A', 5));
    const other = await h.openEvent(['X-9-9']);
    await h.admit(e, ['p1', 'p2']);
    await h.holdOk(e, ['A-5'], fanHeaders('p2'));
    const before = await h.snapshot(e);
    const otherBefore = await h.snapshot(other);
    for (const seats of [
      ['A-1', 'A-1'], // 같은 좌석 두 번
      ['A-1', 'A-2', 'A-1'],
      ['NOPE-1'], // 없는 좌석
      ['X-9-9'], // 다른 회차의 좌석
      ['A-1', 'A-2', 'NOPE-1'], // 정상 좌석 + 없는 좌석
      ['A-3', 'X-9-9'], // 정상 좌석 + 다른 회차 좌석
      // '같은 좌석이 두 번 있거나 그 회차에 없는 좌석이 있으면 422'는 조건이 없다(§14 동작 2): 잠그기 전에 보므로
      // 다른 분이 잡은 좌석이 앞에 있어도 409가 아니고, 요청 수가 한도를 넘어도 한도 초과가 아니다
      ['A-5', 'NOPE-1'],
      ['A-5', 'A-1', 'A-5'],
      ['A-1', 'A-2', 'A-3', 'A-4', 'A-1'],
    ]) {
      expectProblem(await h.hold(e, seats, fanHeaders('p1')), 422, 'invalid-seat');
    }
    expect(await h.snapshot(e)).toEqual(before);
    expect(await h.snapshot(other)).toEqual(otherBefore);
    // 정상 좌석만이면 잡힌다
    await h.holdOk(e, ['A-1', 'A-2'], fanHeaders('p1'));
  });

  test('FR010_POL011_다른분이잡은좌석이섞인요청은한도를넘어도409이미잡힘이다_경합판정이한도보다먼저다', async () => {
    // §14 동작 2: 잠근 좌석이 하나라도 AVAILABLE이 아니면 409, '다음으로' v0_quota를 한도 안에서만 늘린다(아니면 422)
    const e = await h.openEvent(ids('A', 6), { perPersonLimit: 2 });
    await h.admit(e, ['pa', 'pb']);
    await h.holdOk(e, ['A-6'], fanHeaders('pb'));
    await h.holdOk(e, ['A-1', 'A-2'], fanHeaders('pa')); // pa는 한도(2)를 다 채웠다
    const before = await h.snapshot(e);
    // 이미 한도를 채운 사람이 잡힌 좌석을 넣은 경우와, 요청 수만으로 한도를 넘는 경우
    expectProblem(await h.hold(e, ['A-6'], fanHeaders('pa')), 409, 'seat-already-held');
    expectProblem(await h.hold(e, ['A-3', 'A-6'], fanHeaders('pa')), 409, 'seat-already-held');
    expectProblem(await h.hold(e, ['A-3', 'A-4', 'A-6'], fanHeaders('pb', { account: 'acc-pb-2' })), 409, 'seat-already-held');
    expect(await h.snapshot(e)).toEqual(before);
    // 잡힌 좌석이 없으면 한도 초과다
    expectProblem(await h.hold(e, ['A-3', 'A-4', 'A-5'], fanHeaders('pb', { account: 'acc-pb-2' })), 422, 'purchase-limit-exceeded');
    expect(await h.snapshot(e)).toEqual(before);
  });

  test('ST30_좌석ID의형식이나개수가틀린본문은400이고아무것도잡지않는다_10개와64자는받는다 [ASVS v5.0.0-2.2.1]', async () => {
    const tenIds = [...ids('A', 9), 'Z'.repeat(64)];
    const e = await h.openEvent(tenIds, { perPersonLimit: 10 });
    await h.admit(e, ['p1']);
    const before = await h.snapshot(e);
    const bodies: [string, unknown][] = [
      ['빈 목록', { seatIds: [] }],
      ['11개', { seatIds: [...tenIds, 'A-10'] }],
      ['공백', { seatIds: ['A 1'] }],
      ['빗금', { seatIds: ['A/1'] }],
      ['따옴표', { seatIds: ["A-1'--"] }],
      ['중괄호', { seatIds: ['{A-1}'] }],
      ['빈 ID', { seatIds: [''] }],
      ['65자', { seatIds: ['Z'.repeat(65)] }],
      ['숫자', { seatIds: [1] }],
      ['문자열', { seatIds: 'A-1' }],
      ['null', { seatIds: null }],
      ['칸 없음', {}],
      ['배열 본문', ['A-1']],
      ['문자열 본문', 'A-1'],
    ];
    for (const [label, body] of bodies) expectStatus(await h.http('POST', `/v1/events/${e}/holds`, fanHeaders('p1'), body), 400, label);
    for (const [label, raw] of [
      ['깨진 JSON', '{"seatIds":'],
      ['빈 본문', ''],
    ] as const) {
      expectStatus(await h.http('POST', `/v1/events/${e}/holds`, fanHeaders('p1'), undefined, raw), 400, label);
    }
    expect(await h.snapshot(e)).toEqual(before);
    // 경계: 10개(64자 ID 포함)는 받는다
    const r = await h.hold(e, tenIds, fanHeaders('p1'));
    expect(r.status, r.raw).toBe(201);
    expect(sorted(r.body.seatIds)).toEqual(sorted(tenIds));
  });

  test('FR010_홀드본문에정의밖칸이있으면400이고아무것도잡지않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, ['p1']);
    const before = await h.snapshot(e);
    for (const body of [
      { seatIds: ['A-1'], accountId: 'acc-someone' },
      { seatIds: ['A-1'], holdId: randomUUID() },
      { seatIds: ['A-1'], status: 'SOLD' },
      { seatIds: ['A-1'], expiresAt: '2099-01-01T00:00:00.000+09:00' },
      { seatIds: ['A-1'], perPersonLimit: 10 },
    ]) {
      expectStatus(await h.http('POST', `/v1/events/${e}/holds`, fanHeaders('p1'), body), 400, Object.keys(body).join(','));
    }
    expect(await h.snapshot(e)).toEqual(before);
  });

  test('ST10_엇갈린순서로같은좌석들을잡는두요청은_둘다끝나고성공은많아야하나이며실패는409나429이고부분홀드가없다 [ASVS v5.0.0-2.3.4]', { timeout: 120_000 }, async () => {
    // 교착 수·지연(성능 판정)은 wbs 1.4.1 ②에서 본다(§14 '시험'). 여기서는 요청 순서대로 잠그는지 단언하지 않고,
    // 어느 쪽이 끊기든 부분 홀드가 없고 좌석·홀드·보유 수가 맞으며 잠금이 남지 않는지만 본다
    const e = await h.openEvent(ids('A', 11), { perPersonLimit: 10 });
    await h.admit(e, ['x', 'y', 'z']);
    const listener = await h.listenNotifications();
    const rounds = [
      ['A-1', 'A-2'],
      ['A-3', 'A-4'],
      ['A-5', 'A-6', 'A-7'],
      ['A-8', 'A-9'],
      ['A-10', 'A-11'],
    ];
    for (const [round, seats] of rounds.entries()) {
      await h.warmPool(4);
      const now = h.clock.now();
      const from = listener.inbox.raw.length;
      const reversed = [...seats].reverse();
      // 라운드마다 계정을 달리해 1인 한도(422)가 결과에 섞이지 않게 한다
      const accounts = { x: `acc-x-r${round}`, y: `acc-y-r${round}` };
      const results = await Promise.all([h.hold(e, seats, fanHeaders('x', { account: accounts.x })), h.hold(e, reversed, fanHeaders('y', { account: accounts.y }))]);
      const label = `${seats.join(',')}: ${results.map((r) => r.raw).join(' / ')}`;
      expect(results.filter((r) => r.status === 201), label).not.toHaveLength(2);
      for (const r of results) {
        if (r.status === 201) continue;
        if (r.status === 409) {
          expectProblem(r, 409, 'seat-already-held');
        } else {
          // PostgreSQL이 교착으로 끊은 쪽과 잠금을 1초 넘게 기다린 쪽(K3의 v0 한계)
          expectProblem(r, 429, 'server-busy');
          expect(r.headers['retry-after'], label).toBe('1');
        }
      }
      // 끊긴 쪽의 트랜잭션도 끝났다(응답 뒤에 잠금을 쥔 채 남은 연결이 없다)
      await h.expectNoOpenTransactions(label);
      const snap = await h.expectConsistent(e);
      const winnerAt = results.findIndex((r) => r.status === 201);
      const mine = snap.seats.filter((s) => seats.includes(s.seatId));
      const zHeld = { eventId: e, changes: changesOf(seats, 'HELD'), atMs: now };
      if (winnerAt >= 0) {
        const winner = results[winnerAt]!;
        for (const s of mine) expect(s, label).toEqual({ seatId: s.seatId, status: 'HELD', holdId: winner.body.holdId });
        // 이긴 홀드를 놓은 뒤 다른 사람이 같은 좌석을 바로 잡는다(남은 잠금이 있으면 1초를 기다리다 429다)
        const owner = winnerAt === 0 ? fanHeaders('x', { account: accounts.x }) : fanHeaders('y', { account: accounts.y });
        expect((await h.release(winner.body.holdId, owner)).status, label).toBe(204);
        await h.holdOk(e, seats, fanHeaders('z', { account: `acc-z-r${round}` }));
        // 변경분은 커밋된 셋(이긴 홀드·해제·z의 홀드)뿐이다. 진 쪽(409·429)의 트랜잭션은 알리지 않는다
        expect(await SeatHarness.untilMarker(listener.inbox, e, zHeld, from, 2), label).toEqual([
          zHeld,
          { eventId: e, changes: changesOf(seats, 'AVAILABLE'), atMs: now },
          zHeld,
        ]);
      } else {
        for (const s of mine) expect(s, label).toEqual({ seatId: s.seatId, status: 'AVAILABLE', holdId: null });
        // 남은 잠금이 없다: 다른 사람이 바로 잡는다
        await h.holdOk(e, seats, fanHeaders('z', { account: `acc-z-r${round}` }));
        // 둘 다 실패했으면 변경분은 z의 홀드 하나뿐이다
        expect(await SeatHarness.untilMarker(listener.inbox, e, zHeld, from), label).toEqual([zHeld]);
      }
      await h.expectConsistent(e);
    }
    await listener.close();
  });

  test('FR010_ST10_좌석행잠금을1초넘게기다린홀드는429서버바쁨과RetryAfter1이고_앞서잠근좌석도잡지않는다 [ASVS v5.0.0-2.3.4]', { timeout: 30_000 }, async () => {
    // §14 동작 2: '잠금을 1초 넘게 기다린 쪽은 429 server-busy(Retry-After 1초)이고 아무 좌석도 잡지 않는다'. 문장 시간 상한 1초(§14 동작)
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, ['pa']);
    const listener = await h.listenNotifications();
    const now = h.clock.now();
    // 시험 연결이 A-2 행을 잠근 채 둔다(다른 트랜잭션이 그 행을 쥔 상태)
    const locker = await h.inspect.connect();
    try {
      await locker.query('begin');
      await locker.query('select 1 from v0_seat where event_id = $1 and seat_id = $2 for update', [e, 'A-2']);
      const before = await h.snapshot(e);
      const t = performance.now();
      const pending = h.hold(e, ['A-1', 'A-2'], fanHeaders('pa')); // A-1은 먼저 잠그고 A-2에서 기다린다
      // 상한이 없는 구현은 잠금이 풀릴 때까지 기다리므로, 시험이 매달리지 않게 5초에서 끊고 잠금을 푼다(finally)
      const r = await Promise.race([pending, sleep(5_000).then(() => undefined)]);
      const waited = performance.now() - t;
      if (!r) throw new Error('잠금을 기다리는 홀드가 5초 안에 끝나지 않았다(문장 시간 상한 1초가 없다)');
      expectProblem(r, 429, 'server-busy');
      expect(r.headers['retry-after']).toBe('1');
      // 기다리지 않고 바로 거절하지 않았고(1초 가까이 기다림), 1초 상한을 크게 넘지 않았다
      expect(waited).toBeGreaterThanOrEqual(900);
      expect(waited).toBeLessThan(5_000);
      expect(await h.snapshot(e)).toEqual(before);
      expect(before.holds).toEqual([]);
      // 거절된 트랜잭션은 끝났다(A-1 잠금이 남지 않았다)
      await h.expectNoOpenTransactions();
    } finally {
      await locker.query('rollback').catch(() => {});
      locker.release();
    }
    // 잠금이 풀리면 같은 요청이 바로 잡힌다. 그 앞의 429 요청은 변경분을 내지 않았다
    const holdId = await h.holdOk(e, ['A-1', 'A-2'], fanHeaders('pa'));
    const held = { eventId: e, changes: changesOf(['A-1', 'A-2'], 'HELD'), atMs: now };
    expect(await SeatHarness.untilMarker(listener.inbox, e, held)).toEqual([held]);
    expect((await h.holdRow(holdId))?.status).toBe('HELD');
    await listener.close();
  });
});

// ───────────────────────── 해제(§14 동작 3, FR-010, S-T29) ─────────────────────────

describe('해제 DELETE /v1/holds/{holdId}', () => {
  test('FR010_자기홀드를놓으면본문없는204이고_좌석이다시비며보유수가줄고홀드는RELEASED다', async () => {
    const e = await h.openEvent(ids('A', 4));
    await h.admit(e, ['pa', 'pb']);
    const holdId = await h.holdOk(e, ['A-1', 'A-2'], fanHeaders('pa'));
    const keep = await h.holdOk(e, ['A-3'], fanHeaders('pa'));
    expect(await h.held(e, 'acc-pa')).toBe(3);
    const r = await h.release(holdId, fanHeaders('pa'));
    expect({ status: r.status, raw: r.raw }).toEqual({ status: 204, raw: '' });
    expect(await h.seatRows(e)).toEqual([
      { seatId: 'A-1', status: 'AVAILABLE', holdId: null },
      { seatId: 'A-2', status: 'AVAILABLE', holdId: null },
      { seatId: 'A-3', status: 'HELD', holdId: keep },
      { seatId: 'A-4', status: 'AVAILABLE', holdId: null },
    ]);
    expect(await h.held(e, 'acc-pa')).toBe(1);
    expect(await h.holdRow(holdId)).toMatchObject({ status: 'RELEASED', accountId: 'acc-pa', seatIds: ['A-1', 'A-2'] });
    expect((await h.holdRow(keep))?.status).toBe('HELD');
    await h.expectConsistent(e);
    // 좌석 목록에 다시 비어 보이고, 다른 사람이 바로 잡는다
    const list = await h.seats(e, fanHeaders('pb'));
    expect((list.body.seats as { id: string; status: string }[]).filter((s) => s.status === 'AVAILABLE').map((s) => s.id).sort()).toEqual(['A-1', 'A-2', 'A-4']);
    await h.holdOk(e, ['A-1', 'A-2'], fanHeaders('pb'));
  });

  test('ST29_남의홀드와없는홀드의해제는같은404홀드없음이고_그홀드와좌석과보유수는그대로다 [ASVS v5.0.0-8.2.2]', async () => {
    const e = await h.openEvent(['SEATX-1', 'SEATX-2', 'SEATX-3']);
    await h.admit(e, ['pa', 'pb']);
    // pb의 끝난 홀드 둘(만료·놓음)과 살아 있는 홀드 하나
    const bExpired = await h.holdOk(e, ['SEATX-3'], fanHeaders('pb'));
    h.clock.advance(TTL_MS + 1);
    await h.seatAdmin.expire(h.clock.now());
    expect((await h.holdRow(bExpired))?.status).toBe('EXPIRED');
    const bReleased = await h.holdOk(e, ['SEATX-2'], fanHeaders('pb'));
    expect((await h.release(bReleased, fanHeaders('pb'))).status).toBe(204);
    const bHold = await h.holdOk(e, ['SEATX-1'], fanHeaders('pb'));
    const before = await h.snapshot(e);
    const theirs = await h.release(bHold, fanHeaders('pa'));
    const missing = await h.release(randomUUID(), fanHeaders('pa'));
    // pb의 pid를 실었어도 계정이 다르면 남의 홀드다(자기 것은 계정으로 가린다)
    const samePidOtherAccount = await h.release(bHold, fanHeaders('pb', { account: 'acc-intruder', session: 'ses-intruder' }));
    // 남의 끝난 홀드도 남의 홀드다: '이미 끝난 자기 홀드는 204'를 남에게 주면 그런 홀드가 있다고 알리게 된다(§14 동작 3)
    const theirsReleased = await h.release(bReleased, fanHeaders('pa'));
    const theirsExpired = await h.release(bExpired, fanHeaders('pa'));
    const others = [theirs, samePidOtherAccount, theirsReleased, theirsExpired];
    for (const r of [...others, missing]) expectProblem(r, 404, 'hold-not-found');
    for (const r of others) {
      expect(problemShape(r), r.raw).toEqual(problemShape(missing));
      for (const secret of ['acc-pb', 'SEATX-1', 'SEATX-2', 'SEATX-3', e]) expect(r.raw).not.toContain(secret);
    }
    expect(await h.snapshot(e)).toEqual(before);
  });

  test('FR010_ST29_자기홀드는계정으로가려_같은계정의다른탭세션에서도놓을수있다 [ASVS v5.0.0-8.2.2]', async () => {
    const e = await h.openEvent(ids('A', 2));
    await h.admit(e, ['pa']);
    const holdId = await h.holdOk(e, ['A-1'], fanHeaders('pa', { session: 'ses-pa-tab1' }));
    const r = await h.release(holdId, fanHeaders('pa', { session: 'ses-pa-tab2' }));
    expect(r.status, r.raw).toBe(204);
    expect((await h.holdRow(holdId))?.status).toBe('RELEASED');
    expect(await h.held(e, 'acc-pa')).toBe(0);
  });

  test('FR010_이미끝난자기홀드를놓으면204이고아무것도바꾸지않는다_만료뒤남이잡은좌석도그대로다', async () => {
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, ['pa', 'pb']);
    // 이미 놓은 홀드
    const released = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    expect((await h.release(released, fanHeaders('pa'))).status).toBe(204);
    const afterRelease = await h.snapshot(e);
    const again = await h.release(released, fanHeaders('pa'));
    expect({ status: again.status, raw: again.raw }).toEqual({ status: 204, raw: '' });
    expect(await h.snapshot(e)).toEqual(afterRelease);
    // 만료된 홀드: 그 좌석을 다른 사람이 새로 잡은 뒤에 놓아도 남의 홀드를 풀지 않는다
    const expired = await h.holdOk(e, ['A-2'], fanHeaders('pa'));
    h.clock.advance(TTL_MS + 1);
    await h.seatAdmin.expire(h.clock.now());
    expect((await h.holdRow(expired))?.status).toBe('EXPIRED');
    const bHold = await h.holdOk(e, ['A-2'], fanHeaders('pb'));
    const before = await h.snapshot(e);
    const late = await h.release(expired, fanHeaders('pa'));
    expect({ status: late.status, raw: late.raw }).toEqual({ status: 204, raw: '' });
    expect(await h.snapshot(e)).toEqual(before);
    expect((await h.seatRows(e)).find((s) => s.seatId === 'A-2')).toEqual({ seatId: 'A-2', status: 'HELD', holdId: bHold });
    expect(await h.held(e, 'acc-pb')).toBe(1);
    expect(await h.held(e, 'acc-pa')).toBe(0);
  });
});

// ───────────────────────── 연장(§14 동작 4, FR-042, POL-012, S-T6·S-T29) ─────────────────────────

describe('연장 POST /v1/holds/{holdId}/extension', () => {
  test('ST6_FR042_POL012_자기홀드를연장하면200이고_만료가원래만료에서3분늘며연장가능은false다', async () => {
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, ['pa']);
    const t0 = h.clock.now();
    const holdId = await h.holdOk(e, ['A-2', 'A-1'], fanHeaders('pa'));
    // 연장은 지금이 아니라 원래 만료 시각에서 늘린다
    h.clock.advance(2 * 60 * 1000);
    const r = await h.extend(holdId, fanHeaders('pa'));
    expect({ status: r.status, contentType: r.contentType }, r.raw).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    expect(r.body).toEqual({ holdId, seatIds: expect.any(Array), expiresAt: refKst(t0 + TTL_MS + EXTEND_MS), extendable: false });
    expect(sorted(r.body.seatIds)).toEqual(['A-1', 'A-2']);
    expect(await h.holdRow(holdId)).toEqual({
      holdId, eventId: e, accountId: 'acc-pa', seatIds: ['A-1', 'A-2'], status: 'HELD', extended: true, heldAtMs: t0, expiresAtMs: t0 + TTL_MS + EXTEND_MS,
    });
    expect(await h.held(e, 'acc-pa')).toBe(2);
    await h.expectConsistent(e);
  });

  test('ST6_FR042_POL012_두번째연장은409이미연장이고_만료는그대로다', async () => {
    const e = await h.openEvent(ids('A', 2));
    await h.admit(e, ['pa']);
    const t0 = h.clock.now();
    const holdId = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    expect((await h.extend(holdId, fanHeaders('pa'))).status).toBe(200);
    const before = await h.holdRow(holdId);
    expectProblem(await h.extend(holdId, fanHeaders('pa')), 409, 'hold-already-extended');
    expectProblem(await h.extend(holdId, fanHeaders('pa', { session: 'ses-pa-tab2' })), 409, 'hold-already-extended');
    expect(await h.holdRow(holdId)).toEqual(before);
    expect(before?.expiresAtMs).toBe(t0 + TTL_MS + EXTEND_MS);
  });

  test('POL012_회차에정한연장시간이있으면_그만큼늘린다', async () => {
    const e = await h.openEvent(ids('A', 2), { holdTtlMs: 120_000, extendMs: 45_000 });
    await h.admit(e, ['pa']);
    const t0 = h.clock.now();
    const holdId = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    const r = await h.extend(holdId, fanHeaders('pa'));
    expect(r.status, r.raw).toBe(200);
    expect(r.body.expiresAt).toBe(refKst(t0 + 120_000 + 45_000));
    expect((await h.holdRow(holdId))?.expiresAtMs).toBe(t0 + 165_000);
  });

  test('ST29_남의홀드와없는홀드의연장은같은404홀드없음이고_그홀드는늘지않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const e = await h.openEvent(['SEATY-1', 'SEATY-2', 'SEATY-3']);
    await h.admit(e, ['pa', 'pb']);
    const bHold = await h.holdOk(e, ['SEATY-1'], fanHeaders('pb'));
    // pb가 이미 연장한 홀드와 놓은 홀드
    const bExtended = await h.holdOk(e, ['SEATY-2'], fanHeaders('pb'));
    expect((await h.extend(bExtended, fanHeaders('pb'))).status).toBe(200);
    const bReleased = await h.holdOk(e, ['SEATY-3'], fanHeaders('pb'));
    expect((await h.release(bReleased, fanHeaders('pb'))).status).toBe(204);
    const before = await h.snapshot(e);
    const theirs = await h.extend(bHold, fanHeaders('pa'));
    const missing = await h.extend(randomUUID(), fanHeaders('pa'));
    const samePidOtherAccount = await h.extend(bHold, fanHeaders('pb', { account: 'acc-intruder' }));
    // 남이 이미 연장한 홀드는 409가 아니라 404다(409를 주면 그런 홀드가 있다고 알리게 된다, §14 동작 4 '남의 홀드는 404')
    const theirsExtended = await h.extend(bExtended, fanHeaders('pa'));
    const theirsReleased = await h.extend(bReleased, fanHeaders('pa'));
    const others = [theirs, samePidOtherAccount, theirsExtended, theirsReleased];
    for (const r of [...others, missing]) expectProblem(r, 404, 'hold-not-found');
    for (const r of others) {
      expect(problemShape(r), r.raw).toEqual(problemShape(missing));
      for (const secret of ['acc-pb', 'SEATY-1', 'SEATY-2', 'SEATY-3', e]) expect(r.raw).not.toContain(secret);
    }
    expect(await h.snapshot(e)).toEqual(before);
    // pb는 아직 자기 1회 연장을 쓸 수 있다
    expect((await h.extend(bHold, fanHeaders('pb'))).status).toBe(200);
  });

  test('FR042_끝난홀드의연장은404홀드없음이다_놓은홀드와만료된홀드와연장뒤놓은홀드', async () => {
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, ['pa']);
    const released = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    expect((await h.release(released, fanHeaders('pa'))).status).toBe(204);
    expectProblem(await h.extend(released, fanHeaders('pa')), 404, 'hold-not-found');
    expect(await h.holdRow(released)).toMatchObject({ status: 'RELEASED', extended: false });

    // 연장한 뒤 놓은 홀드도 끝난 홀드라 404다(409 '이미 연장'은 아직 HELD인 홀드의 두 번째 연장, §14 동작 4)
    const extendedThenReleased = await h.holdOk(e, ['A-3'], fanHeaders('pa'));
    expect((await h.extend(extendedThenReleased, fanHeaders('pa'))).status).toBe(200);
    expect((await h.release(extendedThenReleased, fanHeaders('pa'))).status).toBe(204);
    expectProblem(await h.extend(extendedThenReleased, fanHeaders('pa')), 404, 'hold-not-found');

    const expired = await h.holdOk(e, ['A-2'], fanHeaders('pa'));
    h.clock.advance(TTL_MS + 1);
    await h.seatAdmin.expire(h.clock.now());
    expect((await h.holdRow(expired))?.status).toBe('EXPIRED');
    const before = await h.snapshot(e);
    expectProblem(await h.extend(expired, fanHeaders('pa')), 404, 'hold-not-found');
    expect(await h.snapshot(e)).toEqual(before);
  });
});

// ───────────────────────── 만료(§14 동작 5, FR-042, S-T6) ─────────────────────────

describe('만료 createSeatAdmin().expire', () => {
  test('ST6_FR042_만료시각전에는풀지않고_지난뒤에풀어좌석이다시비고보유수가줄며홀드는EXPIRED다', async () => {
    await h.flushExpired();
    const e = await h.openEvent(ids('A', 5));
    await h.admit(e, ['pa', 'pb']);
    const t0 = h.clock.now();
    const a = await h.holdOk(e, ['A-1', 'A-2'], fanHeaders('pa'));
    const b = await h.holdOk(e, ['A-3'], fanHeaders('pb'));
    // 만료 시각 1ms 전에는 풀지 않는다
    expect(await h.seatAdmin.expire(t0 + TTL_MS - 1)).toBe(0);
    expect(await h.seatStatus(e)).toMatchObject({ 'A-1': 'HELD', 'A-2': 'HELD', 'A-3': 'HELD' });
    expect(await h.held(e, 'acc-pa')).toBe(2);
    // 지나면 푼다
    h.clock.advance(TTL_MS + 1);
    expect(await h.seatAdmin.expire(h.clock.now())).toBe(2);
    expect(await h.seatRows(e)).toEqual(ids('A', 5).map((seatId) => ({ seatId, status: 'AVAILABLE', holdId: null })));
    expect((await h.holdRows(e)).map((x) => [x.holdId, x.status]).sort()).toEqual([
      [a, 'EXPIRED'],
      [b, 'EXPIRED'],
    ].sort());
    expect(await h.held(e, 'acc-pa')).toBe(0);
    expect(await h.held(e, 'acc-pb')).toBe(0);
    await h.expectConsistent(e);
    // 다시 보이고 다른 사람이 잡을 수 있다
    const list = await h.seats(e, fanHeaders('pb'));
    expect((list.body.seats as { status: string }[]).every((s) => s.status === 'AVAILABLE')).toBe(true);
    await h.holdOk(e, ['A-1'], fanHeaders('pb'));
  });

  test('FR042_같은만료를두번불러도두번풀지않고_보유수가한번만준다', async () => {
    await h.flushExpired();
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, ['pa']);
    await h.holdOk(e, ['A-1', 'A-2'], fanHeaders('pa'));
    await h.holdOk(e, ['A-3'], fanHeaders('pa'));
    h.clock.advance(TTL_MS + 1);
    expect(await h.seatAdmin.expire(h.clock.now())).toBe(2);
    expect(await h.seatAdmin.expire(h.clock.now())).toBe(0);
    h.clock.advance(1000);
    expect(await h.seatAdmin.expire(h.clock.now())).toBe(0);
    expect(await h.held(e, 'acc-pa')).toBe(0);
    await h.expectConsistent(e);
  });

  test('FR042_만료는HELD홀드만풀고_이미놓은홀드와그좌석을새로잡은남의홀드는건드리지않는다', async () => {
    // §14 동작 5: '만료 시각이 지난 HELD 홀드'만 고른다. 놓은 홀드(RELEASED)는 만료 시각이 지나도 대상이 아니다
    await h.flushExpired();
    const e = await h.openEvent(ids('A', 2));
    await h.admit(e, ['pa', 'pb']);
    const listener = await h.listenNotifications();
    const t0 = h.clock.now();
    const released = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    expect((await h.release(released, fanHeaders('pa'))).status).toBe(204);
    const due = await h.holdOk(e, ['A-2'], fanHeaders('pa'));
    h.clock.advance(60_000);
    const bHold = await h.holdOk(e, ['A-1'], fanHeaders('pb')); // t0 + 1분 + TTL에 만료
    // 놓은 홀드와 due의 만료 시각(t0 + TTL)은 지났고 pb의 홀드는 아직이다
    const at = t0 + TTL_MS + 1;
    expect(await h.seatAdmin.expire(at)).toBe(1);
    expect(await h.holdRow(released)).toMatchObject({ status: 'RELEASED' });
    expect(await h.holdRow(due)).toMatchObject({ status: 'EXPIRED' });
    expect(await h.holdRow(bHold)).toMatchObject({ status: 'HELD' });
    expect(await h.seatRows(e)).toEqual([
      { seatId: 'A-1', status: 'HELD', holdId: bHold },
      { seatId: 'A-2', status: 'AVAILABLE', holdId: null },
    ]);
    expect(await h.held(e, 'acc-pa')).toBe(0);
    expect(await h.held(e, 'acc-pb')).toBe(1);
    await h.expectConsistent(e);
    // 만료 변경분은 푼 좌석(A-2)만이다
    const expired = { eventId: e, changes: [{ seatId: 'A-2', status: 'AVAILABLE' }], atMs: at };
    const got = await SeatHarness.untilMarker(listener.inbox, e, expired);
    expect(got[got.length - 1]).toEqual(expired);
    expect(got.filter((m) => m.atMs === at)).toEqual([expired]);
    await listener.close();
  });

  test('FR042_두복제본이동시에만료를돌려도_홀드마다한번만풀고좌석마다변경분이한번나간다', { timeout: 60_000 }, async () => {
    await h.flushExpired();
    const e = await h.openEvent(ids('A', 8), { perPersonLimit: 10 });
    await h.admit(e, ['pa', 'pb', 'pc']);
    await h.holdOk(e, ['A-1', 'A-2'], fanHeaders('pa'));
    await h.holdOk(e, ['A-3'], fanHeaders('pb'));
    await h.holdOk(e, ['A-4', 'A-5', 'A-6'], fanHeaders('pc'));
    await h.holdOk(e, ['A-7'], fanHeaders('pa'));
    const listener = await h.listenNotifications();
    const second = h.secondSeatAdmin();
    h.clock.advance(TTL_MS + 1);
    const now = h.clock.now();
    const [n1, n2] = await Promise.all([h.seatAdmin.expire(now), second.expire(now)]);
    expect(n1 + n2).toBe(4);
    expect(await h.seatAdmin.expire(now)).toBe(0);
    expect(await second.expire(now)).toBe(0);
    expect((await h.holdRows(e)).map((x) => x.status)).toEqual(['EXPIRED', 'EXPIRED', 'EXPIRED', 'EXPIRED']);
    for (const account of ['acc-pa', 'acc-pb', 'acc-pc']) expect(await h.held(e, account), account).toBe(0);
    await h.expectConsistent(e);
    // 변경분: 푼 좌석마다 AVAILABLE이 한 번씩만 나간다(같은 좌석을 두 번 알리지 않는다)
    const seatChanges = () => SeatHarness.forEvent(listener.inbox, e).flatMap((m) => m.changes);
    await waitUntil(() => seatChanges().length >= 7, 5_000, '만료 변경분 7좌석');
    await sleep(QUIET_MS);
    expect(seatChanges().map((c) => c.seatId).sort()).toEqual(ids('A', 7).sort());
    expect(seatChanges().every((c) => c.status === 'AVAILABLE')).toBe(true);
    for (const m of SeatHarness.forEvent(listener.inbox, e)) expect(m.atMs).toBe(now);
    await listener.close();
  });

  test('FR042_연장한홀드는늘어난만료시각까지풀리지않는다', async () => {
    await h.flushExpired();
    const e = await h.openEvent(ids('A', 2));
    await h.admit(e, ['pa']);
    const t0 = h.clock.now();
    const holdId = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    expect((await h.extend(holdId, fanHeaders('pa'))).status).toBe(200);
    expect(await h.seatAdmin.expire(t0 + TTL_MS + 1)).toBe(0);
    expect(await h.seatAdmin.expire(t0 + TTL_MS + EXTEND_MS - 1)).toBe(0);
    expect((await h.holdRow(holdId))?.status).toBe('HELD');
    expect(await h.seatAdmin.expire(t0 + TTL_MS + EXTEND_MS + 1)).toBe(1);
    expect((await h.holdRow(holdId))?.status).toBe('EXPIRED');
    expect(await h.seatStatus(e)).toEqual({ 'A-1': 'AVAILABLE', 'A-2': 'AVAILABLE' });
  });
});

// ───────────────────────── 변경분 WebSocket(§14 동작 6, S-T12의 v0, K4) ─────────────────────────
// 변경분을 받는 시험만 LISTEN 시작(feedReady)을 기다린다. 업그레이드 거절 시험은 변경분을 받지 않는다.

describe('변경분 WebSocket GET /v0/events/{eventId}/seat-deltas', () => {
  test('ST12_같은회차에연결한모든WebSocket이홀드해제만료변경분JSON을받고_다른회차연결은받지않는다 [ASVS v5.0.0-14.1.1]', { timeout: 60_000 }, async () => {
    await h.feedReady();
    const e = await h.openEvent(ids('A', 6));
    const other = await h.openEvent(ids('A', 3));
    await h.admit(e, ['pa', 'pb', 'pc']);
    await h.admit(other, ['pd']);
    const conns = [
      await h.openDeltas(e, fanHeaders('pa')),
      await h.openDeltas(e, fanHeaders('pa', { session: 'ses-pa-tab2' })), // 같은 사람의 다른 탭
      await h.openDeltas(e, fanHeaders('pb'), SECOND_ALLOWED_ORIGIN),
      await h.openDeltas(e, fanHeaders('pc')),
    ];
    const otherConn = await h.openDeltas(other, fanHeaders('pd'));

    const t1 = h.clock.now();
    const holdId = await h.holdOk(e, ['A-2', 'A-1'], fanHeaders('pa'));
    for (const c of conns) await c.inbox.waitForCount(1);

    h.clock.advance(1000);
    const t2 = h.clock.now();
    expect((await h.release(holdId, fanHeaders('pa'))).status).toBe(204);
    for (const c of conns) await c.inbox.waitForCount(2);

    const t3 = h.clock.now();
    const b = await h.holdOk(e, ['A-5'], fanHeaders('pb'));
    for (const c of conns) await c.inbox.waitForCount(3);
    h.clock.advance(TTL_MS + 1);
    const t4 = h.clock.now();
    await h.seatAdmin.expire(t4);
    expect((await h.holdRow(b))?.status).toBe('EXPIRED');
    for (const c of conns) await c.inbox.waitForCount(4);

    const want: DeltaMessage[] = [
      { eventId: e, changes: changesOf(['A-1', 'A-2'], 'HELD'), atMs: t1 },
      { eventId: e, changes: changesOf(['A-1', 'A-2'], 'AVAILABLE'), atMs: t2 },
      { eventId: e, changes: changesOf(['A-5'], 'HELD'), atMs: t3 },
      { eventId: e, changes: changesOf(['A-5'], 'AVAILABLE'), atMs: t4 },
    ];
    for (const c of conns) {
      expect(c.inbox.messages.map(sortedDelta)).toEqual(want);
      expect(c.inbox.binary).toEqual([false, false, false, false]);
      // 누가 잡았는지(계정·pid·홀드 ID)는 싣지 않는다
      for (const raw of c.inbox.raw) for (const secret of ['acc-pa', 'acc-pb', holdId, b]) expect(raw).not.toContain(secret);
    }
    // 다른 회차 연결은 그 회차의 표지 홀드 하나만 받는다(위 네 변경분은 오지 않았다)
    const t5 = h.clock.now();
    await h.holdOk(other, ['A-1'], fanHeaders('pd'));
    await otherConn.inbox.waitForCount(1);
    await sleep(QUIET_MS);
    expect(otherConn.inbox.messages).toEqual([{ eventId: other, changes: [{ seatId: 'A-1', status: 'HELD' }], atMs: t5 }]);
    for (const c of conns) expect(c.inbox.raw, '다른 회차 변경분이 오지 않는다').toHaveLength(4);
  });

  test('ST12_변경분은커밋된바뀜만나가_실패한홀드와실패한해제와연장은변경분이없다', { timeout: 60_000 }, async () => {
    await h.feedReady();
    const e = await h.openEvent(ids('A', 6), { perPersonLimit: 2 });
    await h.admit(e, ['pa', 'pb']);
    const c = await h.openDeltas(e, fanHeaders('pb'));
    const t1 = h.clock.now();
    const aHold = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    const gone = await h.holdOk(e, ['A-5'], fanHeaders('pa'));
    expect((await h.release(gone, fanHeaders('pa'))).status).toBe(204);
    await c.inbox.waitForCount(3);
    // 여기부터는 아무것도 바꾸지 않는 요청뿐이다
    expectProblem(await h.hold(e, ['A-2', 'A-1'], fanHeaders('pb')), 409, 'seat-already-held'); // A-2를 잠근 뒤 A-1에서 되돌린다
    expectProblem(await h.hold(e, ['A-2', 'A-3', 'A-4'], fanHeaders('pb')), 422, 'purchase-limit-exceeded');
    expectProblem(await h.hold(e, ['A-2', 'A-2'], fanHeaders('pb')), 422, 'invalid-seat');
    expectProblem(await h.release(aHold, fanHeaders('pb')), 404, 'hold-not-found');
    // 이미 끝난 자기 홀드의 해제는 204지만 아무것도 바꾸지 않는다(§14 동작 3)
    expect((await h.release(gone, fanHeaders('pa'))).status).toBe(204);
    // 연장은 좌석 상태를 바꾸지 않으므로 변경분이 없다
    expect((await h.extend(aHold, fanHeaders('pa'))).status).toBe(200);
    expectProblem(await h.extend(aHold, fanHeaders('pa')), 409, 'hold-already-extended');
    // 이 회차에 만료 시각이 지난 홀드가 없을 때의 만료
    await h.seatAdmin.expire(h.clock.now());
    // 표지: 성공한 홀드 하나. 그 앞에 다른 변경분이 끼지 않았다
    const t2 = h.clock.now();
    await h.holdOk(e, ['A-6'], fanHeaders('pb'));
    await c.inbox.waitForCount(4);
    await sleep(QUIET_MS);
    expect(c.inbox.messages.map(sortedDelta)).toEqual([
      { eventId: e, changes: [{ seatId: 'A-1', status: 'HELD' }], atMs: t1 },
      { eventId: e, changes: [{ seatId: 'A-5', status: 'HELD' }], atMs: t1 },
      { eventId: e, changes: [{ seatId: 'A-5', status: 'AVAILABLE' }], atMs: t1 },
      { eventId: e, changes: [{ seatId: 'A-6', status: 'HELD' }], atMs: t2 },
    ]);
  });

  test('ST12_연결에보내는글은v0_seat_delta채널알림의JSON그대로다', { timeout: 60_000 }, async () => {
    await h.feedReady();
    expect(DELTA_CHANNEL).toBe(DELTA_CHANNEL_NAME);
    const listener = await h.listenNotifications();
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, ['pa']);
    const c = await h.openDeltas(e, fanHeaders('pa'));
    const holdId = await h.holdOk(e, ['A-3', 'A-1'], fanHeaders('pa'));
    expect((await h.release(holdId, fanHeaders('pa'))).status).toBe(204);
    await c.inbox.waitForCount(2);
    await waitUntil(() => SeatHarness.forEvent(listener.inbox, e).length >= 2, 5_000, '알림 2건');
    const notified = listener.inbox.raw.filter((r) => (JSON.parse(r) as DeltaMessage).eventId === e);
    expect(c.inbox.raw).toEqual(notified);
    for (const raw of notified) expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(['atMs', 'changes', 'eventId']);
    await listener.close();
  });

  test('ST12_업그레이드요청에신원머리가없으면401이고_ticketbuy스코프나pid가없으면403이다 [ASVS v5.0.0-8.2.1]', async () => {
    const e = await h.openEvent(ids('A', 2));
    await h.admit(e, ['pa']);
    const path = h.deltaPath(e);
    const full = fanHeaders('pa');
    const noPid: Headers = { ...full };
    delete noPid['x-user-pid'];
    const noAccount: Headers = { ...full };
    delete noAccount['x-user-id'];
    const noSession: Headers = { ...full };
    delete noSession['x-session-id'];
    const cases: [string, Headers, number][] = [
      ['신원 머리 없음', {}, 401],
      ['계정 없음', noAccount, 401],
      ['세션 없음', noSession, 401],
      ['스코프 없음', fanHeaders('pa', { scope: '' }), 403],
      ['다른 스코프', fanHeaders('pa', { scope: 'ticket:read profile:read' }), 403],
      ['pid 없음', noPid, 403],
    ];
    for (const [label, headers, status] of cases) {
      expect({ label, outcome: await h.connect(path, headers, ALLOWED_ORIGIN) }).toEqual({ label, outcome: { kind: 'rejected', status } });
    }
    // 팬이 아닌 신원(§14 동작 6 '팬·ticket:buy·pid·입장')은 열리지 않는다. 그 상태 코드는 정본이 정하지 않아 401·403 둘 다 받는다
    for (const aud of ['scanner', 'staff', '']) {
      const outcome = await h.connect(path, { ...full, 'x-user-aud': aud }, ALLOWED_ORIGIN);
      expect({ aud, kind: outcome.kind }).toEqual({ aud, kind: 'rejected' });
      expect([401, 403], aud).toContain(outcome.kind === 'rejected' ? outcome.status : 0);
    }
    // 모두 갖추면 열린다(위 거절이 다른 까닭이 아니다)
    expect((await h.connect(path, full, ALLOWED_ORIGIN)).kind).toBe('open');
  });

  test('ST12_업그레이드요청에Origin이없거나허용출처와정확히같지않으면403이다 [ASVS v5.0.0-4.4.2]', async () => {
    const e = await h.openEvent(ids('A', 2));
    await h.admit(e, ['pa']);
    const path = h.deltaPath(e);
    for (const origin of [undefined, 'http://evil.example', 'http://127.0.0.1:8089', 'https://127.0.0.1:8088', 'http://127.0.0.1:8088/', 'null', `${ALLOWED_ORIGIN}.evil.example`]) {
      expect({ origin, outcome: await h.connect(path, fanHeaders('pa'), origin) }).toEqual({ origin, outcome: { kind: 'rejected', status: 403 } });
    }
    for (const origin of [ALLOWED_ORIGIN, SECOND_ALLOWED_ORIGIN]) {
      expect((await h.connect(path, fanHeaders('pa'), origin)).kind, origin).toBe('open');
    }
  });

  test('ST12_그회차에입장하지않은사람의업그레이드는403이다_다른회차입장도마찬가지다 [ASVS v5.0.0-8.2.1]', async () => {
    const e = await h.openEvent(ids('A', 2));
    const other = await h.openEvent(ids('A', 2));
    await h.admit(other, ['elsewhere']);
    await h.enterOnly(e, 'waiting');
    for (const pid of ['stranger', 'waiting', 'elsewhere']) {
      expect({ pid, outcome: await h.connect(h.deltaPath(e), fanHeaders(pid), ALLOWED_ORIGIN) }).toEqual({ pid, outcome: { kind: 'rejected', status: 403 } });
    }
    // 입장한 회차에는 열린다
    expect((await h.connect(h.deltaPath(other), fanHeaders('elsewhere'), ALLOWED_ORIGIN)).kind).toBe('open');
  });

  test('ST12_형식이틀린회차의업그레이드는400이고_변경분이아닌경로는404다', async () => {
    // 업그레이드는 입장만 본다(좌석을 열지 않아도 된다)
    const e = h.newEventId();
    await h.admit(e, ['pa']);
    const cases: [string, number][] = [
      ['/v0/events/bad.id/seat-deltas', 400],
      [`/v0/events/${'z'.repeat(65)}/seat-deltas`, 400],
      ['/v0/events/bad%7Bx%7D/seat-deltas', 400],
      ['/v0/events/a%2Fb/seat-deltas', 400],
      [`/v0/events/${e}/seat-delta`, 404],
      [`/v0/events/${e}/seat-deltas/x`, 404],
      [`/v0/events/${e}/seats`, 404],
      ['/v0/seat-deltas', 404],
    ];
    for (const [path, status] of cases) {
      expect({ path, outcome: await h.connect(path, fanHeaders('pa'), ALLOWED_ORIGIN) }).toEqual({ path, outcome: { kind: 'rejected', status } });
    }
  });

  test('ST12_회차자리의퍼센트인코딩이깨진업그레이드도400으로끊고_서비스는계속받는다', async () => {
    // 업그레이드는 입장만 본다(좌석을 열지 않아도 된다)
    const e = h.newEventId();
    await h.admit(e, ['pa']);
    expect(await h.connect('/v0/events/bad%E0%A4%A/seat-deltas', fanHeaders('pa'), ALLOWED_ORIGIN)).toEqual({ kind: 'rejected', status: 400 });
    expect((await h.connect(h.deltaPath(e), fanHeaders('pa'), ALLOWED_ORIGIN)).kind).toBe('open');
  });
});

// ───────────────────────── 좌석맵 화면(§14 동작 7, K5의 v0, v0-baseline V3) ─────────────────────────

describe('좌석맵 화면 GET /v0/seatmap/{eventId}', () => {
  const ASSETS: [string, RegExp][] = [
    ['seatmap-page.js', /^text\/javascript(;\s*charset=utf-8)?$/i],
    ['seatmap-model.js', /^text\/javascript(;\s*charset=utf-8)?$/i],
    ['seatmap.css', /^text\/css(;\s*charset=utf-8)?$/i],
    // 랩 판정 계측(§14 동작 7, BSL-070 ②): 같은 출처의 정한 이름으로만 낸다
    ['vitals.js', /^text\/javascript(;\s*charset=utf-8)?$/i],
    ['web-vitals.js', /^text\/javascript(;\s*charset=utf-8)?$/i],
  ];
  /** CSP 머리를 지시어 → 값 목록으로 편다 */
  function parseCsp(v: unknown): Record<string, string[]> {
    expect(typeof v, 'content-security-policy 머리').toBe('string');
    const out: Record<string, string[]> = {};
    for (const part of String(v).split(';')) {
      const [name, ...values] = part.trim().split(/\s+/);
      if (name) out[name.toLowerCase()] = values;
    }
    return out;
  }

  test('FR009_좌석맵화면은신원없이열리는HTML이고_CSP가같은출처파일만싣게한다 [ASVS v5.0.0-3.4.3]', async () => {
    const e = h.newEventId();
    for (const headers of [{}, fanHeaders('anyone')]) {
      const r = await h.http('GET', `/v0/seatmap/${e}`, headers);
      expect(r.status, r.raw).toBe(200);
      expect(r.contentType).toMatch(/^text\/html(;\s*charset=utf-8)?$/i);
      expect(r.raw).toMatch(/^<!doctype html>/i);
      const csp = parseCsp(r.headers['content-security-policy']);
      expect(csp).toMatchObject({
        'default-src': ["'none'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      });
      for (const [name, values] of Object.entries(csp)) {
        for (const bad of ["'unsafe-inline'", "'unsafe-eval'", '*', 'data:', 'http:', 'https:']) expect(values, `${name}에 ${bad}`).not.toContain(bad);
      }
    }
  });

  test('FR009_좌석맵화면과파일은다른페이지에끼워넣을수없다 [ASVS v5.0.0-3.4.6]', async () => {
    const page = await h.http('GET', `/v0/seatmap/${h.newEventId()}`, {});
    expect(parseCsp(page.headers['content-security-policy'])['frame-ancestors']).toEqual(["'none'"]);
    for (const [file] of ASSETS) {
      const r = await h.http('GET', `/v0/seatmap/assets/${file}`, {});
      expect(parseCsp(r.headers['content-security-policy'])['frame-ancestors'], file).toEqual(["'none'"]);
    }
  });

  test('FR009_좌석맵화면과파일응답에nosniff가있다 [ASVS v5.0.0-3.4.4]', async () => {
    // v0-baseline 3.4.4 행: '좌석맵 화면과 파일 응답에 둔다'. Referrer-Policy는 v0 정본(§14 동작 7, v0-baseline)에 없어 보지 않는다
    const page = await h.http('GET', `/v0/seatmap/${h.newEventId()}`, {});
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    for (const [file, type] of ASSETS) {
      const r = await h.http('GET', `/v0/seatmap/assets/${file}`, {});
      expect(r.status, file).toBe(200);
      expect(r.contentType, file).toMatch(type);
      expect(r.headers['x-content-type-options'], file).toBe('nosniff');
    }
  });

  test('FR009_화면HTML에는인라인스크립트와스타일과이벤트처리기가없고_같은출처파일만부르며_캔버스한장과상태줄이있다 [ASVS v5.0.0-3.4.3]', async () => {
    const html = (await h.http('GET', `/v0/seatmap/${h.newEventId()}`, {})).raw;
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    for (const [, attrs, body] of scripts) {
      expect(attrs, '스크립트는 src로만').toMatch(/\ssrc\s*=/i);
      expect(body!.trim(), '인라인 스크립트 본문').toBe('');
    }
    expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i); // onclick= 같은 인라인 처리기
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/<[^>]+\sstyle\s*=/i);
    // 부르는 파일은 모두 같은 출처 경로이고 실제로 받힌다
    const refs = [...html.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      expect(ref, ref).toMatch(/^\/(?!\/)/);
      const r = await h.http('GET', ref, {});
      expect(r.status, ref).toBe(200);
    }
    expect(html.match(/<canvas\b/gi)).toHaveLength(1);
    expect(html).toMatch(/role\s*=\s*"status"/i);
  });

  test('FR009_화면파일은정한셋만내주고_다른이름과상위경로는404다', async () => {
    for (const [file, type] of ASSETS) {
      const r = await h.http('GET', `/v0/seatmap/assets/${file}`, {});
      expect({ file, status: r.status }).toEqual({ file, status: 200 });
      expect(r.contentType).toMatch(type);
      expect(r.raw.length, file).toBeGreaterThan(0);
    }
    const bad = [
      'index.html',
      'package.json',
      '.env',
      'seatmap-model.js.map',
      'SEATMAP.CSS',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      '..%2Fpackage.json',
      '..%2F..%2F..%2Fpackage.json',
      '%2E%2E%2Fsrc%2Fmain.ts',
      '..%5C..%5Cpackage.json',
    ];
    for (const name of bad) {
      const r = await h.http('GET', `/v0/seatmap/assets/${name}`, {});
      expect({ name, status: r.status }).toEqual({ name, status: 404 });
      expect(r.raw, name).not.toContain('@peaket/v0-monolith');
    }
    for (const url of ['/v0/seatmap/assets/../../../package.json', '/v0/seatmap/assets/../../src/main.ts']) {
      const r = await h.http('GET', url, {});
      expect({ url, status: r.status }).toEqual({ url, status: 404 });
      expect(r.raw, url).not.toContain('@peaket/v0-monolith');
      expect(r.raw, url).not.toContain('PEAKET_V0_DATABASE_URL');
    }
  });

  test('K5 NFR012_좌석맵화면은랩판정계측을화면스크립트보다먼저싣고_고정판web-vitals를같은출처로낸다 [ASVS v5.0.0-3.4.3]', async () => {
    const page = (await h.http('GET', `/v0/seatmap/${h.newEventId()}`, {})).raw;
    const vitalsAt = page.indexOf('src="/v0/seatmap/assets/vitals.js"');
    expect(vitalsAt, '계측 스크립트').toBeGreaterThan(0);
    expect(vitalsAt).toBeLessThan(page.indexOf('src="/v0/seatmap/assets/seatmap-page.js"'));
    const lib = await h.http('GET', '/v0/seatmap/assets/web-vitals.js', {});
    expect(lib.status).toBe(200);
    for (const fn of ['onINP', 'onLCP', 'onCLS']) expect(lib.raw, fn).toContain(fn);
    // 속성 정보 빌드여야 원인 칸이 있다(표준 빌드도 onINP는 같다): 고정 판 패키지의 ESM 파일과 같은 바이트인지 본다
    const require = createRequire(import.meta.url);
    const attributionEsm = join(dirname(require.resolve('web-vitals/attribution')), 'web-vitals.attribution.js');
    expect(lib.raw).toBe(readFileSync(attributionEsm, 'utf8'));
    for (const field of ['interactionTarget', 'largestShiftTarget', 'elementRenderDelay']) expect(lib.raw, field).toContain(field);
    const vitals = (await h.http('GET', '/v0/seatmap/assets/vitals.js', {})).raw;
    expect(vitals).toContain('./web-vitals.js');
    expect(vitals).toContain('__peaketVitals');
    // 화면은 밖으로 보내지 않는다(v0에는 텔레메트리 입구가 없다)
    for (const send of ['fetch(', 'sendBeacon', 'XMLHttpRequest', 'WebSocket']) expect(vitals, send).not.toContain(send);
  });

  test('FR009_화면스크립트는서버값과오류문구를textContent로넣고_HTML로해석하는길을쓰지않는다 [ASVS v5.0.0-3.2.2]', async () => {
    const page = (await h.http('GET', '/v0/seatmap/assets/seatmap-page.js', {})).raw;
    const model = (await h.http('GET', '/v0/seatmap/assets/seatmap-model.js', {})).raw;
    for (const [name, js] of [
      ['seatmap-page.js', page],
      ['seatmap-model.js', model],
    ] as const) {
      for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'eval(', 'new Function']) {
        expect(js, `${name}의 ${sink}`).not.toContain(sink);
      }
    }
    expect(page).toContain('textContent');
  });
});

// ───────────────────────── 권한·입력(docs/security/asvs/v0-baseline.md) ─────────────────────────

describe('권한과 입력', () => {
  /** 네 경로(좌석 목록·홀드·해제·연장) */
  async function fourRoutes(e: string, holdId: string, headers: Headers): Promise<[string, SeatReply][]> {
    return [
      ['seats', await h.seats(e, headers)],
      ['hold', await h.hold(e, ['A-2'], headers)],
      ['release', await h.release(holdId, headers)],
      ['extend', await h.extend(holdId, headers)],
    ];
  }

  test('FR009_FR010_FR042_신원머리가없거나팬이아니면네경로모두401이고아무것도바꾸지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, ['pa']);
    const holdId = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    const before = await h.snapshot(e);
    const noSession: Headers = { ...fanHeaders('pa') };
    delete noSession['x-session-id'];
    // 모든 경로는 팬이다(§14 동작). 팬이 아닌 신원은 플랫폼 인증 가드가 401로 거절한다(대기열 v0와 같다)
    const notFan: Headers = { ...fanHeaders('pa'), 'x-user-aud': 'scanner' };
    for (const headers of [{}, noSession, notFan]) {
      for (const [route, r] of await fourRoutes(e, holdId, headers)) expectStatus(r, 401, route);
    }
    expect(await h.snapshot(e)).toEqual(before);
  });

  test('FR009_FR010_FR042_ticketbuy스코프가없으면네경로모두403이고아무것도바꾸지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, ['pa']);
    const holdId = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    const before = await h.snapshot(e);
    for (const scope of ['', 'ticket:read', 'profile:read']) {
      for (const [route, r] of await fourRoutes(e, holdId, fanHeaders('pa', { scope }))) expectStatus(r, 403, `${route} ${scope}`);
    }
    expect(await h.snapshot(e)).toEqual(before);
  });

  test('FR009_FR010_FR042_pid가없으면네경로모두403이고아무것도바꾸지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, ['pa']);
    const holdId = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    const before = await h.snapshot(e);
    const noPid: Headers = { ...fanHeaders('pa') };
    delete noPid['x-user-pid'];
    for (const [route, r] of await fourRoutes(e, holdId, noPid)) expectStatus(r, 403, route);
    expect(await h.snapshot(e)).toEqual(before);
  });

  test('FR010_FR042_holdId가UUID꼴이아니면해제와연장모두400이다 [ASVS v5.0.0-2.2.1]', async () => {
    const e = await h.openEvent(ids('A', 2));
    await h.admit(e, ['pa']);
    const holdId = await h.holdOk(e, ['A-1'], fanHeaders('pa'));
    const before = await h.snapshot(e);
    for (const bad of ['not-a-uuid', '123', `${holdId}x`, holdId.replaceAll('-', ''), encodeURIComponent("1' OR '1'='1")]) {
      expectStatus(await h.http('DELETE', `/v1/holds/${bad}`, fanHeaders('pa')), 400, `release ${bad}`);
      expectStatus(await h.http('POST', `/v1/holds/${bad}/extension`, fanHeaders('pa')), 400, `extend ${bad}`);
    }
    expect(await h.snapshot(e)).toEqual(before);
  });

  test('FR009_FR010_회차ID형식이틀리면좌석목록과홀드가400이다 [ASVS v5.0.0-2.2.1]', async () => {
    for (const bad of ['bad.id', 'z'.repeat(65), 'bad%7Bx%7D', encodeURIComponent("x' OR '1'='1")]) {
      expectStatus(await h.http('GET', `/v0/events/${bad}/seats`, fanHeaders('pa')), 400, `seats ${bad}`);
      expectStatus(await h.http('POST', `/v1/events/${bad}/holds`, fanHeaders('pa'), { seatIds: ['A-1'] }), 400, `hold ${bad}`);
    }
  });
});

// ───────────────────────── 저장(docs/security/asvs/v0-baseline.md 1.2.4·14.1.1) ─────────────────────────

describe('저장', () => {
  test('FR010_표칸은정본표와같고_사람값으로는계정ID만있으며pid와세션ID는어디에도없다 [ASVS v5.0.0-14.1.1]', async () => {
    const cols = await h.inspect.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name like 'v0\\_%' order by table_name, column_name",
    );
    const tables: Record<string, string[]> = {};
    for (const c of cols.rows) (tables[c.table_name] ??= []).push(c.column_name);
    for (const t of Object.keys(tables)) tables[t]!.sort();
    // 같은 DB·같은 마이그레이션의 v0_ 표 전부(좌석: seat-hold §14 표, 주문·결제: payment §13 표, 발권·검표: offline-gate §13 표)
    expect(tables).toEqual({
      v0_hold: sorted(['hold_id', 'event_id', 'account_id', 'seat_ids', 'status', 'extended', 'held_at', 'expires_at']),
      v0_quota: sorted(['event_id', 'account_id', 'held', 'sold']),
      v0_seat: sorted(['event_id', 'seat_id', 'section', 'row_label', 'seat_number', 'x', 'y', 'grade', 'status', 'hold_id', 'order_id']),
      v0_seat_event: sorted(['event_id', 'per_person_limit', 'hold_ttl_ms', 'extend_ms']),
      v0_price: sorted(['event_id', 'grade', 'price']),
      v0_order: sorted(['order_id', 'event_id', 'account_id', 'hold_id', 'seat_ids', 'amount', 'order_name', 'status', 'created_at']),
      v0_order_item: sorted(['order_id', 'line_no', 'seat_id', 'grade', 'price', 'ticket_id']),
      v0_order_event: sorted(['order_id', 'seq', 'to_status', 'reason', 'occurred_at']),
      v0_payment: sorted(['payment_id', 'order_id', 'event_id', 'pg', 'payment_key', 'amount', 'status', 'failure', 'approved_at', 'created_at']),
      v0_ticket: sorted(['ticket_id', 'order_id', 'event_id', 'seat_id', 'account_id', 'code', 'status', 'issued_at', 'entered_at', 'entered_by']),
      v0_gate_staff: sorted(['event_id', 'account_id']),
    });

    const pid = 'pidonly7f3a';
    const account = 'acconly5d2e';
    const session = 'sesonly91bc';
    const e = await h.openEvent(ids('A', 3));
    await h.admit(e, [pid]);
    const who = fanHeaders(pid, { account, session });
    const holdId = await h.holdOk(e, ['A-1', 'A-2'], who);
    expect((await h.extend(holdId, who)).status).toBe(200);
    await h.holdOk(e, ['A-3'], who);
    // 행 별칭은 칸 이름과 겹치지 않게 rec로 둔다(v0_seat에 x 칸이 있어 별칭 x는 그 칸으로 읽힌다)
    const dump = await h.inspect.query<{ t: string; row: string }>(
      `select 'v0_hold' as t, row_to_json(rec)::text as row from v0_hold rec where event_id = $1
       union all select 'v0_seat', row_to_json(rec)::text from v0_seat rec where event_id = $1
       union all select 'v0_quota', row_to_json(rec)::text from v0_quota rec where event_id = $1
       union all select 'v0_seat_event', row_to_json(rec)::text from v0_seat_event rec where event_id = $1`,
      [e],
    );
    expect(new Set(dump.rows.map((r) => r.t))).toEqual(new Set(['v0_hold', 'v0_seat', 'v0_quota', 'v0_seat_event']));
    const all = dump.rows.map((r) => r.row).join('\n');
    expect(all).not.toContain(pid);
    expect(all).not.toContain(session);
    // 계정 ID는 홀드와 보유 수에만 있다
    for (const r of dump.rows) {
      if (r.row.includes(account)) expect(['v0_hold', 'v0_quota'], r.row).toContain(r.t);
    }
    expect((await h.holdRows(e)).map((x) => x.accountId)).toEqual([account, account]);
    expect(await h.quotaRows(e)).toEqual([{ accountId: account, held: 3 }]);
  });

  test('FR010_따옴표와SQL조각이든계정ID도그대로저장되고_다른계정의홀드를건드리지못한다 [ASVS v5.0.0-1.2.4]', async () => {
    const evil = ["acc'); DROP TABLE v0_seat; --", 'acc" OR "1"="1', "acc\\' OR 1=1 --", "acc' OR '1'='1"];
    const e = await h.openEvent(ids('A', 6));
    await h.admit(e, ['victim', 'evil']);
    const victimHold = await h.holdOk(e, ['A-1'], fanHeaders('victim'));
    const evilHolds: string[] = [];
    for (const [i, account] of evil.entries()) {
      const holdId = await h.holdOk(e, [`A-${i + 2}`], fanHeaders('evil', { account }));
      evilHolds.push(holdId);
      expect((await h.holdRow(holdId))?.accountId).toBe(account);
      expect(await h.held(e, account)).toBe(1);
    }
    for (const account of evil) {
      expectProblem(await h.release(victimHold, fanHeaders('evil', { account })), 404, 'hold-not-found');
      expectProblem(await h.extend(victimHold, fanHeaders('evil', { account })), 404, 'hold-not-found');
    }
    expect(await h.holdRow(victimHold)).toMatchObject({ status: 'HELD', extended: false, accountId: 'acc-victim' });
    // 자기 홀드는 그 계정으로만 놓인다
    expectProblem(await h.release(evilHolds[0]!, fanHeaders('evil', { account: evil[3]! })), 404, 'hold-not-found');
    expect((await h.release(evilHolds[0]!, fanHeaders('evil', { account: evil[0]! }))).status).toBe(204);
    expect(await h.held(e, evil[0]!)).toBe(0);
    // 표가 그대로 있다
    const n = await h.inspect.query<{ n: number }>('select count(*)::int as n from v0_seat where event_id = $1', [e]);
    expect(n.rows[0]!.n).toBe(6);
    await h.expectConsistent(e);
  });

  test('FR010_SQL조각이든좌석ID와회차ID는400이고_표가그대로다 [ASVS v5.0.0-1.2.4]', async () => {
    const e = await h.openEvent(ids('A', 2));
    await h.admit(e, ['pa']);
    const before = await h.snapshot(e);
    for (const seat of ["A-1' OR '1'='1", 'A-1;DROP TABLE v0_hold', 'A-1"--', "A-1')--"]) {
      expectStatus(await h.hold(e, [seat], fanHeaders('pa')), 400, seat);
      expectStatus(await h.hold(e, ['A-2', seat], fanHeaders('pa')), 400, `A-2 + ${seat}`);
    }
    expectStatus(await h.http('GET', `/v0/events/${encodeURIComponent("x';DROP TABLE v0_seat;--")}/seats`, fanHeaders('pa')), 400, 'event');
    expect(await h.snapshot(e)).toEqual(before);
    const n = await h.inspect.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_name in ('v0_seat','v0_hold','v0_quota','v0_seat_event')");
    expect(n.rows[0]!.n).toBe(4);
  });
});
