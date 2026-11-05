// 대기열 진입(openapi POST /v1/queues/{eventId}/entries, docs/features/queue-admission.md §3·'묶음의 첫 구현', FR-006, POL-002, ADR-0041).
// ① 사람 슬롯 선점 → ② 회차 슬롯 번호(구간 안의 묶음 대상은 묶음에 넣음) → ③ 사람 슬롯 기록(묶음이면 묶음 기록, OPEN[14]).
// 세 단계는 원자적이지 않아 선점 값 PENDING:{요청 ID}로 같은 사람이 갇히지 않게 한다(중간-035). 이름은 명세 specs/queue.qnt의 동작 이름이다.
// pid 키 전환 기간에는 옛 pid → 새 pid 차례로 선점하고, 앞 키의 기록을 다른 키에 옮겨 쓴다(§3 'pid 키 전환 기간'의 첫 구현, BUILD_ORDER BOT-025, Q-T45).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { type BatchedEntry, ENTRY_STORE, EVENT_SCHEDULES, type EntryStore, type EventSchedules, type PreemptResult, QUEUE_TOKENS, type QueueTokens } from '../domain/ports.js';
import {
  BATCH_REPAIR_RETRY_SEC,
  BATCH_RESULT_DELAY_MS,
  BATCH_SPREAD_SEC,
  batchCloseAtOf,
  type EventSchedule,
  keepUntilOf,
  NUMBER_BATCH_MAX,
  RB05_SKIP_BASE,
  RECOVERING_RETRY_SEC,
  NUMBER_BATCH_WINDOW_MS,
  PENDING_TTL_MS,
  QueueStoreUnavailable,
  type ReasonCategory,
  RESULT_PREFIX_LEN,
  saleEndOf,
  segmentOf,
} from '../domain/queue.js';
import { EntryError } from './entry-error.js';
import { NumberBatcher } from './number-batcher.js';

export const ENTRY_OPTIONS = Symbol('queue.EntryOptions');
export interface EntryOptions {
  /** 선점 값 수명(시험이 줄인다) */
  pendingTtlMs: number;
  /** 진입 ② 파드별 묶음의 모으는 시간과 최대 건수(ADR-0179, 없으면 2ms·500건) */
  batchWindowMs?: number;
  batchMax?: number;
  /** RB-05가 건너뛰는 양의 바탕 값(ADR-0181, 없으면 12만 [가정]. 시험이 줄인다) */
  rb05SkipBase?: number;
}
export const DEFAULT_ENTRY_OPTIONS: EntryOptions = { pendingTtlMs: PENDING_TTL_MS, batchWindowMs: NUMBER_BATCH_WINDOW_MS, batchMax: NUMBER_BATCH_MAX };

export interface EnterInput {
  accountId: string;
  pid: string;
  /** pid 키 전환 기간의 옛 pid(게이트웨이 머리 X-User-Pid-Prev). 있고 pid와 다르면 두 키로 처리한다 */
  pidPrev?: string;
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
  /** 사람 키를 부를 pid(앞 키). 한 키로 처리하면 pid, 두 키면 옛 pid(옛 키에 이 요청의 값을 잃었으면 새 pid) */
  pid: string;
}

@Injectable()
export class EnterQueue {
  readonly #numbers: NumberBatcher;
  /** 회차마다 동시에 하나만 도는 RB-05(파드 안) */
  readonly #recovering = new Map<string, Promise<unknown>>();
  /** 회차마다 하나씩 뒤에서 도는 RB-05 복제 확인(ADR-0186) */
  readonly #confirming = new Map<string, Promise<void>>();

  constructor(
    @Inject(ENTRY_STORE) private readonly store: EntryStore,
    @Inject(EVENT_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(QUEUE_TOKENS) private readonly tokens: QueueTokens,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENTRY_OPTIONS) private readonly options: EntryOptions,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {
    this.#numbers = new NumberBatcher(store, options.batchWindowMs ?? NUMBER_BATCH_WINDOW_MS, options.batchMax ?? NUMBER_BATCH_MAX);
  }

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
    const c: Ctx = { i, schedule, requestId: i.body.entryRequestId ?? randomUUID(), keepUntil: keepUntilOf(schedule), saleEnd: saleEndOf(schedule), pid: i.pid };
    const eligible = pre.i0 < schedule.opensAtMs;
    const tokenHash = this.tokens.hash(i.body.preverifyToken);
    if (i.pidPrev && i.pidPrev !== i.pid) return this.#enterTwoKeys(c, i.pidPrev, pre.jny, pre.vr, eligible, tokenHash);
    return this.#enter(c, pre.jny, pre.vr, eligible, tokenHash, true);
  }

