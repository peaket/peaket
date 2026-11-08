// 진입 규칙 사례(docs/features/queue-admission.md §3, Q-T4·Q-T53·Q-T60, [ASVS v5.0.0-9.2.3]). 메모리 저장소(test/entry.test.ts)와
// 실제 Valkey의 Lua(test-int/entry-store.int.test.ts)에 같은 사례를 돌린다.
import type { Clock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { EnterQueue, type EnterOutcome, type EnterResult } from '../src/modules/entry/application/enter-queue.js';
import { EntryError } from '../src/modules/entry/application/entry-error.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import type { EntryStore, EventSchedules } from '../src/modules/entry/domain/ports.js';
import type { EventSchedule } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, counting, DEVICE, JNY, newEvent, newRequest, openSchedule, OTHER_ACCOUNT, PID, preverifyToken, type Sent, tokens, within } from './support.js';

export interface EntryWorld {
  store: EntryStore;
  schedules: EventSchedules & { set(eventId: string, s: EventSchedule): Promise<void> };
  clock: Clock;
  pendingTtlMs: number;
  /** 선점 수명이 지나게 한다(메모리는 시계를 옮기고 Valkey는 기다린다) */
  passPending(): Promise<void>;
  admit(pid: string, eventId: string, ticketHash: string): Promise<void>;
  addSkipped(eventId: string, line: string): Promise<void>;
  removed(eventId: string, seq: number): Promise<boolean>;
  verifying(eventId: string, ticketHash: string): Promise<string | null>;
  counter(eventId: string): Promise<number>;
  /** 그 회차 슬롯의 주 노드가 바뀐 것을 흉내 낸다(세대 키의 노드 ID와 지금 노드 ID가 달라진다, ADR-0181) */
  failover(eventId: string): Promise<void>;
  /** 장애 전환으로 복제되지 못한 쓰기를 잃은 것을 흉내 낸다: 카운터를 그 값으로 되돌린다 */
  lose(eventId: string, seq: number): Promise<void>;
  skipped(eventId: string): Promise<string[]>;
  /** q:{event:E}:notice의 회차 판매 상태(saleState)를 쓴다(HOT-010, ADR-0214) */
  setSaleState?(eventId: string, state: string): Promise<void>;
  /** 사람 키 q:dup의 값(없으면 null) */
  dupValue?(pid: string, eventId: string): Promise<string | null>;
}

type Body = { preverifyToken: string; deviceId?: string; entryRequestId?: string };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof EntryError) return e.code;
    throw e;
  }
}

function ticketOf(r: EnterOutcome): EnterResult {
  if (r.kind !== 'TICKET') throw new Error(`대기표가 아니라 ${r.kind}다`);
  return r;
}

/** 저장소를 감싸 단계 사이에 일을 끼운다(파드가 멈춘 사이를 흉내 낸다) */
function pausing(store: EntryStore, hooks: { beforeNumber?: () => Promise<void>; beforeRecord?: () => Promise<void> }): EntryStore {
  return {
    preempt: (i) => store.preempt(i),
    release: (i) => store.release(i),
    batchRecord: (i) => store.batchRecord(i),
    batchResult: (i) => store.batchResult(i),
    convertBatch: (i) => store.convertBatch(i),
    dropBatch: (i) => store.dropBatch(i),
    addLobbyMember: (i) => store.addLobbyMember(i),
    lobbyWindow: (i) => store.lobbyWindow(i),
    removeLobbyMember: (i) => store.removeLobbyMember(i),
    recordLobby: (i) => store.recordLobby(i),
    dropLobbyRecord: (i) => store.dropLobbyRecord(i),
    number: async (i) => {
      await hooks.beforeNumber?.();
      return store.number(i);
    },
    numberBatch: async (i) => {
      await hooks.beforeNumber?.();
      return store.numberBatch(i);
    },
    record: async (i) => {
      await hooks.beforeRecord?.();
      return store.record(i);
    },
    markRemoved: (i) => store.markRemoved(i),
    claimArrival: (i) => store.claimArrival(i),
    markVerifying: (i) => store.markVerifying(i),
    rb05: (i) => store.rb05(i),
    confirmRb05: (i) => store.confirmRb05(i),
    mirror: (i) => store.mirror(i),
    dropOwn: (i) => store.dropOwn(i),
  };
}

