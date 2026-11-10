// 이의 접수(openapi POST /v1/queues/{eventId}/verification의 appeal, docs/features/bot-defense.md §12 '접수'·'queue-svc에서 처리함까지의 길', ADR-0259 결정 3·6).
// trust-svc를 부르지 않는다(trust-svc가 멈춰도 받는다). 차례: 대기 참여 찾기 → 이의를 대기열 Redis q:appeal에 처음 것만 둔다(Lua HSETNX)
// → 이의 ID 색인 q:appealid → support.cases-requested에 건 요청(2초 [가정]까지만 기다린다) → 보낸 표시(발행 성공 뒤에만) → 202.
// 발행이 실패하거나 늦으면 503과 Retry-After다. 이의는 이미 두었으므로 다시 보내면 처음 이의 ID·eventKey로 다시 낸다(늦게 간 첫 사건과 같은 eventKey라 ops-svc가 중복을 지운다).
// 2초에 503으로 끝난 요청의 발행이 늦게 성공해도 보낸 표시를 남기고, 같은 이의의 발행이 진행 중이면 파드 안에서 하나로 묶어 그 결과를 기다린다(ADR-0259 결정 12).
// 건 요청에는 이의 글을 싣지 않는다(ops-svc가 GetVerificationAppeal로 읽는다).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { type EventSchedules, saleEndOf } from '../../entry/index.js';
import { type AppealResult, CASE_REQUESTS, type CaseRequestPublisher, noVerificationSignals, VERIFICATION_OPTIONS, VERIFICATION_SCHEDULES, VERIFICATION_SIGNALS, VERIFICATION_STORE, type VerificationSignals, type VerificationStore } from '../domain/ports.js';
import { appealFits, normalizeAppeal, protoReasonOf, type StoredAppeal, UNAVAILABLE_RETRY_AFTER_SEC, type VerificationOptions } from '../domain/verification.js';
import { type Caller, findEntry, openScheduleOf, passedBody } from './entries.js';
import { VerificationError } from './verification-error.js';

export interface AppealInput extends Caller {
  accountId: string;
  /** 이의 글(0~1,000자, 받는 층이 모양을 이미 봤다) */
  text: string;
}

/** 202 본문(openapi QueueVerificationAppealReceipt). 이미 통과한 대기 참여면 200 PASSED를 다시 준다 */
export type AppealOutcome = { kind: 'RECEIVED'; appealId: string; receivedAt: string } | { kind: 'PASSED'; result: 'PASSED'; queueNumber?: number; graceUntil: string | null };

class PublishTimeout extends Error {
  override readonly name = 'PublishTimeout';
}

