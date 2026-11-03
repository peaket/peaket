// 대기열 v0(docs/features/queue-admission.md §13) 통합 시험: 실제 Valkey 컨테이너 + 모놀리스 HTTP(inject) + 모듈 공개 함수.
// 시계만 가짜(fakeClock)다. 입장 루프는 끄고(tickIntervalMs false) createQueueAdmin().tick(지금 시각)으로 한 칸씩 돌린다.
// 시험마다 회차 ID를 새로 만들어 서로 섞이지 않는다. 시계는 파일 안에서 앞으로만 간다.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  GRACE_MS,
  JSON_CONTENT_TYPE,
  PROBLEM_CONTENT_TYPE,
  QueueHarness,
  ROUTES,
  type Reply,
  type Route,
  expectProblem,
  fanHeaders,
} from './queue-harness.js';

let h: QueueHarness;

beforeAll(async () => {
  h = await QueueHarness.start();
});

afterAll(async () => {
  await h?.close();
});

const ALL_ROUTES = Object.keys(ROUTES) as Route[];

/** POL-007 예상 대기(앞 인원 ÷ 속도의 올림, 앞 인원 0이면 0, 속도 0 이하면 null) */
const refEta = (ahead: number, rate: number): number | null => (ahead === 0 ? 0 : rate <= 0 ? null : Math.ceil(ahead / rate));
/** docs/frontend.md §5.1 nextDelayMs 기본 간격(ADR-0110) */
const refPoll = (ahead: number, rate: number): number => {
  const eta = ahead / Math.max(rate, 0.001);
  return eta <= 60 ? 500 : eta <= 300 ? 5_000 : 20_000;
};

/**
 * 판매 중 WAITING의 예상 대기·폴링 간격이 응답의 앞 인원·속도와 맞는지 본다(속도 값이 시험에서 정해지지 않을 때).
 * 속도는 '최근 10칸 [가정] 평균'이라 칸이 10개 차기 전의 값(있는 칸의 평균인지 10으로 나눈 값인지)은 §13이 정하지 않는다.
 * 다만 어느 쪽이든 1초에 부른 수의 평균이므로 0 이상, 정한 수(admitPerSecond) 이하다
 */
function expectWaitingFollowsRate(r: Reply, o: { seq: number; ahead: number; serving: number; admitPerSecond: number }): void {
  expect(r.status, r.raw).toBe(200);
  expect(r.body.servingRate).toBeGreaterThanOrEqual(0);
  expect(r.body.servingRate).toBeLessThanOrEqual(o.admitPerSecond);
  expect(r.body).toEqual({
    status: 'WAITING',
    seq: o.seq,
    ahead: o.ahead,
    serving: o.serving,
    servingRate: expect.any(Number),
    etaSeconds: refEta(o.ahead, r.body.servingRate as number),
    pollAfterMs: refPoll(o.ahead, r.body.servingRate as number),
    saleStatus: 'ON_SALE',
    serverTimeMs: h.clock.now(),
  });
}

const pids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

// ───────────────────────── 진입(§13 동작 1, FR-006, POL-002, Q-T4) ─────────────────────────

describe('진입 POST /v1/queues/{eventId}/entries', () => {
  test('FR006_연회차에진입하면_201로순번과세대0과주입시계의서버시각을준다', async () => {
    const e = await h.open();
    const a = await h.enter(e, 'p1');
    expect({ status: a.status, contentType: a.contentType }).toEqual({ status: 201, contentType: JSON_CONTENT_TYPE });
    expect(a.body).toEqual({ seq: 1, generation: 0, serverTimeMs: h.clock.now() });
    h.clock.advance(250);
    const b = await h.enter(e, 'p2');
    expect(b.status).toBe(201);
    expect(b.body).toEqual({ seq: 2, generation: 0, serverTimeMs: h.clock.now() });
  });

  test('POL002_QT4_같은pid로다시진입하면_409이미대기중이고번호를새로주지않는다', async () => {
    const e = await h.open();
    expect((await h.enter(e, 'p1')).body).toEqual({ seq: 1, generation: 0, serverTimeMs: h.clock.now() });
    expectProblem(await h.enter(e, 'p1'), 409, 'already-in-queue');
    // 계정·세션이 달라도 pid가 같으면 같은 사람이다(POL-002는 pid로 판정한다)
    expectProblem(await h.enter(e, 'p1', fanHeaders('p1', { account: 'acc-other', session: 'ses-other' })), 409, 'already-in-queue');
    // 거절된 두 번은 번호를 쓰지 않았다: 다음 사람이 2번이다
    expect((await h.enter(e, 'p2')).body).toEqual({ seq: 2, generation: 0, serverTimeMs: h.clock.now() });
    // 내 자리는 처음 받은 번호 그대로다
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'WAITING', seq: 1, ahead: 0 });
  });

  test('QT4_같은pid로여러탭과기기에서동시에진입하면_번호하나만나가고나머지는409다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.open();
    const pid = 'p-multi';
    // 탭 여럿(같은 계정·세션) 10건과 기기 여럿(같은 사람의 다른 계정·세션) 10건을 한꺼번에 보낸다
    const headers = [
      ...Array.from({ length: 10 }, () => fanHeaders(pid, { account: 'acc-tabs', session: 'ses-tabs' })),
      ...Array.from({ length: 10 }, (_, i) => fanHeaders(pid, { account: `acc-dev${i}`, session: `ses-dev${i}` })),
    ];
    const replies = await Promise.all(headers.map((hd) => h.enter(e, pid, hd)));
    const created = replies.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toEqual({ seq: 1, generation: 0, serverTimeMs: h.clock.now() });
    const rejected = replies.filter((r) => r.status !== 201);
    expect(rejected).toHaveLength(19);
    for (const r of rejected) expectProblem(r, 409, 'already-in-queue');
    // 거절된 19건은 번호를 받지 않았다: 다음 사람이 2번이다
    expect((await h.enter(e, 'p-next')).body).toEqual({ seq: 2, generation: 0, serverTimeMs: h.clock.now() });
    expect((await h.status(e, pid)).body).toMatchObject({ status: 'WAITING', seq: 1, ahead: 0 });
  });

  test('FR006_서로다른사람50명이동시에진입하면_순번이1부터50까지겹치지않게나간다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.open();
    const people = pids('c', 50);
    const replies = await Promise.all(people.map((p) => h.enter(e, p)));
    expect(replies.map((r) => r.status)).toEqual(Array(50).fill(201));
    const seqs = replies.map((r) => r.body.seq as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // 각자의 앞 인원은 자기보다 작은 순번의 수다
    for (const [i, p] of people.entries()) {
      expect((await h.status(e, p)).body).toMatchObject({ status: 'WAITING', seq: seqs[i], ahead: seqs[i]! - 1 });
    }
  });

  test('FR006_연적없는회차에진입하면_404회차없음이고회차를만들지않는다', async () => {
    const e = h.newEventId();
    expectProblem(await h.enter(e, 'p1'), 404, 'queue-not-found');
    expectProblem(await h.enter(e, 'p1'), 404, 'queue-not-found');
    expectProblem(await h.enter(e, 'p2'), 404, 'queue-not-found');
    expectProblem(await h.status(e, 'p1'), 404, 'queue-not-found');
    expectProblem(await h.admit(e, 'p1'), 404, 'queue-not-found');
    // 연 회차 목록에 들지 않았다: 입장 루프가 이 회차를 돌지 않는다(§13 동작 4·6, 회차는 공개 함수로만 연다)
    const ticked = (await h.admin.tick(h.clock.now())).map((t) => t.eventId);
    expect(ticked).not.toContain(e);
    // 아무 회차 ID로나 키를 만들 수 없다(순번 카운터·대기 줄이 생기지 않았다)
    expect(await h.eventKeys(e)).toEqual([]);
  });

  test('FR006_POL002_판매종료뒤에는진입이410판매종료이고_종료1ms전은받는다', async () => {
    const end = h.clock.now() + 10_000;
    const e = await h.open({ saleEndsAtMs: end });
    h.clock.advance(9_999); // 종료 1ms 전
    expect((await h.enter(e, 'p-before')).body).toEqual({ seq: 1, generation: 0, serverTimeMs: end - 1 });
    h.clock.advance(2); // 종료 1ms 뒤
    expectProblem(await h.enter(e, 'p-after'), 410, 'sale-ended');
    // 거절은 번호를 쓰지 않는다
    expect((await h.status(e, 'p-before')).body).toMatchObject({ status: 'WAITING', seq: 1 });
  });

  test('POL002_입장한사람이다시진입하면_15분이지나도409이미입장이다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1']);
    h.alignToSecond();
    await h.tick(e);
    expect((await h.admit(e, 'p1')).body).toEqual({ status: 'ADMITTED', seq: 1, serverTimeMs: h.clock.now() });
    expectProblem(await h.enter(e, 'p1'), 409, 'already-admitted');
    h.clock.advance(GRACE_MS + 1);
    expectProblem(await h.enter(e, 'p1'), 409, 'already-admitted');
    // 거절은 번호를 쓰지 않는다
    expect((await h.enter(e, 'p2')).body).toEqual({ seq: 2, generation: 0, serverTimeMs: h.clock.now() });
  });

  test('POL002_POL008_차례온지15분안의재진입은409이고_15분을넘기면맨뒤새번호다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1', 'p2', 'p3']);
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 1, serving: 1 });
    h.clock.advance(GRACE_MS); // 차례 뒤 정확히 15분: 아직 유효하다
    expectProblem(await h.enter(e, 'p1'), 409, 'already-in-queue');
    h.clock.advance(1); // 15분 + 1ms: 만료라 맨 뒤 새 번호다
    const re = await h.enter(e, 'p1');
    expect(re.status).toBe(201);
    expect(re.body).toEqual({ seq: 4, generation: 0, serverTimeMs: h.clock.now() });
    // 맨 뒤: 아직 기다리는 p2·p3가 앞에 있다
    expectWaitingFollowsRate(await h.status(e, 'p1'), { seq: 4, ahead: 2, serving: 1, admitPerSecond: 1 });
    // 만료된 차례 기록은 지워졌다(§13 동작 1 '그 기록을 지우고'): 옛 차례로 입장하지 못하고 새 번호로 기다린다
    expect((await h.admit(e, 'p1')).body).toEqual({ status: 'NOT_YET', seq: 4, serverTimeMs: h.clock.now() });
  });

  test('QT4_POL002_차례가만료된사람이여러탭에서동시에다시진입해도_새번호는하나만나간다 [ASVS v5.0.0-2.3.4]', async () => {
    // 만료 기록 지우기와 새 번호 발급이 한 번에 되지 않으면 동시 재진입이 번호를 둘 받는다(§13 동작 1, 판정마다 Lua 하나)
    const e = await h.open({ admitPerSecond: 1 });
    await h.enterAll(e, ['p1', 'p2']);
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 1, serving: 1 });
    h.clock.advance(GRACE_MS + 1);
    const replies = await Promise.all(Array.from({ length: 10 }, () => h.enter(e, 'p1')));
    expect(replies.filter((r) => r.status === 201).map((r) => r.body)).toEqual([{ seq: 3, generation: 0, serverTimeMs: h.clock.now() }]);
    const rejected = replies.filter((r) => r.status !== 201);
    expect(rejected).toHaveLength(9);
    for (const r of rejected) expectProblem(r, 409, 'already-in-queue');
    // 거절된 9건은 번호를 쓰지 않았다
    expect((await h.enter(e, 'p3')).body).toEqual({ seq: 4, generation: 0, serverTimeMs: h.clock.now() });
    expectWaitingFollowsRate(await h.status(e, 'p1'), { seq: 3, ahead: 1, serving: 1, admitPerSecond: 1 });
  });

  test('POL002_1인1순번은회차마다라_같은사람이다른회차에도줄을서고_한회차의입장이다른회차를막지않는다', async () => {
    // 키는 회차 해시 태그로 묶인다(§13 키 표). POL-002 '이 회차에 이미 입장한 사람은 다시 줄을 설 수 없다'
    const e = await h.open({ admitPerSecond: 1 });
    const f = await h.open({ admitPerSecond: 1 });
    await h.enterAll(e, ['p0']);
    expect((await h.enter(e, 'p1')).body).toEqual({ seq: 2, generation: 0, serverTimeMs: h.clock.now() });
    // 순번 카운터도 회차마다 따로다
    expect((await h.enter(f, 'p1')).body).toEqual({ seq: 1, generation: 0, serverTimeMs: h.clock.now() });
    h.alignToSecond();
    await h.tick(f); // e는 p0, f는 p1을 부른다
    expect((await h.admit(f, 'p1')).body).toEqual({ status: 'ADMITTED', seq: 1, serverTimeMs: h.clock.now() });
    // f의 입장이 e의 자리를 바꾸지 않는다
    expectWaitingFollowsRate(await h.status(e, 'p1'), { seq: 2, ahead: 0, serving: 1, admitPerSecond: 1 });
    expectProblem(await h.enter(e, 'p1'), 409, 'already-in-queue');
    expectProblem(await h.enter(f, 'p1'), 409, 'already-admitted');
  });
});

