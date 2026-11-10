// 추가 검증 제출·이의 접수·상태 읽기·이의 내용 읽기·결과 반영(docs/features/bot-defense.md §5.2·§12, B-T6 ④·B-T10 ①②④⑤·B-T11·I-T56 ④, ADR-0259).
// 메모리 저장소(test/verification.test.ts)와 실제 Valkey의 Lua(test-int/verification-store.int.test.ts)에 같은 사례를 돌린다.
// identity-svc·trust-svc·건 요청 발행은 포트의 가짜다(답·실패·지연·성공 뒤 응답 유실을 시험이 정한다). 실제 gRPC·실제 trust-svc는 test/verification-clients.test.ts와
// test-int/appeal-resolve.int.test.ts가 본다. 시험 값(유예·한도·창·발행 상한)은 코드 상수와 다르게 넣는다. 판 번호는 9 → 10을 넣는다.
import type { Clock, PlatformLogger } from '@peaket/platform';
import { expect, test } from 'vitest';
import type { EventSchedules } from '../src/modules/entry/domain/ports.js';
import { type EventSchedule, QueueStoreUnavailable, saleEndOf } from '../src/modules/entry/domain/queue.js';
import { GetVerificationAppeal, ResolveVerificationAppeal } from '../src/modules/verification/application/appeals.js';
import { ReadVerification } from '../src/modules/verification/application/read-verification.js';
import { SubmitAppeal } from '../src/modules/verification/application/submit-appeal.js';
import { SubmitVerification } from '../src/modules/verification/application/submit-verification.js';
import { VerificationError } from '../src/modules/verification/application/verification-error.js';
import type { AppealResult, CaseRequestPublisher, HumanVerdict, ReverificationPort, ReverificationResult, SubmissionResult, VerificationRiskPort, VerificationSignals, VerificationStore } from '../src/modules/verification/domain/ports.js';
import { ReverificationUnavailable } from '../src/modules/verification/domain/ports.js';
import { APPEAL_KEEP_AFTER_SALE_END_MS, type CaseRequest, DEFAULT_VERIFICATION_OPTIONS, type VerificationOptions } from '../src/modules/verification/domain/verification.js';
import { ACCOUNT, DEVICE, JNY, newEvent, newRequest, openSchedule, PID } from './support.js';

export interface VerificationWorld {
  store: VerificationStore;
  schedules: EventSchedules & { set(eventId: string, s: EventSchedule): Promise<void> };
  clock: Clock;
  setDup(pid: string, eventId: string, value: string): Promise<void>;
  setVerify(eventId: string, hash: string, value: string): Promise<void>;
  verifyOf(eventId: string, hash: string): Promise<string | null>;
  setServing(eventId: string, serving: number): Promise<void>;
  /** serving_log 칸 하나(리더가 1초마다 쓰는 {초} → serving) */
  setServingLog(eventId: string, second: number, serving: number): Promise<void>;
  setLobbyResult(tokenHash: string, seq: number, gen: number): Promise<void>;
  /** q:appeal:{pid}:E의 칸(없으면 {}) */
  appealRaw(pid: string, eventId: string): Promise<Record<string, string>>;
  /** 시간을 민다(메모리는 가짜 시계, Valkey는 실제로 기다린다) */
  passTime(ms: number): Promise<void>;
  /** 제출 수 키 q:vsub:{pid}:E의 값(없으면 null) */
  vsubOf(pid: string, eventId: string): Promise<number | null>;
  /** 빠진 번호 비트(메모리 저장소는 그 키가 없어 늘 null) */
  setRemoved?(eventId: string, seq: number): Promise<void>;
  removedOf?(eventId: string, seq: number): Promise<boolean>;
}

/** 대기표 해시처럼 생긴 값(64자 16진) */
export const hashOf = (name: string): string => Buffer.from(name.padEnd(32, '.')).toString('hex').slice(0, 64);
/** q:dup의 번호 기록(진입 ③ RECORD의 모양): {번호}:{세대}:{요청 ID}:{jny}:{vr}:{대기표 해시} */
export const numberDup = (seq: number, ticketHash: string, vr = 'DEVICE_HISTORY') => `${seq}:1:${newRequest()}:${JNY}:${vr}:${ticketHash}`;
export const lobbyDup = (tokenHash: string) => `LOBBY:${tokenHash}:${newRequest()}`;
/** 시험 값(상수와 다르다): 유예 7분, 한도 3회, 창 1.2초, 발행 상한 150ms, 보관 3일 */
export const TEST_OPTIONS: VerificationOptions = { ...DEFAULT_VERIFICATION_OPTIONS, graceMs: 7 * 60_000, submitLimit: 3, submitWindowMs: 1_200, publishTimeoutMs: 150, appealKeepAfterSaleEndMs: 3 * 86_400_000 };
const PID2 = `${PID}-b`;
const OLD_PID = `${PID}-old`;

export function recordingReverification(result: ReverificationResult | (() => Promise<ReverificationResult>) = 'PASSED'): ReverificationPort & { calls: { accountId: string; pid: string; notBeforeMs: number }[] } {
  const calls: { accountId: string; pid: string; notBeforeMs: number }[] = [];
  return {
    calls,
    check: async (i) => {
      calls.push(i);
      return typeof result === 'function' ? result() : result;
    },
  };
}

/** 사람 확인 가짜. score는 가중합 판정(PREVERIFY)을 흉내 내 차단 목록 기기를 다시 걸리게 한다: 추가 검증 제출이 부르면 안 된다 */
export function recordingRisk(verdict: HumanVerdict | (() => Promise<HumanVerdict>) = 'ALLOW') {
  const calls: Parameters<VerificationRiskPort['verify']>[0][] = [];
  let scoreCalls = 0;
  return {
    calls,
    get scoreCalls() {
      return scoreCalls;
    },
    verify: async (i: Parameters<VerificationRiskPort['verify']>[0]) => {
      calls.push(i);
      return typeof verdict === 'function' ? verdict() : verdict;
    },
    score: async () => {
      scoreCalls++;
      return { kind: 'VERIFY' as const, reason: 'DEVICE_HISTORY' as const };
    },
  };
}

/** 건 요청 발행 가짜: ok 전달, fail 전달 없이 실패, lost 전달한 뒤 응답을 잃음(실패로 봄), slow 상한보다 늦게 전달, hang 끝나지 않음 */
export type PublishMode = 'ok' | 'fail' | 'lost' | 'slow' | 'hang';
export function recordingCases(mode: PublishMode | (() => PublishMode) = 'ok'): CaseRequestPublisher & { delivered: CaseRequest[]; attempts: number } {
  const out = {
    delivered: [] as CaseRequest[],
    attempts: 0,
    async publish(c: CaseRequest): Promise<void> {
      out.attempts++;
      const m = typeof mode === 'function' ? mode() : mode;
      if (m === 'fail') throw new Error('브로커가 받지 않았다');
      if (m === 'hang') return new Promise<void>(() => undefined);
      if (m === 'slow') {
        await new Promise((r) => setTimeout(r, 500));
        out.delivered.push(c);
        return;
      }
      out.delivered.push(c);
      if (m === 'lost') throw new Error('전달했는데 확인을 잃었다');
    },
  };
  return out;
}

export function recordingLogger() {
  const lines: { level: 'info' | 'warn'; fields: Record<string, unknown>; message: string }[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, message: string) => void lines.push({ level: 'info', fields, message }),
    warn: (fields: Record<string, unknown>, message: string) => void lines.push({ level: 'warn', fields, message }),
    error: () => undefined,
    debug: () => undefined,
  } as unknown as PlatformLogger;
  return { lines, logger };
}

export function recordingSignals(): VerificationSignals & { submissions: SubmissionResult[]; appeals: AppealResult[] } {
  const submissions: SubmissionResult[] = [];
  const appeals: AppealResult[] = [];
  return { submissions, appeals, submission: (r) => void submissions.push(r), appeal: (r) => void appeals.push(r) };
}

/** 저장소 메서드 몇 개를 바꾼 판(나머지는 원래 객체에 묶어 부른다: 비공개 칸을 그대로 쓴다) */
export function override(s: VerificationStore, over: Partial<VerificationStore>): VerificationStore {
  return new Proxy(s, {
    get(target, k) {
      if (k in over) return (over as Record<string | symbol, unknown>)[k];
      const f = Reflect.get(target, k) as unknown;
      return typeof f === 'function' ? (f as (...a: unknown[]) => unknown).bind(target) : f;
    },
  });
}

export const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof VerificationError) return e.code;
    if (e instanceof QueueStoreUnavailable) return 'STORE_DOWN';
    throw e;
  }
};

