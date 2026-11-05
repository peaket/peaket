// 엣지 매진 표시를 notice의 판으로 맞춘다(docs/features/queue-admission.md §4 '엣지 매진 표시와 좌석 수 칸의 첫 구현', ADR-0219 결정 2·3).
// - 판매 상태 받기(ApplySaleChange)가 매진 판이면 notice보다 먼저(pre), notice를 쓴 뒤 그 지금 판으로(current) 부른다.
// - 쓰기는 차단기(@peaket/platform createCircuitBreaker, 의존성 edge-kvs)와 마감 2초 [가정] 안에서 한다. 실패해도 던지지 않는다
//   (던지면 그 파티션이 멈춰 다른 회차의 매진 반영과 원본 410이 늦는다). 차단기가 열린 동안은 부르지 않아 처리 줄을 늦추지 않는다.
// - 맞추지 못한 회차와 notice보다 큰 판이 저장된 회차는 따로 두고, 파드 안 반복(5초 [가정])이 notice의 지금 판을 다시 읽어 다시 쓴다.
//   그래서 파티션이 다른 파드로 넘어간 회차도 저장소가 답하는 대로 셈에서 빠지고, 내는 쪽의 다시 내기(PRF-144) 없이도 다시 맞춘다.
// - 멈춤 스위치(paused)가 켜지면 아무것도 쓰지 않는다(운영자가 손으로 바꾼 엣지 값을 되돌리지 않게).
import { type CircuitBreaker, type Clock, createCircuitBreaker, errorSummary, PlatformConfigError, ProblemError, type Registry } from '@peaket/platform';
import { QueueStoreUnavailable } from '../../entry/index.js';
import {
  EDGE_FLAG_BREAKER,
  EDGE_FLAG_CACHE_MAX,
  EDGE_FLAG_PUT_DEADLINE_MS,
  EDGE_FLAG_RESYNC_BATCH,
  EDGE_FLAG_RESYNC_EVERY_MS,
  EDGE_FLAG_RESYNC_MS,
  type EdgeFlagSignals,
  type EdgePutResult,
  type EdgeSaleFlag,
  type EdgeSaleFlags,
  edgeFlagEntry,
} from '../domain/edge.js';
import type { SaleStates } from '../domain/sale.js';

export interface EdgeFlagSyncOptions {
  logger?: { warn(obj: object, msg?: string): void };
  signals?: EdgeFlagSignals;
  /** 쓰기 마감(기본 2초 [가정], 시험이 줄인다) */
  deadlineMs?: number;
  /** 참이면 엣지를 쓰지 않는다(환경 값 PEAKET_EDGE_SYNC=off, 손으로 엣지를 바꾸는 런북) */
  paused?: () => boolean;
  /** 차단기 지표(circuit_breaker_*)를 낼 곳 */
  registry?: Registry;
  /** 회차의 지금 판매 종료 시각(일정 사본, 없으면 null). 다시 맞출 때 엣지 값의 만료를 지금 일정으로 다시 정한다 */
  untilOf?: (eventId: string) => Promise<number | null>;
  /** 차단기 값 바꾸기(시험이 다른 사례에서 열리지 않게 한다. 운영은 EDGE_FLAG_BREAKER) */
  breaker?: Partial<Record<keyof typeof EDGE_FLAG_BREAKER, number>>;
}

/**
 * 다시 맞출 회차. unsynced: 쓰기가 실패했다. ahead: notice보다 큰 판이 저장돼 있다. recheck: notice를 다시 읽지 못해 앞섬을 아직 모른다(셈에 넣지 않는다).
 * version은 그때 바라던 판이다. 그 판 이상을 쓴 때만 지운다(옛 판 쓰기가 늦게 끝나 새 판의 기록을 지우지 않게)
 */
type Pending = { kind: 'unsynced' | 'ahead' | 'recheck'; want: 'on' | 'off'; version: number; expireAtMs: number };

/** 멈춤 스위치 값: 앞뒤 공백을 빼고 소문자로 맞춘 뒤, off·false·0은 멈춤, on·true·1·빈칸·없음은 켬이다 */
const EDGE_SYNC_OFF = new Set(['off', 'false', '0']);
const EDGE_SYNC_ON = new Set(['', 'on', 'true', '1']);

/**
 * 엣지 맞추기 멈춤 스위치(환경 값 PEAKET_EDGE_SYNC, docs/features/queue-admission.md §4 '멈춤 스위치'). 참이면 멈춤.
 * 그 밖의 값은 시작에 실패한다(손으로 바꾼 엣지 값을 지키려던 잘못 쓴 값이 조용히 켬이 되지 않게. 굴려 바꾸는 배포라 새 파드만 뜨지 못한다)
 * @throws PlatformConfigError 알 수 없는 값
 */
