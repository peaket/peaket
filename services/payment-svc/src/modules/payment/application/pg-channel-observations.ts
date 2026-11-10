// 포트원 채널의 관측 하위 결제사 표를 파드 메모리에 두는 캐시와, 그것으로 전환의 대체 후보에서 뺄 수단을 셈하는 읽기
// (docs/features/payment.md §2.2 '하위 결제사 검사의 첫 구현', BUILD_ORDER PRF-203).
// 정지 행 캐시(entry-pause-cache.ts)와 같은 꼴이다: 1초 [가정] 수명(단조 시계), 겹친 호출은 읽기 하나를 함께 기다림, 저장소 읽기는 고정 150ms [가정],
// 읽기가 실패하면 10초 [가정] 안의 마지막 값을 쓰고, 그런 값이 없으면 값을 지어내지 않고 실패한다(ASVS v5.0.0-16.5.3).
// 저장소 읽기가 클라이언트 시간 한도 300ms [가정] 안에 끝나지 않으면(응답이 끊긴 연결) 읽기 실패로 보고 다음 호출이 새로 읽는다(코드 리뷰 F4).
import type { Clock } from '@peaket/platform';
import { PaymentDeadlineError } from '../domain/confirm-command.js';
import type { PayMethod, PgName } from '../domain/payment-gateway.js';
import { excludedFallbackMethods, type PortoneChannelMap } from '../domain/pg-sub-provider.js';
import type { CallBudget, FallbackExclusionReader, PgChannelObservationReader, PgChannelObservedSignals } from '../domain/ports.js';
import { withClientTimeout } from './client-timeout.js';

/** 관측 표를 다시 읽는 간격 1초 [가정] */
export const PG_CHANNEL_OBSERVED_TTL_MS = 1_000;
/** 저장소 읽기 하나에 주는 시간 150ms [가정](결제창 준비의 데드라인 300ms 안) */
export const PG_CHANNEL_OBSERVED_READ_BUDGET_MS = 150;
/** 읽기가 실패해도 마지막 값을 쓸 수 있는 나이 10초 [가정](정지 행 캐시와 같다) */
export const PG_CHANNEL_OBSERVED_MAX_STALE_MS = 10_000;
/** 저장소 읽기의 클라이언트 시간 한도 300ms [가정](문장 한도 150ms에 연결 받기·BEGIN 여유) */
export const PG_CHANNEL_OBSERVED_CLIENT_TIMEOUT_MS = 300;
const MAX_TIMER_MS = 2_147_483_647;

export interface CachedPgChannelObservationsOptions {
  readonly reader: PgChannelObservationReader;
  readonly clock: Pick<Clock, 'monotonicMs'>;
  readonly signals: Pick<PgChannelObservedSignals, 'channelObservedFailed'>;
  readonly ttlMs?: number;
}

type Observed = ReadonlyMap<string, string>;

export class CachedPgChannelObservations implements PgChannelObservationReader {
  #expiresAtMs = Number.NEGATIVE_INFINITY;
  #last: Observed | undefined;
  #lastAtMs = Number.NEGATIVE_INFINITY;
  #inFlight: Promise<Observed> | undefined;

  constructor(private readonly o: CachedPgChannelObservationsOptions) {}

  /**
   * @param budget 이 호출이 기다릴 시한(저장소 읽기의 시한이 아니다)
   * @throws PaymentDeadlineError 쓸 수 있는 마지막 값이 없는데 시한 안에 읽기가 끝나지 않음 · Error 쓸 수 있는 값이 없고 읽기가 실패함
   */
  readAll(budget?: CallBudget): Promise<Observed> {
    const nowMs = this.o.clock.monotonicMs();
    const last = this.#usable(nowMs);
    if (last !== undefined && nowMs < this.#expiresAtMs) return Promise.resolve(last);
    return this.#within(this.#inFlight ?? this.#load(nowMs), budget);
  }

  /** 수명을 끝낸다(관측 값을 쓴 뒤 다음 읽기가 새로 읽게) */
  invalidate(): void {
    this.#expiresAtMs = Number.NEGATIVE_INFINITY;
    this.#inFlight = undefined;
  }

  #load(nowMs: number): Promise<Observed> {
    this.#expiresAtMs = nowMs + (this.o.ttlMs ?? PG_CHANNEL_OBSERVED_TTL_MS);
    const value: Promise<Observed> = withClientTimeout(this.o.reader.readAll({ remainingMs: PG_CHANNEL_OBSERVED_READ_BUDGET_MS }), PG_CHANNEL_OBSERVED_CLIENT_TIMEOUT_MS).then(
      (rows) => {
        if (this.#inFlight === value) {
          this.#last = rows;
          this.#lastAtMs = nowMs;
          this.#inFlight = undefined;
        }
        return rows;
      },
      (err: unknown) => {
        try {
          this.o.signals.channelObservedFailed('read');
        } catch {
          // 지표가 읽기를 막지 않는다
        }
        if (this.#inFlight === value) this.#inFlight = undefined;
        const last = this.#usable(this.o.clock.monotonicMs());
        if (last === undefined) {
          this.#expiresAtMs = Number.NEGATIVE_INFINITY;
          throw err;
        }
        return last;
      },
    );
    this.#inFlight = value;
    return value;
  }

  #usable(nowMs: number): Observed | undefined {
    return nowMs - this.#lastAtMs <= PG_CHANNEL_OBSERVED_MAX_STALE_MS ? this.#last : undefined;
  }

  #within(value: Promise<Observed>, budget: CallBudget | undefined): Promise<Observed> {
    if (budget === undefined || budget.remainingMs === Number.POSITIVE_INFINITY) return value;
    return new Promise<Observed>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const last = this.#usable(this.o.clock.monotonicMs());
          if (last === undefined) reject(new PaymentDeadlineError());
          else resolve(last);
        },
        Math.min(Math.max(0, budget.remainingMs), MAX_TIMER_MS),
      );
      void value.finally(() => clearTimeout(timer)).then(resolve, reject);
    });
  }
}

/** 관측 표와 설정의 채널 표로 전환의 대체 후보에서 뺄 포트원 수단을 셈한다(관측 불일치와 기준 결제사와의 하위 결제사 규칙, 코드 리뷰 F1) */
export class PortoneFallbackExclusions implements FallbackExclusionReader {
  readonly pg = 'PORTONE' as const;

  constructor(private readonly o: { readonly portone: PortoneChannelMap; readonly observations: PgChannelObservationReader }) {}

  async read(base: PgName, budget?: CallBudget): Promise<ReadonlySet<PayMethod>> {
    return excludedFallbackMethods(this.o.portone, await this.o.observations.readAll(budget), base);
  }
}