// ───────────────────────── 대기 상태(§13 동작 2, FR-007, POL-007, Q-T2, ADR-0110) ─────────────────────────

describe('대기 상태 GET /v1/queues/{eventId}/entries/me', () => {
  test('FR007_QT2_기다리는사람의상태는_WAITING과ZRANK앞인원과회차값이다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1', 'p2', 'p3']);
    h.clock.advance(1_234);
    const r1 = await h.status(e, 'p1');
    expect({ status: r1.status, contentType: r1.contentType }).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    // 아직 아무도 부르지 않았다: serving 0, 속도 0
    expect(r1.body).toEqual({ status: 'WAITING', seq: 1, ahead: 0, serving: 0, servingRate: 0, etaSeconds: 0, pollAfterMs: 500, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now() });
    expect((await h.status(e, 'p2')).body).toEqual({
      status: 'WAITING', seq: 2, ahead: 1, serving: 0, servingRate: 0, etaSeconds: null, pollAfterMs: 20_000, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
    });
  });

  test('ADR0110_QT2_속도가0이면_앞인원이있을때예상대기는null이고폴링은20000ms다', async () => {
    const e = await h.open();
    await h.enterAll(e, pids('z', 4));
    expect((await h.status(e, 'z4')).body).toEqual({
      status: 'WAITING', seq: 4, ahead: 3, serving: 0, servingRate: 0, etaSeconds: null, pollAfterMs: 20_000, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
    });
    // 앞 인원이 0이면 속도와 상관없이 예상 대기 0초, 가까운 구간(500ms)이다
    expect((await h.status(e, 'z1')).body).toEqual({
      status: 'WAITING', seq: 1, ahead: 0, serving: 0, servingRate: 0, etaSeconds: 0, pollAfterMs: 500, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
    });
  });

  test('QT2_POL007_조회마다앞인원을다시세어_중간사람이취소하거나불리면바로줄어든다', async () => {
    const e = await h.open({ admitPerSecond: 1 });
    await h.enterAll(e, pids('p', 5));
    expect((await h.status(e, 'p5')).body).toMatchObject({ status: 'WAITING', seq: 5, ahead: 4 });
    // 대기표 기준(POL-007): 취소한 사람은 앞 인원에서 바로 빠진다
    expect((await h.cancel(e, 'p2')).status).toBe(204);
    expect((await h.status(e, 'p5')).body).toMatchObject({ status: 'WAITING', seq: 5, ahead: 3 });
    expect((await h.cancel(e, 'p4')).status).toBe(204);
    expect((await h.status(e, 'p5')).body).toMatchObject({ status: 'WAITING', seq: 5, ahead: 2 });
    // 차례가 온 사람도 앞 인원에서 빠진다
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 1, serving: 1 });
    expectWaitingFollowsRate(await h.status(e, 'p5'), { seq: 5, ahead: 1, serving: 1, admitPerSecond: 1 });
    expectWaitingFollowsRate(await h.status(e, 'p3'), { seq: 3, ahead: 0, serving: 1, admitPerSecond: 1 });
  });

  describe('거리별 폴링 간격(속도 1명/초를 10칸 이어 만든 뒤 앞 인원 60·61·300·301)', () => {
    let e: string;

    beforeAll(async () => {
      e = await h.open({ admitPerSecond: 1 });
      // d1..d312가 순번 1..312를 받는다. 10칸 동안 1명씩 불러 1..10이 차례가 오고 속도는 1이다.
      // 기다리는 사람은 11..312라 순번 s의 앞 인원은 s − 11이다
      await h.enterAll(e, pids('d', 312));
      h.alignToSecond();
      const ticks = await h.tickSeconds(e, 10);
      expect(ticks.map((t) => t.called)).toEqual(Array(10).fill(1));
      expect(ticks.at(-1)).toEqual({ eventId: e, ticked: true, called: 1, serving: 10 });
    }, 120_000);

    const waiting = (seq: number, etaSeconds: number, pollAfterMs: number) => ({
      status: 'WAITING', seq, ahead: seq - 11, serving: 10, servingRate: 1, etaSeconds, pollAfterMs, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
    });

    test('QT2_ADR0110_예상대기가정확히60초면_폴링500ms다', async () => {
      expect((await h.status(e, 'd71')).body).toEqual(waiting(71, 60, 500));
    });

    test('QT2_ADR0110_예상대기가60초를넘으면_폴링5000ms다', async () => {
      expect((await h.status(e, 'd72')).body).toEqual(waiting(72, 61, 5_000));
    });

    test('QT2_ADR0110_예상대기가정확히300초면_폴링5000ms다', async () => {
      expect((await h.status(e, 'd311')).body).toEqual(waiting(311, 300, 5_000));
    });

    test('QT2_ADR0110_예상대기가300초를넘으면_폴링20000ms다', async () => {
      expect((await h.status(e, 'd312')).body).toEqual(waiting(312, 301, 20_000));
    });

    test('QT2_ADR0110_가장가까운사람은_앞인원0에폴링500ms다', async () => {
      expect((await h.status(e, 'd11')).body).toEqual(waiting(11, 0, 500));
    });
  });

  test('FR007_POL008_차례가온사람은_CALLED이고폴링500ms다', async () => {
    const e = await h.open({ admitPerSecond: 2 });
    await h.enterAll(e, ['p1', 'p2', 'p3']);
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 2, serving: 2 });
    h.clock.advance(700);
    for (const [pid, seq] of [['p1', 1], ['p2', 2]] as const) {
      expect((await h.status(e, pid)).body).toEqual({
        status: 'CALLED', seq, ahead: 0, serving: 2, servingRate: expect.any(Number), etaSeconds: 0, pollAfterMs: 500, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
      });
    }
    expectWaitingFollowsRate(await h.status(e, 'p3'), { seq: 3, ahead: 0, serving: 2, admitPerSecond: 2 });
  });

  test('FR007_POL008_차례뒤정확히15분은CALLED이고_1ms넘으면EXPIRED에폴링null이다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1']);
    h.alignToSecond();
    await h.tick(e);
    h.clock.advance(GRACE_MS);
    expect((await h.status(e, 'p1')).body).toEqual({
      status: 'CALLED', seq: 1, ahead: 0, serving: 1, servingRate: expect.any(Number), etaSeconds: 0, pollAfterMs: 500, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
    });
    h.clock.advance(1);
    expect((await h.status(e, 'p1')).body).toEqual({
      status: 'EXPIRED', seq: 1, ahead: 0, serving: 1, servingRate: expect.any(Number), etaSeconds: 0, pollAfterMs: null, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
    });
  });

  test('FR007_입장한사람은_ADMITTED에폴링null이고15분이지나도그대로다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1']);
    h.alignToSecond();
    await h.tick(e);
    expect((await h.admit(e, 'p1')).status).toBe(200);
    const admitted = () => ({
      status: 'ADMITTED', seq: 1, ahead: 0, serving: 1, servingRate: expect.any(Number), etaSeconds: 0, pollAfterMs: null, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
    });
    expect((await h.status(e, 'p1')).body).toEqual(admitted());
    h.clock.advance(GRACE_MS + 1);
    expect((await h.status(e, 'p1')).body).toEqual(admitted());
  });

  test('FR007_판매가끝나면_saleStatus는ENDED이고폴링null이다', async () => {
    const end = h.clock.now() + 5_000;
    const e = await h.open({ saleEndsAtMs: end });
    await h.enterAll(e, ['p1', 'p2']);
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'WAITING', saleStatus: 'ON_SALE', pollAfterMs: 500 });
    h.clock.advance(5_001);
    expect((await h.status(e, 'p1')).body).toEqual({
      status: 'WAITING', seq: 1, ahead: 0, serving: 0, servingRate: 0, etaSeconds: 0, pollAfterMs: null, saleStatus: 'ENDED', serverTimeMs: h.clock.now(),
    });
    expect((await h.status(e, 'p2')).body).toEqual({
      status: 'WAITING', seq: 2, ahead: 1, serving: 0, servingRate: 0, etaSeconds: null, pollAfterMs: null, saleStatus: 'ENDED', serverTimeMs: h.clock.now(),
    });
  });

  test('FR007_줄에없으면404줄에없음이고_연적없는회차면404회차없음이다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['someone']);
    expectProblem(await h.status(e, 'nobody'), 404, 'not-in-queue');
    expectProblem(await h.status(e, 'nobody'), 404, 'not-in-queue');
    expectProblem(await h.status(h.newEventId(), 'someone'), 404, 'queue-not-found');
    // 조회는 아무것도 바꾸지 않는다: 404 조회가 자리를 만들거나 번호를 쓰지 않았다
    expect((await h.enter(e, 'nobody')).body).toEqual({ seq: 2, generation: 0, serverTimeMs: h.clock.now() });
  });

  test('FR007_조회는상태를바꾸지않는다_여러번조회해도같고EXPIRED를조회해도입장확정은410이다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1', 'p2']);
    const first = await h.status(e, 'p2');
    for (let i = 0; i < 5; i += 1) expect((await h.status(e, 'p2')).body).toEqual(first.body);
    // 조회는 순번을 쓰지 않는다
    expect((await h.enter(e, 'p3')).body).toEqual({ seq: 3, generation: 0, serverTimeMs: h.clock.now() });
    h.alignToSecond();
    await h.tick(e); // p1 차례
    h.clock.advance(GRACE_MS + 1);
    for (let i = 0; i < 3; i += 1) expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'EXPIRED', seq: 1, pollAfterMs: null });
    // 조회가 만료 기록을 지우지 않았다: 입장 확정은 404가 아니라 410이다
    expectProblem(await h.admit(e, 'p1'), 410, 'queue-ticket-expired', { rejoinAllowed: true });
    // 입장 확정이 만료 기록을 지운 뒤에는 줄에 없다
    expectProblem(await h.status(e, 'p1'), 404, 'not-in-queue');
    // 그동안 다른 사람의 자리도 그대로다
    expectWaitingFollowsRate(await h.status(e, 'p2'), { seq: 2, ahead: 0, serving: 1, admitPerSecond: 1 });
  });
});