export function verificationCases(name: string, setup: () => Promise<VerificationWorld>): void {
  interface Ports {
    reverification?: ReverificationPort;
    risk?: VerificationRiskPort;
    cases?: CaseRequestPublisher;
    options?: Partial<VerificationOptions>;
    store?: (s: VerificationStore) => VerificationStore;
  }

  async function world(p: Ports = {}) {
    const w = await setup();
    const reverification = p.reverification ?? recordingReverification();
    const risk = p.risk ?? recordingRisk();
    const cases = p.cases ?? recordingCases();
    const options = { ...TEST_OPTIONS, ...p.options };
    const store = p.store ? p.store(w.store) : w.store;
    const signals = recordingSignals();
    const log = recordingLogger();
    const eventId = newEvent();
    const schedule = openSchedule(w.clock.now());
    await w.schedules.set(eventId, schedule);
    const submit = new SubmitVerification(store, w.schedules, reverification, risk, options, w.clock, signals, log.logger);
    const appeal = new SubmitAppeal(store, w.schedules, cases, options, w.clock, signals, log.logger);
    const read = new ReadVerification(store, w.schedules, options);
    const get = new GetVerificationAppeal(store);
    const resolve = new ResolveVerificationAppeal(store, w.clock, log.logger);
    /** 번호 기록과 VERIFYING 칸을 둔 대기 참여(시작 시각은 지금 − 1분) */
    const verifying = async (o: { pid?: string; seq?: number; ticket?: string; reason?: string; serving?: number } = {}) => {
      const ticket = o.ticket ?? hashOf(`t-${eventId}-${o.pid ?? PID}-${o.seq ?? 7}`);
      const startedAt = w.clock.now() - 60_000;
      await w.setDup(o.pid ?? PID, eventId, numberDup(o.seq ?? 7, ticket, o.reason ?? 'DEVICE_HISTORY'));
      await w.setVerify(eventId, ticket, `VERIFYING:${startedAt}:${o.reason ?? 'DEVICE_HISTORY'}`);
      if (o.serving !== undefined) await w.setServing(eventId, o.serving);
      return { ticket, startedAt };
    };
    const submitAs = (o: { pid?: string; pidPrev?: string; token?: string; deviceId?: string } = {}) =>
      submit.run({ eventId, accountId: ACCOUNT, pid: o.pid ?? PID, ...(o.pidPrev ? { pidPrev: o.pidPrev } : {}), challengeToken: o.token ?? 'verify-token', ...(o.deviceId !== undefined ? { deviceId: o.deviceId } : { deviceId: DEVICE }) });
    const appealAs = (text: string, o: { pid?: string; pidPrev?: string } = {}) => appeal.run({ eventId, accountId: ACCOUNT, pid: o.pid ?? PID, ...(o.pidPrev ? { pidPrev: o.pidPrev } : {}), text });
    return { w, eventId, schedule, store, reverification, risk, cases, options, signals, log, submit, appeal, read, get, resolve, verifying, submitAs, appealAs };
  }

  // ---------- 제출(challengeToken) ----------

  test(`${name}: B-T11 제출은 VERIFICATION 맥락으로만 부르고 차단 목록 기기도 챌린지와 재통과면 PASSED다`, async () => {
    const risk = recordingRisk('ALLOW');
    const rev = recordingReverification('PASSED');
    const x = await world({ risk, reverification: rev });
    const { ticket, startedAt } = await x.verifying({ seq: 40, serving: 10 });
    const r = await x.submitAs({ token: 'verify-ok' });
    expect(r).toEqual({ result: 'PASSED', queueNumber: 40, graceUntil: null });
    // 차단 목록을 다시 보는 가중합 판정(score)은 부르지 않고 사람 확인(verify)만 한 번 부른다
    expect(risk.scoreCalls).toBe(0);
    expect(risk.calls).toEqual([expect.objectContaining({ eventId: x.eventId, accountId: ACCOUNT, pid: PID, humanCheckToken: 'verify-ok', deviceId: DEVICE })]);
    // 재통과 확인은 추가 검증을 시작한 때(VERIFYING 시각) 뒤의 것을 묻는다
    expect(rev.calls).toEqual([{ accountId: ACCOUNT, pid: PID, notBeforeMs: startedAt }]);
    expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^PASSED:\d+:DEVICE_HISTORY$/);
    expect(x.signals.submissions).toEqual(['passed']);
  });

  test(`${name}: B-T11 통과 응답은 원래 번호를 싣고 차례가 지났을 때만 통과 시각 + 유예를 graceUntil로 싣는다(serving = 번호 경계)`, async () => {
    const x = await world();
    // 차례가 막 온 번호(serving = 번호): 유예 마감 = 통과 시각 + 시험 유예 7분
    const a = await x.verifying({ seq: 50, serving: 50 });
    const r = await x.submitAs();
    const passedAt = Number(/^PASSED:(\d+):/.exec((await x.w.verifyOf(x.eventId, a.ticket))!)![1]);
    expect(r).toEqual({ result: 'PASSED', queueNumber: 50, graceUntil: new Date(passedAt + TEST_OPTIONS.graceMs).toISOString() });
    // 차례 바로 전(serving = 번호 − 1): 원래 번호의 차례에 들어가므로 graceUntil은 null
    const y = await world();
    await y.verifying({ seq: 51, serving: 50 });
    expect(await y.submitAs()).toEqual({ result: 'PASSED', queueNumber: 51, graceUntil: null });
  });

  test(`${name}: B-T11 이미 통과한 참여에 다시 보낸 제출·이의의 graceUntil은 차례와 통과 가운데 늦은 때 + 유예다`, async () => {
    const x = await world();
    const { ticket } = await x.verifying({ seq: 50, serving: 40 });
    // 차례 전에 통과: graceUntil 없음
    expect(await x.submitAs()).toEqual({ result: 'PASSED', queueNumber: 50, graceUntil: null });
    const passedAt = Number(/^PASSED:(\d+):/.exec((await x.w.verifyOf(x.eventId, ticket))!)![1]);
    // 통과 2분 뒤 차례가 왔다(serving_log의 그 초 칸이 처음으로 번호 50 이상)
    const turnSec = Math.floor(passedAt / 1000) + 120;
    await x.w.setServingLog(x.eventId, turnSec - 1, 49);
    await x.w.setServingLog(x.eventId, turnSec, 52);
    await x.w.setServing(x.eventId, 55);
    const later = new Date(turnSec * 1000 + TEST_OPTIONS.graceMs).toISOString();
    expect(await x.submitAs()).toEqual({ result: 'PASSED', queueNumber: 50, graceUntil: later });
    expect(await x.appealAs('통과 뒤 이의')).toEqual({ kind: 'PASSED', result: 'PASSED', queueNumber: 50, graceUntil: later });
    // 차례가 통과보다 먼저였으면 통과 시각 + 유예
    const y = await world();
    const b = await y.verifying({ seq: 60, serving: 70 });
    await y.w.setServingLog(y.eventId, Math.floor(y.w.clock.now() / 1000) - 600, 61);
    const r = await y.submitAs();
    const passedB = Number(/^PASSED:(\d+):/.exec((await y.w.verifyOf(y.eventId, b.ticket))!)![1]);
    expect(r).toEqual({ result: 'PASSED', queueNumber: 60, graceUntil: new Date(passedB + TEST_OPTIONS.graceMs).toISOString() });
  });

  test(`${name}: B-T11 재통과가 없으면 trust-svc를 부르지 않고 REVERIFY_REQUIRED이고 다른 사람이면 PERSON_MISMATCH다`, async () => {
    const risk = recordingRisk('ALLOW');
    let answer: ReverificationResult = 'NOT_FOUND';
    const x = await world({ risk, reverification: recordingReverification(async () => answer) });
    const { ticket } = await x.verifying();
    expect(await x.submitAs()).toEqual({ result: 'REVERIFY_REQUIRED' });
    answer = 'PERSON_MISMATCH';
    expect(await x.submitAs()).toEqual({ result: 'PERSON_MISMATCH' });
    // 한 번 쓰기 사람 확인 토큰을 태우지 않았다
    expect(risk.calls).toHaveLength(0);
    expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^VERIFYING:/);
    expect(x.signals.submissions).toEqual(['reverify_required', 'person_mismatch']);
  });

  test(`${name}: B-T11 사람 확인이 실패하면 CHALLENGE_FAILED이고 verify 칸은 VERIFYING 그대로다`, async () => {
    const x = await world({ risk: recordingRisk('CHALLENGE') });
    const { ticket } = await x.verifying();
    expect(await x.submitAs()).toEqual({ result: 'CHALLENGE_FAILED' });
    expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^VERIFYING:/);
  });

  test(`${name}: B-T6 ④ trust-svc 서킷이 열리면 제출은 503이고 verify 칸은 VERIFYING 그대로다`, async () => {
    for (const verdict of ['UNAVAILABLE', 'HELD'] as const) {
      const x = await world({ risk: recordingRisk(verdict) });
      const { ticket } = await x.verifying();
      const err = await x.submitAs().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VerificationError);
      expect((err as VerificationError).code).toBe('UNAVAILABLE');
      expect((err as VerificationError).retryAfterSeconds).toBeGreaterThan(0);
      expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^VERIFYING:/);
      expect(x.signals.submissions).toEqual(['unavailable']);
    }
  });

  test(`${name}: I-T56 ④ identity-svc가 답하지 않으면 제출은 503이고 통과가 아니다`, async () => {
    const risk = recordingRisk('ALLOW');
    const x = await world({ risk, reverification: recordingReverification(() => Promise.reject(new ReverificationUnavailable('데드라인 넘김'))) });
    const { ticket } = await x.verifying();
    expect(await codeOf(x.submitAs())).toBe('UNAVAILABLE');
    // 재통과를 모르면 사람 확인도 부르지 않는다(토큰을 태우지 않는다)
    expect(risk.calls).toHaveLength(0);
    expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^VERIFYING:/);
  });

  test(`${name}: B-T11 PASSED 쓰기 뒤 응답을 잃어도 다시 보내면 같은 200 PASSED이고 identity·trust를 다시 부르지 않는다`, async () => {
    const risk = recordingRisk('ALLOW');
    const rev = recordingReverification('PASSED');
    let cut = 0;
    const x = await world({
      risk,
      reverification: rev,
      store: (s) =>
        override(s, {
          settleVerify: async (...a: Parameters<VerificationStore['settleVerify']>) => {
            const out = await s.settleVerify(...a);
            if (cut++ === 0) throw new QueueStoreUnavailable(new Error('쓰기 뒤 응답 유실'));
            return out;
          },
        }),
    });
    const { ticket } = await x.verifying({ seq: 9, serving: 20 });
    expect(await codeOf(x.submitAs())).toBe('STORE_DOWN');
    // 끊긴 자리가 쓰기 뒤다: 칸은 이미 PASSED다
    const written = await x.w.verifyOf(x.eventId, ticket);
    expect(written).toMatch(/^PASSED:\d+:DEVICE_HISTORY$/);
    const again = await x.submitAs();
    const passedAt = Number(/^PASSED:(\d+):/.exec(written!)![1]);
    expect(again).toEqual({ result: 'PASSED', queueNumber: 9, graceUntil: new Date(passedAt + TEST_OPTIONS.graceMs).toISOString() });
    expect(await x.w.verifyOf(x.eventId, ticket)).toBe(written);
    expect(rev.calls).toHaveLength(1);
    expect(risk.calls).toHaveLength(1);
  });

  test(`${name}: B-T11 B-T6 ④ 사람 확인 통과 뒤 PASSED 쓰기 전에 끊기면 503이고, 같은 토큰을 다시 보내면 CHALLENGE_FAILED이며 verify 칸은 VERIFYING 그대로다(새 토큰이어야 통과)`, async () => {
    // 사람 확인 토큰은 한 번 쓰기다: 같은 토큰의 두 번째 검증은 중복으로 실패한다(Turnstile timeout-or-duplicate)
    const used = new Set<string>();
    const risk = recordingRisk(async () => {
      const token = risk.calls.at(-1)!.humanCheckToken;
      if (used.has(token)) return 'CHALLENGE';
      used.add(token);
      return 'ALLOW';
    });
    let cut = 0;
    const x = await world({
      risk,
      store: (s) =>
        override(s, {
          // 첫 호출은 쓰기 전에 끊는다(연결 끊김)
          settleVerify: async (...a: Parameters<VerificationStore['settleVerify']>) => {
            if (cut++ === 0) throw new QueueStoreUnavailable(new Error('쓰기 전 끊김'));
            return s.settleVerify(...a);
          },
        }),
    });
    const { ticket } = await x.verifying();
    expect(await codeOf(x.submitAs({ token: 'tok-1' }))).toBe('STORE_DOWN');
    // 끊김이 실제로 있었고 그 자리는 쓰기 전이다: trust-svc는 ALLOW를 냈지만 칸은 VERIFYING이다
    expect(cut).toBe(1);
    expect(risk.calls).toHaveLength(1);
    expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^VERIFYING:/);
    // 같은 토큰을 다시 보내면 실패로 기록된다(화면은 503 뒤 위젯을 다시 돌린 새 토큰으로만 보낸다, ADR-0259 결정 12)
    expect(await x.submitAs({ token: 'tok-1' })).toEqual({ result: 'CHALLENGE_FAILED' });
    expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^VERIFYING:/);
    expect(await x.submitAs({ token: 'tok-2' })).toMatchObject({ result: 'PASSED' });
  });

  test(`${name}: [ASVS v5.0.0-2.3.1] 제출은 VERIFYING일 때만 받고 그 밖의 상태에서는 identity·trust를 부르지 않는다`, async () => {
    const risk = recordingRisk('ALLOW');
    const rev = recordingReverification('PASSED');
    const x = await world({ risk, reverification: rev });
    const t = hashOf(`t-${x.eventId}-blocked`);
    await x.w.setDup(PID, x.eventId, numberDup(3, t));
    await x.w.setVerify(x.eventId, t, `BLOCKED:${x.w.clock.now()}:NETWORK`);
    const blocked = await x.submitAs().catch((e: unknown) => e);
    expect((blocked as VerificationError).code).toBe('BLOCKED');
    // 주인 없는 자리·칸 없음은 409, 기록이 없으면 404
    await x.w.setVerify(x.eventId, t, `ORPHAN:${x.w.clock.now()}`);
    expect(await codeOf(x.submitAs())).toBe('NOT_VERIFYING');
    await x.w.setDup(PID, x.eventId, numberDup(3, hashOf('없는칸')));
    expect(await codeOf(x.submitAs())).toBe('NOT_VERIFYING');
    expect(await codeOf(x.submitAs({ pid: PID2 }))).toBe('ENTRY_NOT_FOUND');
    // 선점 값·취소 끝 표지는 대기 참여가 아니다
    await x.w.setDup(PID, x.eventId, `LEFT:${newRequest()}`);
    expect(await codeOf(x.submitAs())).toBe('ENTRY_NOT_FOUND');
    expect(rev.calls).toHaveLength(0);
    expect(risk.calls).toHaveLength(0);
  });

  test(`${name}: B-T11 판매 종료 뒤의 제출은 410 sale-ended이고 열리지 않은 회차는 404다`, async () => {
    const x = await world();
    await x.verifying();
    await x.w.schedules.set(x.eventId, { ...x.schedule, startsAtMs: x.w.clock.now() + 24 * 3600_000 - 1 });
    expect(await codeOf(x.submitAs())).toBe('SALE_ENDED');
    expect(await codeOf(x.submit.run({ eventId: newEvent(), accountId: ACCOUNT, pid: PID, challengeToken: 't' }))).toBe('NOT_FOUND');
  });

  test(`${name}: [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-2.4.1] 한 대기 참여의 challengeToken 제출은 trust-svc 검증을 부른 수로 창 안 한도까지이고 넘으면 429·Retry-After이며 창이 지나면 다시 받는다`, async () => {
    const risk = recordingRisk('CHALLENGE');
    const x = await world({ risk });
    await x.verifying();
    // 한도(시험 3회)까지는 받는다(사람 확인 실패도 trust-svc를 부른 제출이다)
    for (let i = 0; i < TEST_OPTIONS.submitLimit; i++) expect(await x.submitAs()).toEqual({ result: 'CHALLENGE_FAILED' });
    const over = await x.submitAs().catch((e: unknown) => e);
    expect((over as VerificationError).code).toBe('SUBMIT_LIMITED');
    expect((over as VerificationError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect((over as VerificationError).retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(TEST_OPTIONS.submitWindowMs / 1000));
    // 넘은 제출은 trust-svc를 부르지 않는다
    expect(risk.calls).toHaveLength(TEST_OPTIONS.submitLimit);
    expect(x.signals.submissions.at(-1)).toBe('rate_limited');
    // 다른 사람의 한도는 따로다
    await x.verifying({ pid: PID2, ticket: hashOf('pid2') });
    expect(await x.submitAs({ pid: PID2 })).toEqual({ result: 'CHALLENGE_FAILED' });
    // 창이 지나면 다시 받는다
    await x.w.passTime(TEST_OPTIONS.submitWindowMs + 200);
    expect(await x.submitAs()).toEqual({ result: 'CHALLENGE_FAILED' });
  });

  test(`${name}: [ASVS v5.0.0-2.3.2] B-T6 ④ 사람 확인 보류(HELD) 503도 제출 수에서 되돌려 한도 + 1번 뒤에도 복구되면 PASSED다`, async () => {
    let verdict: HumanVerdict = 'HELD';
    const x = await world({ risk: recordingRisk(async () => verdict) });
    const { ticket } = await x.verifying();
    for (let i = 0; i < TEST_OPTIONS.submitLimit + 1; i++) expect(await codeOf(x.submitAs())).toBe('UNAVAILABLE');
    verdict = 'ALLOW';
    expect(await x.submitAs()).toMatchObject({ result: 'PASSED' });
    expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^PASSED:/);
  });

  test(`${name}: [ASVS v5.0.0-2.3.2] 제출 수는 trust-svc를 부른 결과대로 센다: 답하지 않은 503·보류 503은 되돌려 0, 사람 확인 실패는 1씩 쌓인다`, async () => {
    let verdict: HumanVerdict = 'UNAVAILABLE';
    const x = await world({ risk: recordingRisk(async () => verdict) });
    await x.verifying();
    expect(await x.w.vsubOf(PID, x.eventId)).toBeNull();
    expect(await codeOf(x.submitAs())).toBe('UNAVAILABLE');
    expect(await x.w.vsubOf(PID, x.eventId)).toBe(0);
    verdict = 'HELD';
    expect(await codeOf(x.submitAs())).toBe('UNAVAILABLE');
    expect(await x.w.vsubOf(PID, x.eventId)).toBe(0);
    verdict = 'CHALLENGE';
    expect(await x.submitAs()).toEqual({ result: 'CHALLENGE_FAILED' });
    expect(await x.w.vsubOf(PID, x.eventId)).toBe(1);
    expect(await x.submitAs()).toEqual({ result: 'CHALLENGE_FAILED' });
    expect(await x.w.vsubOf(PID, x.eventId)).toBe(2);
    verdict = 'UNAVAILABLE';
    expect(await codeOf(x.submitAs())).toBe('UNAVAILABLE');
    expect(await x.w.vsubOf(PID, x.eventId)).toBe(2);
  });

  test(`${name}: [ASVS v5.0.0-2.3.2] 되돌려 0이 된 제출 수 키 뒤의 제출은 창을 다시 열지 않아 429의 Retry-After가 첫 제출에 정한 마감까지다`, async () => {
    let verdict: HumanVerdict = 'UNAVAILABLE';
    // 시험 창 2.5초(코드 상수 10분, 다른 시험의 1.2초와 다르다)
    const x = await world({ risk: recordingRisk(async () => verdict), options: { submitWindowMs: 2_500 } });
    await x.verifying();
    // 첫 제출이 키를 만들고(마감 = 지금 + 2.5초) trust-svc가 답하지 않아 0으로 되돌린다
    expect(await codeOf(x.submitAs())).toBe('UNAVAILABLE');
    expect(await x.w.vsubOf(PID, x.eventId)).toBe(0);
    await x.w.passTime(1_600);
    verdict = 'CHALLENGE';
    for (let i = 0; i < TEST_OPTIONS.submitLimit; i++) expect(await x.submitAs()).toEqual({ result: 'CHALLENGE_FAILED' });
    const over = await x.submitAs().catch((e: unknown) => e);
    expect((over as VerificationError).code).toBe('SUBMIT_LIMITED');
    // 남은 시간은 첫 마감까지 약 0.9초다(0에서 다시 센 때부터 2.5초를 새로 열었다면 3초다)
    expect((over as VerificationError).retryAfterSeconds).toBe(1);
    // 첫 마감이 지나면 다시 받는다
    await x.w.passTime(1_100);
    expect(await x.submitAs()).toEqual({ result: 'CHALLENGE_FAILED' });
  });

  test(`${name}: [ASVS v5.0.0-2.3.2] B-T6 ④ trust-svc를 부르지 못한 503은 제출 수에서 되돌려 한도 + 1번 뒤에도 복구되면 PASSED다`, async () => {
    let verdict: HumanVerdict = 'UNAVAILABLE';
    const x = await world({ risk: recordingRisk(async () => verdict) });
    const { ticket } = await x.verifying();
    for (let i = 0; i < TEST_OPTIONS.submitLimit + 1; i++) expect(await codeOf(x.submitAs())).toBe('UNAVAILABLE');
    verdict = 'ALLOW';
    expect(await x.submitAs()).toMatchObject({ result: 'PASSED' });
    expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^PASSED:/);
  });

  test(`${name}: [ASVS v5.0.0-2.3.2] I-T56 ④ identity-svc 무응답 503과 재통과 없음·다른 사람은 제출 수에 세지 않아 한도 번 뒤에도 복구되면 429가 아니다`, async () => {
    let answer: ReverificationResult | 'DOWN' = 'DOWN';
    const risk = recordingRisk('ALLOW');
    const x = await world({ risk, reverification: recordingReverification(async () => (answer === 'DOWN' ? Promise.reject(new ReverificationUnavailable('멈춤')) : answer)) });
    await x.verifying();
    for (let i = 0; i < TEST_OPTIONS.submitLimit; i++) expect(await codeOf(x.submitAs())).toBe('UNAVAILABLE');
    answer = 'NOT_FOUND';
    for (let i = 0; i < TEST_OPTIONS.submitLimit; i++) expect(await x.submitAs()).toEqual({ result: 'REVERIFY_REQUIRED' });
    answer = 'PERSON_MISMATCH';
    for (let i = 0; i < TEST_OPTIONS.submitLimit; i++) expect(await x.submitAs()).toEqual({ result: 'PERSON_MISMATCH' });
    answer = 'PASSED';
    expect(await x.submitAs()).toMatchObject({ result: 'PASSED' });
    expect(risk.calls).toHaveLength(1);
  });

  test(`${name}: B-T11 대기 참여는 요청한 사람의 q:dup으로만 찾아 다른 pid의 대기 참여를 PASSED로 바꾸지 못한다`, async () => {
    const x = await world();
    const a = await x.verifying({ pid: PID });
    expect(await codeOf(x.submitAs({ pid: PID2 }))).toBe('ENTRY_NOT_FOUND');
    expect(await codeOf(x.appealAs('남의 것', { pid: PID2 }))).toBe('ENTRY_NOT_FOUND');
    expect(await x.w.verifyOf(x.eventId, a.ticket)).toMatch(/^VERIFYING:/);
    expect(await x.w.appealRaw(PID, x.eventId)).toEqual({});
    expect(await x.w.appealRaw(PID2, x.eventId)).toEqual({});
  });

  test(`${name}: B-T11 pid 키 전환 기간에는 옛 pid의 기록으로 찾아 통과시킨다`, async () => {
    const rev = recordingReverification('PASSED');
    const x = await world({ reverification: rev });
    const { ticket } = await x.verifying({ pid: OLD_PID });
    expect(await x.submitAs({ pid: PID, pidPrev: OLD_PID })).toMatchObject({ result: 'PASSED' });
    expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^PASSED:/);
    // 재통과는 지금 pid로 묻는다
    expect(rev.calls[0]!.pid).toBe(PID);
  });

  test(`${name}: B-T11 로비 참가자는 참가 토큰 해시 칸으로 통과하고 셔플 결과가 있으면 원래 번호를 싣는다`, async () => {
    const x = await world();
    const token = hashOf(`lobby-${x.eventId}`);
    await x.w.setDup(PID, x.eventId, lobbyDup(token));
    await x.w.setVerify(x.eventId, token, `VERIFYING:${x.w.clock.now() - 1_000}:INTERACTION`);
    // 게시 전: 번호가 없다
    expect(await x.submitAs()).toEqual({ result: 'PASSED', graceUntil: null });
    expect(await x.w.verifyOf(x.eventId, token)).toMatch(/^PASSED:\d+:INTERACTION$/);
    // 게시 뒤 다시 보내면 원래 번호를 싣는다
    await x.w.setLobbyResult(token, 12, 1);
    await x.w.setServing(x.eventId, 11);
    expect(await x.submitAs()).toEqual({ result: 'PASSED', queueNumber: 12, graceUntil: null });
  });

  test(`${name}: B-T10 ④ 제출 확인 사이에 기각되면 PASSED로 덮지 않고 410 BLOCKED다`, async () => {
    let w: VerificationWorld | undefined;
    let target: { eventId: string; ticket: string } | undefined;
    const risk = recordingRisk(async () => {
      // 사람 확인을 기다리는 사이 CS가 기각했다(경합 ①)
      await w!.setVerify(target!.eventId, target!.ticket, `BLOCKED:${w!.clock.now()}:DEVICE_HISTORY`);
      return 'ALLOW';
    });
    const x = await world({ risk });
    w = x.w;
    const { ticket } = await x.verifying();
    target = { eventId: x.eventId, ticket };
    expect(await codeOf(x.submitAs())).toBe('BLOCKED');
    expect(await x.w.verifyOf(x.eventId, ticket)).toMatch(/^BLOCKED:/);
  });

  test(`${name}: B-T11 PASSED는 빠진 번호 비트를 끄지 않는다`, async () => {
    const x = await world();
    if (!x.w.setRemoved || !x.w.removedOf) return;
    await x.verifying({ seq: 21 });
    await x.w.setRemoved(x.eventId, 21);
    expect(await x.submitAs()).toMatchObject({ result: 'PASSED' });
    expect(await x.w.removedOf(x.eventId, 21)).toBe(true);
  });

  // ---------- 이의 접수 ----------

  test(`${name}: B-T10 ① 이의는 202이고 건 요청이 한 건 나가며 같은 요청을 다시 보내도 같은 eventKey 하나다`, async () => {
    const cases = recordingCases('ok');
    const x = await world({ cases });
    await x.verifying({ reason: 'DEVICE_HISTORY' });
    const first = await x.appealAs('사람입니다');
    expect(first).toMatchObject({ kind: 'RECEIVED', appealId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const again = await x.appealAs('다른 글로 다시');
    expect(again).toEqual(first);
    expect(cases.delivered).toHaveLength(1);
    const raw = await x.w.appealRaw(PID, x.eventId);
    expect(cases.delivered[0]).toEqual({ eventKey: raw.ek, sourceId: (first as { appealId: string }).appealId, category: 'REASON_CATEGORY_DEVICE_HISTORY', createdAtMs: Number(raw.at) });
    // 처음 글이 남는다(덮어쓰지 않는다)
    expect(raw).toMatchObject({ txt: '사람입니다', sent: '1', acc: ACCOUNT });
    expect(x.signals.appeals).toEqual(['accepted', 'duplicate']);
  });

  test(`${name}: B-T10 ② 발행이 실패하면 503·Retry-After이고 다시 보내면 같은 eventKey로 나간다`, async () => {
    for (const failure of ['fail', 'lost'] as const) {
      let mode: PublishMode = failure;
      const cases = recordingCases(() => mode);
      const x = await world({ cases });
      await x.verifying();
      const err = await x.appealAs('재검토 바랍니다').catch((e: unknown) => e);
      expect((err as VerificationError).code).toBe('PUBLISH_FAILED');
      expect((err as VerificationError).retryAfterSeconds).toBeGreaterThan(0);
      // 끊긴 자리가 HSETNX 뒤다: 이의 ID·eventKey·글은 이미 있고 보낸 표시는 없다
      const kept = await x.w.appealRaw(PID, x.eventId);
      expect(kept).toMatchObject({ txt: '재검토 바랍니다' });
      expect(kept.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(kept.sent).toBeUndefined();
      // 보낸 표시가 없으므로 상태 읽기는 아직 '접수'가 아니다
      expect((await x.read.run({ eventId: x.eventId, pid: PID })).appeal).toBeNull();
      mode = 'ok';
      const again = await x.appealAs('바꾼 글');
      expect(again).toMatchObject({ kind: 'RECEIVED', appealId: kept.id });
      // 잃은 확인의 첫 사건과 다시 보낸 사건이 같은 eventKey다(ops-svc가 중복을 지운다)
      expect(new Set(cases.delivered.map((c) => c.eventKey))).toEqual(new Set([kept.ek]));
      expect(cases.delivered.every((c) => c.sourceId === kept.id)).toBe(true);
      expect(cases.delivered.length).toBe(failure === 'fail' ? 1 : 2);
      expect(await x.w.appealRaw(PID, x.eventId)).toMatchObject({ sent: '1', txt: '재검토 바랍니다', ek: kept.ek });
      expect(x.signals.appeals).toEqual(['publish_failed', 'accepted']);
    }
  });

  test(`${name}: B-T10 ② 2초 상한을 넘어 늦게 성공한 발행도 보낸 표시를 남기고, 그 사이 다시 보낸 요청은 진행 중인 발행을 기다려 새로 내지 않는다`, async () => {
    const cases = recordingCases('slow');
    const x = await world({ cases });
    await x.verifying();
    // 첫 요청: 상한(시험 150ms) 안에 확인이 오지 않아 503
    expect(await codeOf(x.appealAs('늦은 발행'))).toBe('PUBLISH_FAILED');
    // 첫 발행이 아직 진행 중일 때 다시 보낸 요청: 새로 내지 않고 그 발행을 기다리다 상한에 503
    expect(await codeOf(x.appealAs('늦은 발행'))).toBe('PUBLISH_FAILED');
    expect(cases.attempts).toBe(1);
    // 첫 발행이 늦게 전달되면 보낸 표시가 남는다
    await new Promise((r) => setTimeout(r, 600));
    expect(cases.delivered).toHaveLength(1);
    expect((await x.w.appealRaw(PID, x.eventId)).sent).toBe('1');
    // 세 번째 보내기는 202이고 새 발행이 없다
    const third = await x.appealAs('늦은 발행');
    expect(third).toMatchObject({ kind: 'RECEIVED', appealId: cases.delivered[0]!.sourceId });
    expect(cases.attempts).toBe(1);
    expect((await x.read.run({ eventId: x.eventId, pid: PID })).appeal).toMatchObject({ appealId: cases.delivered[0]!.sourceId });
    // 접수는 늦게 성공한 발행이 보낸 표시를 남길 때 한 번 센다(503 둘, 접수 하나, 세 번째 요청은 중복)
    expect(x.signals.appeals).toEqual(['publish_failed', 'publish_failed', 'accepted', 'duplicate']);
    const accepted = x.log.lines.filter((l) => l.fields.event === 'queue_verification_appeal' && l.fields.result === 'accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.fields).toMatchObject({ eventId: x.eventId, appealId: cases.delivered[0]!.sourceId });
  });

  test(`${name}: B-T10 ① 상한 안에 확인된 발행의 접수는 한 번만 세고 기다리기만 한 겹친 요청은 중복이다`, async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const delivered: CaseRequest[] = [];
    const cases: CaseRequestPublisher = {
      publish: async (c) => {
        await gate;
        delivered.push(c);
      },
    };
    const x = await world({ cases, options: { publishTimeoutMs: 1_000 } });
    await x.verifying();
    const a = x.appealAs('첫째');
    const b = x.appealAs('둘째');
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(delivered).toHaveLength(1);
    expect(x.signals.appeals.filter((r) => r === 'accepted')).toHaveLength(1);
    expect(x.signals.appeals.filter((r) => r === 'duplicate')).toHaveLength(1);
    expect(x.signals.appeals).toHaveLength(2);
  });

  test(`${name}: B-T10 ② 같은 이의의 진행 중인 발행은 파드 안에서 하나로 묶여 끝나지 않는 발행기에 동시에 여러 번 보내도 발행은 한 번이다`, async () => {
    const cases = recordingCases('hang');
    const x = await world({ cases });
    await x.verifying();
    const codes = await Promise.all([1, 2, 3, 4].map(() => codeOf(x.appealAs('겹친 요청'))));
    expect(codes).toEqual(['PUBLISH_FAILED', 'PUBLISH_FAILED', 'PUBLISH_FAILED', 'PUBLISH_FAILED']);
    expect(cases.attempts).toBe(1);
    // 뒤이어 다시 보내도 진행 중인 그 발행을 기다린다
    expect(await codeOf(x.appealAs('겹친 요청'))).toBe('PUBLISH_FAILED');
    expect(cases.attempts).toBe(1);
  });

  test(`${name}: B-T10 ① 같은 사람의 이의 두 요청이 겹쳐도 처음 것 하나만 남고 둘 다 같은 202다`, async () => {
    const cases = recordingCases('ok');
    const x = await world({ cases });
    await x.verifying();
    const [a, b] = await Promise.all([x.appealAs('첫째'), x.appealAs('둘째')]);
    expect(a).toEqual(b);
    const raw = await x.w.appealRaw(PID, x.eventId);
    expect(raw.id).toBe((a as { appealId: string }).appealId);
    expect(['첫째', '둘째']).toContain(raw.txt);
    expect(new Set(cases.delivered.map((c) => c.eventKey))).toEqual(new Set([raw.ek]));
    // 접수는 하나로 센다
    expect(x.signals.appeals.filter((r) => r === 'accepted')).toHaveLength(1);
  });

  test(`${name}: B-T10 ① pid 키 전환 기간에는 옛 pid에 둔 이의를 다시 쓰고 새 이의를 만들지 않는다`, async () => {
    const cases = recordingCases('ok');
    const x = await world({ cases });
    await x.verifying({ pid: OLD_PID });
    const first = await x.appealAs('옛 pid로 보냄', { pid: OLD_PID });
    const again = await x.appealAs('전환 중 다시', { pid: PID, pidPrev: OLD_PID });
    expect(again).toEqual(first);
    expect(await x.w.appealRaw(PID, x.eventId)).toEqual({});
    expect(cases.delivered).toHaveLength(1);
  });

  test(`${name}: B-T6 ④ trust-svc·identity-svc가 멈춰도 이의는 202다`, async () => {
    const risk = recordingRisk('UNAVAILABLE');
    const rev = recordingReverification(() => Promise.reject(new ReverificationUnavailable('멈춤')));
    const x = await world({ risk, reverification: rev });
    await x.verifying();
    expect(await x.appealAs('')).toMatchObject({ kind: 'RECEIVED' });
    expect(risk.calls).toHaveLength(0);
    expect(rev.calls).toHaveLength(0);
  });

  test(`${name}: [ASVS v5.0.0-2.2.1] 이의 글은 NFC로 정규화해 두고 합친 글자 1,000자까지 받는다`, async () => {
    const x = await world();
    await x.verifying();
    // 분해된 한글(자모 셋 = 한 글자) 1,000자는 UTF-16으로 3,000 단위지만 1,000자다
    const nfd = '한'.normalize('NFD').repeat(1_000);
    expect(nfd.length).toBe(3_000);
    expect(await x.appealAs(nfd)).toMatchObject({ kind: 'RECEIVED' });
    expect((await x.w.appealRaw(PID, x.eventId)).txt).toBe('한'.repeat(1_000));
    const y = await world();
    await y.verifying();
    expect(await codeOf(y.appealAs(`${'가'.repeat(1_000)}a`))).toBe('INVALID');
    expect(await y.w.appealRaw(PID, y.eventId)).toEqual({});
  });

  test(`${name}: [ASVS v5.0.0-2.2.1] 이의 글에 양방향 제어·0폭·NUL 글자가 있으면 INVALID이고 이의를 두지 않는다`, async () => {
    const x = await world();
    await x.verifying();
    for (const bad of ['안\u202E녕', '안\u200B녕', '안\u0000녕', '\uFEFF안녕', '안\u2069녕']) expect(await codeOf(x.appealAs(bad))).toBe('INVALID');
    expect(await x.w.appealRaw(PID, x.eventId)).toEqual({});
  });

  test(`${name}: B-T10 ① 이미 통과한 대기 참여의 이의는 200 PASSED이고 기각된 것은 410, 추가 검증 중이 아니면 409다`, async () => {
    const cases = recordingCases('ok');
    const x = await world({ cases });
    const { ticket } = await x.verifying({ seq: 4, serving: 3 });
    await x.w.setVerify(x.eventId, ticket, `PASSED:${x.w.clock.now()}:DEVICE_HISTORY`);
    expect(await x.appealAs('통과 뒤')).toEqual({ kind: 'PASSED', result: 'PASSED', queueNumber: 4, graceUntil: null });
    await x.w.setVerify(x.eventId, ticket, `BLOCKED:${x.w.clock.now()}:DEVICE_HISTORY`);
    expect(await codeOf(x.appealAs('기각 뒤'))).toBe('BLOCKED');
    await x.w.setVerify(x.eventId, ticket, `ORPHAN:${x.w.clock.now()}`);
    expect(await codeOf(x.appealAs('주인 없음'))).toBe('NOT_VERIFYING');
    expect(cases.delivered).toHaveLength(0);
  });

  test(`${name}: B-T10 ① 취소 뒤 다시 줄 선 대기 참여는 지난 이의 대신 새 이의를 받는다`, async () => {
    const cases = recordingCases('ok');
    const x = await world({ cases });
    await x.verifying({ seq: 5, ticket: hashOf('old-entry') });
    const old = await x.appealAs('지난 참여');
    await x.verifying({ seq: 90, ticket: hashOf('new-entry') });
    const fresh = await x.appealAs('새 참여');
    expect((fresh as { appealId: string }).appealId).not.toBe((old as { appealId: string }).appealId);
    expect(await x.w.appealRaw(PID, x.eventId)).toMatchObject({ th: hashOf('new-entry'), txt: '새 참여' });
    expect(cases.delivered).toHaveLength(2);
  });

  test(`${name}: B-T10 ① 이의 키·색인의 수명은 판매 종료 + 보관 기간이다`, async () => {
    const x = await world();
    await x.verifying();
    const r = (await x.appealAs('수명')) as { appealId: string };
    const raw = await x.w.appealRaw(PID, x.eventId);
    expect(Number(raw.exp)).toBe(saleEndOf(x.schedule) + TEST_OPTIONS.appealKeepAfterSaleEndMs);
    expect(TEST_OPTIONS.appealKeepAfterSaleEndMs).not.toBe(APPEAL_KEEP_AFTER_SALE_END_MS);
    expect(await x.store.findAppeal(r.appealId)).toEqual({ eventId: x.eventId, pid: PID });
  });

  // ---------- 상태 읽기 ----------

  test(`${name}: B-T10 ① 상태 읽기는 사유 범주와 발행이 확인된 이의를 주고 아무것도 바꾸지 않는다`, async () => {
    const risk = recordingRisk('ALLOW');
    const x = await world({ risk });
    const { ticket } = await x.verifying({ reason: 'NETWORK' });
    expect(await x.read.run({ eventId: x.eventId, pid: PID })).toEqual({ state: 'VERIFYING', passedVia: null, graceUntil: null, verificationReason: 'NETWORK', appeal: null });
    const a = (await x.appealAs('읽기')) as { appealId: string; receivedAt: string };
    expect(await x.read.run({ eventId: x.eventId, pid: PID })).toEqual({ state: 'VERIFYING', passedVia: null, graceUntil: null, verificationReason: 'NETWORK', appeal: { appealId: a.appealId, receivedAt: a.receivedAt, text: '읽기' } });
    await x.w.setVerify(x.eventId, ticket, `BLOCKED:${x.w.clock.now()}:NETWORK`);
    expect((await x.read.run({ eventId: x.eventId, pid: PID })).state).toBe('BLOCKED');
    expect(await codeOf(x.read.run({ eventId: x.eventId, pid: PID2 }))).toBe('ENTRY_NOT_FOUND');
    expect(risk.calls).toHaveLength(0);
  });

  // ---------- 이의 내용 읽기·결과 반영(gRPC 유스케이스) ----------

  async function appealed(p: Ports = {}) {
    const x = await world(p);
    const v = await x.verifying({ seq: 33, serving: 10, reason: 'DEVICE_HISTORY' });
    const r = (await x.appealAs('사람입니다')) as { appealId: string; receivedAt: string };
    /** 건 ID(실제 Valkey를 시험끼리 나눠 쓰므로 회차마다 다르게) */
    const caseOf = (tag: string) => `${tag}-${x.eventId}`;
    return { ...x, ...v, appealId: r.appealId, receivedAt: r.receivedAt, caseOf };
  }

  test(`${name}: B-T10 ① 이의 내용 읽기는 글·사유 범주·접수 시각·지금 상태를 주고 없으면 NOT_FOUND다`, async () => {
    const x = await appealed();
    expect(await x.get.run(x.appealId)).toEqual({
      appealId: x.appealId,
      eventId: x.eventId,
      accountId: ACCOUNT,
      pid: PID,
      text: '사람입니다',
      reasonCategory: 'REASON_CATEGORY_DEVICE_HISTORY',
      receivedAtMs: Date.parse(x.receivedAt),
      entryState: 'VERIFYING',
    });
    expect(await codeOf(x.get.run('0190f3a1-7c2e-7a00-8000-0000000000ff'))).toBe('APPEAL_NOT_FOUND');
    expect(await codeOf(x.get.run('not-a-uuid'))).toBe('INVALID');
  });

  test(`${name}: B-T10 ③ 상태 읽기는 인정으로 통과하면 passedVia APPEAL, 제출로 통과하면 CHALLENGE이고 유예 마감·본인이 보낸 이의 글을 준다`, async () => {
    const x = await appealed();
    const before = await x.read.run({ eventId: x.eventId, pid: PID });
    expect(before).toEqual({ state: 'VERIFYING', passedVia: null, graceUntil: null, verificationReason: 'DEVICE_HISTORY', appeal: { appealId: x.appealId, receivedAt: x.receivedAt, text: '사람입니다' } });
    expect(await x.resolve.run({ appealId: x.appealId, caseId: x.caseOf('case-v'), caseVersion: 1, outcome: 'ACCEPTED' })).toBe('APPLIED');
    // 차례 전 통과(번호 33, serving 10): 유예 마감 없음
    expect(await x.read.run({ eventId: x.eventId, pid: PID })).toMatchObject({ state: 'PASSED', passedVia: 'APPEAL', graceUntil: null });
    // 통과 1분 뒤 차례가 왔다: 차례 + 유예
    const passedAt = Number(/^PASSED:(\d+):/.exec((await x.w.verifyOf(x.eventId, x.ticket))!)![1]);
    const turnSec = Math.floor(passedAt / 1000) + 60;
    await x.w.setServingLog(x.eventId, turnSec, 35);
    await x.w.setServing(x.eventId, 40);
    expect(await x.read.run({ eventId: x.eventId, pid: PID })).toMatchObject({ state: 'PASSED', passedVia: 'APPEAL', graceUntil: new Date(turnSec * 1000 + TEST_OPTIONS.graceMs).toISOString() });
    // 제출로 먼저 통과한 뒤 온 인정(NOT_ISOLATED)은 통과 경로를 바꾸지 않는다
    const y = await appealed();
    expect(await y.submitAs()).toMatchObject({ result: 'PASSED' });
    expect(await y.resolve.run({ appealId: y.appealId, caseId: y.caseOf('case-v'), caseVersion: 1, outcome: 'ACCEPTED' })).toBe('NOT_ISOLATED');
    expect(await y.read.run({ eventId: y.eventId, pid: PID })).toMatchObject({ state: 'PASSED', passedVia: 'CHALLENGE' });
    // 기각이면 통과 경로가 없다
    const z = await appealed();
    await z.resolve.run({ appealId: z.appealId, caseId: z.caseOf('case-v'), caseVersion: 1, outcome: 'REJECTED' });
    expect(await z.read.run({ eventId: z.eventId, pid: PID })).toMatchObject({ state: 'BLOCKED', passedVia: null, graceUntil: null });
  });

  test(`${name}: B-T11 상태 읽기는 대기 참여가 있는데 추가 검증 칸이 없으면 NOT_VERIFYING이고 대기 참여가 없을 때만 ENTRY_NOT_FOUND다`, async () => {
    const x = await world();
    const { ticket } = await x.verifying();
    await x.w.setVerify(x.eventId, ticket, `ORPHAN:${x.w.clock.now()}`);
    expect(await codeOf(x.read.run({ eventId: x.eventId, pid: PID }))).toBe('NOT_VERIFYING');
    await x.w.setDup(PID, x.eventId, numberDup(7, hashOf('칸없음')));
    expect(await codeOf(x.read.run({ eventId: x.eventId, pid: PID }))).toBe('NOT_VERIFYING');
    expect(await codeOf(x.read.run({ eventId: x.eventId, pid: PID2 }))).toBe('ENTRY_NOT_FOUND');
  });

  test(`${name}: B-T10 ③ 인정은 VERIFYING일 때만 PASSED로 바꾸고 이의 상태는 PASSED가 된다`, async () => {
    const x = await appealed();
    expect(await x.resolve.run({ appealId: x.appealId, caseId: x.caseOf('case-1'), caseVersion: 1, outcome: 'ACCEPTED' })).toBe('APPLIED');
    expect(await x.w.verifyOf(x.eventId, x.ticket)).toMatch(/^PASSED:\d+:DEVICE_HISTORY$/);
    expect((await x.get.run(x.appealId)).entryState).toBe('PASSED');
    // 통과한 대기 참여의 제출은 200 PASSED다(차례 전이라 graceUntil null)
    expect(await x.submitAs()).toEqual({ result: 'PASSED', queueNumber: 33, graceUntil: null });
  });

  test(`${name}: B-T10 ④ 기각하면 BLOCKED로 끝나고 라벨 호출이 없다`, async () => {
    const risk = recordingRisk('ALLOW');
    const x = await appealed({ risk });
    if (x.w.setRemoved) await x.w.setRemoved(x.eventId, 33);
    expect(await x.resolve.run({ appealId: x.appealId, caseId: x.caseOf('case-r'), caseVersion: 1, outcome: 'REJECTED' })).toBe('APPLIED');
    expect(await x.w.verifyOf(x.eventId, x.ticket)).toMatch(/^BLOCKED:\d+:DEVICE_HISTORY$/);
    if (x.w.removedOf) expect(await x.w.removedOf(x.eventId, 33)).toBe(true);
    expect((await x.get.run(x.appealId)).entryState).toBe('ENDED');
    expect((await x.read.run({ eventId: x.eventId, pid: PID })).state).toBe('BLOCKED');
    expect(await codeOf(x.submitAs())).toBe('BLOCKED');
    // queue-svc는 trust-svc를 부르지 않는다(라벨 반영은 인정 때 ops-svc가 따로 부른다)
    expect(risk.calls).toHaveLength(0);
    expect(risk.scoreCalls).toBe(0);
  });

  test(`${name}: B-T10 ④ 이미 PASSED·BLOCKED인 대기 참여는 결과 반영이 바꾸지 않고 NOT_ISOLATED다`, async () => {
    const x = await appealed();
    // 이의 결과를 기다리는 사이 제출로 통과했다
    expect(await x.submitAs()).toMatchObject({ result: 'PASSED' });
    const passed = await x.w.verifyOf(x.eventId, x.ticket);
    expect(await x.resolve.run({ appealId: x.appealId, caseId: x.caseOf('case-2'), caseVersion: 1, outcome: 'REJECTED' })).toBe('NOT_ISOLATED');
    expect(await x.w.verifyOf(x.eventId, x.ticket)).toBe(passed);
    const y = await appealed();
    expect(await y.resolve.run({ appealId: y.appealId, caseId: y.caseOf('case-3'), caseVersion: 1, outcome: 'REJECTED' })).toBe('APPLIED');
    const blocked = await y.w.verifyOf(y.eventId, y.ticket);
    expect(await y.resolve.run({ appealId: y.appealId, caseId: y.caseOf('case-3'), caseVersion: 2, outcome: 'ACCEPTED' })).toBe('NOT_ISOLATED');
    expect(await y.w.verifyOf(y.eventId, y.ticket)).toBe(blocked);
  });

  test(`${name}: B-T10 ⑤ 같은 건 ID·판을 두 번 부르면 한 번만 반영되고 작은 판은 UNCHANGED·다른 이의 ID는 ALREADY_EXISTS다`, async () => {
    const x = await appealed();
    const caseId = x.caseOf('case-9');
    const r = (v: number, o: 'ACCEPTED' | 'REJECTED' = 'ACCEPTED') => x.resolve.run({ appealId: x.appealId, caseId, caseVersion: v, outcome: o });
    expect(await r(9)).toBe('APPLIED');
    const after9 = await x.w.verifyOf(x.eventId, x.ticket);
    expect(after9).toMatch(/^PASSED:/);
    expect(await r(9)).toBe('UNCHANGED');
    expect(await r(8, 'REJECTED')).toBe('UNCHANGED');
    // 판은 숫자로 견준다(10 > 9). 이미 PASSED라 바꿀 것이 없다
    expect(await r(10, 'REJECTED')).toBe('NOT_ISOLATED');
    expect(await r(10, 'REJECTED')).toBe('UNCHANGED');
    expect(await x.w.verifyOf(x.eventId, x.ticket)).toBe(after9);
    expect(await x.w.appealRaw(PID, x.eventId)).toMatchObject({ cid: caseId, cv: '10', res: 'NOT_ISOLATED' });
    // 이 이의는 이 건에 묶였다: 다른 건 ID로 오면 ALREADY_EXISTS
    expect(await codeOf(x.resolve.run({ appealId: x.appealId, caseId: x.caseOf('case-x'), caseVersion: 11, outcome: 'ACCEPTED' }))).toBe('CASE_CONFLICT');
    expect((await x.w.appealRaw(PID, x.eventId)).cv).toBe('10');
  });

  test(`${name}: B-T10 ⑤ 같은 건 ID에 다른 이의 ID가 오면 ALREADY_EXISTS이고 아무것도 바꾸지 않는다`, async () => {
    const x = await appealed();
    const caseId = `case-${x.eventId}`;
    expect(await x.resolve.run({ appealId: x.appealId, caseId, caseVersion: 1, outcome: 'ACCEPTED' })).toBe('APPLIED');
    // 다른 사람의 다른 이의(같은 회차)
    const t2 = hashOf(`other-${x.eventId}`);
    await x.w.setDup(PID2, x.eventId, numberDup(34, t2));
    await x.w.setVerify(x.eventId, t2, `VERIFYING:${x.w.clock.now()}:NETWORK`);
    const b = (await x.appealAs('다른 이의', { pid: PID2 })) as { appealId: string };
    expect(await codeOf(x.resolve.run({ appealId: b.appealId, caseId, caseVersion: 2, outcome: 'REJECTED' }))).toBe('CASE_CONFLICT');
    expect(await x.w.verifyOf(x.eventId, t2)).toMatch(/^VERIFYING:/);
    expect((await x.w.appealRaw(PID2, x.eventId)).cv).toBeUndefined();
  });

  test(`${name}: B-T10 ⑤ 결과 반영의 회차 쓰기 뒤 판 쓰기 전에 끊겨도 다시 부르면 같은 결과(APPLIED)이고 한 번만 바뀐다`, async () => {
    let cut = 0;
    const x = await appealed({
      store: (s) =>
        override(s, {
          commitResolve: async (...a: Parameters<VerificationStore['commitResolve']>) => {
            if (cut++ === 0) throw new QueueStoreUnavailable(new Error('판 쓰기 전 끊김'));
            return s.commitResolve(...a);
          },
        }),
    });
    const call = () => x.resolve.run({ appealId: x.appealId, caseId: x.caseOf('case-c'), caseVersion: 10, outcome: 'ACCEPTED' });
    expect(await codeOf(call())).toBe('STORE_DOWN');
    // 끊긴 자리: 회차 쓰기는 됐고(PASSED) 판 번호는 아직 없다
    const written = await x.w.verifyOf(x.eventId, x.ticket);
    expect(written).toMatch(/^PASSED:/);
    expect((await x.w.appealRaw(PID, x.eventId)).cv).toBeUndefined();
    expect(await call()).toBe('APPLIED');
    expect(await x.w.verifyOf(x.eventId, x.ticket)).toBe(written);
    expect(await x.w.appealRaw(PID, x.eventId)).toMatchObject({ cid: x.caseOf('case-c'), cv: '10', res: 'APPLIED' });
    expect(await call()).toBe('UNCHANGED');
  });

  test(`${name}: B-T10 ⑤ 거절된 결과 반영(없는 이의·다른 건에 묶인 이의)은 건 ID 색인을 남기지 않아 같은 건 ID로 진짜 이의를 부르면 APPLIED다`, async () => {
    const x = await appealed();
    expect(await x.resolve.run({ appealId: x.appealId, caseId: x.caseOf('case-a'), caseVersion: 1, outcome: 'ACCEPTED' })).toBe('APPLIED');
    const caseY = x.caseOf('case-y');
    // 없는 이의 ID로 한 번
    expect(await codeOf(x.resolve.run({ appealId: '0190f3a1-7c2e-7a00-8000-00000000dead', caseId: caseY, caseVersion: 1, outcome: 'ACCEPTED' }))).toBe('APPEAL_NOT_FOUND');
    // 이미 다른 건(case-a)에 묶인 이의로 한 번
    expect(await codeOf(x.resolve.run({ appealId: x.appealId, caseId: caseY, caseVersion: 2, outcome: 'ACCEPTED' }))).toBe('CASE_CONFLICT');
    // 그 건 ID의 진짜 이의(다른 사람, 같은 회차)
    const t2 = hashOf(`y-${x.eventId}`);
    await x.w.setDup(PID2, x.eventId, numberDup(35, t2));
    await x.w.setVerify(x.eventId, t2, `VERIFYING:${x.w.clock.now()}:NETWORK`);
    const b = (await x.appealAs('진짜 이의', { pid: PID2 })) as { appealId: string };
    expect(await x.resolve.run({ appealId: b.appealId, caseId: caseY, caseVersion: 1, outcome: 'REJECTED' })).toBe('APPLIED');
    expect(await x.w.verifyOf(x.eventId, t2)).toMatch(/^BLOCKED:/);
  });

  test(`${name}: B-T10 ⑤ 결과 반영의 요청 모양이 틀리면 INVALID이고 저장소를 바꾸지 않는다`, async () => {
    const x = await appealed();
    for (const bad of [
      { caseId: '{bad}', caseVersion: 1 },
      { caseId: 'c', caseVersion: 0 },
      { caseId: 'c', caseVersion: Number.NaN },
      { caseId: 'c', caseVersion: 1.5 },
    ])
      expect(await codeOf(x.resolve.run({ appealId: x.appealId, outcome: 'ACCEPTED', ...bad }))).toBe('INVALID');
    expect(await x.w.verifyOf(x.eventId, x.ticket)).toMatch(/^VERIFYING:/);
  });

  // ---------- 보안 로그 ----------

  test(`${name}: [ASVS v5.0.0-16.3.3] 제출 결과·이의 접수·결과 반영 보안 로그 줄은 사유 범주·결과·이의 ID·회차·시각만 싣고 이의 글·pid·토큰이 없다`, async () => {
    const x = await appealed();
    await x.submitAs({ token: 'secret-token-value' });
    await x.resolve.run({ appealId: x.appealId, caseId: x.caseOf('case-l'), caseVersion: 1, outcome: 'ACCEPTED' });
    const security = x.log.lines.filter((l) => l.fields.kind === 'security');
    expect(security.map((l) => l.fields.event)).toEqual(['queue_verification_appeal', 'queue_verification_submit', 'queue_verification_appeal_resolved']);
    expect(security[0]!.fields).toMatchObject({ eventId: x.eventId, appealId: x.appealId, result: 'accepted', reasonCategory: 'DEVICE_HISTORY', receivedAt: x.receivedAt });
    expect(security[1]!.fields).toMatchObject({ eventId: x.eventId, result: 'passed', reasonCategory: 'DEVICE_HISTORY', at: expect.any(String) });
    // 제출로 이미 통과해 결과 반영은 바꿀 것이 없다
    expect(security[2]!.fields).toMatchObject({ appealId: x.appealId, caseId: x.caseOf('case-l'), result: 'NOT_ISOLATED' });
    const text = JSON.stringify(x.log.lines);
    for (const secret of ['사람입니다', PID, 'secret-token-value', ACCOUNT, DEVICE]) expect(text).not.toContain(secret);
  });

  test(`${name}: [ASVS v5.0.0-16.3.4] trust·identity가 답하지 않거나 발행이 실패하면 의존 서비스 실패 보안 줄과 지표가 남는다`, async () => {
    const x = await world({ risk: recordingRisk('UNAVAILABLE'), cases: recordingCases('fail') });
    await x.verifying();
    await codeOf(x.submitAs());
    await codeOf(x.appealAs('발행 실패'));
    const warn = x.log.lines.filter((l) => l.level === 'warn').map((l) => l.fields);
    expect(warn).toEqual([
      expect.objectContaining({ kind: 'security', event: 'queue_verification_dependency_failed', dep: 'trust-svc', eventId: x.eventId }),
      expect.objectContaining({ kind: 'security', event: 'queue_verification_appeal_publish_failed', dep: 'kafka', eventId: x.eventId }),
    ]);
    expect(x.signals.submissions).toEqual(['unavailable']);
    expect(x.signals.appeals).toEqual(['publish_failed']);
    expect(JSON.stringify(warn)).not.toContain('발행 실패');
    const y = await world({ reverification: recordingReverification(() => Promise.reject(new ReverificationUnavailable('x'))) });
    await y.verifying();
    await codeOf(y.submitAs({ token: 'secret-token-identity' }));
    expect(y.log.lines.find((l) => l.level === 'warn')!.fields).toMatchObject({ dep: 'identity-svc' });
    // 보류(HELD)로 끝난 제출의 줄도 본다
    const z = await world({ risk: recordingRisk('HELD') });
    await z.verifying();
    await codeOf(z.submitAs({ token: 'secret-token-held' }));
    // 의존 서비스 실패 경고 줄 전체(제출·이의, trust·identity·Kafka)에 pid·계정 ID·기기 식별값·토큰 원문이 없다(16.3.3 시험과 같은 모양)
    const all = [x, y, z].flatMap((w) => w.log.lines.filter((l) => l.level === 'warn'));
    expect(all).toHaveLength(4);
    const text = JSON.stringify(all);
    for (const secret of [PID, ACCOUNT, DEVICE, 'verify-token', 'secret-token-identity', 'secret-token-held']) expect(text).not.toContain(secret);
  });
}
