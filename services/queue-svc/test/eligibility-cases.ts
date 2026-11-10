// 판매 자격 대조와 입장 토큰 `lst`(Q-T36 ①②, queue-admission ASVS 2.3.2·15.4.2·16.5.2, ADR-0265).
// 같은 사례를 메모리 저장소와 실제 Valkey Lua에 돈다. 경계·가짜 시계 사례는 메모리에서만 돈다(서버 시각을 쓰는 Lua는 실제 시계다).
import type { Clock } from '@peaket/platform';
import { TestSeedSealer } from '@peaket/shuffle';
import { expect, test } from 'vitest';
import { ConfirmAdmission } from '../src/modules/admission/application/confirm-admission.js';
import type { AdmissionStore } from '../src/modules/admission/domain/ports.js';
import { DEFAULT_ENTRY_OPTIONS, EnterQueue } from '../src/modules/entry/application/enter-queue.js';
import { EligibilityLog } from '../src/modules/entry/application/eligibility-log.js';
import { NumberBatcher } from '../src/modules/entry/application/number-batcher.js';
import { EntryError } from '../src/modules/entry/application/entry-error.js';
import { JoinLobby } from '../src/modules/entry/application/join-lobby.js';
import { ShuffleCommits } from '../src/modules/entry/application/shuffle-commits.js';
import type { EligibilityCheck, EntryStore, EventSchedules, NumberBatchInput, ShuffleCommitStore } from '../src/modules/entry/domain/ports.js';
import { type EventSchedule, PENDING_TTL_MS } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, DEVICE, newEvent, OTHER_ACCOUNT, PID, preverifyToken, recordingRisk, tokens } from './support.js';
import { readAdmissionToken, signer } from './admission-cases.js';

const PID2 = `${PID}x`;
const PID3 = `${PID}xy`;
const sealer = new TestSeedSealer(Buffer.alloc(32, 5));
const HOUR = 3_600_000;

export interface EligibilityWorld {
  store: EntryStore;
  commits: ShuffleCommitStore;
  schedules: EventSchedules & { set(eventId: string, s: EventSchedule): Promise<void> };
  clock: Clock;
  admission: AdmissionStore;
  /** 사본 넣기(구성원 0명이면 표지만) */
  copy(eventId: string, listKey: string, accountIds: readonly string[], marker?: boolean): Promise<void>;
  dropMarker(eventId: string, listKey: string): Promise<void>;
  counter(eventId: string): Promise<number>;
  lobbyMembers(eventId: string): Promise<string[]>;
  batchMembers(eventId: string): Promise<string[]>;
  dupValue(pid: string, eventId: string): Promise<string | null>;
  setServing(eventId: string, seq: number): Promise<void>;
}

interface Signals {
  checks: { path: 'lobby' | 'entry'; result: EligibilityCheck }[];
}

function logger() {
  const lines: Record<string, unknown>[] = [];
  const log = {
    info: () => undefined,
    warn: (fields: Record<string, unknown>, message?: string) => void lines.push({ ...fields, ...(message ? { message } : {}) }),
    error: () => undefined,
  };
  return { lines, log };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof EntryError) return e.code;
    throw e;
  }
};

const gated = (fromMs: number, toMs: number, lists: string[]): EventSchedule['eligibility'] => ({ kind: 'GATED', gates: [{ fromMs, toMs, lists }], lists: [] });