// ───────────────────────── 입장 루프(§13 동작 4, POL-007·008) ─────────────────────────

describe('입장 루프 createQueueAdmin().tick', () => {
  test('POL008_1초칸마다정한수만큼순번순으로부르고_serving은부른가장큰순번이다', async () => {
    const e = await h.open({ admitPerSecond: 2 });
    await h.enterAll(e, pids('p', 5));
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 2, serving: 2 });
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'CALLED', seq: 1, serving: 2 });
    expect((await h.status(e, 'p2')).body).toMatchObject({ status: 'CALLED', seq: 2, serving: 2 });
    expect((await h.status(e, 'p3')).body).toMatchObject({ status: 'WAITING', seq: 3, ahead: 0, serving: 2 });
    h.clock.advance(1_000);
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 2, serving: 4 });
    expect((await h.status(e, 'p4')).body).toMatchObject({ status: 'CALLED', seq: 4, serving: 4 });
    expect((await h.status(e, 'p5')).body).toMatchObject({ status: 'WAITING', seq: 5, ahead: 0, serving: 4 });
    h.clock.advance(1_000);
    // 남은 사람이 정한 수보다 적으면 남은 만큼만 부른다
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 1, serving: 5 });
    expect((await h.status(e, 'p5')).body).toMatchObject({ status: 'CALLED', seq: 5, serving: 5 });
  });

  test('POL008_같은1초칸을복제본둘이부르면_한쪽만부르고_다음칸은다시부른다', async () => {
    const e = await h.open({ admitPerSecond: 1 });
    await h.enterAll(e, ['p1', 'p2', 'p3']);
    const t0 = h.alignToSecond();
    const other = await h.secondAdmin();
    // 두 복제본이 같은 1초 칸(유닉스 초)을 동시에 부른다
    const [a, b] = await Promise.all([h.tick(e, h.admin, t0), h.tick(e, other, t0 + 999)]);
    expect([a!.ticked, b!.ticked].sort()).toEqual([false, true]);
    expect(a!.called + b!.called).toBe(1);
    // 같은 칸 안의 늦은 호출도 부르지 않는다
    expect(await h.tick(e, other, t0 + 500)).toEqual({ eventId: e, ticked: false, called: 0, serving: 1 });
    // 이미 지난 칸도 부르지 않는다
    expect(await h.tick(e, h.admin, t0 - 1_000)).toEqual({ eventId: e, ticked: false, called: 0, serving: 1 });
    expect((await h.status(e, 'p2')).body).toMatchObject({ status: 'WAITING', seq: 2, ahead: 0, serving: 1 });
    // 다음 칸은 다시 부른다
    h.clock.advance(1_000);
    expect(await h.tick(e, other)).toEqual({ eventId: e, ticked: true, called: 1, serving: 2 });
    expect((await h.status(e, 'p3')).body).toMatchObject({ status: 'WAITING', seq: 3, ahead: 0, serving: 2 });
  });

  test('POL007_POL008_취소한번호는건너뛰고_다음사람을부른다', async () => {
    const e = await h.open({ admitPerSecond: 2 });
    await h.enterAll(e, pids('p', 4));
    expect((await h.cancel(e, 'p2')).status).toBe(204);
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 2, serving: 3 });
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'CALLED', seq: 1 });
    expect((await h.status(e, 'p3')).body).toMatchObject({ status: 'CALLED', seq: 3 });
    expectProblem(await h.status(e, 'p2'), 404, 'not-in-queue');
    expectWaitingFollowsRate(await h.status(e, 'p4'), { seq: 4, ahead: 0, serving: 3, admitPerSecond: 2 });
  });

  test('POL008_칸을건너뛰고불러도_밀린칸을몰아부르지않고한번에정한수만큼만부른다 [ASVS v5.0.0-2.4.1]', async () => {
    // §13 동작 4: 그 1초 칸이 last_tick보다 클 때 admitPerSecond명을 꺼낸다(부를 수는 정한 값이다). 밀린 칸 수를 곱하지 않는다
    const e = await h.open({ admitPerSecond: 2 });
    await h.enterAll(e, pids('p', 10));
    const t0 = h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 2, serving: 2 });
    h.clock.advance(5_000); // 4칸을 건너뛴다(복제본이 모두 잠깐 멈춘 경우)
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 2, serving: 4 });
    expect((await h.status(e, 'p5')).body).toMatchObject({ status: 'WAITING', seq: 5, ahead: 0, serving: 4 });
    const log = await h.admin.servingLog(e);
    expect(log.reduce((n, l) => n + l.called, 0)).toBe(4);
    expect(log.at(-1)).toEqual({ serving: 4, called: 2, atMs: t0 + 5_000 });
  });

  test('POL008_servingLog에는1초칸마다serving과부른수와시각이오래된것부터남고_회차마다따로다', async () => {
    const e = await h.open({ admitPerSecond: 2 });
    const f = await h.open({ admitPerSecond: 1 });
    await h.enterAll(e, pids('e', 5));
    await h.enterAll(f, pids('f', 3));
    const t0 = h.alignToSecond();
    await h.tick(e); // e: 2명(serving 2), f: 1명(serving 1)
    await h.tick(e, h.admin, t0 + 400); // 같은 칸: 남지 않는다
    h.clock.advance(1_000);
    await h.tick(e); // e: 2명(serving 4), f: 1명(serving 2)
    h.clock.advance(1_000);
    await h.tick(e); // e: 1명(serving 5), f: 1명(serving 3)
    expect(await h.admin.servingLog(e)).toEqual([
      { serving: 2, called: 2, atMs: t0 },
      { serving: 4, called: 2, atMs: t0 + 1_000 },
      { serving: 5, called: 1, atMs: t0 + 2_000 },
    ]);
    expect(await h.admin.servingLog(f)).toEqual([
      { serving: 1, called: 1, atMs: t0 },
      { serving: 2, called: 1, atMs: t0 + 1_000 },
      { serving: 3, called: 1, atMs: t0 + 2_000 },
    ]);
  });

  test('POL008_판매종료뒤에는부르지않는다', async () => {
    const t0 = h.alignToSecond();
    const e = await h.open({ admitPerSecond: 1, saleEndsAtMs: t0 + 1_500 });
    await h.enterAll(e, ['p1', 'p2', 'p3']);
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 1, serving: 1 });
    h.clock.advance(1_000);
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 1, serving: 2 });
    h.clock.advance(1_000); // 판매 종료 뒤
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: false, called: 0, serving: 2 });
    h.clock.advance(1_000);
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: false, called: 0, serving: 2 });
    expect((await h.status(e, 'p3')).body).toMatchObject({ status: 'WAITING', seq: 3, ahead: 0, serving: 2, saleStatus: 'ENDED', pollAfterMs: null });
    expect(await h.admin.servingLog(e)).toEqual([
      { serving: 1, called: 1, atMs: t0 },
      { serving: 2, called: 1, atMs: t0 + 1_000 },
    ]);
  });

  test('POL008_줄이비어도그칸은맡고_아무도부르지않으며serving은그대로다', async () => {
    const e = await h.open({ admitPerSecond: 5 });
    await h.enterAll(e, ['p1']);
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 1, serving: 1 });
    h.clock.advance(1_000);
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 0, serving: 1 });
  });

  test('POL007_QT2_차례진행속도는1초칸마다부른수의평균이고_예상대기와폴링간격에쓰인다', async () => {
    const e = await h.open({ admitPerSecond: 3 });
    await h.enterAll(e, pids('r', 40));
    h.alignToSecond();
    const ticks = await h.tickSeconds(e, 10);
    expect(ticks.map((t) => t.called)).toEqual(Array(10).fill(3));
    // 10칸 모두 3명씩: 속도 3. r40의 앞 인원은 31..39의 9명, 예상 대기 9 ÷ 3 = 3초
    expect((await h.status(e, 'r40')).body).toEqual({
      status: 'WAITING', seq: 40, ahead: 9, serving: 30, servingRate: 3, etaSeconds: 3, pollAfterMs: 500, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
    });
  });

  test('POL007_차례진행속도는마지막칸이아니라_최근10칸의평균이다', async () => {
    const e = await h.open({ admitPerSecond: 3 });
    await h.enterAll(e, pids('s', 31));
    h.alignToSecond();
    const ticks = await h.tickSeconds(e, 11);
    // 3명씩 10칸, 마지막 칸은 남은 1명: 최근 10칸 = 3 × 9 + 1 = 28명 → 2.8명/초
    expect(ticks.map((t) => t.called)).toEqual([...Array(10).fill(3), 1]);
    const r = await h.status(e, 's31');
    expect(r.body).toMatchObject({ status: 'CALLED', seq: 31, serving: 31 });
    expect(r.body.servingRate).toBeCloseTo(2.8, 9);
  });
});

