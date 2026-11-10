// 추가 검증 제출(openapi POST /v1/queues/{eventId}/verification의 challengeToken, docs/features/bot-defense.md §5.2, FR-020, POL-006, ADR-0259 결정 1·2·5).
// 차례: 대기 참여 찾기 → verify 칸(PASSED면 200 PASSED 다시, BLOCKED면 410, VERIFYING이 아니면 409) → identity-svc CheckReverification(not_before = VERIFYING 시각)
// → 재통과가 있을 때만 제출 수(q:vsub, 넘으면 429) → trust-svc ScoreRisk(VERIFICATION)로 사람 확인 토큰을 태운다 → 답이 없거나 보류면 센 제출을 되돌린다(ADR-0259 결정 12).
// 둘 가운데 하나라도 답이 없으면 통과로 보지 않고 503이며 verify 칸은 VERIFYING 그대로다(축소 운영의 '막지 않는다'는 대기열에 들어오는 일의 규칙이다).
// 통과는 회차 슬롯 Lua가 VERIFYING일 때만 PASSED:{서버 시각}:{사유}로 바꾸고, 빠진 번호 비트는 그대로 둔다(queue-admission §7).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { type EventSchedules, QueueStoreUnavailable } from '../../entry/index.js';
import {
  noVerificationSignals,
  REVERIFICATION,
  type ReverificationPort,
  type ReverificationResult,
  type SubmissionResult,
  type VerificationClient,
  VERIFICATION_OPTIONS,
  VERIFICATION_RISK,
  VERIFICATION_SCHEDULES,
  VERIFICATION_SIGNALS,
  VERIFICATION_STORE,
  type VerificationRiskPort,
  type VerificationSignals,
  type VerificationStore,
} from '../domain/ports.js';
import { parseVerify, UNAVAILABLE_RETRY_AFTER_SEC, type VerificationOptions } from '../domain/verification.js';
import { type Caller, findEntry, type FoundEntry, openScheduleOf, passedBody } from './entries.js';
import { VerificationError } from './verification-error.js';

export interface SubmitInput extends Caller {
  accountId: string;
  challengeToken: string;
  deviceId?: string;
  client?: VerificationClient;
}

/** 200 본문(openapi QueueVerificationResult) */
export type SubmitResult = { result: 'PASSED'; queueNumber?: number; graceUntil: string | null } | { result: 'CHALLENGE_FAILED' | 'REVERIFY_REQUIRED' | 'PERSON_MISMATCH' };

const REVERIFY_RESULT: Record<Exclude<ReverificationResult, 'PASSED'>, { result: 'REVERIFY_REQUIRED' | 'PERSON_MISMATCH'; signal: SubmissionResult }> = {
  NOT_FOUND: { result: 'REVERIFY_REQUIRED', signal: 'reverify_required' },
  PERSON_MISMATCH: { result: 'PERSON_MISMATCH', signal: 'person_mismatch' },
};