  /**
   * pid 키 전환 기간의 진입: 옛 pid → 새 pid 차례로 선점하고, 그 뒤 단계는 앞 키에서 한 뒤 앞 키의 값을 다른 키에 옮겨 쓴다.
   * 두 pid의 키는 해시 슬롯이 달라 한 Lua로 묶지 못한다. 옛 pid부터 부르는 것은 교체 직전 토큰(옛 pid만)과 두 pid 토큰이 옛 키에서 만나 하나만 통과하게 하려는 것이다
   */
  async #enterTwoKeys(c: Ctx, old: string, jny: string, vr: ReasonCategory | undefined, eligible: boolean, tokenHash: string): Promise<EnterOutcome> {
    const { i, requestId } = c;
    const p1 = await this.store.preempt({ pid: old, eventId: i.eventId, requestId, pendingTtlMs: this.options.pendingTtlMs });
    if (p1.kind === 'ADMITTED') throw new EntryError('ALREADY_ADMITTED', '이 회차에 이미 입장했다(옛 pid)');
    if (p1.kind === 'BUSY') throw new EntryError('ALREADY_WAITING', '이미 대기 중이다(옛 pid)');
    let p2: PreemptResult;
    try {
      p2 = await this.store.preempt({ pid: i.pid, eventId: i.eventId, requestId, pendingTtlMs: this.options.pendingTtlMs });
    } catch (e) {
      // 새 pid 쪽 오류: 옛 선점을 지우고 503(같은 요청 ID로 다시 보내면 처음부터 한다)
      await this.#release(c, old);
      throw e;
    }
    if (p2.kind === 'ADMITTED' || p2.kind === 'BUSY') {
      await this.#release(c, old);
      throw new EntryError(p2.kind === 'ADMITTED' ? 'ALREADY_ADMITTED' : 'ALREADY_WAITING', '새 pid 쪽이 거절했다');
    }
    // 앞 키는 옛 pid다. 옛 키에 이 요청의 값이 없고 새 키에만 있으면(장애 전환으로 옛 키의 쓰기를 잃음) 새 pid가 앞 키다
    const newLeads = p1.kind === 'PROCEED' && p2.kind !== 'PROCEED';
    const lead = newLeads ? i.pid : old;
    const other = newLeads ? old : i.pid;
    let out: EnterOutcome;
    try {
      out = await this.#after({ ...c, pid: lead }, newLeads ? p2 : p1, jny, vr, eligible, tokenHash, true);
    } catch (e) {
      // 번호를 받지 못하고 끝났다: 다른 키의 선점도 푼다(값이 이 요청의 PENDING일 때만)
      await this.#release(c, other);
      throw e;
    }
    // 대기표·202를 주기 전에 앞 키의 값과 수명을 다른 키에 옮겨 쓴다. 오류면 503이고, 같은 요청 ID로 다시 보내면 같은 대기표와 옮겨 쓰기를 다시 한다
    const m = await this.store.mirror({ from: lead, to: other, eventId: i.eventId, requestId });
    if (m === 'COPIED') return out;
    // 다른 키에 다른 요청의 값이나 입장 키가 있다: 한 사람이 번호 둘을 갖지 않게 앞 키의 이 요청 값을 지우고 받은 번호를 빠진 번호로 돌린다
    await this.store.dropOwn({ pid: lead, eventId: i.eventId, requestId });
    if (out.kind === 'TICKET') await this.store.markRemoved({ eventId: i.eventId, seq: out.seq, expireAtMs: c.keepUntil });
    throw new EntryError(m === 'ADMITTED' ? 'ALREADY_ADMITTED' : 'ALREADY_WAITING', '다른 pid 키에 다른 요청의 값이 있다');
  }

  async #enter(c: Ctx, jny: string, vr: ReasonCategory | undefined, eligible: boolean, tokenHash: string, firstTry: boolean): Promise<EnterOutcome> {
    const pre1 = await this.store.preempt({ pid: c.pid, eventId: c.i.eventId, requestId: c.requestId, pendingTtlMs: this.options.pendingTtlMs });
    return this.#after(c, pre1, jny, vr, eligible, tokenHash, firstTry);
  }

  /** ① 선점 결과 뒤의 단계(② 번호·묶음, ③ 기록). 사람 키는 c.pid로 부른다 */
  async #after(c: Ctx, pre1: PreemptResult, jny: string, vr: ReasonCategory | undefined, eligible: boolean, tokenHash: string, firstTry: boolean): Promise<EnterOutcome> {
    const { i, schedule, requestId, keepUntil, saleEnd } = c;
    if (pre1.kind === 'ADMITTED') throw new EntryError('ALREADY_ADMITTED', '이 회차에 이미 입장했다');
    if (pre1.kind === 'BUSY') throw new EntryError('ALREADY_WAITING', '이미 대기 중이다');
    // 응답을 잃은 재시도: 기록 값(번호·세대·jny·vr)으로 처음 대기표를 그대로 다시 만든다. 그 사이 사전 검증 토큰을 갱신했어도 같다
    if (pre1.kind === 'RECORDED') return this.#issue(c, pre1.seq, pre1.gen, pre1.jny, pre1.vr);
    if (pre1.kind === 'BATCH') return this.#batched(c, pre1, jny, vr, eligible, tokenHash, firstTry);

    // ②는 파드별 묶음으로 보낸다(같은 회차의 요청을 2ms 모아 Lua 한 번, ADR-0179)
    const num = await this.#numbers.take(
      {
        eventId: i.eventId,
        expireAtMs: keepUntil,
        opensAtMs: schedule.opensAtMs,
        closeAtMs: batchCloseAtOf(schedule),
        lobbyShuffle: schedule.lobbyShuffle,
        openBatch: schedule.openBatch,
        batchExpireAtMs: saleEnd,
      },
      { eligible, tokenHash },
    );
    if (num.kind === 'RECOVERING') {
      // 장애 전환 뒤 RB-05 전이라 번호를 받지 않았다(OPEN[13], ADR-0181). 선점을 풀고 RB-05를 돈 뒤 다시 오게 한다
      await this.#release(c);
      await this.#rb05(c);
      throw new EntryError('QUEUE_RECOVERING', '대기열 장애 전환 뒤 건너뛸 번호를 적는 중이다', RECOVERING_RETRY_SEC);
    }
    if (num.kind === 'SOLD_OUT' || num.kind === 'ENDED') {
      // 매진·판매 종료 판이 섰다(원본 410, 엣지 응답이 퍼지기 전에 온 진입, ADR-0122·0214). 번호를 받지 않았으니 선점을 푼다
      await this.#release(c);
      if (num.kind === 'SOLD_OUT') throw new EntryError('SOLD_OUT', '매진되었다');
      throw new EntryError('SALE_ENDED', '판매가 끝났다(회차 판매 상태)');
    }
    if (num.kind === 'EARLY' || num.kind === 'WAIT') {
      // 번호를 받지 않았으니 선점을 푼다. 남기면 새 요청 ID로 다시 온 같은 사람이 선점 수명(10초) 동안 409를 받는다
      await this.#release(c);
      // 서버 시각으로는 아직 오픈 전이다(파드 시계가 앞섬)
      if (num.kind === 'EARLY') throw new EntryError('NOT_OPEN', '아직 오픈 전이다');
      // 오픈 뒤 발급 토큰이 묶음 구간에 왔다: 구간이 닫힌 뒤 다시 오게 한다(중간-028)
      throw new EntryError('BATCHING', '오픈 직후 묶음 구간이다', num.retryAfterSeconds);
    }
    if (num.kind === 'BATCHING') {
      const br = await this.store.batchRecord({ pid: c.pid, eventId: i.eventId, requestId, tokenHash, jny, ...(vr ? { vr } : {}), expireAtMs: saleEnd });
      // 같은 요청이 다른 토큰으로 먼저 기록했으면 그 토큰의 결과 파일을 알려 준다(이 토큰의 자리는 아무도 갖지 않는 번호가 된다)
      if (br.kind === 'BATCHED') return this.#batching(c, br.tokenHash);
      // 같은 요청이 구간 끝을 걸쳐 둘로 와서 뒤 요청이 먼저 번호를 기록했다: 그 대기표를 준다(이 토큰의 묶음 자리는 아무도 갖지 않는 번호가 된다)
      if (br.kind === 'SAME') return this.#issue(c, br.seq, br.gen, br.jny, br.vr);
      // 묶음 안 그 토큰의 자리는 아무도 갖지 않는 번호가 된다(②와 ③ 사이 틈과 같은 한계, OPEN[14])
      if (br.kind === 'ADMITTED') throw new EntryError('ALREADY_ADMITTED', '선점과 묶음 기록 사이에 이 회차에 입장했다');
      throw new EntryError('ALREADY_WAITING', '선점 수명이 지난 사이 다른 요청이 대기를 차지했다');
    }

    const { seq, gen } = num;
    const rec = await this.store.record({ pid: c.pid, eventId: i.eventId, requestId, seq, gen, jny, ...(vr ? { vr } : {}), expireAtMs: saleEnd });
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
      const conv = await this.store.convertBatch({ pid: c.pid, eventId: i.eventId, requestId, tokenHash: rec.tokenHash, seq: res.seq, gen: res.gen, expireAtMs: saleEnd });
      if (conv.kind === 'RECORDED') return this.#issue(c, conv.seq, conv.gen, conv.jny, conv.vr);
      throw new EntryError('ALREADY_WAITING', '묶음 기록이 바뀌었다');
    }
    await this.store.dropBatch({ pid: c.pid, eventId: i.eventId, requestId, tokenHash: rec.tokenHash });
    if (!firstTry) throw new EntryError('ALREADY_WAITING', '묶음 기록을 지운 뒤에도 다시 묶음 기록이 보인다');
    // 결과가 이미 게시돼 묶음 구간은 닫혔다. 같은 요청 ID로 일반 진입(맨 뒤 번호)을 한다
    return this.#enter(c, jny, vr, eligible, tokenHash, false);
  }

  /** RB-05를 회차마다 한 번만 동시에 부른다. 다른 파드가 먼저 했으면 Lua가 아무것도 하지 않는다 */
  async #rb05(c: Ctx): Promise<void> {
    const e = c.i.eventId;
    let p = this.#recovering.get(e);
    if (!p) {
      const s = c.schedule;
      p = this.store
        .rb05({
          eventId: e,
          expireAtMs: c.keepUntil,
          skippedExpireAtMs: c.saleEnd,
          skipBase: this.options.rb05SkipBase ?? RB05_SKIP_BASE,
          opensAtMs: s.opensAtMs,
          closeAtMs: batchCloseAtOf(s),
          lobbyShuffle: s.lobbyShuffle,
          openBatch: s.openBatch,
        })
        .then((r) => {
          // 운영자는 건너뛴 줄과 진입 재개를 확인한다(docs/infra.md RB-05)
          if (r.kind === 'SKIPPED') this.logger?.warn({ eventId: e, start: r.start, end: r.end, gen: r.gen }, 'RB-05: 장애 전환 뒤 번호 구간을 건너뛰었다');
          // 건너뛰기를 붙은 복제본이 받은 것을 확인해야 진입 ②가 다시 번호를 낸다(ADR-0186). WAIT가 0.5초까지 걸려 요청은 기다리지 않고 바로 503을 받고,
          // 확인은 회차마다 하나씩 뒤에서 돈다. 안 되면 다음 진입이나 리더(1초마다)가 다시 하고, 계속 안 되는 것은 리더가 회차마다 10초에 한 번 남긴다
          if (r.kind === 'SKIPPED' || r.kind === 'PENDING') this.#confirm(e);
        })
        .finally(() => this.#recovering.delete(e));
      this.#recovering.set(e, p);
    }
    await p;
  }

  /** RB-05 복제 확인을 회차마다 하나씩 뒤에서 돈다. 대기열 Redis 일시 장애는 다음 진입이나 리더가 다시 하므로 삼키고, 그 밖(버그)은 남긴다 */
  #confirm(e: string): void {
    if (this.#confirming.has(e)) return;
    const p = this.store
      .confirmRb05({ eventId: e })
      .then(
        () => undefined,
        (err: unknown) => {
          if (!(err instanceof QueueStoreUnavailable)) this.logger?.error({ err, eventId: e }, 'RB-05 복제 확인 실패');
        },
      )
      .finally(() => this.#confirming.delete(e));
    this.#confirming.set(e, p);
  }

  /** 뒤에서 도는 RB-05 복제 확인이 끝나기를 기다린다(멈출 때와 시험) */
  async confirmsSettled(): Promise<void> {
    await Promise.all([...this.#confirming.values()]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.confirmsSettled();
  }

  /** 선점 풀기는 덤이다: 대기열 Redis가 잠시 안 되면 선점 수명이 지나 풀린다. pid를 주지 않으면 앞 키 */
  async #release(c: Ctx, pid: string = c.pid): Promise<void> {
    try {
      await this.store.release({ pid, eventId: c.i.eventId, requestId: c.requestId });
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
