// 대기열 진입(openapi POST /v1/queues/{eventId}/entries, docs/features/queue-admission.md §3·'묶음의 첫 구현', FR-006, POL-002, ADR-0041).
// ① 사람 슬롯 선점 → ② 회차 슬롯 번호(구간 안의 묶음 대상은 묶음에 넣음) → ③ 사람 슬롯 기록(묶음이면 묶음 기록, OPEN[14]).
// 세 단계는 원자적이지 않아 선점 값 PENDING:{요청 ID}로 같은 사람이 갇히지 않게 한다(중간-035). 이름은 명세 specs/queue.qnt의 동작 이름이다.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { type BatchedEntry, ENTRY_STORE, EVENT_SCHEDULES, type EntryStore, type EventSchedules, QUEUE_TOKENS, type QueueTokens } from '../domain/ports.js';
import {
  BATCH_REPAIR_RETRY_SEC,
  BATCH_RESULT_DELAY_MS,
  BATCH_SPREAD_SEC,
  batchCloseAtOf,
  type EventSchedule,
  keepUntilOf,
  PENDING_TTL_MS,
  QueueStoreUnavailable,
  type ReasonCategory,
  RESULT_PREFIX_LEN,
  saleEndOf,
  segmentOf,
} from '../domain/queue.js';
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

/** 201 대기표(openapi QueueTicket) */
export interface EnterResult {
  kind: 'TICKET';
  queueTicket: string;
  seq: number;
  generation: number;
  segment: number;
  verification?: 'REQUIRED';
  verificationReason: ReasonCategory | null;
  serverTimeMs: number;
}

/** 202 BATCHING(openapi BatchingResponse) */
export interface BatchingResult {
  kind: 'BATCHING';
  /** 이 묶음 참가의 진입 요청 ID(본문에 없었으면 만든 값). 결과 뒤 같은 값으로 진입을 다시 보낸다 */
  entryRequestId: string;
  resultPath: string;
  resultAt: string;
  spreadSec: number;
  serverTimeMs: number;
}

export type EnterOutcome = EnterResult | BatchingResult;

interface Ctx {
  i: EnterInput;
  schedule: EventSchedule;
  requestId: string;
  keepUntil: number;
  saleEnd: number;
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

  async run(i: EnterInput): Promise<EnterOutcome> {
    const schedule = await this.schedules.get(i.eventId);
    if (!schedule) throw new EntryError('NOT_FOUND', '이 회차의 대기열이 열리지 않았다');
    const now = this.clock.now();
    if (now >= saleEndOf(schedule)) throw new EntryError('SALE_ENDED', '판매가 끝났다(공연 시작 24시간 전)');
    if (now < schedule.opensAtMs) throw new EntryError('NOT_OPEN', '아직 오픈 전이다');

    const device = i.body.deviceId ?? '';
    const pre = this.tokens.readPreverify(i.body.preverifyToken);
    if (!pre || pre.e !== i.eventId || pre.a !== i.accountId || pre.d !== device || now >= pre.exp) {
      throw new EntryError('PREVERIFY_INVALID', '사전 검증 토큰이 없거나 맞지 않는다');
    }
    const c: Ctx = { i, schedule, requestId: i.body.entryRequestId ?? randomUUID(), keepUntil: keepUntilOf(schedule), saleEnd: saleEndOf(schedule) };
    return this.#enter(c, pre.jny, pre.vr, pre.i0 < schedule.opensAtMs, this.tokens.hash(i.body.preverifyToken), true);
  }

  async #enter(c: Ctx, jny: string, vr: ReasonCategory | undefined, eligible: boolean, tokenHash: string, firstTry: boolean): Promise<EnterOutcome> {
    const { i, schedule, requestId, keepUntil, saleEnd } = c;
    const pre1 = await this.store.preempt({ pid: i.pid, eventId: i.eventId, requestId, pendingTtlMs: this.options.pendingTtlMs });
    if (pre1.kind === 'ADMITTED') throw new EntryError('ALREADY_ADMITTED', '이 회차에 이미 입장했다');
    if (pre1.kind === 'BUSY') throw new EntryError('ALREADY_WAITING', '이미 대기 중이다');
    // 응답을 잃은 재시도: 기록 값(번호·세대·jny·vr)으로 처음 대기표를 그대로 다시 만든다. 그 사이 사전 검증 토큰을 갱신했어도 같다
    if (pre1.kind === 'RECORDED') return this.#issue(c, pre1.seq, pre1.gen, pre1.jny, pre1.vr);
    if (pre1.kind === 'BATCH') return this.#batched(c, pre1, jny, vr, eligible, tokenHash, firstTry);

