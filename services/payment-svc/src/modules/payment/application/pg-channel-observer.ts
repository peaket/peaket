// 포트원 결제 답의 하위 결제사를 설정과 견주는 관측기(docs/features/payment.md §2.2 '하위 결제사 검사의 첫 구현', P-T46 ④, BUILD_ORDER PRF-203).
// 포트원 어댑터가 승인 뒤 조회·단독 조회의 200 답에서 읽은 channel을 알린다(onChannel). 결제 처리는 기다리지 않는다(던지지 않고 비동기로 쓴다).
// - 답에 채널 키가 없으면 쓰는 채널 키가 하나일 때만 그 키로 본다(공식 스키마에서 key는 필수가 아니다). 여럿이거나 쓰지 않는 채널 키의 답이면 unattributed다.
// - 설정 값과 다르면 SEV2 한 줄(파드마다 채널·관측 값마다 한 번)과 지표를 내고 관측 표에 쓴다. 쓰기는 표의 값이 관측 값과 다를 때만이다.
//   설정 값과 같은 관측은 표를 쓰지 않는다(행을 지우거나 덮지 않는다): 옛 결제의 답이 남은 빼기를 풀지 않게(BUILD_ORDER PRF-203 코드 리뷰 F3).
import type { Clock } from '@peaket/platform';
import { safeErrorCode } from '../../../safe-error-code.js';
import type { PayMethod } from '../domain/payment-gateway.js';
import { channelKeysInUse, type PortoneChannelMap } from '../domain/pg-sub-provider.js';
import type { PgChannelObservationReader, PgChannelObservationStore, PgChannelObservedOutcome, PgChannelObservedSignals, PgChannelObserverLog } from '../domain/ports.js';
import { withClientTimeout } from './client-timeout.js';

/** 관측 값 쓰기의 클라이언트 시간 한도 600ms [가정](문장 한도 400ms에 여유. 걸린 연결이 종료를 멈추지 않게, 코드 리뷰 F4) */
export const PG_CHANNEL_OBSERVED_WRITE_CLIENT_TIMEOUT_MS = 600;

/** 포트원 어댑터가 알리는 답의 채널(SelectedChannel의 key·pgProvider) */
export interface PortoneObservedChannel {
  readonly key?: string;
  readonly pgProvider: string;
}

export interface PgChannelObserverDeps {
  readonly portone: PortoneChannelMap;
  /** 관측 표의 1초 캐시(쓴 뒤 무효화한다) */
  readonly observations: PgChannelObservationReader & { invalidate(): void };
  readonly store: PgChannelObservationStore;
  readonly clock: Pick<Clock, 'now'>;
  readonly signals: PgChannelObservedSignals;
  readonly log: PgChannelObserverLog;
}

export class PgChannelObserver {
  readonly #inflight = new Set<Promise<void>>();
  readonly #logged = new Set<string>();
  readonly #keys: ReadonlySet<string>;

  constructor(private readonly deps: PgChannelObserverDeps) {
    this.#keys = channelKeysInUse(deps.portone);
  }

  /** 답의 채널 하나를 본다. 던지지 않는다 */
  observe(c: PortoneObservedChannel): void {
    try {
      this.#observe(c);
    } catch {
      // 관측이 결제를 막지 않는다
    }
  }

  /** 돌고 있는 관측 표 쓰기가 모두 끝나면 풀린다 */
  async whenIdle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  #observe(c: PortoneObservedChannel): void {
    const key = c.key ?? (this.#keys.size === 1 ? [...this.#keys][0] : undefined);
    if (key === undefined || !this.#keys.has(key)) return this.#count('unattributed');
    const configured = this.deps.portone.providers.get(key);
    if (configured === undefined) return this.#count('unconfigured');
    const mismatch = c.pgProvider !== configured;
    this.#count(mismatch ? 'mismatch' : 'match');
    if (mismatch) {
      const tag = `${key}\u0000${c.pgProvider}`;
      if (!this.#logged.has(tag)) {
        this.#logged.add(tag);
        this.deps.log.providerMismatch({ configured, observed: c.pgProvider, payMethods: this.#methodsOf(key) });
      }
    }
    if (!mismatch) return;
    const p = this.#record(key, c.pgProvider);
    this.#inflight.add(p);
    void p.finally(() => this.#inflight.delete(p));
  }

  async #record(key: string, observed: string): Promise<void> {
    let table: ReadonlyMap<string, string>;
    try {
      table = await this.deps.observations.readAll();
    } catch (err) {
      this.deps.log.observedFailed({ step: 'read', code: safeErrorCode(err) });
      return;
    }
    if (table.get(key) === observed) return;
    try {
      await withClientTimeout(this.deps.store.upsert(key, observed, this.deps.clock.now()), PG_CHANNEL_OBSERVED_WRITE_CLIENT_TIMEOUT_MS);
      this.deps.observations.invalidate();
    } catch (err) {
      try {
        this.deps.signals.channelObservedFailed('write');
      } catch {
        // 삼킨다
      }
      this.deps.log.observedFailed({ step: 'write', code: safeErrorCode(err) });
    }
  }

  #methodsOf(key: string): PayMethod[] {
    return [...this.deps.portone.byMethod].filter(([, k]) => k === key).map(([m]) => m);
  }

  #count(outcome: PgChannelObservedOutcome): void {
    try {
      this.deps.signals.channelObserved(outcome);
    } catch {
      // 삼킨다
    }
  }
}