export function eligibilityCases(name: string, setup: () => Promise<EligibilityWorld>): void {
  async function world(o: { opensInMs?: number; schedule?: Partial<EventSchedule>; eligibility?: EventSchedule['eligibility'] } = {}) {
    const w = await setup();
    const eventId = newEvent();
    const now = w.clock.now();
    const schedule: EventSchedule = {
      opensAtMs: now + (o.opensInMs ?? -60_000),
      startsAtMs: now + 3 * 24 * HOUR,
      lobbyShuffle: true,
      openBatch: false,
      ...(o.eligibility ? { eligibility: o.eligibility } : {}),
      ...o.schedule,
    };
    await w.schedules.set(eventId, schedule);
    const signals: Signals = { checks: [] };
    const log = logger();
    const eligibilityLog = new EligibilityLog(w.clock, log.log as never);
    const commits = new ShuffleCommits(w.commits, sealer, w.schedules, w.clock);
    const lobby = new JoinLobby(w.store, w.schedules, tokens, recordingRisk(), commits, w.clock, undefined, undefined, undefined, undefined, { check: (i) => signals.checks.push(i) }, eligibilityLog);
    const enter = new EnterQueue(w.store, w.schedules, tokens, w.clock, { ...DEFAULT_ENTRY_OPTIONS, pendingTtlMs: PENDING_TTL_MS }, undefined, undefined, undefined, commits, { check: (i) => signals.checks.push(i) }, eligibilityLog);
    const admission = new ConfirmAdmission(w.admission, w.schedules, tokens, signer, { admittedBeforeTurn: () => undefined, turnEntryFailed: () => undefined, arrivalDelay: () => undefined, soonWait: () => undefined, etaError: () => undefined }, w.clock);
    return { w, eventId, now, schedule, signals, log: log.lines, lobby, enter, admission };
  }

  const join = (app: JoinLobby, eventId: string, o: { accountId?: string; pid?: string } = {}) =>
    app.run({ eventId, accountId: o.accountId ?? ACCOUNT, pid: o.pid ?? PID, body: { humanCheckToken: 'ok', deviceId: DEVICE } });

  const enterOne = (app: EnterQueue, eventId: string, clock: Clock, o: { accountId?: string; pid?: string; i0?: number; requestId?: string } = {}) =>
    app.run({
      accountId: o.accountId ?? ACCOUNT,
      sessionId: 's-1',
      pid: o.pid ?? PID,
      eventId,
      body: { preverifyToken: preverifyToken(clock, eventId, { ...(o.accountId ? { a: o.accountId } : {}), ...(o.i0 !== undefined ? { i0: o.i0 } : {}) }), deviceId: DEVICE, entryRequestId: o.requestId },
    });

  test(`[${name}] Q-T36 ① 로비 참가는 오픈 시각으로 창을 골라 오픈 전에 와도 명단 밖이면 403이고 참가자·번호가 늘지 않으며 선점이 풀린다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-16.5.2]`, async () => {
    const x = await world({ opensInMs: 5 * 60_000, eligibility: gated(0, 0, ['fan-a']) });
    // 오픈 시각에 시작하는 창: 지금(오픈 5분 전)으로 고르면 창 밖이지만 오픈 시각으로 고르면 창 안이다
    await x.w.schedules.set(x.eventId, { ...x.schedule, eligibility: { kind: 'GATED', gates: [{ fromMs: x.now + 5 * 60_000, toMs: x.now + 65 * 60_000, lists: ['fan-a'] }], lists: [] } });
    await x.w.copy(x.eventId, 'fan-a', [OTHER_ACCOUNT]);
    expect(await code(join(x.lobby, x.eventId))).toBe('SALE_ELIGIBILITY_REQUIRED');
    expect(await x.w.lobbyMembers(x.eventId)).toEqual([]);
    expect(await x.w.dupValue(PID, x.eventId)).toBeNull();
    expect(await x.w.counter(x.eventId)).toBe(0);
    expect(x.signals.checks).toContainEqual({ path: 'lobby', result: 'denied' });
    // 선점을 풀었으므로 같은 사람이 명단에 든 뒤 바로 다시 참가할 수 있다
    await x.w.copy(x.eventId, 'fan-a', [ACCOUNT]);
    expect(await code(join(x.lobby, x.eventId))).toBe('OK');
    expect((await x.w.lobbyMembers(x.eventId)).length).toBe(1);
  });

  test(`[${name}] Q-T36 ① 진입은 지금으로 창을 골라 명단 밖이면 403이고 번호가 나가지 않으며 같은 사람이 바로 다시 시도할 수 있다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-15.4.2]`, async () => {
    const x = await world({ eligibility: gated(0, 0, ['fan-a']) });
    await x.w.schedules.set(x.eventId, { ...x.schedule, eligibility: { kind: 'GATED', gates: [{ fromMs: x.now - HOUR, toMs: x.now + HOUR, lists: ['fan-a'] }], lists: [] } });
    await x.w.copy(x.eventId, 'fan-a', [OTHER_ACCOUNT]);
    expect(await code(enterOne(x.enter, x.eventId, x.w.clock))).toBe('SALE_ELIGIBILITY_REQUIRED');
    expect(await x.w.counter(x.eventId)).toBe(0);
    expect(await x.w.dupValue(PID, x.eventId)).toBeNull();
    expect(x.signals.checks).toContainEqual({ path: 'entry', result: 'denied' });
    await x.w.copy(x.eventId, 'fan-a', [ACCOUNT]);
    const t = await enterOne(x.enter, x.eventId, x.w.clock);
    expect(t.kind).toBe('TICKET');
    expect(await x.w.counter(x.eventId)).toBe(1);
    expect(x.signals.checks).toContainEqual({ path: 'entry', result: 'allowed' });
  });

  test(`[${name}] Q-T36 ① 창 경계는 fromMs 이상 toMs 미만이고 겹친 창은 명단 키를 합치며 lists가 빈 창은 아무도 통과하지 못한다 [ASVS v5.0.0-2.3.2]`, async () => {
    const x = await world({ eligibility: gated(0, 0, []) });
    const at = x.w.clock.now();
    // fromMs 1ms 전: 창 밖이라 사본을 읽지 않고 통과한다. fromMs: 창 안인데 명단 밖이라 403
    await x.w.schedules.set(x.eventId, { ...x.schedule, opensAtMs: at - HOUR, eligibility: { kind: 'GATED', gates: [{ fromMs: at + 1_000, toMs: at + HOUR, lists: ['fan-a'] }], lists: [] } });
    expect((await enterOne(x.enter, x.eventId, x.w.clock)).kind).toBe('TICKET');
    await x.w.schedules.set(x.eventId, { ...x.schedule, opensAtMs: at - HOUR, eligibility: { kind: 'GATED', gates: [{ fromMs: at, toMs: at + HOUR, lists: ['fan-a'] }], lists: [] } });
    expect(await code(enterOne(x.enter, x.eventId, x.w.clock, { pid: PID2 }))).toBe('SALE_ELIGIBILITY_REQUIRED');
    // 겹친 창: 두 키를 합치고 두 번째 명단에 든 계정은 통과한다
    await x.w.copy(x.eventId, 'fan-b', [ACCOUNT]);
    await x.w.schedules.set(x.eventId, { ...x.schedule, opensAtMs: at - HOUR, eligibility: { kind: 'GATED', gates: [{ fromMs: at - HOUR, toMs: at + HOUR, lists: ['fan-a'] }, { fromMs: at - 1_000, toMs: at + 2 * HOUR, lists: ['fan-b'] }], lists: [] } });
    expect((await enterOne(x.enter, x.eventId, x.w.clock, { pid: PID3 })).kind).toBe('TICKET');
    // 빈 lists 창: 그 시간에는 아무도 지나지 못한다
    await x.w.schedules.set(x.eventId, { ...x.schedule, opensAtMs: at - HOUR, eligibility: { kind: 'GATED', gates: [{ fromMs: at - HOUR, toMs: at + HOUR, lists: [] }], lists: [] } });
    expect(await code(enterOne(x.enter, x.eventId, x.w.clock, { pid: `${PID3}x` }))).toBe('SALE_ELIGIBILITY_REQUIRED');
  });

  test(`[${name}] Q-T36 ①⑨ 사본 표지가 없으면 copy_missing으로 403이고, 다른 사본에 들었으면 통과하며 구성원 0명은 denied다 [ASVS v5.0.0-16.5.2]`, async () => {
    const x = await world({ eligibility: gated(0, 0, ['fan-a', 'fan-b']) });
    const at = x.w.clock.now();
    await x.w.schedules.set(x.eventId, { ...x.schedule, opensAtMs: at - HOUR, eligibility: { kind: 'GATED', gates: [{ fromMs: at - HOUR, toMs: at + HOUR, lists: ['fan-a', 'fan-b'] }], lists: [] } });
    await x.w.copy(x.eventId, 'fan-b', [ACCOUNT]);
    // fan-a 표지만 없다. fan-b에 들었으므로 통과한다
    expect((await enterOne(x.enter, x.eventId, x.w.clock)).kind).toBe('TICKET');
    await x.w.copy(x.eventId, 'fan-b', [OTHER_ACCOUNT]);
    expect(await code(enterOne(x.enter, x.eventId, x.w.clock, { pid: PID2 }))).toBe('SALE_ELIGIBILITY_REQUIRED');
    expect(x.signals.checks).toContainEqual({ path: 'entry', result: 'copy_missing' });
    // 표지는 있는데 구성원이 0명: 사본 없음이 아니라 명단 밖(denied)이다
    await x.w.copy(x.eventId, 'fan-a', []);
    await x.w.copy(x.eventId, 'fan-b', []);
    expect(await code(enterOne(x.enter, x.eventId, x.w.clock, { pid: PID3 }))).toBe('SALE_ELIGIBILITY_REQUIRED');
    expect(x.signals.checks.at(-1)).toEqual({ path: 'entry', result: 'denied' });
    // 로비도 표지가 없으면 copy_missing으로 403이고, 없는 명단 키를 돌려준다
    const y = await world({ opensInMs: 5 * 60_000, eligibility: gated(0, 0, ['fan-a']) });
    await y.w.schedules.set(y.eventId, { ...y.schedule, eligibility: { kind: 'GATED', gates: [{ fromMs: y.now + 5 * 60_000, toMs: y.now + 65 * 60_000, lists: ['fan-a'] }], lists: [] } });
    expect(await code(join(y.lobby, y.eventId))).toBe('SALE_ELIGIBILITY_REQUIRED');
    expect(y.signals.checks).toContainEqual({ path: 'lobby', result: 'copy_missing' });
    expect(y.log.at(-1)).toMatchObject({ event: 'sale_eligibility.copy_missing', eventId: y.eventId, listKey: 'fan-a' });
  });

  test(`[${name}] Q-T36 ① 대조 값은 계정 ID이고 pid·기기 값이 명단 구성원과 같아도 통과하지 못한다`, async () => {
    const x = await world({ eligibility: gated(0, 0, ['fan-a']) });
    const at = x.w.clock.now();
    await x.w.schedules.set(x.eventId, { ...x.schedule, opensAtMs: at - HOUR, eligibility: { kind: 'GATED', gates: [{ fromMs: at - HOUR, toMs: at + HOUR, lists: ['fan-a'] }], lists: [] } });
    await x.w.copy(x.eventId, 'fan-a', [PID, DEVICE]);
    expect(await code(enterOne(x.enter, x.eventId, x.w.clock))).toBe('SALE_ELIGIBILITY_REQUIRED');
    await x.w.copy(x.eventId, 'fan-a', [ACCOUNT]);
    expect((await enterOne(x.enter, x.eventId, x.w.clock, { pid: PID2 })).kind).toBe('TICKET');
    // 로비도 같은 계정 ID로 대조한다: pid·기기가 구성원과 같아도 명단 밖이다
    const y = await world({ opensInMs: 5 * 60_000, eligibility: gated(0, 0, ['fan-a']) });
    await y.w.schedules.set(y.eventId, { ...y.schedule, eligibility: { kind: 'GATED', gates: [{ fromMs: y.now + 5 * 60_000, toMs: y.now + 65 * 60_000, lists: ['fan-a'] }], lists: [] } });
    await y.w.copy(y.eventId, 'fan-a', [PID, DEVICE]);
    expect(await code(join(y.lobby, y.eventId))).toBe('SALE_ELIGIBILITY_REQUIRED');
    await y.w.copy(y.eventId, 'fan-a', [ACCOUNT]);
    expect(await code(join(y.lobby, y.eventId))).toBe('OK');
  });

  test(`[${name}] Q-T36 ①⑨ 설정 모양이 틀리면 창 밖이어도 로비·진입이 모두 config_invalid 403이고 번호가 나가지 않는다 [ASVS v5.0.0-16.5.2]`, async () => {
    const x = await world({ opensInMs: 5 * 60_000, eligibility: { kind: 'INVALID' } });
    expect(await code(join(x.lobby, x.eventId))).toBe('SALE_ELIGIBILITY_REQUIRED');
    expect(x.signals.checks.at(-1)).toEqual({ path: 'lobby', result: 'config_invalid' });
    expect(x.log.at(-1)).toMatchObject({ event: 'sale_eligibility.config_invalid', eventId: x.eventId });
    const y = await world({ eligibility: { kind: 'INVALID' } });
    expect(await code(enterOne(y.enter, y.eventId, y.w.clock))).toBe('SALE_ELIGIBILITY_REQUIRED');
    expect(await y.w.counter(y.eventId)).toBe(0);
    expect(y.signals.checks.at(-1)).toEqual({ path: 'entry', result: 'config_invalid' });
  });

  test(`[${name}] Q-T36 ① 자격이 섞인 두 요청은 자격 없는 요청만 403이고 번호는 빠지지 않으며 카운터는 자격 있는 수만큼만 는다 [ASVS v5.0.0-2.3.2]`, async () => {
    const x = await world({ eligibility: gated(0, 0, ['fan-a']) });
    const at = x.w.clock.now();
    await x.w.copy(x.eventId, 'fan-a', [ACCOUNT]);
    const r = await x.w.store.numberBatch({
      eventId: x.eventId,
      expireAtMs: at + HOUR,
      opensAtMs: at - HOUR,
      closeAtMs: at + HOUR,
      lobbyShuffle: true,
      openBatch: false,
      items: [
        { accountId: ACCOUNT, eligible: false, tokenHash: 'a'.repeat(64) },
        { accountId: OTHER_ACCOUNT, eligible: false, tokenHash: 'b'.repeat(64) },
        { accountId: ACCOUNT, eligible: false, tokenHash: 'c'.repeat(64) },
      ],
      eligibility: { listKeys: ['fan-a'] },
    });
    expect(r.map((v) => v.kind)).toEqual(['NUMBERED', 'ELIGIBILITY_REQUIRED', 'NUMBERED']);
    expect(r[0]).toMatchObject({ kind: 'NUMBERED', seq: 1 });
    expect(r[2]).toMatchObject({ kind: 'NUMBERED', seq: 2 });
    expect(await x.w.counter(x.eventId)).toBe(2);
  });

  test(`[${name}] Q-T36 ② 입장 토큰 lst에는 그 계정이 든 명단 키만 글자 차례로 실리고 든 것이 없거나 설정이 틀리면 클레임이 없다 [ASVS v5.0.0-2.3.2] (queue-admission:v5.0.0-2.3.2)`, async () => {
    const x = await world();
    const at = x.w.clock.now();
    await x.w.setServing(x.eventId, 1);
    await x.w.schedules.set(x.eventId, { ...x.schedule, opensAtMs: at - HOUR, startsAtMs: at + 2 * 24 * HOUR, eligibility: { kind: 'GATED', gates: [], lists: ['beta-list', 'alpha-list'] } });
    await x.w.admission.admit({ eventId: x.eventId, seq: 1, ticketHash: 'a'.repeat(64), freshJti: 'j-1', skipped: false, keepUntilMs: at + 2 * 24 * HOUR, soonExpireAtMs: at + 2 * 24 * HOUR });
    // 입장 토큰 후보는 eligLists의 두 키다. 그 계정이 alpha-list에만 들면 lst에는 alpha-list만 싣는다
    const store = x.w.admission as AdmissionStore & { db?: { elig: (e: string) => Map<string, Set<string>> } };
    if (store.db) {
      store.db.elig(x.eventId).set('alpha-list', new Set([ACCOUNT]));
      store.db.elig(x.eventId).set('beta-list', new Set([OTHER_ACCOUNT]));
    } else {
      await x.w.copy(x.eventId, 'alpha-list', [ACCOUNT]);
      await x.w.copy(x.eventId, 'beta-list', [OTHER_ACCOUNT]);
    }
    const r = await x.w.admission.admit({ eventId: x.eventId, seq: 1, ticketHash: 'b'.repeat(64), freshJti: 'j-2', skipped: false, keepUntilMs: at + 2 * 24 * HOUR, soonExpireAtMs: at + 2 * 24 * HOUR, eligibility: { accountId: ACCOUNT, listKeys: ['beta-list', 'alpha-list'] } });
    expect(r.kind).toBe('ADMITTED');
    expect(r.kind === 'ADMITTED' ? r.lists : undefined).toEqual(['alpha-list']);
    const token = signer.sign({ jti: 'j-2', accountId: ACCOUNT, sessionId: 's-1', eventId: x.eventId, jny: 'jny', nowMs: at, lists: r.kind === 'ADMITTED' ? r.lists : undefined });
    expect(readAdmissionToken(token.token).claims.lst).toEqual(['alpha-list']);
    // 든 것이 없으면 클레임이 없다
    const none = signer.sign({ jti: 'j-3', accountId: ACCOUNT, sessionId: 's-1', eventId: x.eventId, jny: 'jny', nowMs: at, lists: [] });
    expect(readAdmissionToken(none.token).claims).not.toHaveProperty('lst');
  });

  test(`[${name}] Q-T36 ② 같은 jti를 다시 줄 때도 그때 사본으로 lst를 다시 읽고, 설정이 틀리면 lst를 싣지 않는다`, async () => {
    const x = await world();
    const at = x.w.clock.now();
    await x.w.setServing(x.eventId, 1);
    await x.w.schedules.set(x.eventId, { ...x.schedule, opensAtMs: at - HOUR, startsAtMs: at + 2 * 24 * HOUR, eligibility: { kind: 'GATED', gates: [], lists: ['alpha-list', 'beta-list'] } });
    const store = x.w.admission as AdmissionStore & { db?: { elig: (e: string) => Map<string, Set<string>> } };
    if (store.db) store.db.elig(x.eventId).set('alpha-list', new Set([ACCOUNT]));
    else await x.w.copy(x.eventId, 'alpha-list', [ACCOUNT]);
    const first = await x.w.admission.admit({ eventId: x.eventId, seq: 1, ticketHash: 'c'.repeat(64), freshJti: 'j-4', skipped: false, keepUntilMs: at + 2 * 24 * HOUR, soonExpireAtMs: at + 2 * 24 * HOUR, eligibility: { accountId: ACCOUNT, listKeys: ['alpha-list', 'beta-list'] } });
    expect(first.kind === 'ADMITTED' ? first.lists : undefined).toEqual(['alpha-list']);
    // 사본이 늘어난 뒤 같은 대기표(같은 jti 자리)를 다시 받으면 그때 사본으로 beta-list도 싣는다
    if (store.db) store.db.elig(x.eventId).set('beta-list', new Set([ACCOUNT]));
    else await x.w.copy(x.eventId, 'beta-list', [ACCOUNT]);
    const again = await x.w.admission.admit({ eventId: x.eventId, seq: 1, ticketHash: 'c'.repeat(64), freshJti: 'j-5', skipped: false, keepUntilMs: at + 2 * 24 * HOUR, soonExpireAtMs: at + 2 * 24 * HOUR, eligibility: { accountId: ACCOUNT, listKeys: ['alpha-list', 'beta-list'] } });
    expect(again.kind).toBe('ADMITTED');
    expect(again.kind === 'ADMITTED' ? again.lists : undefined).toEqual(['alpha-list', 'beta-list']);
    // 설정이 틀리면 후보를 넘기지 않으므로 lst가 없다
    const noLists = await x.w.admission.admit({ eventId: x.eventId, seq: 1, ticketHash: 'd'.repeat(64), freshJti: 'j-6', skipped: false, keepUntilMs: at + 2 * 24 * HOUR, soonExpireAtMs: at + 2 * 24 * HOUR });
    expect(noLists.kind).toBe('ADMITTED');
    expect(noLists.kind === 'ADMITTED' ? noLists.lists : undefined).toBeUndefined();
  });

  test(`[${name}] Q-T36 ① 고른 명단 키가 다른 요청은 한 묶음에 모이지 않는다`, async () => {
    const x = await world();
    const calls: number[] = [];
    const store = new Proxy(x.w.store, {
      get(t, k) {
        if (k === 'numberBatch') {
          return async (i: NumberBatchInput) => {
            calls.push(i.items.length);
            return i.items.map((_, n) => ({ kind: 'NUMBERED' as const, seq: n + 1, gen: 1 }));
          };
        }
        return Reflect.get(t, k) as unknown;
      },
    }) as EntryStore;
    const batcher = new NumberBatcher(store, 2, 10);
    const common = { eventId: x.eventId, expireAtMs: x.now + 10_000, opensAtMs: x.now - 10_000 };
    const a = batcher.take({ ...common, eligibility: { listKeys: ['fan-a'] } }, { accountId: ACCOUNT });
    const b = batcher.take({ ...common, eligibility: { listKeys: ['fan-b'] } }, { accountId: ACCOUNT });
    await Promise.all([a, b]);
    // 같은 명단 키면 한 번에 모으지만, 다르면 앞 묶음을 먼저 보내고 새 묶음을 만든다
    expect(calls).toEqual([1, 1]);
  });

  test(`[${name}] Q-T36 ① 이미 대기 중(409)은 자격 403보다 앞서고 경고는 회차·명단 키만 담아 1분에 한 번이다 [ASVS v5.0.0-16.3.1]`, async () => {
    const x = await world({ opensInMs: 5 * 60_000, eligibility: gated(0, 0, ['fan-a']) });
    // 이미 대기 중인 사람 키
    await x.w.copy(x.eventId, 'fan-a', [OTHER_ACCOUNT]);
    await x.w.store.preempt({ pid: PID, eventId: x.eventId, requestId: 'old', pendingTtlMs: 60_000 });
    expect(await code(join(x.lobby, x.eventId))).toBe('ALREADY_WAITING');
    const y = await world({ eligibility: gated(0, 0, ['fan-a', 'fan-b']) });
    const at = y.w.clock.now();
    await y.w.schedules.set(y.eventId, { ...y.schedule, opensAtMs: at - HOUR, eligibility: { kind: 'GATED', gates: [{ fromMs: at - HOUR, toMs: at + HOUR, lists: ['fan-a', 'fan-b'] }], lists: [] } });
    // 두 표지가 모두 없다: 회차·명단 키마다 한 줄, 같은 1분 안의 다음 요청은 남기지 않는다
    expect(await code(enterOne(y.enter, y.eventId, y.w.clock))).toBe('SALE_ELIGIBILITY_REQUIRED');
    const first = y.log.length;
    expect(first).toBe(2);
    expect(y.log.every((l) => l.eventId === y.eventId && l.event === 'sale_eligibility.copy_missing' && typeof l.listKey === 'string')).toBe(true);
    expect(JSON.stringify(y.log)).not.toContain(ACCOUNT);
    expect(await code(enterOne(y.enter, y.eventId, y.w.clock, { pid: PID2 }))).toBe('SALE_ELIGIBILITY_REQUIRED');
    expect(y.log.length).toBe(first);
  });
}