// ───────────────────────── 입장 확정(§13 동작 5, FR-008, POL-008) ─────────────────────────

describe('입장 확정 POST /v1/queues/{eventId}/admission', () => {
  test('FR008_차례전입장확정은_200NOT_YET과순번이고상태를바꾸지않는다 [ASVS v5.0.0-2.4.1]', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1', 'p2']);
    const r = await h.admit(e, 'p2');
    expect({ status: r.status, contentType: r.contentType }).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    expect(r.body).toEqual({ status: 'NOT_YET', seq: 2, serverTimeMs: h.clock.now() });
    expect((await h.admit(e, 'p2')).body).toEqual({ status: 'NOT_YET', seq: 2, serverTimeMs: h.clock.now() });
    // NOT_YET은 아무것도 옮기지 않는다: 그대로 기다리고 serving도 그대로다
    expect((await h.status(e, 'p2')).body).toEqual({
      status: 'WAITING', seq: 2, ahead: 1, serving: 0, servingRate: 0, etaSeconds: null, pollAfterMs: 20_000, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
    });
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'WAITING', seq: 1, ahead: 0, serving: 0 });
  });

  test('FR008_차례가온뒤입장확정은_200ADMITTED이고다시보내도같은200이다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1']);
    h.alignToSecond();
    await h.tick(e);
    h.clock.advance(3_000);
    const r = await h.admit(e, 'p1');
    expect({ status: r.status, contentType: r.contentType }).toEqual({ status: 200, contentType: JSON_CONTENT_TYPE });
    expect(r.body).toEqual({ status: 'ADMITTED', seq: 1, serverTimeMs: h.clock.now() });
    h.clock.advance(5);
    expect((await h.admit(e, 'p1')).body).toEqual({ status: 'ADMITTED', seq: 1, serverTimeMs: h.clock.now() });
    // 입장한 뒤에는 15분과 상관없다
    h.clock.advance(GRACE_MS + 1);
    const late = await h.admit(e, 'p1');
    expect(late.status).toBe(200);
    expect(late.body).toEqual({ status: 'ADMITTED', seq: 1, serverTimeMs: h.clock.now() });
  });

  test('FR008_POL008_차례뒤정확히15분은입장되고_1ms넘으면410대기표만료와재진입허용이며_재진입은맨뒤다', async () => {
    const e = await h.open({ admitPerSecond: 2 });
    await h.enterAll(e, ['p1', 'p2', 'p3']);
    const t0 = h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 2, serving: 2 });
    h.clock.advance(GRACE_MS);
    expect((await h.admit(e, 'p1')).body).toEqual({ status: 'ADMITTED', seq: 1, serverTimeMs: t0 + GRACE_MS });
    h.clock.advance(1);
    expectProblem(await h.admit(e, 'p2'), 410, 'queue-ticket-expired', { rejoinAllowed: true });
    // 만료 기록은 지워졌다
    expectProblem(await h.status(e, 'p2'), 404, 'not-in-queue');
    expectProblem(await h.admit(e, 'p2'), 404, 'not-in-queue');
    // 다시 줄을 서면 맨 뒤 새 번호다(p3가 앞에 있다)
    expect((await h.enter(e, 'p2')).body).toEqual({ seq: 4, generation: 0, serverTimeMs: h.clock.now() });
    expectWaitingFollowsRate(await h.status(e, 'p2'), { seq: 4, ahead: 1, serving: 2, admitPerSecond: 2 });
  });

  test('POL008_FR007_FR008_차례온시각은부른순간의밀리초라_칸가운데서불려도진입조회입장확정모두15분을온전히준다', async () => {
    // POL-008 '차례가 온 때부터 15분', §13 키 표 called = 순번:부른 시각(밀리초). 칸 시작(초 단위로 내린 값)을 쓰면 700ms 일찍 만료된다
    const e = await h.open({ admitPerSecond: 4 });
    await h.enterAll(e, pids('p', 5));
    const t0 = h.alignToSecond();
    h.clock.advance(700);
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 4, serving: 4 });
    h.clock.advance(GRACE_MS); // 부른 뒤 정확히 15분: 세 곳 모두 아직 유효하다
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'CALLED', seq: 1, pollAfterMs: 500 });
    expect((await h.admit(e, 'p2')).body).toEqual({ status: 'ADMITTED', seq: 2, serverTimeMs: t0 + 700 + GRACE_MS });
    expectProblem(await h.enter(e, 'p3'), 409, 'already-in-queue');
    h.clock.advance(1); // 15분 + 1ms: 세 곳 모두 만료다
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'EXPIRED', seq: 1, pollAfterMs: null });
    expectProblem(await h.admit(e, 'p4'), 410, 'queue-ticket-expired', { rejoinAllowed: true });
    expect((await h.enter(e, 'p3')).body).toEqual({ seq: 6, generation: 0, serverTimeMs: h.clock.now() });
    expectWaitingFollowsRate(await h.status(e, 'p3'), { seq: 6, ahead: 1, serving: 4, admitPerSecond: 4 });
  });

  test('FR008_POL002_판매종료뒤에는_차례온사람과이미입장한사람의다시보내기까지입장확정이모두410판매종료다', async () => {
    // §13 동작 5 '판매 종료 뒤의 입장 확정은 이미 입장한 사람의 다시 보내기까지 모두 410 sale-ended다(입장 자리를 주지 않는다)'
    const t0 = h.alignToSecond();
    const e = await h.open({ admitPerSecond: 2, saleEndsAtMs: t0 + 5_000 });
    await h.enterAll(e, ['p1', 'p2', 'p3']);
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 2, serving: 2 });
    expect((await h.admit(e, 'p1')).body).toEqual({ status: 'ADMITTED', seq: 1, serverTimeMs: t0 });
    h.clock.advance(5_001); // 판매 종료 1ms 뒤, 차례 뒤 15분 안
    // 조회는 기록대로 답하고, 판매 종료라 더 물을 필요가 없다(pollAfterMs null)
    const ended = (status: string, seq: number) => ({
      status, seq, ahead: 0, serving: 2, servingRate: expect.any(Number), etaSeconds: 0, pollAfterMs: null, saleStatus: 'ENDED', serverTimeMs: h.clock.now(),
    });
    expect((await h.status(e, 'p1')).body).toEqual(ended('ADMITTED', 1));
    expect((await h.status(e, 'p2')).body).toEqual(ended('CALLED', 2));
    // 입장한 사람(p1)·차례가 온 사람(p2)·기다리는 사람(p3) 모두 410이고, 다시 보내도 같다
    for (let round = 0; round < 2; round += 1) {
      for (const pid of ['p1', 'p2', 'p3']) expectProblem(await h.admit(e, pid), 410, 'sale-ended');
    }
    // 차례가 온 사람에게 입장 자리를 주지 않았다. 410 뒤에 차례 기록을 남길지 지울지는 §13이 정하지 않아 둘 다 받는다
    const after = await h.status(e, 'p2');
    expect([200, 404], after.raw).toContain(after.status);
    expect(after.body.status, after.raw).not.toBe('ADMITTED');
  });

  test('FR008_판매종료뒤입장확정은410판매종료다', async () => {
    const end = h.clock.now() + 2_000;
    const e = await h.open({ saleEndsAtMs: end });
    await h.enterAll(e, ['p1', 'p2']);
    expect((await h.admit(e, 'p2')).body).toEqual({ status: 'NOT_YET', seq: 2, serverTimeMs: h.clock.now() });
    h.clock.advance(2_001);
    expectProblem(await h.admit(e, 'p2'), 410, 'sale-ended');
  });

  test('FR008_줄에없으면입장확정은404줄에없음이고_연적없는회차면404회차없음이다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['someone']);
    expectProblem(await h.admit(e, 'nobody'), 404, 'not-in-queue');
    expectProblem(await h.admit(h.newEventId(), 'someone'), 404, 'queue-not-found');
  });

  test('FR008_같은사람이동시에입장확정을여러번보내도_입장은하나이고모두같은순번이다 [ASVS v5.0.0-2.3.4]', async () => {
    const e = await h.open({ admitPerSecond: 1 });
    await h.enterAll(e, ['p1', 'p2']);
    h.alignToSecond();
    await h.tick(e);
    const replies = await Promise.all(Array.from({ length: 10 }, () => h.admit(e, 'p1')));
    for (const r of replies) {
      expect({ status: r.status, body: r.body }).toEqual({ status: 200, body: { status: 'ADMITTED', seq: 1, serverTimeMs: h.clock.now() } });
    }
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'ADMITTED', seq: 1 });
    // 다른 사람은 그 입장을 나눠 갖지 않는다
    expect((await h.admit(e, 'p2')).body).toEqual({ status: 'NOT_YET', seq: 2, serverTimeMs: h.clock.now() });
  });
});