export function edgeSyncPausedFromEnv(env: Record<string, string | undefined>): boolean {
  const v = (env.PEAKET_EDGE_SYNC ?? '').trim().toLowerCase();
  if (EDGE_SYNC_OFF.has(v)) return true;
  if (EDGE_SYNC_ON.has(v)) return false;
  throw new PlatformConfigError('PEAKET_EDGE_SYNC는 off·false·0(멈춤)이나 on·true·1·빈칸(켬)이어야 한다(대소문자·앞뒤 공백은 무시한다)');
}

export class EdgeFlagSync {
  /** 파드가 마지막으로 맞춘 값(회차마다 켬·끔, 판 번호, 쓴 때의 단조 시각) */
  readonly #synced = new Map<string, { soldOut: boolean; version: number; atMs: number }>();
  /** 맞추지 못한 회차(unsynced)와 notice보다 큰 판이 저장된 회차(ahead). 다시 맞추기가 본다 */
  readonly #pending = new Map<string, Pending>();
  readonly #breaker: CircuitBreaker;
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;

  constructor(
    private readonly edge: EdgeSaleFlags,
    private readonly states: Pick<SaleStates, 'current'>,
    private readonly clock: Clock,
    private readonly o: EdgeFlagSyncOptions = {},
  ) {
    this.#breaker = createCircuitBreaker({ service: 'queue-svc', dependency: 'edge-kvs', clock, ...EDGE_FLAG_BREAKER, ...o.breaker, ...(o.registry ? { registry: o.registry } : {}) });
  }

  /** 매진 판을 notice보다 먼저 켠다. 저장된 판이 더 크면(그 판이 notice보다 옛 판) 그대로 두고 뒤의 current가 정한다 */
  async pre(eventId: string, f: EdgeSaleFlag): Promise<void> {
    if (this.#paused()) return;
    await this.#write(eventId, f, false);
    this.#report();
  }

  /** notice의 지금 판으로 맞춘다. 저장된 판이 그보다 크면 따로 센다(꾸민 값이거나 notice를 잃었다) */
  async current(eventId: string, f: EdgeSaleFlag): Promise<void> {
    if (this.#paused()) return;
    await this.#write(eventId, f, true);
    this.#report();
  }

  /** 다시 맞추기 한 번: 따로 둔 회차를 notice의 지금 판으로 다시 쓴다. notice가 없거나 엣지 값의 만료가 지난 회차는 뺀다 */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      if (this.#paused()) return;
      const now = this.clock.now();
      for (const eventId of [...this.#pending.keys()].slice(0, EDGE_FLAG_RESYNC_BATCH)) {
        try {
          await this.#resync(eventId, now);
        } finally {
          // 본 회차는 뒤로 보낸다(안 풀리는 회차가 앞에 쌓여도 뒤 회차가 굶지 않게)
          const p = this.#pending.get(eventId);
          if (p) {
            this.#pending.delete(eventId);
            this.#pending.set(eventId, p);
          }
        }
      }
    } finally {
      this.#ticking = false;
      this.#report();
    }
  }

  /** 한 회차 다시 맞추기: 지금 일정의 판매 종료로 만료를 다시 정하고, notice의 지금 판을 쓴다. 대기열 Redis가 잠시 안 되면 다음 주기에 다시 본다 */
  async #resync(eventId: string, now: number): Promise<void> {
    const p = this.#pending.get(eventId);
    if (!p) return;
    let expireAtMs = p.expireAtMs;
    let cur: { state: string; version: number } | null;
    try {
      const until = this.o.untilOf ? await this.o.untilOf(eventId) : null;
      if (until !== null) expireAtMs = until;
      cur = await this.states.current(eventId);
    } catch (err) {
      if (err instanceof QueueStoreUnavailable) return;
      throw err;
    }
    if (expireAtMs <= now || cur === null) {
      this.#pending.delete(eventId);
      return;
    }
    await this.#write(eventId, { soldOut: cur.state === 'SOLD_OUT', version: cur.version, expireAtMs }, true, true);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch((err: unknown) => this.o.logger?.warn({ dep: 'edge-kvs', err: errorSummary(err) }, '엣지 매진 표시 다시 맞추기 실패'));
    }, EDGE_FLAG_RESYNC_EVERY_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#breaker.shutdown();
  }

