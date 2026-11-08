// 로비 참가(docs/features/queue-admission.md §2 '로비 참가와 커밋 공시의 첫 구현', Q-T55·Q-T60·Q-T45·Q-T52⑤, ADR-0231). 메모리 저장소(test/entry.test.ts)와
// 실제 Valkey의 Lua(test-int/entry-store.int.test.ts)에 같은 사례를 돌린다. 서버 시각을 쓰는 Lua는 실제 시계이므로 일정은 지금을 기준으로 잡는다.
import { type Clock } from '@peaket/platform';
import { drandRoundAfter, drandRoundTimeMs, TestSeedSealer } from '@peaket/shuffle';
import { expect, test } from 'vitest';
import { DEFAULT_ENTRY_OPTIONS, EnterQueue } from '../src/modules/entry/application/enter-queue.js';
import { EntryError } from '../src/modules/entry/application/entry-error.js';
import { JoinLobby } from '../src/modules/entry/application/join-lobby.js';
import { ShuffleCommits } from '../src/modules/entry/application/shuffle-commits.js';
import type { EntryStore, EventSchedules, ShuffleCommitStore } from '../src/modules/entry/domain/ports.js';
import { type EventSchedule, QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, DEVICE, newEvent, OTHER_ACCOUNT, PID, recordingRisk, tokens } from './support.js';

export interface LobbyWorld {
  store: EntryStore;
  commits: ShuffleCommitStore;
  schedules: EventSchedules & { set(eventId: string, s: EventSchedule): Promise<void> };
  clock: Clock;
  admit(pid: string, eventId: string, hash: string): Promise<void>;
  /** 로비 표시 batch_done의 lobby를 쓴다(T=0 목록 고정) */
  closeLobby(eventId: string): Promise<void>;
  members(eventId: string): Promise<string[]>;
  dupValue(pid: string, eventId: string): Promise<string | null>;
  verifying(eventId: string, hash: string): Promise<string | null>;
}

const PID2 = `${PID}x`;
const sealer = new TestSeedSealer(Buffer.alloc(32, 5));