// ───────────────────────── 대기 취소(§13 동작 3, FR-007, POL-002) ─────────────────────────

describe('대기 취소 DELETE /v1/queues/{eventId}/entries/me', () => {
  test('FR007_대기취소는본문없는204이고_줄에없어도204다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1']);
    const r = await h.cancel(e, 'p1');
    expect({ status: r.status, raw: r.raw }).toEqual({ status: 204, raw: '' });
    expectProblem(await h.status(e, 'p1'), 404, 'not-in-queue');
    expect((await h.cancel(e, 'p1')).status).toBe(204);
    expect((await h.cancel(e, 'never-entered')).status).toBe(204);
  });

  test('POL002_취소뒤재진입하면_맨뒤새번호다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1', 'p2', 'p3']);
    expect((await h.cancel(e, 'p1')).status).toBe(204);
    expect((await h.enter(e, 'p1')).body).toEqual({ seq: 4, generation: 0, serverTimeMs: h.clock.now() });
    expect((await h.status(e, 'p1')).body).toEqual({
      status: 'WAITING', seq: 4, ahead: 2, serving: 0, servingRate: 0, etaSeconds: null, pollAfterMs: 20_000, saleStatus: 'ON_SALE', serverTimeMs: h.clock.now(),
    });
  });

  test('FR007_차례온사람이취소하면_입장확정은404줄에없음이고바로맨뒤로다시설수있다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1', 'p2']);
    h.alignToSecond();
    await h.tick(e);
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'CALLED', seq: 1 });
    expect((await h.cancel(e, 'p1')).status).toBe(204);
    expectProblem(await h.admit(e, 'p1'), 404, 'not-in-queue');
    expectProblem(await h.status(e, 'p1'), 404, 'not-in-queue');
    // 15분을 기다리지 않고 맨 뒤 새 번호를 받는다
    expect((await h.enter(e, 'p1')).body).toEqual({ seq: 3, generation: 0, serverTimeMs: h.clock.now() });
  });

  test('POL002_입장한사람은취소해도입장기록이남아_재진입은409이미입장이다', async () => {
    const e = await h.open();
    await h.enterAll(e, ['p1']);
    h.alignToSecond();
    await h.tick(e);
    expect((await h.admit(e, 'p1')).body).toMatchObject({ status: 'ADMITTED', seq: 1 });
    expect((await h.cancel(e, 'p1')).status).toBe(204);
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'ADMITTED', seq: 1, pollAfterMs: null });
    expect((await h.admit(e, 'p1')).body).toEqual({ status: 'ADMITTED', seq: 1, serverTimeMs: h.clock.now() });
    expectProblem(await h.enter(e, 'p1'), 409, 'already-admitted');
  });
});