  #paused(): boolean {
    if (!this.o.paused?.()) return false;
    // 멈춘 동안은 맞추지 않으므로 따로 둔 것도 버린다(풀린 뒤 사건과 다시 맞추기가 다시 정한다)
    if (this.#pending.size > 0) {
      this.#pending.clear();
      this.#report();
    }
    this.#synced.clear();
    return true;
  }

  /** 쓴다. 파드가 60초 안에 같은 값을 맞췄으면 쓰지 않는다(force는 다시 맞추기). 실패는 던지지 않고 센다 */
  async #write(eventId: string, f: EdgeSaleFlag, isCurrent: boolean, force = false): Promise<void> {
    const mono = this.clock.monotonicMs();
    const last = this.#synced.get(eventId);
    if (!force && last && last.soldOut === f.soldOut && last.version === f.version && mono - last.atMs < EDGE_FLAG_RESYNC_MS) return;
    const want = f.soldOut ? 'on' : 'off';
    let result: EdgePutResult;
    try {
      result = await this.#breaker.run(() => withDeadline(this.edge.put(edgeFlagEntry(eventId, f)), this.o.deadlineMs ?? EDGE_FLAG_PUT_DEADLINE_MS));
    } catch (err) {
      this.#synced.delete(eventId);
      this.#mark(eventId, { kind: 'unsynced', want, version: f.version, expireAtMs: f.expireAtMs });
      // 차단기가 열려 부르지 않은 것은 실패로 세지 않는다(부르지 않았다). 값(사건 본문)은 싣지 않는다. 회차 ID는 공개 값이다
      if (err instanceof ProblemError && err.status === 503) return;
      this.o.logger?.warn({ dep: 'edge-kvs', eventId, want, version: f.version, err: errorSummary(err) }, '엣지 매진 표시를 맞추지 못했다(다시 맞추기가 다시 한다)');
      this.o.signals?.failed();
      return;
    }
    if (result === 'NEWER_STORED') {
      // 매진 판의 '엣지 먼저'(그 판이 notice보다 옛 판)는 뒤의 current가 정한다. 파드가 맞춘 값은 그대로 둔다
      if (isCurrent) await this.#newerStored(eventId, f, want);
      return;
    }
    this.#synced.delete(eventId);
    this.#synced.set(eventId, { soldOut: f.soldOut, version: f.version, atMs: mono });
    while (this.#synced.size > EDGE_FLAG_CACHE_MAX) this.#synced.delete(this.#synced.keys().next().value!);
    // 그 판 이상을 바라던 기록만 지운다(옛 판 쓰기가 늦게 끝나 새 판의 기록을 지우지 않게)
    const prev = this.#pending.get(eventId);
    if (prev && prev.version <= f.version) this.#pending.delete(eventId);
  }

  /**
   * 저장된 판이 쓰려던 판보다 크다: notice를 다시 읽어 정말 notice보다 큰지 본다. 읽은 뒤 처리기가 더 큰 판을 썼으면(notice가 쓰려던 판보다 크다)
   * 이쪽이 옛 판을 쓰려던 것이라 세지 않는다. 다시 읽지 못하면 recheck로 두고 다음 다시 맞추기가 본다
   */
  async #newerStored(eventId: string, f: EdgeSaleFlag, want: 'on' | 'off'): Promise<void> {
    let cur: { state: string; version: number } | null;
    try {
      cur = await this.states.current(eventId);
    } catch {
      this.#mark(eventId, { kind: 'recheck', want, version: f.version, expireAtMs: f.expireAtMs });
      return;
    }
    if (cur !== null && cur.version > f.version) return;
    this.#synced.delete(eventId);
    if (this.#pending.get(eventId)?.kind !== 'ahead') {
      this.o.logger?.warn({ dep: 'edge-kvs', eventId, want, version: f.version, stored: 'newer' }, 'notice보다 큰 판의 엣지 매진 표시가 있어 바꾸지 못했다(손으로 지운다, ADR-0219)');
    }
    this.#mark(eventId, { kind: 'ahead', want, version: f.version, expireAtMs: f.expireAtMs });
  }

  /** 기록을 넣는다. 이미 더 큰 판을 바라던 기록이 있으면 그것을 둔다 */
  #mark(eventId: string, p: Pending): void {
    const prev = this.#pending.get(eventId);
    if (prev && prev.version > p.version) return;
    this.#pending.set(eventId, p);
  }

  /** 맞추지 못한 회차 수(바라는 값별)와 notice보다 큰 판이 저장된 회차 수를 낸다. 엣지 값의 만료(판매 종료)가 지난 회차는 뺀다 */
  #report(): void {
    const now = this.clock.now();
    let on = 0;
    let off = 0;
    let ahead = 0;
    for (const [id, p] of this.#pending) {
      if (p.expireAtMs <= now) this.#pending.delete(id);
      else if (p.kind === 'recheck') continue;
      else if (p.kind === 'ahead') ahead++;
      else if (p.want === 'on') on++;
      else off++;
    }
    this.o.signals?.unsynced('on', on);
    this.o.signals?.unsynced('off', off);
    this.o.signals?.ahead(ahead);
  }
}

/** 마감 안에 끝나지 않으면 실패로 본다(어댑터도 같은 마감을 건다. 이쪽은 어댑터가 멈춰도 처리 줄을 붙잡지 않게 하는 두 번째 끈) */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`엣지 매진 표시 쓰기가 ${ms}ms 안에 끝나지 않았다`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