export function lobbyCases(name: string, setup: () => Promise<LobbyWorld>): void {
  async function world(o: { lobbyMinutes?: number; opensInMs?: number; schedule?: Partial<EventSchedule>; verdict?: Parameters<typeof recordingRisk>[0] } = {}) {
    const w = await setup();
    const eventId = newEvent();
    const now = w.clock.now();
    const schedule: EventSchedule = { opensAtMs: now + (o.opensInMs ?? 5 * 60_000), startsAtMs: now + 3 * 24 * 3600_000, lobbyShuffle: true, openBatch: true, lobbyMinutes: o.lobbyMinutes ?? 10, ...o.schedule };
    await w.schedules.set(eventId, schedule);
    const risk = recordingRisk(o.verdict ?? { kind: 'OK' });
    const commits = new ShuffleCommits(w.commits, sealer, w.schedules, w.clock);
    const app = new JoinLobby(w.store, w.schedules, tokens, risk, commits, w.clock);
    const join = (i: { pid?: string; pidPrev?: string; deviceId?: string; accountId?: string } = {}) =>
      app.run({ eventId, accountId: i.accountId ?? ACCOUNT, pid: i.pid ?? PID, ...(i.pidPrev ? { pidPrev: i.pidPrev } : {}), body: { humanCheckToken: 'ok', deviceId: i.deviceId ?? DEVICE } });
    return { w, eventId, now, schedule, risk, app, join };
  }

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e instanceof EntryError) return e.code;
      throw e;
    }
  };

  test(`[${name}] Q-T55① 창 앞이면 409 NOT_OPEN이고, 창 안이면 참가 토큰 1장과 공시 칸·공개 예정 시각·분산 창을 준다`, async () => {
    const early = await world({ opensInMs: 20 * 60_000, lobbyMinutes: 10 });
    expect(await code(early.join())).toBe('NOT_OPEN');
    expect(await early.w.members(early.eventId)).toEqual([]);
    const a = await world({ opensInMs: 5 * 60_000, lobbyMinutes: 10 });
    const r = await a.join();
    expect(r.lobbyToken.split('.')).toHaveLength(4);
    const round = drandRoundAfter(a.schedule.opensAtMs);
    expect(r).toMatchObject({ drandChain: 'quicknet', drandRound: round, algorithmVersion: 'v1', shuffleSpreadSec: 8, verificationReason: null });
    expect(r.shuffleResultAt).toBe(new Date(drandRoundTimeMs(round) + 5_000).toISOString());
    expect(r.lobbyOpenedAt).toBe(new Date(a.schedule.opensAtMs - 10 * 60_000).toISOString());
    expect(r.seedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await a.w.members(a.eventId)).toEqual([tokens.hash(r.lobbyToken)]);
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(new RegExp(`^LOBBY:${tokens.hash(r.lobbyToken)}:`));
  });

  test(`[${name}] Q-T55② 같은 pid의 다른 탭·기기는 새 토큰 없이 409 ALREADY_WAITING이고, 입장 이력이 있으면 ALREADY_ADMITTED다`, async () => {
    const a = await world();
    await a.join();
    expect(await code(a.join({ deviceId: 'dev-other' }))).toBe('ALREADY_WAITING');
    expect(await a.w.members(a.eventId)).toHaveLength(1);
    const b = await world();
    await b.w.admit(PID, b.eventId, 'x');
    expect(await code(b.join())).toBe('ALREADY_ADMITTED');
  });

  test(`[${name}] Q-T60 참가 토큰 jny는 UUIDv7이고 위험 판정 journeyId와 같으며, 409(이미 참가·이미 입장·창 밖)면 jny를 만들지 않아 판정에 실린 여정이 없다`, async () => {
    const a = await world();
    const r = await a.join();
    const claims = tokens.readLobby(r.lobbyToken)!;
    expect(claims.jny).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claims).toMatchObject({ e: a.eventId, a: ACCOUNT, d: DEVICE });
    expect(a.risk.seen).toHaveLength(1);
    expect(a.risk.seen[0]).toMatchObject({ context: 'LOBBY', journeyId: claims.jny, pid: PID, deviceId: DEVICE });
    // 이미 참가한 사람의 두 번째 요청은 선점에서 끝나 여정을 만들지 않는다
    await code(a.join({ deviceId: 'dev-2' }));
    expect(a.risk.seen).toHaveLength(1);
    const admitted = await world();
    await admitted.w.admit(PID, admitted.eventId, 'x');
    expect(await code(admitted.join())).toBe('ALREADY_ADMITTED');
    expect(admitted.risk.seen).toEqual([]);
    const outside = await world({ opensInMs: 7 * 24 * 3600_000 });
    expect(await code(outside.join())).toBe('NOT_OPEN');
    expect(outside.risk.seen).toEqual([]);
  });

  test(`[${name}] Q-T55① 창 밖 참가는 409여도 커밋 기록을 만들지 않고 위험 판정도 부르지 않으며 선점을 푼다`, async () => {
    const early = await world({ opensInMs: 7 * 24 * 3600_000 });
    expect(await code(early.join())).toBe('NOT_OPEN');
    const late = await world({ opensInMs: -1_000 });
    expect(await code(late.join())).toBe('LOBBY_CLOSED');
    for (const a of [early, late]) {
      expect(await a.w.commits.read(a.eventId, 'lobby')).toBeNull();
      expect(a.risk.seen).toEqual([]);
      expect(await a.w.dupValue(PID, a.eventId)).toBeNull();
      expect(await a.w.members(a.eventId)).toEqual([]);
    }
  });

  test(`[${name}] 공시 시각은 파드 시계가 아니라 저장소 시각이다`, async () => {
    const a = await world();
    const skewed: Clock = { now: () => a.w.clock.now() - 3_600_000, monotonicMs: () => a.w.clock.monotonicMs() };
    const rec = await new ShuffleCommits(a.w.commits, sealer, a.w.schedules, skewed).ensure(a.eventId, 'lobby', a.schedule);
    expect(Math.abs(rec.atMs - a.w.clock.now())).toBeLessThan(10_000);
  });

  test(`[${name}] Q-T34 위험 판정이 추가 검증이면 참가 토큰과 REQUIRED를 주고 VERIFYING을 적으며, 판정을 못 받으면 hd로 이어 간다`, async () => {
    const a = await world({ verdict: { kind: 'VERIFY', reason: 'NETWORK' } });
    const r = await a.join();
    expect(r).toMatchObject({ verification: 'REQUIRED', verificationReason: 'NETWORK' });
    expect(await a.w.verifying(a.eventId, tokens.hash(r.lobbyToken))).toMatch(/^VERIFYING:\d+:NETWORK$/);
    expect(tokens.readLobby(r.lobbyToken)).toMatchObject({ vr: 'NETWORK' });
    const b = await world({ verdict: { kind: 'UNAVAILABLE' } });
    const out = await b.join();
    expect(out.verification).toBeUndefined();
    expect(tokens.readLobby(out.lobbyToken)).toMatchObject({ hd: true });
  });

  test(`[${name}] [ASVS v5.0.0-15.4.2] Q-T52⑤ 로비 표시가 선 뒤나 오픈이 지난 뒤의 참가는 409 LOBBY_CLOSED이고 목록과 선점이 그대로다`, async () => {
    const a = await world();
    await a.w.closeLobby(a.eventId);
    expect(await code(a.join())).toBe('LOBBY_CLOSED');
    expect(await a.w.members(a.eventId)).toEqual([]);
    expect(await a.w.dupValue(PID, a.eventId)).toBeNull();
    const b = await world({ opensInMs: -1_000 });
    expect(await code(b.join())).toBe('LOBBY_CLOSED');
    expect(await b.w.members(b.eventId)).toEqual([]);
    expect(await b.w.dupValue(PID, b.eventId)).toBeNull();
  });

  test(`[${name}] [ASVS v5.0.0-15.4.2] Q-T52⑤ 목록을 고정한 뒤의 되돌리기는 목록과 검증 기록을 바꾸지 않는다`, async () => {
    const a = await world({ verdict: { kind: 'VERIFY', reason: 'NETWORK' } });
    let hash = '';
    const racing = new Proxy(a.w.store, {
      get(t, k) {
        if (k === 'addLobbyMember')
          return (i: Parameters<EntryStore['addLobbyMember']>[0]) => {
            hash = i.tokenHash;
            return t.addLobbyMember(i);
          };
        if (k === 'recordLobby')
          return async () => {
            await a.w.closeLobby(a.eventId);
            return 'TAKEN' as const;
          };
        const f = Reflect.get(t, k) as unknown;
        return typeof f === 'function' ? (f as (...x: unknown[]) => unknown).bind(t) : f;
      },
    }) as EntryStore;
    const app = new JoinLobby(racing, a.w.schedules, tokens, recordingRisk({ kind: 'VERIFY', reason: 'NETWORK' }), new ShuffleCommits(a.w.commits, sealer, a.w.schedules, a.w.clock), a.w.clock);
    expect(await code(app.run({ eventId: a.eventId, pid: PID, accountId: ACCOUNT, body: {} }))).toBe('ALREADY_WAITING');
    expect(await a.w.members(a.eventId)).toEqual([hash]);
    expect(await a.w.verifying(a.eventId, hash)).toMatch(/^VERIFYING:/);
  });

  test(`[${name}] Q-T52⑤ 목록을 고정한 뒤 되돌리기가 목록에 남긴 자리는 ORPHAN으로 적어 게시 때 빠진 번호가 되게 하고, 사람 키는 풀어 갇히지 않게 한다`, async () => {
    const a = await world();
    let hash = '';
    const racing = new Proxy(a.w.store, {
      get(t, k) {
        if (k === 'addLobbyMember')
          return (i: Parameters<EntryStore['addLobbyMember']>[0]) => {
            hash = i.tokenHash;
            return t.addLobbyMember(i);
          };
        if (k === 'recordLobby')
          return async () => {
            await a.w.closeLobby(a.eventId);
            return 'TAKEN' as const;
          };
        const f = Reflect.get(t, k) as unknown;
        return typeof f === 'function' ? (f as (...x: unknown[]) => unknown).bind(t) : f;
      },
    }) as EntryStore;
    const app = new JoinLobby(racing, a.w.schedules, tokens, recordingRisk(), new ShuffleCommits(a.w.commits, sealer, a.w.schedules, a.w.clock), a.w.clock);
    expect(await code(app.run({ eventId: a.eventId, pid: PID, accountId: ACCOUNT, body: {} }))).toBe('ALREADY_WAITING');
    expect(await a.w.members(a.eventId)).toEqual([hash]);
    expect(await a.w.verifying(a.eventId, hash)).toMatch(/^ORPHAN:\d+$/);
    expect(await a.w.dupValue(PID, a.eventId)).toBeNull();
  });

  test(`[${name}] Q-T45 기록 응답만 잃어 예외가 났어도 그 키의 LOBBY 값을 지워 다시 보내면 지나간다`, async () => {
    const a = await world();
    let lost = true;
    const failing = new Proxy(a.w.store, {
      get(t, k) {
        if (k === 'recordLobby')
          return async (i: Parameters<EntryStore['recordLobby']>[0]) => {
            const r = await t.recordLobby(i);
            if (lost && i.pid === PID2) throw new QueueStoreUnavailable(new Error('응답을 잃음'));
            return r;
          };
        const f = Reflect.get(t, k) as unknown;
        return typeof f === 'function' ? (f as (...x: unknown[]) => unknown).bind(t) : f;
      },
    }) as EntryStore;
    const app = new JoinLobby(failing, a.w.schedules, tokens, recordingRisk(), new ShuffleCommits(a.w.commits, sealer, a.w.schedules, a.w.clock), a.w.clock);
    const input = { eventId: a.eventId, pid: PID2, pidPrev: PID, accountId: ACCOUNT, body: {} };
    await expect(app.run(input)).rejects.toBeInstanceOf(QueueStoreUnavailable);
    expect(await a.w.dupValue(PID, a.eventId)).toBeNull();
    expect(await a.w.dupValue(PID2, a.eventId)).toBeNull();
    lost = false;
    expect(await code(app.run(input))).toBe('OK');
  });

  test(`[${name}] Q-T45 뒤 키의 기록에서 오류가 나면 앞 키의 LOBBY 값과 참가자를 되돌리고 503이며, 다시 보내면 지나간다`, async () => {
    const a = await world();
    let down = true;
    const failing = new Proxy(a.w.store, {
      get(t, k) {
        if (k === 'recordLobby')
          return (i: Parameters<EntryStore['recordLobby']>[0]) => (down && i.pid === PID2 ? Promise.reject(new QueueStoreUnavailable(new Error('down'))) : t.recordLobby(i));
        const f = Reflect.get(t, k) as unknown;
        return typeof f === 'function' ? (f as (...x: unknown[]) => unknown).bind(t) : f;
      },
    }) as EntryStore;
    const app = new JoinLobby(failing, a.w.schedules, tokens, recordingRisk(), new ShuffleCommits(a.w.commits, sealer, a.w.schedules, a.w.clock), a.w.clock);
    const input = { eventId: a.eventId, pid: PID2, pidPrev: PID, accountId: ACCOUNT, body: {} };
    await expect(app.run(input)).rejects.toBeInstanceOf(QueueStoreUnavailable);
    expect(await a.w.dupValue(PID, a.eventId)).toBeNull();
    expect(await a.w.dupValue(PID2, a.eventId)).toBeNull();
    expect(await a.w.members(a.eventId)).toEqual([]);
    down = false;
    expect(await code(app.run(input))).toBe('OK');
  });

  test(`[${name}] 로비 셔플을 끈 회차와 사본이 없는 회차는 NOT_FOUND다`, async () => {
    const off = await world({ schedule: { lobbyShuffle: false } });
    expect(await code(off.join())).toBe('NOT_FOUND');
    const w = await setup();
    const none = new JoinLobby(w.store, w.schedules, tokens, recordingRisk(), new ShuffleCommits(w.commits, sealer, w.schedules, w.clock), w.clock);
    expect(await code(none.run({ eventId: 'no-such', pid: PID, accountId: ACCOUNT, body: {} }))).toBe('NOT_FOUND');
  });

  test(`[${name}] Q-T45① 전환 기간은 옛 pid → 새 pid 두 키를 잡고 판정의 pid는 옛 pid이며, 뒤이어 어느 pid로 와도 409다`, async () => {
    const a = await world();
    const r = await a.join({ pid: PID, pidPrev: PID2 });
    expect(await a.w.dupValue(PID2, a.eventId)).toMatch(/^LOBBY:/);
    expect(await a.w.dupValue(PID, a.eventId)).toMatch(/^LOBBY:/);
    expect(a.risk.seen[0]!.pid).toBe(PID2);
    expect(await a.w.members(a.eventId)).toEqual([tokens.hash(r.lobbyToken)]);
    expect(await code(a.join({ pid: PID }))).toBe('ALREADY_WAITING');
    expect(await code(a.join({ pid: PID2 }))).toBe('ALREADY_WAITING');
  });

  test(`[${name}] Q-T45⑤ 새 pid 선점이 거절되면 옛 pid 선점을 풀고 409, 오류면 옛 선점을 풀고 503이다`, async () => {
    const taken = await world();
    await taken.join({ pid: PID2 });
    expect(await code(taken.join({ pid: PID2, pidPrev: PID }))).toBe('ALREADY_WAITING');
    expect(await taken.w.dupValue(PID, taken.eventId)).toBeNull();
    const down = await world();
    const failing = new Proxy(down.w.store, {
      get(t, k) {
        if (k === 'preempt')
          return (i: { pid: string; eventId: string; requestId: string; pendingTtlMs: number }) => (i.pid === PID2 ? Promise.reject(new QueueStoreUnavailable(new Error('down'))) : t.preempt(i));
        const f = Reflect.get(t, k) as unknown;
        return typeof f === 'function' ? (f as (...a: unknown[]) => unknown).bind(t) : f;
      },
    }) as EntryStore;
    const app = new JoinLobby(failing, down.w.schedules, tokens, recordingRisk(), new ShuffleCommits(down.w.commits, sealer, down.w.schedules, down.w.clock), down.w.clock);
    await expect(app.run({ eventId: down.eventId, pid: PID2, pidPrev: PID, accountId: ACCOUNT, body: {} })).rejects.toBeInstanceOf(QueueStoreUnavailable);
    expect(await down.w.dupValue(PID, down.eventId)).toBeNull();
  });

  test(`[${name}] 선점 뒤 다른 요청이 그 키를 차지하면 넣은 참가자와 검증 기록을 빼고 409다`, async () => {
    const a = await world({ verdict: { kind: 'VERIFY', reason: 'NETWORK' } });
    let hash = '';
    const racing = new Proxy(a.w.store, {
      get(t, k) {
        if (k === 'addLobbyMember')
          return (i: Parameters<EntryStore['addLobbyMember']>[0]) => {
            hash = i.tokenHash;
            return t.addLobbyMember(i);
          };
        if (k === 'recordLobby') return async () => 'TAKEN' as const;
        const f = Reflect.get(t, k) as unknown;
        return typeof f === 'function' ? (f as (...x: unknown[]) => unknown).bind(t) : f;
      },
    }) as EntryStore;
    const app = new JoinLobby(racing, a.w.schedules, tokens, recordingRisk({ kind: 'VERIFY', reason: 'NETWORK' }), new ShuffleCommits(a.w.commits, sealer, a.w.schedules, a.w.clock), a.w.clock);
    expect(await code(app.run({ eventId: a.eventId, pid: PID, accountId: ACCOUNT, body: {} }))).toBe('ALREADY_WAITING');
    expect(await a.w.members(a.eventId)).toEqual([]);
    expect(await a.w.verifying(a.eventId, hash)).toBeNull();
    expect(await a.w.dupValue(PID, a.eventId)).toBeNull();
  });

  test(`[${name}] 커밋 기록을 만들지 못하면 503이고 참가자도 선점도 남기지 않는다`, async () => {
    const a = await world();
    const broken = new ShuffleCommits(a.w.commits, { seal: () => Promise.reject(new Error('kms down')), open: () => Promise.reject(new Error('x')) }, a.w.schedules, a.w.clock);
    const app = new JoinLobby(a.w.store, a.w.schedules, tokens, recordingRisk(), broken, a.w.clock);
    await expect(app.run({ eventId: a.eventId, pid: PID, accountId: ACCOUNT, body: {} })).rejects.toBeInstanceOf(QueueStoreUnavailable);
    expect(await a.w.members(a.eventId)).toEqual([]);
    expect(await a.w.dupValue(PID, a.eventId)).toBeNull();
  });

  test(`[${name}] Q-T55② 같은 사람의 두 요청이 동시에 와도 참가자 하나만 든다`, async () => {
    const a = await world();
    const results = await Promise.all([code(a.join()), code(a.join({ deviceId: 'd2', accountId: OTHER_ACCOUNT }))]);
    expect([...results].sort()).toEqual(['ALREADY_WAITING', 'OK']);
    expect(await a.w.members(a.eventId)).toHaveLength(1);
  });

  test(`[${name}] Q-T6 202 BATCHING의 resultAt은 공시 라운드 시각 + 5초이고 기록이 없으면 구간 끝 + 11초다`, async () => {
    const w = await setup();
    const eventId = newEvent();
    const now = w.clock.now();
    const schedule: EventSchedule = { opensAtMs: now - 200, startsAtMs: now + 3 * 24 * 3600_000, lobbyShuffle: false, openBatch: true, batchWindowMs: 5_000 };
    await w.schedules.set(eventId, schedule);
    const pre = tokens.preverify({ e: eventId, a: ACCOUNT, d: DEVICE, i0: now - 60_000, iat: now, exp: now + 900_000, jny: '0190f3a1-7c2e-7a00-8000-0000000000aa' });
    const commits = new ShuffleCommits(w.commits, sealer, w.schedules, w.clock);
    const enter = new EnterQueue(w.store, w.schedules, tokens, w.clock, DEFAULT_ENTRY_OPTIONS, undefined, undefined, undefined, commits);
    const without = await new EnterQueue(w.store, w.schedules, tokens, w.clock, DEFAULT_ENTRY_OPTIONS).run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { preverifyToken: pre, deviceId: DEVICE, entryRequestId: crypto.randomUUID() } });
    expect(without.kind).toBe('BATCHING');
    if (without.kind === 'BATCHING') expect(without.resultAt).toBe(new Date(schedule.opensAtMs + 5_000 + 11_000).toISOString());
    const rec = await commits.ensure(eventId, 1, schedule);
    const out = await enter.run({ accountId: ACCOUNT, sessionId: 's', pid: PID, eventId, body: { preverifyToken: pre, deviceId: DEVICE, entryRequestId: (without as { entryRequestId: string }).entryRequestId } });
    expect(out.kind).toBe('BATCHING');
    if (out.kind === 'BATCHING') expect(out.resultAt).toBe(new Date(drandRoundTimeMs(rec.round) + 5_000).toISOString());
  });

  test(`[${name}] ShuffleCommits: 같은 구간을 두 번 만들면 먼저 쓴 값 하나로 남고, 묶음 구간은 시드와 라운드가 따로다`, async () => {
    const a = await world();
    const c1 = new ShuffleCommits(a.w.commits, sealer, a.w.schedules, a.w.clock);
    const c2 = new ShuffleCommits(a.w.commits, sealer, a.w.schedules, a.w.clock);
    const [x, y] = await Promise.all([c1.ensure(a.eventId, 'lobby', a.schedule), c2.ensure(a.eventId, 'lobby', a.schedule)]);
    expect(x.commit).toBe(y.commit);
    expect(x.round).toBe(drandRoundAfter(a.schedule.opensAtMs));
    expect(await new ShuffleCommits(a.w.commits, sealer, a.w.schedules, a.w.clock).peek(a.eventId, 'lobby')).toEqual(x);
    const batch = await c1.ensure(a.eventId, 1, a.schedule);
    expect(batch.commit).not.toBe(x.commit);
    expect(batch.round).toBe(drandRoundAfter(a.schedule.opensAtMs + 2_000));
  });
}