/** 상한 안에 끝나지 않으면 던진다(발행 자체는 멈추지 않는다: 늦게 전달된 사건은 같은 eventKey다) */
async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new PublishTimeout(`발행 확인이 ${ms}ms 안에 오지 않았다`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class SubmitAppeal {
  constructor(
    @Inject(VERIFICATION_STORE) private readonly store: VerificationStore,
    @Inject(VERIFICATION_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(CASE_REQUESTS) private readonly cases: CaseRequestPublisher,
    @Inject(VERIFICATION_OPTIONS) private readonly options: VerificationOptions,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(VERIFICATION_SIGNALS) private readonly signals: VerificationSignals = noVerificationSignals,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  /** 진행 중인 발행(이의 ID → 발행 뒤 보낸 표시까지의 약속, 결과는 이 발행이 표시를 처음 썼는가). 끝나면 지운다 */
  readonly #inflight = new Map<string, Promise<boolean>>();

  /**
   * 같은 이의의 발행이 진행 중이면 그것을 기다리고(joined), 없으면 새로 낸다. 요청의 상한과 따로 끝까지 가서 성공하면 보낸 표시를 쓰고,
   * 그 표시를 처음 쓴 발행이면 접수(accepted)를 여기서 한 번 센다: 2초 상한에 503으로 끝난 요청의 발행이 늦게 성공해도 접수가 빠지지 않는다(리뷰 S5)
   */
  #publish(owner: string, i: AppealInput, a: StoredAppeal): { done: Promise<boolean>; joined: boolean } {
    const running = this.#inflight.get(a.appealId);
    if (running) return { done: running, joined: true };
    const done = this.cases
      .publish({ eventKey: a.eventKey, sourceId: a.appealId, category: protoReasonOf(a.reason), createdAtMs: a.receivedAtMs })
      .then(() => this.store.markSent(owner, i.eventId, a.appealId))
      .then((first) => {
        if (first) this.#done(i, 'accepted', a);
        return first;
      })
      .finally(() => this.#inflight.delete(a.appealId));
    // 기다리던 요청이 상한에 먼저 끝나도 늦은 실패를 처리되지 않은 거부로 남기지 않는다(다음 요청이 다시 낸다)
    done.catch(() => undefined);
    this.#inflight.set(a.appealId, done);
    return { done, joined: false };
  }

  async run(i: AppealInput): Promise<AppealOutcome> {
    const now = this.clock.now();
    const schedule = await openScheduleOf(this.schedules, i.eventId, now);
    const text = normalizeAppeal(i.text);
    if (!appealFits(text)) throw new VerificationError('INVALID', '이의 글이 1,000자를 넘거나 막는 글자가 있다');
    const entry = await findEntry(this.store, i);
    const v = entry.verify;
    if (v?.state === 'BLOCKED') throw new VerificationError('BLOCKED', '이의 기각으로 끝난 대기 참여');
    if (v?.state === 'PASSED') return { kind: 'PASSED', ...(await passedBody(this.store, i.eventId, entry, v.atMs, this.options.graceMs)) };
    if (v?.state !== 'VERIFYING' || !entry.fieldHash) throw new VerificationError('NOT_VERIFYING', '추가 검증 중인 대기 참여가 아니다');

    // pid 키 전환 기간: 옛 pid의 사람 키에 이 대기 참여의 이의가 이미 있으면 그것을 쓴다(새 pid 쪽은 Lua HSETNX가 처음 것만 둔다)
    let owner = i.pid;
    let appeal: StoredAppeal | undefined;
    if (i.pidPrev && i.pidPrev !== i.pid) {
      const prev = await this.store.readAppeal(i.pidPrev, i.eventId);
      if (prev && prev.fieldHash === entry.fieldHash) {
        owner = i.pidPrev;
        appeal = prev;
      }
    }
    if (!appeal) {
      const r = await this.store.openAppeal(owner, i.eventId, {
        appealId: randomUUID(),
        accountId: i.accountId,
        fieldHash: entry.fieldHash,
        reason: v.reason,
        text,
        eventKey: randomUUID(),
        receivedAtMs: now,
        expireAtMs: saleEndOf(schedule) + this.options.appealKeepAfterSaleEndMs,
      });
      appeal = r.appeal;
    }
    const receipt: AppealOutcome = { kind: 'RECEIVED', appealId: appeal.appealId, receivedAt: new Date(appeal.receivedAtMs).toISOString() };
    if (appeal.sent) {
      this.#done(i, 'duplicate', appeal);
      return receipt;
    }

    // 보낸 표시가 없다: 처음 접수이거나 앞 발행이 실패·지연했다. 같은 이의 ID·eventKey로 (다시) 낸다
    await this.store.indexAppeal(appeal.appealId, i.eventId, owner, appeal.expireAtMs);
    const publishing = this.#publish(owner, i, appeal);
    let first: boolean;
    try {
      first = await within(this.options.publishTimeoutMs, publishing.done);
    } catch (err) {
      this.signals.appeal('publish_failed');
      this.logger?.warn({ kind: 'security', event: 'queue_verification_appeal_publish_failed', dep: 'kafka', eventId: i.eventId, appealId: appeal.appealId, timeout: err instanceof PublishTimeout }, '이의 건 요청을 내지 못했다(503, 다시 보내면 같은 eventKey로 낸다)');
      throw new VerificationError('PUBLISH_FAILED', '건 요청 발행 실패', UNAVAILABLE_RETRY_AFTER_SEC);
    }
    // 접수는 보낸 표시를 처음 쓴 발행이 이미 셌다. 진행 중인 발행을 기다리기만 한 요청과 겹친 두 요청의 뒤 것은 중복이다
    if (!first || publishing.joined) this.#done(i, 'duplicate', appeal);
    return receipt;
  }

  /** 지표와 보안 로그 줄(이의 ID·사유 범주·회차·접수 시각. 이의 글·pid 원문은 남기지 않는다, ASVS 16.3.3) */
  #done(i: AppealInput, result: AppealResult, a: StoredAppeal): void {
    this.signals.appeal(result);
    this.logger?.info(
      { kind: 'security', event: 'queue_verification_appeal', eventId: i.eventId, appealId: a.appealId, result, reasonCategory: a.reason, receivedAt: new Date(a.receivedAtMs).toISOString() },
      '추가 검증 이의 접수',
    );
  }
}