    const num = await this.store.number({
      eventId: i.eventId,
      expireAtMs: keepUntil,
      opensAtMs: schedule.opensAtMs,
      closeAtMs: batchCloseAtOf(schedule),
      lobbyShuffle: schedule.lobbyShuffle,
      openBatch: schedule.openBatch,
      eligible,
      tokenHash,
      batchExpireAtMs: saleEnd,
    });
    if (num.kind === 'EARLY' || num.kind === 'WAIT') {
      // 번호를 받지 않았으니 선점을 푼다. 남기면 새 요청 ID로 다시 온 같은 사람이 선점 수명(10초) 동안 409를 받는다
      await this.#release(c);
      // 서버 시각으로는 아직 오픈 전이다(파드 시계가 앞섬)
      if (num.kind === 'EARLY') throw new EntryError('NOT_OPEN', '아직 오픈 전이다');
      // 오픈 뒤 발급 토큰이 묶음 구간에 왔다: 구간이 닫힌 뒤 다시 오게 한다(중간-028)
      throw new EntryError('BATCHING', '오픈 직후 묶음 구간이다', num.retryAfterSeconds);
    }
    if (num.kind === 'BATCHING') {
      const br = await this.store.batchRecord({ pid: i.pid, eventId: i.eventId, requestId, tokenHash, jny, ...(vr ? { vr } : {}), expireAtMs: saleEnd });
      // 같은 요청이 다른 토큰으로 먼저 기록했으면 그 토큰의 결과 파일을 알려 준다(이 토큰의 자리는 아무도 갖지 않는 번호가 된다)
      if (br.kind === 'BATCHED') return this.#batching(c, br.tokenHash);
      // 같은 요청이 구간 끝을 걸쳐 둘로 와서 뒤 요청이 먼저 번호를 기록했다: 그 대기표를 준다(이 토큰의 묶음 자리는 아무도 갖지 않는 번호가 된다)
      if (br.kind === 'SAME') return this.#issue(c, br.seq, br.gen, br.jny, br.vr);
      // 묶음 안 그 토큰의 자리는 아무도 갖지 않는 번호가 된다(②와 ③ 사이 틈과 같은 한계, OPEN[14])
      if (br.kind === 'ADMITTED') throw new EntryError('ALREADY_ADMITTED', '선점과 묶음 기록 사이에 이 회차에 입장했다');
      throw new EntryError('ALREADY_WAITING', '선점 수명이 지난 사이 다른 요청이 대기를 차지했다');
    }

