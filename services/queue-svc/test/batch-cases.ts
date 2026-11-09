// 동시 도착 구간 묶음과 오픈 직후 표시(docs/features/queue-admission.md §3 '묶음의 첫 구현', Q-T24·Q-T52, OPEN[14]).
// 이름은 명세 specs/queue.qnt의 동작 이름(enterNumber·enterBatchRecord·batchMissing·publishBatch)과 같다.
// 메모리 저장소와 실제 Valkey의 Lua에 같은 사례를 돌린다(구간 길이는 회차 일정 사본의 batchWindowMs로 줄인다).
import type { Clock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { type BatchingResult, EnterQueue, type EnterOutcome, type EnterResult } from '../src/modules/entry/application/enter-queue.js';
import { EntryError } from '../src/modules/entry/application/entry-error.js';
import type { EntryStore } from '../src/modules/entry/domain/ports.js';
import { type EventSchedule, QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import type { EntryWorld } from './entry-cases.js';
import { ACCOUNT, counting, DEVICE, JNY, newEvent, newRequest, openSchedule, PID, preverifyToken, type Sent, tokens, within } from './support.js';

export interface BatchWorld extends EntryWorld {
  /** 구간 길이(메모리는 시계를 옮기고 Valkey는 실제로 기다린다) */
  windowMs: number;
  passWindow(): Promise<void>;
  /** admission-ctrl의 게시(publishBatch)를 흉내 낸다: q:batch:{토큰 해시}와 pub:1 */
  publishResult(eventId: string, tokenHash: string, seq: number, gen: number): Promise<void>;
  /** 결과 없이 게시만 끝났다고 둔다(batchMissing) */
  publishNone(eventId: string): Promise<void>;
  batchMembers(eventId: string): Promise<string[]>;
  marker(eventId: string, field: string): Promise<string | null>;
  addLobby(eventId: string, n: number): Promise<void>;
  dupOf(pid: string, eventId: string): Promise<{ value: string | null; expireAtMs: number | null }>;
  /** 장애 전환으로 SADD를 잃은 것을 흉내 낸다 */
  dropMember(eventId: string, tokenHash: string): Promise<void>;
}

const PID2 = 'pid-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ACCOUNT2 = '0190f3a1-7c2e-7a00-8000-000000000003';

/** 저장소의 단계 앞에 일을 끼운다(파드가 멈춘 사이를 흉내 낸다) */
function around(store: EntryStore, hooks: Partial<Record<keyof EntryStore, () => Promise<void>>>): EntryStore {
  return new Proxy(store, {
    get(target, k) {
      const f = Reflect.get(target, k) as unknown;
      if (typeof f !== 'function') return f;
      return async (...args: unknown[]) => {
        await hooks[k as keyof EntryStore]?.();
        return (f as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function ticket(r: EnterOutcome): EnterResult {
  if (r.kind !== 'TICKET') throw new Error(`대기표가 아니라 ${r.kind}다`);
  return r;
}
function batching(r: EnterOutcome): BatchingResult {
  if (r.kind !== 'BATCHING') throw new Error(`묶음이 아니라 ${r.kind}다`);
  return r;
}
async function failure(p: Promise<unknown>): Promise<EntryError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (!(e instanceof EntryError)) throw new Error(`업무 오류가 아니다: ${String(e)}`);
  return e;
}

export function batchCases(label: string, make: () => Promise<BatchWorld>) {
  describe(`묶음(${label})`, () => {
    /** 방금 연 회차(구간 안). 기본은 로비 셔플 끔·묶음 켬(선착순) */
    const setup = async (o: Partial<EventSchedule> = {}) => {
      const w = await make();
      const eventId = newEvent();
      const now = w.clock.now();
      const schedule = openSchedule(now, { opensAtMs: now - 150, lobbyShuffle: false, openBatch: true, batchWindowMs: w.windowMs, ...o });
      await w.schedules.set(eventId, schedule);
      const enter = (store: EntryStore = w.store) => new EnterQueue(store, w.schedules, tokens, w.clock, { pendingTtlMs: w.pendingTtlMs });
      /** 오픈 전에 받은 사전 검증 토큰(묶음 대상) */
      const early = (o2: Parameters<typeof preverifyToken>[2] = {}) => preverifyToken(w.clock, eventId, { i0: schedule.opensAtMs - 60_000, ...o2 });
      const run = (b: { preverifyToken: string; entryRequestId?: string }, who: { accountId?: string; pid?: string } = {}, store?: EntryStore) =>
        enter(store).run({ accountId: who.accountId ?? ACCOUNT, pid: who.pid ?? PID, eventId, body: { deviceId: DEVICE, entryRequestId: newRequest(), ...b } });
      return { w, eventId, schedule, early, run };
    };

    test('Q-T24_오픈전에받은토큰으로구간안에오면_202BATCHING이고묶음에들어가며_결과파일경로는토큰해시앞세자리다', async () => {
      const { w, eventId, early, run } = await setup();
      const t = early();
      const rq = newRequest();
      const r = batching(await run({ preverifyToken: t, entryRequestId: rq }));
      expect(r.entryRequestId).toBe(rq);
      const hash = tokens.hash(t);
      expect(r.resultPath).toBe(`/v1/queues/${eventId}/batch-results/${hash.slice(0, 3)}.json`);
      expect(r.spreadSec).toBe(8);
      expect(Date.parse(r.resultAt)).toBeGreaterThan(r.serverTimeMs);
      expect(await w.batchMembers(eventId)).toEqual([hash]);
      expect(await w.counter(eventId)).toBe(0);
    });

    test('묶음표시가없는데구간이지난뒤장애전환을알아채면_묶음인원만큼더건너뛰고_다음진입이새카운터위에서묶음을닫는다', async () => {
      const { w, eventId, early, run } = await setup();
      const SKIP = 50;
      // 구간 안에 묶음 대상 셋이 들어간다
      for (let i = 0; i < 3; i++) batching(await run({ preverifyToken: early({ iat: w.clock.now() - i }) }, { pid: `pid-mk-${i}-${eventId}`.slice(0, 64) }));
      await w.passWindow();
      // 구간이 지났지만 닫는 진입이 오기 전에 주 노드가 바뀌었다(닫았더라도 표시를 잃었을 수 있다)
      await w.failover(eventId);
      const pod = new EnterQueue(w.store, w.schedules, tokens, w.clock, { pendingTtlMs: w.pendingTtlMs, rb05SkipBase: SKIP });
      const go = () => pod.run({ accountId: ACCOUNT, pid: PID, eventId, body: { preverifyToken: preverifyToken(w.clock, eventId), deviceId: DEVICE, entryRequestId: newRequest() } });
      expect((await failure(go())).code).toBe('QUEUE_RECOVERING');
      // RB-05의 복제 확인은 뒤에서 돈다(ADR-0186). 진입 사례처럼 끝나기를 기다린 뒤 다시 보낸다(부하가 크면 다음 진입이 확인 전에 와 RECOVERING을 한 번 더 받는다)
      await pod.confirmsSettled();
      expect(await w.skipped(eventId)).toEqual([`1:${SKIP + 3}:1`]);
      const t = ticket(await go());
      // 다음 진입이 묶음을 닫는다: 묶음 몫 3을 뗀 뒤 번호
      expect(await w.marker(eventId, '1')).toBe(`${SKIP + 4}:3:2`);
      expect([t.seq, t.generation]).toEqual([SKIP + 3 + 3 + 1, 2]);
    });

    test('묶음표시가이미서있으면_RB05는묶음인원을더건너뛰지않는다', async () => {
      const { w, eventId, early, run } = await setup();
      const SKIP = 50;
      for (let i = 0; i < 3; i++) batching(await run({ preverifyToken: early({ iat: w.clock.now() - i }) }, { pid: `pid-mk-${i}-${eventId}`.slice(0, 64) }));
      await w.passWindow();
      // 구간 뒤 첫 진입이 묶음을 닫는다(표시 1:3:1, 그 진입은 4번)
      expect(ticket(await run({ preverifyToken: preverifyToken(w.clock, eventId) })).seq).toBe(4);
      await w.failover(eventId);
      const pod = new EnterQueue(w.store, w.schedules, tokens, w.clock, { pendingTtlMs: w.pendingTtlMs, rb05SkipBase: SKIP });
      const go = () => pod.run({ accountId: ACCOUNT2, pid: PID2, eventId, body: { preverifyToken: preverifyToken(w.clock, eventId, { a: ACCOUNT2 }), deviceId: DEVICE, entryRequestId: newRequest() } });
      expect((await failure(go())).code).toBe('QUEUE_RECOVERING');
      // RB-05의 복제 확인은 뒤에서 돈다(ADR-0186). 진입 사례처럼 끝나기를 기다린 뒤 다시 보낸다(부하가 크면 다음 진입이 확인 전에 와 RECOVERING을 한 번 더 받는다)
      await pod.confirmsSettled();
      expect(await w.skipped(eventId)).toEqual([`5:${4 + SKIP}:1`]);
    });

    test('로비셔플회차에로비표시가없는데오픈뒤장애전환을알아채면_로비인원만큼더건너뛰고_다음진입이새카운터위에서로비표시를쓴다', async () => {
      const { w, eventId } = await setup({ lobbyShuffle: true, openBatch: false });
      const SKIP = 50;
      await w.addLobby(eventId, 4);
      // 오픈 뒤 첫 진입 전에 주 노드가 바뀌었다(로비 표시를 썼더라도 잃었을 수 있다)
      await w.failover(eventId);
      const pod = new EnterQueue(w.store, w.schedules, tokens, w.clock, { pendingTtlMs: w.pendingTtlMs, rb05SkipBase: SKIP });
      const go = () => pod.run({ accountId: ACCOUNT, pid: PID, eventId, body: { preverifyToken: preverifyToken(w.clock, eventId), deviceId: DEVICE, entryRequestId: newRequest() } });
      expect((await failure(go())).code).toBe('QUEUE_RECOVERING');
      // RB-05의 복제 확인은 뒤에서 돈다(ADR-0186). 진입 사례처럼 끝나기를 기다린 뒤 다시 보낸다(부하가 크면 다음 진입이 확인 전에 와 RECOVERING을 한 번 더 받는다)
      await pod.confirmsSettled();
      expect(await w.skipped(eventId)).toEqual([`1:${SKIP + 4}:1`]);
      const t = ticket(await go());
      expect(await w.marker(eventId, 'lobby')).toBe(`${SKIP + 5}:4:2`);
      expect([t.seq, t.generation]).toEqual([SKIP + 4 + 4 + 1, 2]);
    });

    test('한묶음Lua에묶음대상과오픈뒤토큰이섞여도_요청마다가른다_대상만202BATCHING으로참가자가되고_나머지는503BATCHING이다', async () => {
      const { w, eventId, early } = await setup();
      const sent: Sent[] = [];
      // 일곱이 차면 바로 보내 한 묶음이 되게 한다(ADR-0179). 순서를 섞어 두어 결과를 요청에 거꾸로 나눠 주면 잡힌다
      const enter = new EnterQueue(counting(w.store, sent), w.schedules, tokens, w.clock, { pendingTtlMs: w.pendingTtlMs, batchWindowMs: 60_000, batchMax: 7 });
      const kinds = ['E', 'L', 'E', 'E', 'L', 'L', 'E'];
      const now = w.clock.now();
      const go = (k: string, i: number) =>
        enter
          .run({ accountId: ACCOUNT, pid: `pid-mix-${i}-${eventId}`.slice(0, 64), eventId, body: { preverifyToken: k === 'E' ? early({ iat: now - i }) : preverifyToken(w.clock, eventId, { iat: now - i }), deviceId: DEVICE, entryRequestId: newRequest() } })
          .then(
            (r) => `OK:${r.kind}`,
            (e: unknown) => (e instanceof EntryError ? `ERR:${e.code}` : String(e)),
          );
      const rs = await within(3_000, Promise.all(kinds.map(go)));
      expect(sent.map((c) => c.n)).toEqual([7]);
      expect(rs).toEqual(kinds.map((k) => (k === 'E' ? 'OK:BATCHING' : 'ERR:BATCHING')));
      expect(await w.batchMembers(eventId)).toHaveLength(4);
      expect(await w.counter(eventId)).toBe(0);
    });

    test('Q-T24·Q-T52③_오픈뒤에받은토큰으로구간안에오면_503이고Retry-After는구간끝까지_닫힌뒤에는묶음뒤번호를받는다', async () => {
      const { w, eventId, early, run } = await setup();
      batching(await run({ preverifyToken: early({ a: ACCOUNT2 }) }, { accountId: ACCOUNT2, pid: PID2 }));
      const late = preverifyToken(w.clock, eventId);
      const rq = newRequest();
      const e = await failure(run({ preverifyToken: late, entryRequestId: rq }));
      expect(e.code).toBe('BATCHING');
      expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      await w.passWindow();
      const r = ticket(await run({ preverifyToken: late, entryRequestId: rq }));
      expect(r.seq).toBe(2);
      expect(await w.marker(eventId, '1')).toBe('1:1:1');
    });

    test('Q-T24_무중단갱신으로최초발급시각이오픈전이면_갱신한토큰도묶음대상이다', async () => {
      const { w, early, run } = await setup();
      const renewed = early({ iat: w.clock.now(), exp: w.clock.now() + 900_000 });
      batching(await run({ preverifyToken: renewed }));
    });

    test('Q-T52①_로비셔플켬_로비표시가없으면첫진입이먼저써서_첫INCR은로비몫뒤다', async () => {
      const { w, eventId, run } = await setup({ lobbyShuffle: true, openBatch: false });
      await w.addLobby(eventId, 1000);
      const r = ticket(await run({ preverifyToken: preverifyToken(w.clock, eventId) }));
      expect(r.seq).toBe(1001);
      expect(await w.marker(eventId, 'lobby')).toBe('1:1000:1');
    });

    test('Q-T52_로비·묶음둘다켬_로비몫다음에묶음몫이고그뒤INCR이다', async () => {
      const { w, eventId, early, run } = await setup({ lobbyShuffle: true, openBatch: true });
      await w.addLobby(eventId, 3);
      batching(await run({ preverifyToken: early() }));
      batching(await run({ preverifyToken: early({ a: ACCOUNT2 }) }, { accountId: ACCOUNT2, pid: PID2 }));
      await w.passWindow();
      const r = ticket(await run({ preverifyToken: preverifyToken(w.clock, eventId, { a: '0190f3a1-7c2e-7a00-8000-000000000004' }) }, { accountId: '0190f3a1-7c2e-7a00-8000-000000000004', pid: 'pid-ccccccccccccccccccccccccccccccccccccccccccc' }));
      expect(r.seq).toBe(6);
      expect(await w.marker(eventId, 'lobby')).toBe('1:3:1');
      expect(await w.marker(eventId, '1')).toBe('4:2:1');
    });

    test('[ASVS v5.0.0-2.3.2] OPEN[14]_enterBatchRecord_묶음기록은판매종료까지남아_선점수명이지나도같은사람의다른탭은409다', async () => {
      const { w, eventId, schedule, early, run } = await setup();
      const t = early();
      batching(await run({ preverifyToken: t }));
      await w.passPending();
      const otherJourney = '0190f3a1-7c2e-7a00-8000-0000000000ee';
      expect((await failure(run({ preverifyToken: early({ jny: otherJourney }) }))).code).toBe('ALREADY_WAITING');
      const dup = await w.dupOf(PID, eventId);
      expect(dup.value).toMatch(new RegExp(`^BATCH:1:${tokens.hash(t)}:[0-9a-f-]+:${JNY}:$`));
      expect(dup.expireAtMs).toBe(schedule.startsAtMs - 24 * 3600_000);
    });

    test('OPEN[14]_묶음에넣은사이같은사람이입장했으면_409ALREADY_ADMITTED이고묶음기록을쓰지않는다', async () => {
      const { w, eventId, early, run } = await setup();
      const slow = around(w.store, { batchRecord: () => w.admit(PID, eventId, 'd'.repeat(64)) });
      expect((await failure(run({ preverifyToken: early() }, {}, slow))).code).toBe('ALREADY_ADMITTED');
      expect((await w.dupOf(PID, eventId)).value).toMatch(/^PENDING:/);
    });

    test('게시전에같은요청ID로다시오면_같은202를다시준다', async () => {
      const { w, eventId, early, run } = await setup();
      const t = early();
      const rq = newRequest();
      const first = batching(await run({ preverifyToken: t, entryRequestId: rq }));
      await w.passWindow();
      const again = batching(await run({ preverifyToken: early(), entryRequestId: rq }));
      expect(again.resultPath).toBe(first.resultPath);
      expect(await w.batchMembers(eventId)).toEqual([tokens.hash(t)]);
    });

    test('publishBatch뒤같은요청ID로다시오면_그순번의201대기표를주고_사람슬롯은번호기록이되며_다시보내도같다', async () => {
      const { w, eventId, early, run } = await setup();
      const t = early({ vr: 'NETWORK' });
      const rq = newRequest();
      batching(await run({ preverifyToken: t, entryRequestId: rq }));
      await w.passWindow();
      await w.publishResult(eventId, tokens.hash(t), 7, 1);
      const r = ticket(await run({ preverifyToken: early(), entryRequestId: rq }));
      expect(r).toMatchObject({ seq: 7, generation: 1, segment: 0, verification: 'REQUIRED', verificationReason: 'NETWORK' });
      expect(tokens.readTicket(r.queueTicket)).toMatchObject({ s: 7, g: 1, rq, jny: JNY, vr: 'NETWORK' });
      expect((await w.dupOf(PID, eventId)).value).toBe(`7:1:${rq}:${JNY}:NETWORK:${tokens.hash(r.queueTicket)}`);
      expect(await w.verifying(eventId, tokens.hash(r.queueTicket))).toMatch(/^VERIFYING:\d+:NETWORK$/);
      const again = ticket(await run({ preverifyToken: early(), entryRequestId: rq }));
      expect(again.queueTicket).toBe(r.queueTicket);
    });

    test('batchMissing_게시가끝났는데결과에없으면_묶음기록을지우고일반진입으로맨뒤번호를준다', async () => {
      const { w, eventId, early, run } = await setup();
      const rq = newRequest();
      const t = early();
      batching(await run({ preverifyToken: t, entryRequestId: rq }));
      await w.passWindow();
      await w.dropMember(eventId, tokens.hash(t));
      await w.publishNone(eventId);
      const r = ticket(await run({ preverifyToken: early(), entryRequestId: rq }));
      expect(r.seq).toBe(1);
      expect((await w.dupOf(PID, eventId)).value).toBe(`1:1:${rq}:${JNY}::${tokens.hash(r.queueTicket)}`);
    });

    test('Q-T52③_503뒤새요청ID로다시와도_선점이남지않아409가아니다_닫힌뒤에는번호를받는다', async () => {
      const { w, eventId, run } = await setup();
      const late = preverifyToken(w.clock, eventId);
      expect((await failure(run({ preverifyToken: late }))).code).toBe('BATCHING');
      expect((await failure(run({ preverifyToken: late }))).code).toBe('BATCHING');
      expect((await w.dupOf(PID, eventId)).value).toBeNull();
      await w.passWindow();
      expect(ticket(await run({ preverifyToken: late })).seq).toBe(1);
    });

    test('선점풀기가대기열Redis장애로실패해도_묶음구간503BATCHING을그대로준다', async () => {
      const { w, eventId, run } = await setup();
      const down = around(w.store, {
        release: async () => {
          throw new QueueStoreUnavailable(new Error('down'));
        },
      });
      expect((await failure(run({ preverifyToken: preverifyToken(w.clock, eventId) }, {}, down))).code).toBe('BATCHING');
    });

    test('결과키를장애전환으로잃었으면(참가자인데결과없음)_503이고다시쓰기를청하며_묶음기록은남긴다', async () => {
      const { w, eventId, early, run } = await setup();
      const rq = newRequest();
      const t = early();
      batching(await run({ preverifyToken: t, entryRequestId: rq }));
      await w.passWindow();
      await w.publishNone(eventId);
      const e = await failure(run({ preverifyToken: early(), entryRequestId: rq }));
      expect(e.code).toBe('BATCHING');
      expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(await w.marker(eventId, 'repair:1')).not.toBeNull();
      expect((await w.dupOf(PID, eventId)).value).toMatch(/^BATCH:1:/);
    });

    test('묶음기록은같은진입요청ID로만잇는다_본문에없어서만든요청ID는202가알려주고_다른요청ID는같은토큰이어도409다', async () => {
      const { w, eventId, early, run } = await setup();
      const t = early();
      const first = batching(await run({ preverifyToken: t, entryRequestId: undefined }));
      expect(first.entryRequestId).toMatch(/^[0-9a-f-]{36}$/);
      expect((await failure(run({ preverifyToken: t }))).code).toBe('ALREADY_WAITING');
      await w.passWindow();
      await w.publishResult(eventId, tokens.hash(t), 3, 1);
      const r = ticket(await run({ preverifyToken: t, entryRequestId: first.entryRequestId }));
      expect(r.seq).toBe(3);
      expect(tokens.readTicket(r.queueTicket)?.rq).toBe(first.entryRequestId);
      expect((await w.dupOf(PID, eventId)).value).toBe(`3:1:${first.entryRequestId}:${JNY}::${tokens.hash(r.queueTicket)}`);
    });

    test('같은요청ID쌍둥이가구간끝을걸쳐_뒤요청이먼저번호를기록했으면_앞요청의묶음기록도같은대기표를준다', async () => {
      const { w, early, run } = await setup();
      const rq = newRequest();
      let twin: EnterOutcome | undefined;
      // 앞 요청이 SADD 뒤 ③ 앞에서 멈춘 사이 구간이 끝나고, 같은 요청 ID의 뒤 요청이 번호를 받아 기록한다
      const paused = around(w.store, {
        batchRecord: async () => {
          await w.passWindow();
          twin = await run({ preverifyToken: early(), entryRequestId: rq });
        },
      });
      const r = ticket(await run({ preverifyToken: early(), entryRequestId: rq }, {}, paused));
      expect(r.seq).toBe(2);
      expect(ticket(twin!).queueTicket).toBe(r.queueTicket);
    });

    test('같은요청ID의묶음기록이있으면_③기록은받은번호를빠진번호로돌리고_기록된해시의202를준다', async () => {
      const { w, eventId, early, run } = await setup();
      const rq = newRequest();
      const t = early();
      batching(await run({ preverifyToken: t, entryRequestId: rq }));
      await w.passWindow();
      // 같은 요청이 구간 끝을 걸쳐 동시에 왔다: ①을 묶음 기록 전에 지났다고 두고 ②·③을 그대로 돈다
      const raced = new Proxy(w.store, {
        get(target, k) {
          if (k === 'preempt') return async () => ({ kind: 'PROCEED' });
          const f = Reflect.get(target, k) as unknown;
          return typeof f === 'function' ? (f as (...a: unknown[]) => unknown).bind(target) : f;
        },
      });
      const renewed = early({ iat: w.clock.now(), exp: w.clock.now() + 900_000 });
      const r = batching(await run({ preverifyToken: renewed, entryRequestId: rq }, {}, raced as EntryStore));
      expect(r.resultPath).toBe(`/v1/queues/${eventId}/batch-results/${tokens.hash(t).slice(0, 3)}.json`);
      expect(await w.removed(eventId, 2)).toBe(true);
    });

    test('같은요청이다른토큰으로동시에묶음에들면_202의결과파일경로는먼저기록된토큰의것이다', async () => {
      const { w, eventId, early, run } = await setup();
      const rq = newRequest();
      const t = early();
      batching(await run({ preverifyToken: t, entryRequestId: rq }));
      // 둘째 요청이 첫 요청의 묶음 기록 전에 ①을 지났다고 둔다
      const raced = new Proxy(w.store, {
        get(target, k) {
          if (k === 'preempt') return async () => ({ kind: 'PROCEED' });
          const f = Reflect.get(target, k) as unknown;
          return typeof f === 'function' ? (f as (...a: unknown[]) => unknown).bind(target) : f;
        },
      });
      const other = early({ jny: '0190f3a1-7c2e-7a00-8000-0000000000ef' });
      const r = batching(await run({ preverifyToken: other, entryRequestId: rq }, {}, raced as EntryStore));
      expect(r.resultPath).toBe(`/v1/queues/${eventId}/batch-results/${tokens.hash(t).slice(0, 3)}.json`);
      expect((await w.dupOf(PID, eventId)).value).toMatch(new RegExp(`^BATCH:1:${tokens.hash(t)}:`));
    });

    test('파드시계가앞서②가EARLY면_선점을풀어_새요청ID로다시와도409가아니다', async () => {
      const w = await make();
      const eventId = newEvent();
      const now = w.clock.now();
      await w.schedules.set(eventId, openSchedule(now, { opensAtMs: now + 2_000, lobbyShuffle: false, openBatch: true, batchWindowMs: w.windowMs }));
      const ahead: Clock = { now: () => w.clock.now() + 3_000, monotonicMs: () => w.clock.monotonicMs() };
      const enter = new EnterQueue(w.store, w.schedules, tokens, ahead, { pendingTtlMs: w.pendingTtlMs });
      const t = preverifyToken(w.clock, eventId, { i0: now - 60_000 });
      const go = () => enter.run({ accountId: ACCOUNT, pid: PID, eventId, body: { preverifyToken: t, deviceId: DEVICE, entryRequestId: newRequest() } });
      expect((await failure(go())).code).toBe('NOT_OPEN');
      expect((await w.dupOf(PID, eventId)).value).toBeNull();
      expect((await failure(go())).code).toBe('NOT_OPEN');
    });

    test('묶음을끈회차는_오픈직후에도오픈전토큰으로바로번호를준다', async () => {
      const { early, run } = await setup({ openBatch: false, lobbyShuffle: true });
      expect(ticket(await run({ preverifyToken: early() })).seq).toBe(1);
    });

    test('다른회차에서다시시작해도_묶음은회차마다따로다', async () => {
      const a = await setup();
      const b = await setup();
      batching(await a.run({ preverifyToken: a.early() }));
      expect(await b.w.batchMembers(b.eventId)).toEqual([]);
      expect(newEvent()).not.toBe(a.eventId);
    });
  });
}