// ───────────────────────── 권한·입력·응답 형식(v0-baseline 추적 표) ─────────────────────────

describe('권한과 입력(docs/security/asvs/v0-baseline.md)', () => {
  test('FR006_FR007_FR008_신원머리가없거나팬이아니면_네경로모두401이다 [ASVS v5.0.0-8.2.1]', async () => {
    const e = await h.open();
    const notFan = { ...fanHeaders('p1'), 'x-user-aud': 'scanner' };
    for (const route of ALL_ROUTES) {
      for (const headers of [{}, notFan]) {
        const r = await h.request(route, e, headers);
        expect({ route, status: r.status, contentType: r.contentType }).toEqual({ route, status: 401, contentType: PROBLEM_CONTENT_TYPE });
      }
    }
    // 거절된 요청은 아무 자리도 만들지 않았다
    expect((await h.enter(e, 'p1')).body).toEqual({ seq: 1, generation: 0, serverTimeMs: h.clock.now() });
  });

  test('FR006_FR007_FR008_ticketbuy스코프가없으면_네경로모두403이다 [ASVS v5.0.0-8.2.1]', async () => {
    const e = await h.open();
    for (const route of ALL_ROUTES) {
      for (const scope of ['', 'profile:read', 'ticket:read']) {
        const r = await h.request(route, e, fanHeaders('p1', { scope }));
        expect({ route, scope, status: r.status, contentType: r.contentType }).toEqual({ route, scope, status: 403, contentType: PROBLEM_CONTENT_TYPE });
      }
    }
    expect((await h.enter(e, 'p1')).body).toEqual({ seq: 1, generation: 0, serverTimeMs: h.clock.now() });
  });

  test('FR006_FR007_FR008_pid가없으면_네경로모두403이다 [ASVS v5.0.0-8.2.1]', async () => {
    const e = await h.open();
    const noPid: Record<string, string> = { ...fanHeaders('p1') };
    delete noPid['x-user-pid'];
    for (const route of ALL_ROUTES) {
      const r = await h.request(route, e, noPid);
      expect({ route, status: r.status, contentType: r.contentType }).toEqual({ route, status: 403, contentType: PROBLEM_CONTENT_TYPE });
    }
    expect((await h.enter(e, 'p1')).body).toEqual({ seq: 1, generation: 0, serverTimeMs: h.clock.now() });
  });

  test('FR007_FR008_경로에사람ID가없어_pid마다자기기록만보고바꾼다 [ASVS v5.0.0-8.2.2]', async () => {
    const e = await h.open();
    await h.enterAll(e, ['pa', 'pb']);
    expect((await h.status(e, 'pa')).body).toMatchObject({ status: 'WAITING', seq: 1, ahead: 0 });
    expect((await h.status(e, 'pb')).body).toMatchObject({ status: 'WAITING', seq: 2, ahead: 1 });
    // 사람은 pid로만 고른다(§13 'v0는 게이트웨이가 넘긴 pid로 사람을 알아본다'): pa의 계정·세션 머리에 pb의 pid가 오면 pb의 기록이다
    const pbWithPaSession = fanHeaders('pb', { account: 'acc-pa', session: 'ses-pa' });
    expect((await h.status(e, 'pb', pbWithPaSession)).body).toMatchObject({ status: 'WAITING', seq: 2, ahead: 1 });
    expect((await h.admit(e, 'pb', pbWithPaSession)).body).toEqual({ status: 'NOT_YET', seq: 2, serverTimeMs: h.clock.now() });
    h.alignToSecond();
    await h.tick(e); // pa 차례
    // pb의 입장 확정은 pa의 차례를 쓰지 않는다
    expect((await h.admit(e, 'pb')).body).toEqual({ status: 'NOT_YET', seq: 2, serverTimeMs: h.clock.now() });
    // pb의 취소는 pa를 지우지 않는다
    expect((await h.cancel(e, 'pb')).status).toBe(204);
    expect((await h.status(e, 'pa')).body).toMatchObject({ status: 'CALLED', seq: 1 });
    expect((await h.admit(e, 'pa')).body).toEqual({ status: 'ADMITTED', seq: 1, serverTimeMs: h.clock.now() });
    // 다른 사람의 ID를 경로에 넣을 길이 없다
    for (const method of ['GET', 'DELETE'] as const) {
      const r = await h.requestRaw(method, `/v1/queues/${e}/entries/pa`, fanHeaders('pb'));
      expect(r.status).toBe(404);
      expect(r.raw).not.toContain('"seq"');
    }
    expect((await h.status(e, 'pa')).body).toMatchObject({ status: 'ADMITTED', seq: 1 });
  });

  test('FR006_회차ID형식이틀리면_네경로모두400이고_64자까지는받는다 [ASVS v5.0.0-2.2.1]', async () => {
    const bad = [
      '%7Bevent%3Ax%7D', // {event:x}: 해시 태그를 깨는 문자
      'a%7Bb',
      'a%7Db',
      'x'.repeat(65), // 65자
      'a%3Ab', // :
      'a.b',
      'a%20b',
      '%ED%9A%8C%EC%B0%A8', // 한글
    ];
    for (const id of bad) {
      for (const route of ALL_ROUTES) {
        const r = await h.request(route, id, fanHeaders('p1'));
        expect({ id, route, status: r.status, contentType: r.contentType }).toEqual({ id, route, status: 400, contentType: PROBLEM_CONTENT_TYPE });
      }
    }
    // 경계: 64자는 형식이 맞다(연 적 없으면 404, 열면 진입한다)
    const id64 = h.newEventId().padEnd(64, 'x');
    expect(id64).toHaveLength(64);
    expectProblem(await h.status(id64, 'p1'), 404, 'queue-not-found');
    await h.admin.open(id64, { admitPerSecond: 1 });
    expect((await h.enter(id64, 'p1')).body).toEqual({ seq: 1, generation: 0, serverTimeMs: h.clock.now() });
  });

  test('FR006_성공응답은json_charset_utf8이고_오류응답은problem_json이다 [ASVS v5.0.0-4.1.1]', async () => {
    const e = await h.open();
    const ok = [await h.enter(e, 'p1'), await h.status(e, 'p1'), await h.admit(e, 'p1')];
    expect(ok.map((r) => [r.status, r.contentType])).toEqual([
      [201, JSON_CONTENT_TYPE],
      [200, JSON_CONTENT_TYPE],
      [200, JSON_CONTENT_TYPE],
    ]);
    const errors = [
      await h.enter(e, 'p1'), // 409
      await h.status(e, 'nobody'), // 404
      await h.request('status', 'a%7Bb', fanHeaders('p1')), // 400
      await h.request('status', e, {}), // 401
    ];
    expect(errors.map((r) => [r.status, r.contentType])).toEqual([
      [409, PROBLEM_CONTENT_TYPE],
      [404, PROBLEM_CONTENT_TYPE],
      [400, PROBLEM_CONTENT_TYPE],
      [401, PROBLEM_CONTENT_TYPE],
    ]);
    // 204는 본문이 없다
    const gone = await h.cancel(e, 'p1');
    expect({ status: gone.status, raw: gone.raw }).toEqual({ status: 204, raw: '' });
  });

  test('FR006_FR007_FR008_같은오류이름은어느경로어느상황에서나같은상태코드와같은제목이다', async () => {
    // docs/api/guidelines.md §2 '한 type은 언제나 같은 상태 코드와 같은 title로 낸다'. §13의 오류 이름마다 두 상황 이상에서 낸다
    const t0 = h.alignToSecond();
    const e = await h.open({ admitPerSecond: 5 });
    const ended = await h.open({ saleEndsAtMs: t0 + 1_000 });
    await h.enterAll(e, ['a1', 'a2', 'c1', 'x1', 'x2', 'w1']);
    await h.enterAll(ended, ['g1']);
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 5, serving: 5 }); // a1·a2·c1·x1·x2 차례, w1 대기
    for (const pid of ['a1', 'a2']) expect((await h.admit(e, pid)).status).toBe(200);
    const got: { name: string; status: number; r: Reply }[] = [];
    const add = (name: string, status: number, r: Reply) => got.push({ name, status, r });
    add('already-admitted', 409, await h.enter(e, 'a1'));
    add('already-admitted', 409, await h.enter(e, 'a2'));
    add('already-in-queue', 409, await h.enter(e, 'w1')); // 기다리는 중
    add('already-in-queue', 409, await h.enter(e, 'c1')); // 차례가 온 지 15분 안
    add('not-in-queue', 404, await h.status(e, 'nobody'));
    add('not-in-queue', 404, await h.admit(e, 'nobody'));
    const unopened = h.newEventId();
    add('queue-not-found', 404, await h.enter(unopened, 'a1'));
    add('queue-not-found', 404, await h.status(unopened, 'a1'));
    add('queue-not-found', 404, await h.admit(unopened, 'a1'));
    h.clock.advance(1_001); // ended 판매 종료 뒤
    add('sale-ended', 410, await h.enter(ended, 'g2'));
    add('sale-ended', 410, await h.admit(ended, 'g1'));
    h.clock.advance(GRACE_MS); // x1·x2 차례 뒤 15분 넘음
    add('queue-ticket-expired', 410, await h.admit(e, 'x1'));
    add('queue-ticket-expired', 410, await h.admit(e, 'x2'));
    const titles = new Map<string, Set<string>>();
    for (const { name, status, r } of got) {
      expectProblem(r, status, name, name === 'queue-ticket-expired' ? { rejoinAllowed: true } : {});
      titles.set(name, (titles.get(name) ?? new Set()).add(r.body.title as string));
    }
    for (const [name, set] of titles) expect([...set], name).toHaveLength(1);
  });

  test('FR006_오류응답과대기상태에pid와Redis주소를싣지않는다 [ASVS v5.0.0-16.2.5]', async () => {
    // v0-baseline 16.2.5 행: pid와 Redis 주소를 응답·오류 문구에 싣지 않는다. 오류 이름마다 한 번씩 낸다
    const pid = 'pid-secret-7f3a9c';
    const late = 'pid-secret-x81d0e'; // 차례가 와도 15분 안에 오지 않는 사람
    const t0 = h.alignToSecond();
    const e = await h.open({ admitPerSecond: 2 });
    const other = await h.open();
    const ended = await h.open({ saleEndsAtMs: t0 + 1_000 });
    await h.enterAll(e, [pid, late]);
    await h.enterAll(other, ['someone']);
    const first = await h.enter(ended, pid); // 201
    await h.tick(e);
    const replies = [
      first,
      await h.status(e, pid), // 200 CALLED
      await h.admit(e, pid), // 200 ADMITTED
      await h.enter(e, pid), // 409 already-admitted
      await h.enter(other, pid), // 201
      await h.enter(other, pid), // 409 already-in-queue
      await h.status(h.newEventId(), pid), // 404 queue-not-found
      await h.admit(h.newEventId(), pid), // 404 queue-not-found
      await h.request('status', other, fanHeaders(pid, { scope: '' })), // 403
    ];
    await h.cancel(other, pid);
    replies.push(await h.status(other, pid), await h.admit(other, pid)); // 404 not-in-queue 둘
    h.clock.advance(GRACE_MS + 1);
    replies.push(
      await h.enter(ended, `${pid}-2`), // 410 sale-ended(진입)
      await h.admit(ended, pid), // 410 sale-ended(입장 확정)
      await h.admit(e, late), // 410 queue-ticket-expired
    );
    expect(replies.map((r) => r.status)).toEqual([201, 200, 200, 409, 201, 409, 404, 404, 403, 404, 404, 410, 410, 410]);
    const hostPort = h.valkeyUrl.replace(/^redis:\/\//, '');
    for (const r of replies) {
      expect(r.raw).not.toContain(pid);
      expect(r.raw).not.toContain(late);
      expect(r.raw).not.toContain(hostPort);
    }
  });

  test('FR006_대기열Redis에는사람값으로pid와순번과시각만남고_계정과세션값은남지않는다 [ASVS v5.0.0-14.1.1]', async () => {
    // v0-baseline 14.1.1 행: 대기열 Redis에 두는 사람 값은 pid와 순번·시각뿐이다. §13 키 표: called·admitted = pid → 순번:시각(밀리초)
    const account = 'acc-secret-91c2d0';
    const session = 'ses-secret-4be7a5';
    const hd = (pid: string) => fanHeaders(pid, { account, session });
    const e = await h.open({ admitPerSecond: 2 });
    for (const pid of ['pa', 'pb', 'pc', 'pd']) expect((await h.enter(e, pid, hd(pid))).status).toBe(201);
    expect((await h.cancel(e, 'pd', hd('pd'))).status).toBe(204);
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 2, serving: 2 });
    expect((await h.admit(e, 'pa', hd('pa'))).status).toBe(200);
    expect((await h.status(e, 'pc', hd('pc'))).status).toBe(200);

    const dump = await h.dumpEvent(e);
    expect(Object.keys(dump).length).toBeGreaterThan(0);
    const everything = JSON.stringify(dump);
    expect(everything).not.toContain(account);
    expect(everything).not.toContain(session);
    // 사람별 기록: 차례가 온 사람·입장한 사람·기다리는 사람만, 값은 순번:시각뿐이다
    expect(await h.hash(`q0:{event:${e}}:admitted`)).toEqual({ pa: expect.stringMatching(/^1:\d+$/) });
    expect(await h.hash(`q0:{event:${e}}:called`)).toEqual({ pb: expect.stringMatching(/^2:\d+$/) });
    expect(dump[`q0:{event:${e}}:waiting`]).toEqual(['pc', '3']);
  });
});