    const { seq, gen } = num;
    const rec = await this.store.record({ pid: i.pid, eventId: i.eventId, requestId, seq, gen, jny, ...(vr ? { vr } : {}), expireAtMs: saleEnd });
    if (rec.kind === 'RECORDED') return this.#issue(c, seq, gen, jny, vr);
    // 기록하지 못한 번호는 아무도 갖지 않으므로 빠진 번호로 돌린다
    await this.store.markRemoved({ eventId: i.eventId, seq, expireAtMs: keepUntil });
    if (rec.kind === 'SAME') return this.#issue(c, rec.seq, rec.gen, rec.jny, rec.vr);
    // 같은 요청이 구간 끝을 걸쳐 동시에 와서 먼저 묶음에 들었다: 묶음의 202를 준다
    if (rec.kind === 'BATCH') return this.#batching(c, rec.tokenHash);
    if (rec.kind === 'ADMITTED') throw new EntryError('ALREADY_ADMITTED', '선점과 기록 사이에 이 회차에 입장했다');
    throw new EntryError('ALREADY_WAITING', '선점 수명이 지난 사이 다른 요청이 대기를 차지했다');
  }

  /** 묶음 기록이 있다: 결과가 있으면 대기표, 게시 전이면 202 다시, 참가자인데 결과 키를 잃었으면 503(다시 쓰기를 청했다),
   * 참가자 목록에 없으면(batchMissing, 장애 전환으로 SADD를 잃음) 기록을 지우고 일반 진입 */
  async #batched(c: Ctx, rec: BatchedEntry, jny: string, vr: ReasonCategory | undefined, eligible: boolean, tokenHash: string, firstTry: boolean): Promise<EnterOutcome> {
    const { i, requestId, saleEnd } = c;
    const res = await this.store.batchResult({ eventId: i.eventId, tokenHash: rec.tokenHash });
    if (res.kind === 'PENDING') return this.#batching(c, rec.tokenHash);
    // 묶음 기록은 그대로 두고 잠시 뒤 다시 오게 한다. admission-ctrl이 같은 입력으로 결과를 다시 쓴다
    if (res.kind === 'REPAIRING') throw new EntryError('BATCHING', '묶음 결과를 다시 쓰는 중이다', BATCH_REPAIR_RETRY_SEC);
    if (res.kind === 'RESULT') {
      const conv = await this.store.convertBatch({ pid: i.pid, eventId: i.eventId, requestId, tokenHash: rec.tokenHash, seq: res.seq, gen: res.gen, expireAtMs: saleEnd });
      if (conv.kind === 'RECORDED') return this.#issue(c, conv.seq, conv.gen, conv.jny, conv.vr);
      throw new EntryError('ALREADY_WAITING', '묶음 기록이 바뀌었다');
    }
    await this.store.dropBatch({ pid: i.pid, eventId: i.eventId, requestId, tokenHash: rec.tokenHash });
    if (!firstTry) throw new EntryError('ALREADY_WAITING', '묶음 기록을 지운 뒤에도 다시 묶음 기록이 보인다');
    // 결과가 이미 게시돼 묶음 구간은 닫혔다. 같은 요청 ID로 일반 진입(맨 뒤 번호)을 한다
    return this.#enter(c, jny, vr, eligible, tokenHash, false);
  }

  /** 선점 풀기는 덤이다: 대기열 Redis가 잠시 안 되면 선점 수명이 지나 풀린다 */
  async #release(c: Ctx): Promise<void> {
    try {
      await this.store.release({ pid: c.i.pid, eventId: c.i.eventId, requestId: c.requestId });
    } catch (e) {
      if (!(e instanceof QueueStoreUnavailable)) throw e;
    }
  }

  #batching(c: Ctx, tokenHash: string): BatchingResult {
    return {
      kind: 'BATCHING',
      entryRequestId: c.requestId,
      resultPath: `/v1/queues/${c.i.eventId}/batch-results/${tokenHash.slice(0, RESULT_PREFIX_LEN)}.json`,
      resultAt: new Date(batchCloseAtOf(c.schedule) + BATCH_RESULT_DELAY_MS).toISOString(),
      spreadSec: BATCH_SPREAD_SEC,
      serverTimeMs: this.clock.now(),
    };
  }

  async #issue(c: Ctx, seq: number, gen: number, jny: string, vr: ReasonCategory | undefined): Promise<EnterResult> {
    const { i, requestId, keepUntil, saleEnd } = c;
    const ticket = this.tokens.ticket({ e: i.eventId, a: i.accountId, d: i.body.deviceId ?? '', s: seq, g: gen, seg: segmentOf(seq), rq: requestId, jny, ...(vr ? { vr } : {}) });
    const now = this.clock.now();
    // 고위험: 번호는 그대로 내고 빠진 번호·VERIFYING으로 기록해 추가 검증으로 보낸다(ADR-0062, 303 대신 본문 필드 ADR-0079 결정 4)
    if (vr) await this.store.markVerifying({ eventId: i.eventId, seq, ticketHash: this.tokens.hash(ticket), atMs: now, reason: vr, expireAtMs: keepUntil, verifyExpireAtMs: saleEnd });
    return {
      kind: 'TICKET',
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
