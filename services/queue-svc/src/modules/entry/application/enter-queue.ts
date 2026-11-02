// 대기열 진입(openapi POST /v1/queues/{eventId}/entries, docs/features/queue-admission.md §3, FR-006, POL-002).
// ① 사람 슬롯 선점 → ② 회차 슬롯 번호 → ③ 사람 슬롯 기록. 세 단계는 원자적이지 않아 선점 값 PENDING:{요청 ID}로 같은 사람이 갇히지 않게 한다(중간-035).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ENTRY_STORE, EVENT_SCHEDULES, type EntryStore, type EventSchedules, QUEUE_TOKENS, type QueueTokens } from '../domain/ports.js';
import { OPEN_BATCH_MS, PENDING_TTL_MS, type ReasonCategory, keepUntilOf, saleEndOf, segmentOf } from '../domain/queue.js';
import { EntryError } from './entry-error.js';

export const ENTRY_OPTIONS = Symbol('queue.EntryOptions');
export interface EntryOptions {
  /** 선점 값 수명(시험이 줄인다) */
  pendingTtlMs: number;
}
export const DEFAULT_ENTRY_OPTIONS: EntryOptions = { pendingTtlMs: PENDING_TTL_MS };

export interface EnterInput {
  accountId: string;
  pid: string;
  eventId: string;
  body: { preverifyToken: string; deviceId?: string; entryRequestId?: string };
}

export interface EnterResult {
  queueTicket: string;
  seq: number;
  generation: number;
  segment: number;
  verification?: 'REQUIRED';
  verificationReason: ReasonCategory | null;
  serverTimeMs: number;
}

@Injectable()
export class EnterQueue {
  constructor(
    @Inject(ENTRY_STORE) private readonly store: EntryStore,
    @Inject(EVENT_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(QUEUE_TOKENS) private readonly tokens: QueueTokens,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENTRY_OPTIONS) private readonly options: EntryOptions,
  ) {}

  async run(i: EnterInput): Promise<EnterResult> {
    const schedule = await this.schedules.get(i.eventId);
    if (!schedule) throw new EntryError('NOT_FOUND', '이 회차의 대기열이 열리지 않았다');
    const now = this.clock.now();
    if (now >= saleEndOf(schedule)) throw new EntryError('SALE_ENDED', '판매가 끝났다(공연 시작 24시간 전)');
    if (now < schedule.opensAtMs) throw new EntryError('NOT_OPEN', '아직 오픈 전이다');
    // 오픈 직후 묶음 구간(ADR-0041)은 BUILD_ORDER PRF-060이 202 BATCHING으로 받는다. 그 전까지는 구간이 닫힐 때까지 모두 다시 오게 한다
    if (schedule.openBatch && now < schedule.opensAtMs + OPEN_BATCH_MS) {
      throw new EntryError('BATCHING', '오픈 직후 묶음 구간이다', Math.ceil((schedule.opensAtMs + OPEN_BATCH_MS - now) / 1000));
    }

    const device = i.body.deviceId ?? '';
    const pre = this.tokens.readPreverify(i.body.preverifyToken);
    if (!pre || pre.e !== i.eventId || pre.a !== i.accountId || pre.d !== device || now >= pre.exp) {
      throw new EntryError('PREVERIFY_INVALID', '사전 검증 토큰이 없거나 맞지 않는다');
    }
    const requestId = i.body.entryRequestId ?? randomUUID();
    const keepUntil = keepUntilOf(schedule);
    const saleEnd = saleEndOf(schedule);

    const pre1 = await this.store.preempt({ pid: i.pid, eventId: i.eventId, requestId, pendingTtlMs: this.options.pendingTtlMs });
    if (pre1.kind === 'ADMITTED') throw new EntryError('ALREADY_ADMITTED', '이 회차에 이미 입장했다');
    if (pre1.kind === 'BUSY') throw new EntryError('ALREADY_WAITING', '이미 대기 중이다');
    // 응답을 잃은 재시도: 기록 값(번호·세대·jny·vr)으로 처음 대기표를 그대로 다시 만든다. 그 사이 사전 검증 토큰을 갱신했어도 같다
    if (pre1.kind === 'RECORDED') return this.#issue(i, pre1.seq, pre1.gen, requestId, pre1.jny, pre1.vr, keepUntil, saleEnd);

    const { seq, gen } = await this.store.number({ eventId: i.eventId, expireAtMs: keepUntil });
    const rec = await this.store.record({ pid: i.pid, eventId: i.eventId, requestId, seq, gen, jny: pre.jny, ...(pre.vr ? { vr: pre.vr } : {}), expireAtMs: saleEnd });
    if (rec.kind === 'RECORDED') return this.#issue(i, seq, gen, requestId, pre.jny, pre.vr, keepUntil, saleEnd);
    // 기록하지 못한 번호는 아무도 갖지 않으므로 빠진 번호로 돌린다
    await this.store.markRemoved({ eventId: i.eventId, seq, expireAtMs: keepUntil });
    if (rec.kind === 'SAME') return this.#issue(i, rec.seq, rec.gen, requestId, rec.jny, rec.vr, keepUntil, saleEnd);
    if (rec.kind === 'ADMITTED') throw new EntryError('ALREADY_ADMITTED', '선점과 기록 사이에 이 회차에 입장했다');
    throw new EntryError('ALREADY_WAITING', '선점 수명이 지난 사이 다른 요청이 대기를 차지했다');
  }

  async #issue(i: EnterInput, seq: number, gen: number, requestId: string, jny: string, vr: ReasonCategory | undefined, keepUntil: number, saleEnd: number): Promise<EnterResult> {
    const ticket = this.tokens.ticket({ e: i.eventId, a: i.accountId, d: i.body.deviceId ?? '', s: seq, g: gen, seg: segmentOf(seq), rq: requestId, jny, ...(vr ? { vr } : {}) });
    const now = this.clock.now();
    // 고위험: 번호는 그대로 내고 빠진 번호·VERIFYING으로 기록해 추가 검증으로 보낸다(ADR-0062, 303 대신 본문 필드 ADR-0079 결정 4)
    if (vr) await this.store.markVerifying({ eventId: i.eventId, seq, ticketHash: this.tokens.hash(ticket), atMs: now, reason: vr, expireAtMs: keepUntil, verifyExpireAtMs: saleEnd });
    return {
      queueTicket: ticket,
      seq,
      generation: gen,
      segment: segmentOf(seq),
      ...(vr ? { verification: 'REQUIRED' as const } : {}),
      verificationReason: vr ?? null,
      serverTimeMs: now,
    };
  }
}