// ───────────────────────── 회차 열기(§13 동작 6, 모듈 공개 함수) ─────────────────────────

describe('회차 열기 createQueueAdmin().open', () => {
  /** 동기로 던지든 거부된 약속이든 같은 거부로 받는다 */
  const attempt = (eventId: string, config: { admitPerSecond: number; saleEndsAtMs?: number }) => Promise.resolve().then(() => h.admin.open(eventId, config));

  test('FR006_회차열기는형식이틀린회차ID와범위밖설정을던지고_회차를열지않는다 [ASVS v5.0.0-2.2.1]', async () => {
    for (const id of ['', 'x'.repeat(65), '{a}', 'a{b', 'a}b', 'a:b', 'a b', 'a.b', '회차', 'a\nb']) {
      await expect(attempt(id, { admitPerSecond: 1 }), `id=${JSON.stringify(id)}`).rejects.toThrow();
    }
    const e = h.newEventId();
    for (const admitPerSecond of [0, -1, 100_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(attempt(e, { admitPerSecond }), `admitPerSecond=${admitPerSecond}`).rejects.toThrow();
    }
    for (const saleEndsAtMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(attempt(e, { admitPerSecond: 1, saleEndsAtMs }), `saleEndsAtMs=${saleEndsAtMs}`).rejects.toThrow();
    }
    // 던진 열기는 회차를 만들지 않았다. 던지기만 보면 '무엇이든 던지는' 구현도 통과하므로 연 회차 목록과 HTTP로 확인한다
    const opened = (await h.admin.tick(h.clock.now())).map((t) => t.eventId);
    expect(opened).not.toContain(e);
    expect(opened.filter((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))).toEqual([]);
    expect(await h.eventKeys(e)).toEqual([]);
    expectProblem(await h.enter(e, 'p1'), 404, 'queue-not-found');
  });

  test('FR006_회차열기는경계값_1명과100000명과판매종료0을받는다 [ASVS v5.0.0-2.2.1]', async () => {
    const one = h.newEventId();
    await attempt(one, { admitPerSecond: 1 });
    expect((await h.enter(one, 'p1')).body).toEqual({ seq: 1, generation: 0, serverTimeMs: h.clock.now() });

    const max = h.newEventId();
    await attempt(max, { admitPerSecond: 100_000 });
    await h.enterAll(max, pids('m', 3));
    h.alignToSecond();
    expect(await h.tick(max)).toEqual({ eventId: max, ticked: true, called: 3, serving: 3 });

    // 판매 종료 0(1970-01-01)은 0 이상 정수라 받는다. 이미 끝난 회차라 진입은 410이다
    const ended = h.newEventId();
    await attempt(ended, { admitPerSecond: 1, saleEndsAtMs: 0 });
    expectProblem(await h.enter(ended, 'p1'), 410, 'sale-ended');
  });

  test('FR006_POL008_회차를다시열면설정만바뀌고_줄과순번은그대로다', async () => {
    const e = await h.open({ admitPerSecond: 1 });
    await h.enterAll(e, pids('p', 8));
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 1, serving: 1 });
    await h.admin.open(e, { admitPerSecond: 3 });
    h.clock.advance(1_000);
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 3, serving: 4 });
    expect((await h.status(e, 'p1')).body).toMatchObject({ status: 'CALLED', seq: 1 });
    expectWaitingFollowsRate(await h.status(e, 'p5'), { seq: 5, ahead: 0, serving: 4, admitPerSecond: 3 });
    // 범위 밖 설정으로 다시 열면 던지고, 앞의 설정(1초에 3명)이 그대로 남는다
    for (const admitPerSecond of [0, 100_001]) {
      await expect(attempt(e, { admitPerSecond }), `admitPerSecond=${admitPerSecond}`).rejects.toThrow();
    }
    h.clock.advance(1_000);
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 3, serving: 7 });
    // 판매 종료를 지난 시각으로 바꾸면 새 진입을 받지 않는다
    await h.admin.open(e, { admitPerSecond: 3, saleEndsAtMs: h.clock.now() - 1 });
    expectProblem(await h.enter(e, 'p9'), 410, 'sale-ended');
    // 이미 받은 자리는 그대로다
    expect((await h.status(e, 'p8')).body).toMatchObject({ status: 'WAITING', seq: 8, ahead: 0, serving: 7, saleStatus: 'ENDED', pollAfterMs: null });
  });
});