@Injectable()
export class SubmitVerification {
  constructor(
    @Inject(VERIFICATION_STORE) private readonly store: VerificationStore,
    @Inject(VERIFICATION_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(REVERIFICATION) private readonly reverification: ReverificationPort,
    @Inject(VERIFICATION_RISK) private readonly risk: VerificationRiskPort,
    @Inject(VERIFICATION_OPTIONS) private readonly options: VerificationOptions,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(VERIFICATION_SIGNALS) private readonly signals: VerificationSignals = noVerificationSignals,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  async run(i: SubmitInput): Promise<SubmitResult> {
    await openScheduleOf(this.schedules, i.eventId, this.clock.now());
    const entry = await findEntry(this.store, i);
    const v = entry.verify;
    if (v?.state === 'PASSED') return this.#passed(i, entry, v.atMs, v.reason, false);
    if (v?.state === 'BLOCKED') throw new VerificationError('BLOCKED', '이의 기각으로 끝난 대기 참여');
    if (v?.state !== 'VERIFYING' || !entry.fieldHash) throw new VerificationError('NOT_VERIFYING', '추가 검증 중인 대기 참여가 아니다');
    const reason = v.reason;

    // 본인확인 재통과를 먼저 묻는다: 재통과가 없으면 trust-svc를 부르지 않아 한 번 쓰기 사람 확인 토큰을 태우지 않는다(ADR-0259 결정 1)
    let re: ReverificationResult;
    try {
      re = await this.reverification.check({ accountId: i.accountId, pid: i.pid, notBeforeMs: v.atMs });
    } catch (err) {
      if (err instanceof QueueStoreUnavailable) throw err;
      throw this.#unavailable(i, 'identity-svc', reason, err);
    }
    if (re !== 'PASSED') {
      const r = REVERIFY_RESULT[re];
      this.#done(i, r.signal, reason);
      return { result: r.result };
    }

    // 한 대기 참여의 제출 한도(사람 슬롯 카운터, 게이트웨이 한도와 따로): trust-svc 검증을 실제로 부를 때만 센다(ADR-0259 결정 12).
    // 재통과 확인이 통과한 뒤 ScoreRisk 바로 앞에서 세고, 넘은 제출은 trust-svc를 부르지 않는다
    const { count, ttlMs } = await this.store.countSubmit(i.pid, i.eventId, this.options.submitWindowMs);
    if (count > this.options.submitLimit) {
      this.#done(i, 'rate_limited', reason);
      throw new VerificationError('SUBMIT_LIMITED', '제출 한도를 넘었다', Math.max(1, Math.ceil(ttlMs / 1000)));
    }

    // 사람 확인만 다시 본다(가중합을 다시 하면 차단 기기 목록 같은 같은 근거로 또 걸린다, §3.1). 보류(HELD)도 통과로 보지 않는다
    const human = await this.risk.verify({
      eventId: i.eventId,
      accountId: i.accountId,
      pid: i.pid,
      humanCheckToken: i.challengeToken,
      ...(i.deviceId ? { deviceId: i.deviceId } : {}),
      ...(i.client ? { client: i.client } : {}),
    });
    if (human === 'CHALLENGE') {
      this.#done(i, 'challenge_failed', reason);
      return { result: 'CHALLENGE_FAILED' };
    }
    if (human !== 'ALLOW') {
      // trust-svc가 응답하지 않았거나(UNAVAILABLE: 서킷 열림·데드라인 넘김·오류) 사람 확인 서버 검증이 보류됐다(HELD): 검증하지 못한 503이라
      // 센 제출을 되돌린다(ADR-0259 결정 12, 2026-11-10 보류도 되돌리게 바로잡음)
      await this.store.uncountSubmit(i.pid, i.eventId);
      throw this.#unavailable(i, 'trust-svc', reason, human);
    }

    const s = await this.store.settleVerify(i.eventId, entry.fieldHash, 'PASSED');
    if (s.kind === 'APPLIED') return this.#passed(i, entry, parseVerify(s.value)!.atMs, reason, true);
    // 그사이 다른 길(이의 인정·기각·대기 취소)이 칸을 바꿨다
    const now = s.kind === 'CURRENT' ? parseVerify(s.value) : null;
    if (now?.state === 'PASSED') return this.#passed(i, entry, now.atMs, reason, false);
    if (now?.state === 'BLOCKED') throw new VerificationError('BLOCKED', '이의 기각으로 끝난 대기 참여');
    throw new VerificationError('NOT_VERIFYING', '추가 검증 중인 대기 참여가 아니다');
  }

  async #passed(i: SubmitInput, entry: FoundEntry, passedAtMs: number, reason: string, fresh: boolean): Promise<SubmitResult> {
    const body = await passedBody(this.store, i.eventId, entry, passedAtMs, this.options.graceMs);
    // 이미 통과한 대기 참여가 다시 보낸 것은 제출 결과로 세지 않는다(같은 200을 다시 준다)
    if (fresh) this.#done(i, 'passed', reason);
    return body;
  }

  /** 통과로 보지 않는다: 503과 Retry-After. 의존 서비스 장애를 보안 통제 실패로 남긴다(ASVS 16.3.4) */
  #unavailable(i: SubmitInput, dep: 'identity-svc' | 'trust-svc', reason: string, cause: unknown): VerificationError {
    this.logger?.warn({ kind: 'security', event: 'queue_verification_dependency_failed', dep, eventId: i.eventId, cause: typeof cause === 'string' ? cause : 'error' }, '추가 검증 제출을 확인하지 못했다(통과로 보지 않는다)');
    this.#done(i, 'unavailable', reason);
    return new VerificationError('UNAVAILABLE', `${dep}가 답하지 않았다`, UNAVAILABLE_RETRY_AFTER_SEC);
  }

  /** 지표와 보안 로그 줄(사유 범주·결과·회차·시각. pid·토큰은 남기지 않는다, ASVS 16.3.3) */
  #done(i: SubmitInput, result: SubmissionResult, reason: string): void {
    this.signals.submission(result);
    this.logger?.info({ kind: 'security', event: 'queue_verification_submit', eventId: i.eventId, result, reasonCategory: reason, at: new Date(this.clock.now()).toISOString() }, '추가 검증 제출');
  }
}