export function entryCases(label: string, make: () => Promise<EntryWorld>) {
  describe(`진입(${label})`, () => {
    const setup = async (o: Partial<EventSchedule> = {}) => {
      const w = await make();
      const eventId = newEvent();
      await w.schedules.set(eventId, openSchedule(w.clock.now(), o));
      const enter = (store: EntryStore = w.store) => new EnterQueue(store, w.schedules, tokens, w.clock, { pendingTtlMs: w.pendingTtlMs });
      const body = (o2: Partial<Body> = {}): Body => ({ preverifyToken: preverifyToken(w.clock, eventId), deviceId: DEVICE, entryRequestId: newRequest(), ...o2 });
      const run = async (b: Body, store?: EntryStore, who: { accountId?: string; pid?: string } = {}): Promise<EnterResult> =>
        ticketOf(await enter(store).run({ accountId: who.accountId ?? ACCOUNT, pid: who.pid ?? PID, eventId, body: b }));
      return { w, eventId, enter, body, run };
    };

    test('Q-T51②_매진(notice saleState SOLD_OUT)이면_진입은SOLD_OUT이고_번호를내지않으며_선점을푼다', async () => {
      const { w, eventId, body, run } = await setup();
      await w.setSaleState!(eventId, 'SOLD_OUT');
      expect(await code(run(body()))).toBe('SOLD_OUT');
      expect(await w.counter(eventId)).toBe(0);
      expect(await w.dupValue!(PID, eventId)).toBeNull();
    });

    test('Q-T51_판매상태가ENDED면_진입은SALE_ENDED이고_번호를내지않는다', async () => {
      const { w, eventId, body, run } = await setup();
      await w.setSaleState!(eventId, 'ENDED');
      expect(await code(run(body()))).toBe('SALE_ENDED');
      expect(await w.counter(eventId)).toBe(0);
      expect(await w.dupValue!(PID, eventId)).toBeNull();
    });

    test('Q-T51①_일시매진(ALL_HELD)과_매진풀림(ON_SALE)에는_번호를준다', async () => {
      const { w, eventId, body, run } = await setup();
      await w.setSaleState!(eventId, 'ALL_HELD');
      expect((await run(body())).seq).toBe(1);
      await w.setSaleState!(eventId, 'ON_SALE');
      expect((await run(body({ preverifyToken: preverifyToken(w.clock, eventId, { a: OTHER_ACCOUNT }) }), undefined, { accountId: OTHER_ACCOUNT, pid: 'pid-other' })).seq).toBe(2);
    });

    test('Q-T4_같은pid가여러요청ID로동시에진입하면_번호는하나만나가고나머지는409이며번호를쓰지않는다', async () => {
      const { w, eventId, body, run } = await setup();
      const codes = await Promise.all(Array.from({ length: 8 }, () => code(run(body()))));
      expect(codes.filter((c) => c === 'OK')).toHaveLength(1);
      expect(codes.filter((c) => c === 'ALREADY_WAITING')).toHaveLength(7);
      expect(await w.counter(eventId)).toBe(1);
    });

    test('첫번호는1이고_구간0_세대1이며_대기표는그값을서명해담는다', async () => {
      const { eventId, body, run } = await setup();
      const r = await run(body());
      expect(r).toMatchObject({ seq: 1, generation: 1, segment: 0, verificationReason: null });
      expect(r.verification).toBeUndefined();
      expect(tokens.readTicket(r.queueTicket)).toMatchObject({ e: eventId, a: ACCOUNT, d: DEVICE, s: 1, g: 1, seg: 0 });
    });

    test('Q-T60_대기표의jny는_진입에쓴사전검증토큰의값이다', async () => {
      const { w, eventId, body, run } = await setup();
      const other = '0190f3a1-7c2e-7a00-8000-0000000000cc';
      const r = await run(body({ preverifyToken: preverifyToken(w.clock, eventId, { jny: other }) }));
      expect(tokens.readTicket(r.queueTicket)?.jny).toBe(other);
      expect(other).not.toBe(JNY);
    });

    test('Q-T53①_선점직후멈춘뒤_같은요청ID로다시보내면_대기를취소하지않고번호를받는다', async () => {
      const { w, eventId, body, run } = await setup();
      const b = body();
      await w.store.preempt({ pid: PID, eventId, requestId: b.entryRequestId!, pendingTtlMs: w.pendingTtlMs });
      const r = await run(b);
      expect(r.seq).toBe(1);
    });

    test('Q-T53②_선점수명동안다른요청ID는409이고_수명이지나면번호를받는다_그사람의번호는하나다', async () => {
      const { w, eventId, body, run } = await setup();
      await w.store.preempt({ pid: PID, eventId, requestId: newRequest(), pendingTtlMs: w.pendingTtlMs });
      expect(await code(run(body()))).toBe('ALREADY_WAITING');
      await w.passPending();
      expect((await run(body())).seq).toBe(1);
      expect(await w.counter(eventId)).toBe(1);
    });

    test('Q-T53③_기록뒤응답을잃고같은요청ID로다시보내면_같은대기표이고새번호는나가지않는다', async () => {
      const { w, eventId, body, run } = await setup();
      const b = body();
      const first = await run(b);
      const again = await run({ ...b, preverifyToken: preverifyToken(w.clock, eventId) });
      expect(again.queueTicket).toBe(first.queueTicket);
      expect(await w.counter(eventId)).toBe(1);
    });

    test('Q-T53③_응답을잃은사이사전검증토큰이갱신돼jny·vr가바뀌어도_같은요청ID재시도는처음대기표를다시준다', async () => {
      const { w, eventId, body, run } = await setup();
      const b = body({ preverifyToken: preverifyToken(w.clock, eventId, { vr: 'RAPID_REQUESTS' }) });
      const first = await run(b);
      // 화면이 만료 전에 조용히 갱신했고 새 판정에는 추가 검증 표시가 없다(여정 ID도 다른 값으로 흉내 낸다)
      const renewed = preverifyToken(w.clock, eventId, { jny: '0190f3a1-7c2e-7a00-8000-0000000000dd' });
      const again = await run({ ...b, preverifyToken: renewed });
      expect(again.queueTicket).toBe(first.queueTicket);
      expect(again.verification).toBe('REQUIRED');
      expect(again.verificationReason).toBe('RAPID_REQUESTS');
      expect(tokens.readTicket(again.queueTicket)?.jny).toBe(JNY);
      expect(await w.verifying(eventId, tokens.hash(again.queueTicket))).toMatch(/^VERIFYING:/);
    });

    test('Q-T53④_번호발급과기록사이에멈추면_다시보낸요청은새번호를받는다', async () => {
      const { w, eventId, body, run } = await setup();
      const b = body();
      await w.store.preempt({ pid: PID, eventId, requestId: b.entryRequestId!, pendingTtlMs: w.pendingTtlMs });
      await w.store.number({ eventId, expireAtMs: w.clock.now() + 86_400_000 });
      const r = await run(b);
      expect(r.seq).toBe(2);
      expect(await w.counter(eventId)).toBe(2);
    });

    test('Q-T53⑤_선점뒤수명넘게멈춘사이다른요청이차지하면_이요청의번호는빠진번호이고409다', async () => {
      const { w, eventId, body, run } = await setup();
      let other: EnterResult | undefined;
      const slow = pausing(w.store, {
        beforeNumber: async () => {
          await w.passPending();
          other = await run(body());
        },
      });
      expect(await code(run(body(), slow))).toBe('ALREADY_WAITING');
      expect(other?.seq).toBe(1);
      expect(await w.removed(eventId, 2)).toBe(true);
      expect(await w.removed(eventId, 1)).toBe(false);
    });

    test('FND-130_선점과번호기록사이에같은사람이입장하면_번호를빠진번호로돌리고409ALREADY_ADMITTED', async () => {
      const { w, eventId, body, run } = await setup();
      const slow = pausing(w.store, { beforeRecord: () => w.admit(PID, eventId, 'f'.repeat(64)) });
      expect(await code(run(body(), slow))).toBe('ALREADY_ADMITTED');
      expect(await w.removed(eventId, 1)).toBe(true);
    });

    test('이미입장한사람은_선점에서409ALREADY_ADMITTED이고_번호를쓰지않는다', async () => {
      const { w, eventId, body, run } = await setup();
      await w.admit(PID, eventId, 'e'.repeat(64));
      expect(await code(run(body()))).toBe('ALREADY_ADMITTED');
      expect(await w.counter(eventId)).toBe(0);
    });

    test('세대번호는_건너뛴구간줄수+1이다', async () => {
      const { w, eventId, body, run } = await setup();
      await w.addSkipped(eventId, '100:200:1');
      await w.addSkipped(eventId, '300:400:2');
      const r = await run(body());
      expect(r.generation).toBe(3);
      expect(tokens.readTicket(r.queueTicket)?.g).toBe(3);
    });

    test('같은요청ID가동시에두번오면_같은대기표를받고_뒤에뗀번호는빠진번호다', async () => {
      const { w, eventId, body, run } = await setup();
      const b = body();
      const [x, y] = await Promise.all([run(b), run(b)]);
      expect(x.queueTicket).toBe(y.queueTicket);
      const issued = await w.counter(eventId);
      if (issued === 2) expect(await w.removed(eventId, x.seq === 1 ? 2 : 1)).toBe(true);
    });

    test('추가검증표시가있는사전검증토큰이면_번호를내고빠진번호·VERIFYING으로기록하며_다시보내도같다', async () => {
      const { w, eventId, body, run } = await setup();
      const b = body({ preverifyToken: preverifyToken(w.clock, eventId, { vr: 'RAPID_REQUESTS' }) });
      const r = await run(b);
      expect(r.verification).toBe('REQUIRED');
      expect(r.verificationReason).toBe('RAPID_REQUESTS');
      expect(await w.removed(eventId, r.seq)).toBe(true);
      const hash = tokens.hash(r.queueTicket);
      const first = await w.verifying(eventId, hash);
      expect(first).toMatch(/^VERIFYING:\d+:RAPID_REQUESTS$/);
      const again = await run(b);
      expect(again.queueTicket).toBe(r.queueTicket);
      expect(await w.verifying(eventId, hash)).toBe(first);
    });

    test('[ASVS v5.0.0-9.2.3] 토큰의회차·계정·기기가요청과다르면_403PREVERIFY_INVALID이고번호를쓰지않는다', async () => {
      const { w, eventId, body, run } = await setup();
      expect(await code(run(body({ preverifyToken: preverifyToken(w.clock, newEvent()) })))).toBe('PREVERIFY_INVALID');
      expect(await code(run(body(), undefined, { accountId: OTHER_ACCOUNT }))).toBe('PREVERIFY_INVALID');
      expect(await code(run(body({ deviceId: 'dev-other' })))).toBe('PREVERIFY_INVALID');
      expect(await code(run(body({ preverifyToken: 'v1.k1.x.y' })))).toBe('PREVERIFY_INVALID');
      expect(await w.counter(eventId)).toBe(0);
    });

    test('[ASVS v5.0.0-9.2.1] 만료된사전검증토큰은_403PREVERIFY_INVALID', async () => {
      const { w, eventId, body, run } = await setup();
      const now = w.clock.now();
      expect(await code(run(body({ preverifyToken: preverifyToken(w.clock, eventId, { iat: now - 900_001, exp: now - 1 }) })))).toBe('PREVERIFY_INVALID');
    });

    test('판매종료(공연시작24시간전)뒤진입은_410SALE_ENDED이고번호를내지않는다', async () => {
      const now = (await make()).clock.now();
      const { w, eventId, body, run } = await setup({ startsAtMs: now + 24 * 3600_000 - 1 });
      expect(await code(run(body()))).toBe('SALE_ENDED');
      expect(await w.counter(eventId)).toBe(0);
    });

    test('오픈전진입은_409NOT_OPEN이다', async () => {
      const now = (await make()).clock.now();
      const { body, run } = await setup({ opensAtMs: now + 60_000 });
      expect(await code(run(body()))).toBe('NOT_OPEN');
    });

    test('Q-T24_오픈뒤발급토큰이오픈직후묶음구간에오면_503BATCHING이고_RetryAfter는구간끝까지의초를올린다', async () => {
      const now = (await make()).clock.now();
      const { body, run } = await setup({ opensAtMs: now - 500, openBatch: true });
      const e = await run(body()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(EntryError);
      expect((e as EntryError).code).toBe('BATCHING');
      expect((e as EntryError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect((e as EntryError).retryAfterSeconds).toBeLessThanOrEqual(2);
    });

    test('묶음을끈회차는_오픈직후에도바로번호를준다', async () => {
      const now = (await make()).clock.now();
      const { body, run } = await setup({ opensAtMs: now - 500, openBatch: false, lobbyShuffle: true });
      expect((await run(body())).seq).toBe(1);
    });

    test('회차일정사본이없으면_404NOT_FOUND', async () => {
      const w = await make();
      const e = new EnterQueue(w.store, w.schedules, tokens, w.clock, { pendingTtlMs: w.pendingTtlMs });
      const eventId = newEvent();
      expect(await code(e.run({ accountId: ACCOUNT, pid: PID, eventId, body: { preverifyToken: preverifyToken(w.clock, eventId), deviceId: DEVICE } }))).toBe('NOT_FOUND');
    });
  });

  describe(`장애 전환과 RB-05(${label})`, () => {
    // 건너뛰는 양의 바탕 값을 작게 두어 구간을 확인한다(운영은 12만 [가정], ADR-0181 결정 4)
    const SKIP = 50;
    const setup = async () => {
      const w = await make();
      const eventId = newEvent();
      await w.schedules.set(eventId, openSchedule(w.clock.now()));
      /** 진입 파드 하나 */
      const pod = () => new EnterQueue(w.store, w.schedules, tokens, w.clock, { pendingTtlMs: w.pendingTtlMs, rb05SkipBase: SKIP });
      const person = (i: number) => ({ accountId: ACCOUNT, pid: `pid-rb05-${i}-${eventId}`.slice(0, 64) });
      const body = (): Body => ({ preverifyToken: preverifyToken(w.clock, eventId), deviceId: DEVICE, entryRequestId: newRequest() });
      return { w, eventId, pod, person, body };
    };
    const failed = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => {
          if (!(e instanceof EntryError)) throw e;
          return e;
        },
      );

    test('[Q-T13] 장애전환으로주노드가바뀌면_RB05전진입은503QUEUE_RECOVERING이고번호를내지않으며_RB05가K만큼건너뛰어한줄을적고세대를올린다', async () => {
      const { w, eventId, pod, person, body } = await setup();
      const enter = pod();
      for (let i = 0; i < 3; i++) expect(ticketOf(await enter.run({ ...person(i), eventId, body: body() })).seq).toBe(i + 1);
      await w.failover(eventId);
      const b = body();
      const e = await failed(enter.run({ ...person(3), eventId, body: b }));
      expect([e?.code, e?.retryAfterSeconds]).toEqual(['QUEUE_RECOVERING', 1]);
      expect(await w.skipped(eventId)).toEqual([`4:${3 + SKIP}:1`]);
      expect(await w.counter(eventId)).toBe(3 + SKIP);
      // 같은 요청 ID로 다시 오면(그사이 뒤에서 복제 확인이 끝났다) 건너뛴 구간 뒤 번호와 올라간 세대를 받는다
      await enter.confirmsSettled();
      const t = ticketOf(await enter.run({ ...person(3), eventId, body: b }));
      expect([t.seq, t.generation]).toEqual([3 + SKIP + 1, 2]);
    });

    test('[Q-T13] 장애전환이복제되지못한번호를잃어카운터가되돌아가도_RB05가그위를건너뛰어_잃은번호를같은세대로다시내지않는다', async () => {
      const { w, eventId, pod, person, body } = await setup();
      const enter = pod();
      for (let i = 0; i < 5; i++) expect(ticketOf(await enter.run({ ...person(i), eventId, body: body() })).seq).toBe(i + 1);
      // 4·5번(세대 1)을 받은 사람이 있는데 그 쓰기를 잃었다
      await w.lose(eventId, 3);
      await w.failover(eventId);
      const b = body();
      expect((await failed(enter.run({ ...person(5), eventId, body: b })))?.code).toBe('QUEUE_RECOVERING');
      expect(await w.skipped(eventId)).toEqual([`4:${3 + SKIP}:1`]);
      await enter.confirmsSettled();
      const t = ticketOf(await enter.run({ ...person(5), eventId, body: b }));
      expect([t.seq, t.generation]).toEqual([3 + SKIP + 1, 2]);
    });

    test('장애전환을알아챈진입은번호를받지않았으니선점을풀어_새요청ID로다시와도409가아니고번호를받는다', async () => {
      const { w, eventId, pod, person, body } = await setup();
      const enter = pod();
      expect(ticketOf(await enter.run({ ...person(0), eventId, body: body() })).seq).toBe(1);
      await w.failover(eventId);
      expect((await failed(enter.run({ ...person(1), eventId, body: body() })))?.code).toBe('QUEUE_RECOVERING');
      await enter.confirmsSettled();
      expect(ticketOf(await enter.run({ ...person(1), eventId, body: body() })).seq).toBe(1 + SKIP + 1);
    });

    test('여러파드가거의함께알아채도_RB05는한번만건너뛰고_받은번호는건너뛴구간뒤에서겹치지않는다', async () => {
      const { w, eventId, pod, person, body } = await setup();
      const [a, b] = [pod(), pod()];
      expect(ticketOf(await a.run({ ...person(0), eventId, body: body() })).seq).toBe(1);
      await w.failover(eventId);
      const rs = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? a : b).run({ ...person(10 + i), eventId, body: body() }).then(
            (r) => ticketOf(r).seq,
            (e: unknown) => (e instanceof EntryError ? e.code : String(e)),
          ),
        ),
      );
      expect(rs.filter((r) => typeof r === 'string').every((r) => r === 'QUEUE_RECOVERING')).toBe(true);
      expect(await w.skipped(eventId)).toEqual([`2:${1 + SKIP}:1`]);
      const seqs = rs.filter((r): r is number => typeof r === 'number');
      expect(seqs.every((n) => n > 1 + SKIP)).toBe(true);
      expect(new Set(seqs).size).toBe(seqs.length);
    });

    test('장애전환이없으면_세대키는처음진입이쓰고그대로라_건너뛰지않는다', async () => {
      const { w, eventId, pod, person, body } = await setup();
      const [a, b] = [pod(), pod()];
      const seqs = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).run({ ...person(i), eventId, body: body() }).then((r) => ticketOf(r).seq)));
      expect(seqs.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await w.skipped(eventId)).toEqual([]);
    });
  });

  describe(`파드별 묶음(${label})`, () => {
    const setup = async () => {
      const w = await make();
      const eventId = newEvent();
      await w.schedules.set(eventId, openSchedule(w.clock.now()));
      const person = (i: number, e = eventId) => ({ accountId: ACCOUNT, pid: `pid-batch-${i}-${e}`.slice(0, 64) });
      const body = (e = eventId) => ({ preverifyToken: preverifyToken(w.clock, e), deviceId: DEVICE, entryRequestId: newRequest() });
      /** 진입 서비스 하나(운영처럼 파드의 모든 요청이 같은 묶음기를 쓴다) */
      const queue = (store: EntryStore, o: { batchWindowMs: number; batchMax: number }) => new EnterQueue(store, w.schedules, tokens, w.clock, { pendingTtlMs: w.pendingTtlMs, ...o });
      return { w, eventId, person, body, queue };
    };

    test('[NFR-001] 같은회차진입이몰리면_묶음Lua한번에여러요청을보내고_번호는겹치지않고빈틈없이이어진다', async () => {
      const { w, eventId, person, body, queue } = await setup();
      const sent: Sent[] = [];
      const enter = queue(counting(w.store, sent), { batchWindowMs: 5, batchMax: 500 });
      const rs = await Promise.all(Array.from({ length: 120 }, (_, i) => enter.run({ ...person(i), eventId, body: body() })));
      expect(rs.map((r) => ticketOf(r).seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
      expect(sent.length).toBeLessThan(120);
      expect(sent.reduce((a, c) => a + c.n, 0)).toBe(120);
      expect(Math.max(...sent.map((c) => c.n))).toBeGreaterThan(1);
    });

    test('묶음은최대건수가차면_구간을기다리지않고바로보내고_회차마다따로모은다', async () => {
      const { w, eventId, person, body, queue } = await setup();
      const other = newEvent();
      await w.schedules.set(other, openSchedule(w.clock.now()));
      const sent: Sent[] = [];
      // 구간을 1분으로 두어 최대 건수(7)로만 나가게 한다. 7의 배수만 보내므로 바로 보내지 않으면 끝나지 않는다
      const enter = queue(counting(w.store, sent), { batchWindowMs: 60_000, batchMax: 7 });
      const go = (e: string, n: number) => Promise.all(Array.from({ length: n }, (_, i) => enter.run({ ...person(i, e), eventId: e, body: body(e) })));
      const [x, y] = await within(3_000, Promise.all([go(eventId, 14), go(other, 7)]));
      expect(x.map((r) => ticketOf(r).seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
      expect(y.map((r) => ticketOf(r).seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 7 }, (_, i) => i + 1));
      expect(sent.map((c) => c.n)).toEqual([7, 7, 7]);
      expect(sent.filter((c) => c.eventId === other)).toHaveLength(1);
    });

    test('묶음Lua가일시장애로실패하면_그묶음의모든요청이QueueStoreUnavailable이고_선점은남아_다른요청ID는409이고같은요청ID는번호를받는다', async () => {
      const { w, eventId, person, body, queue } = await setup();
      const sent: Sent[] = [];
      // 다섯이 차면 바로 보내 한 묶음이 되게 한다
      const enter = queue(counting(w.store, sent, () => true), { batchWindowMs: 60_000, batchMax: 5 });
      const bodies = Array.from({ length: 5 }, () => body());
      const errs = await within(3_000, Promise.all(bodies.map((b, i) => enter.run({ ...person(i), eventId, body: b }).then(() => null, (e: unknown) => e))));
      expect(sent.map((c) => c.n)).toEqual([5]);
      expect(errs.every((e) => e instanceof QueueStoreUnavailable)).toBe(true);
      const healthy = queue(w.store, { batchWindowMs: 2, batchMax: 500 });
      expect(await code(healthy.run({ ...person(1), eventId, body: body() }))).toBe('ALREADY_WAITING');
      expect(ticketOf(await healthy.run({ ...person(0), eventId, body: bodies[0]! })).seq).toBe(1);
    });
  });
}