// ───────────────────────── 새 맥락 리뷰 결함의 재현 시험(docs/architecture.md §8.6의 3) ─────────────────────────

describe('리뷰 재현: 입장 루프', () => {
  test('POL007_입장루프가칸안의어디에서불려도_차례진행속도는1초칸단위평균이다', async () => {
    // §13 키 표 rate: 1초에 부른 사람 수의 최근 10칸 평균. 칸 안의 호출 위치(밀리초)가 달라도 칸 수로 나눈다
    const e = await h.open({ admitPerSecond: 1 });
    await h.enterAll(e, ['ra', 'rb', 'rc', 'rd']);
    h.alignToSecond();
    h.clock.advance(999); // 칸 N의 끝(…999ms)
    expect(await h.tick(e)).toMatchObject({ ticked: true, called: 1 });
    h.clock.advance(1); // 칸 N+1의 시작(…000ms)
    expect(await h.tick(e)).toMatchObject({ ticked: true, called: 1 });
    expect((await h.status(e, 'rd')).body).toMatchObject({ status: 'WAITING', ahead: 1, servingRate: 1, etaSeconds: 1 });
  });

  test('FR007_입장루프에유닉스밀리초가아닌시각을넘기면_던지고회차를망가뜨리지않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const e = await h.open({ admitPerSecond: 1 });
    await h.enterAll(e, ['na', 'nb']);
    await expect(h.admin.tick(Number.NaN)).rejects.toThrow();
    await expect(h.admin.tick(1.73e15)).rejects.toThrow(); // 마이크로초를 잘못 넘김
    await expect(h.admin.tick(-1)).rejects.toThrow();
    await expect(h.admin.tick(h.clock.now() + 0.5)).rejects.toThrow();
    expect(await h.admin.servingLog(e)).toEqual([]);
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 1, serving: 1 });
    expect((await h.status(e, 'na')).body).toMatchObject({ status: 'CALLED', seq: 1 });
    expect((await h.status(e, 'nb')).body).toMatchObject({ status: 'WAITING', seq: 2, ahead: 0, serving: 1 });
  });

  test('POL008_한회차의입장루프가실패해도_다른회차는그칸에부른다', async () => {
    const bad = await h.open({ admitPerSecond: 1 });
    const good = await h.open({ admitPerSecond: 1 });
    await h.enterAll(good, ['ga']);
    // bad 회차의 대기 줄을 다른 형(문자열)으로 바꿔 그 회차의 Lua만 실패하게 한다
    await h.redis.sendCommand(['SET', `q0:{event:${bad}}:waiting`, 'broken']);
    h.alignToSecond();
    await expect(h.admin.tick(h.clock.now())).rejects.toThrow();
    expect((await h.status(good, 'ga')).body).toMatchObject({ status: 'CALLED', seq: 1 });
    await h.redis.sendCommand(['DEL', `q0:{event:${bad}}:waiting`]);
  });
});

// ───────────────────────── 저장 키(§13 키 표, 마지막에 파일 전체의 키를 본다) ─────────────────────────

describe('저장 키와 주입 방지', () => {
  test('FR006_특수문자pid도값으로만쓰여한사람으로다뤄지고_모든키는회차해시태그키표모양이다 [ASVS v5.0.0-1.2.4]', async () => {
    const e = await h.open({ admitPerSecond: 1 });
    // Lua 문자열·Redis 키를 깨려는 문자를 담은 pid(헤더 값으로 보낼 수 있는 ASCII)
    const weird = `p"'{event:${e}}:waiting\\ ; ]] -- FLUSHALL`;
    expect((await h.enter(e, weird)).body).toEqual({ seq: 1, generation: 0, serverTimeMs: h.clock.now() });
    expect((await h.enter(e, 'normal')).body).toEqual({ seq: 2, generation: 0, serverTimeMs: h.clock.now() });
    expectProblem(await h.enter(e, weird), 409, 'already-in-queue');
    expect((await h.status(e, weird)).body).toMatchObject({ status: 'WAITING', seq: 1, ahead: 0 });
    expect((await h.status(e, 'normal')).body).toMatchObject({ status: 'WAITING', seq: 2, ahead: 1 });
    h.alignToSecond();
    expect(await h.tick(e)).toEqual({ eventId: e, ticked: true, called: 1, serving: 1 });
    expect((await h.admit(e, weird)).body).toEqual({ status: 'ADMITTED', seq: 1, serverTimeMs: h.clock.now() });

    // 이 파일이 만든 모든 키: q0:events와 q0:{event:<회차 ID>}:<§13 키 표 이름>뿐이다(사람 값·형식이 틀린 회차 ID가 키 이름에 없다)
    const allowed = /^q0:(?:events|\{event:[A-Za-z0-9_-]{1,64}\}:(?:meta|seq|waiting|called|admitted|serving|rate|last_tick|serving_log))$/;
    const keys = await h.keys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !allowed.test(k))).toEqual([]);
    expect(keys).toContain(`q0:{event:${e}}:waiting`);
    // 연 회차 목록에는 형식이 맞는 회차 ID만 있다
    const events = ((await h.redis.sendCommand(['SMEMBERS', 'q0:events'])) as unknown[]).map(String);
    expect(events).toContain(e);
    expect(events.filter((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))).toEqual([]);
  });
});
