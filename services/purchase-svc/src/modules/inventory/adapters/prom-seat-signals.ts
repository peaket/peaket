// 좌석 Lua·만료 반복 지표(BUILD_ORDER PRF-135 'PRF-130 리뷰 낮음 4'·추천 적용 2026-11-04 M1, 경보 행은 docs/observability.md).
// 이름표는 값이 몇 개뿐인 것만 단다(observability §8). queue-svc adapters/prom-admission-signals.ts와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, Gauge, Histogram, type Registry } from '@peaket/platform';
import type { HoldReleaseReason } from '../domain/hold-lifecycle.js';
import type { SweepOutcome } from '../domain/expiry.js';
import type { SeatLuaErrorCode, SeatLuaScript } from '../domain/lua-errors.js';
import type { SeatSignals, SeatStreamRelaySignals } from '../domain/ports.js';
import type { SessionEndReason } from '../domain/purchase-session.js';
import type { StreamDropReason, TradeTopic } from '../domain/seat-event.js';

/**
 * SeatSignals(와 다시 만들기의 SeatRebuilderSignals)의 Prometheus 구현. 이름표에 회차 ID·계정 ID·키 이름을 달지 않는다.
 * - seat_lua_errors_total{script, code}(카운터, script는 SeatLuaScript, code는 SeatLuaErrorCode의 값만)
 * - seat_expiry_lag_seconds(게이지, 이름표 없음): 이 파드가 마지막 틱에 돈 회차 가운데 지금 − 가장 오래된 지난 점수(초)의 최댓값, 밀린 것이 없으면 0(M1)
 * - seat_expiry_ticks_total{outcome}(카운터, outcome은 SweepOutcome의 값만): 회차의 틱 결과마다 1(M1)
 * - purchase_sessions_ended_total{reason}(카운터, reason은 COMPLETED·LEFT·IDLE·MAX_STAY): 구매 세션을 끝낼 때마다 1(BUILD_ORDER PRF-138)
 * - seat_hold_deferred_total{reason}(카운터, reason은 not_ready·store_unavailable): 홀드 요청을 503으로 미룰 때마다 1(BUILD_ORDER PRF-143)
 * - seat_rebuild_total{result}(카운터, result는 rebuilt·ready·busy·failed): 다시 만들기(RB-06) 한 회차의 결과마다 1(BUILD_ORDER PRF-143).
 *   rebuilt 메서드가 application/seat-rebuilder.ts의 SeatRebuilderSignals 모양이라 SeatRebuilder의 signals로 그대로 넘긴다(어댑터가 응용 층을 가져오지 않게 implements는 달지 않는다)
 * - 좌석 Stream 릴레이(SeatStreamRelaySignals, BUILD_ORDER PRF-164: 릴레이 프로세스가 이 클래스를 relay 레지스트리에 붙여 SeatStreamRelay의 signals로 넘긴다):
 *   seat_stream_relay_sent_total{topic}(카운터, topic은 TradeTopic의 값만), seat_stream_relay_dropped_total{reason}(카운터, reason은 StreamDropReason의 값만),
 *   seat_stream_relay_failures_total{stage}(카운터, stage는 read·publish·ack). 이름·뜻은 docs/observability.md. register()가 다른 지표와 함께 붙인다
 * - seat_epoch_bumps_total(카운터, 이름표 없음): 장애 조치 뒤 회차 세대를 올린 수(BUILD_ORDER PRF-168). 좌석을 쓰는 Lua와 세대 올리기 Lua가 올린 것을 모두 센다:
 *   세대 올리기 감시(SeatEpochWatch)가 회차마다 세대 키 bumps 칸의 지난번 값과의 차이 n으로 epochBumped(n)을 부른다(ADR-0210, 리뷰 고침 중간 1).
 *   epochBumped 메서드가 application/seat-epoch-watch.ts의 SeatEpochWatchSignals 모양이라 감시의 signals로 그대로 넘긴다
 */
export class PromSeatSignals implements SeatSignals, SeatStreamRelaySignals {
  readonly #luaErrors = new Counter({
    name: 'seat_lua_errors_total',
    help: '좌석 Lua 오류·NOT_READY 수(script: hold·expire, code: CORRUPT_KEY·KEEP_UNTIL_PAST·FENCE_OVERFLOW·NODE_ID·OOM·NOT_READY·OTHER)',
    labelNames: ['script', 'code'] as const,
    registers: [],
  });
  readonly #released = new Counter({ name: 'seat_hold_released_total', help: '직접·세션 끝·예매 제한으로 푼 좌석 수(reason: user·left·idle·max_stay·restricted)', labelNames: ['reason'] as const, registers: [] });
  readonly #extended = new Counter({ name: 'seat_hold_extended_total', help: '1회 연장한 홀드 수', registers: [] });
  readonly #freezeTotal = new Counter({ name: 'seat_hold_freeze_total', help: '결제 정지 옮기기·되돌리기 좌석 수(op: freeze·thaw, result: moved·dropped·corrupt)', labelNames: ['op', 'result'] as const, registers: [] });
  readonly #freezeSeconds = new Histogram({ name: 'seat_hold_freeze_batch_seconds', help: '옮기기·되돌리기 묶음 하나의 앱 쪽 시간(초)', labelNames: ['op'] as const, buckets: [0.001, 0.002, 0.005, 0.01, 0.05, 0.1], registers: [] });
  readonly #pauseReads = new Counter({ name: 'seat_payment_pause_read_total', help: '새 결제 일시 정지 조회 결과(result: ok·stale·failed)', labelNames: ['result'] as const, registers: [] });
  readonly #frozen = new Gauge({ name: 'seat_frozen_holds', help: '이 파드가 본 회차의 멈춘 좌석 수 합', registers: [] });
  readonly #lag = new Gauge({ name: 'seat_expiry_lag_seconds', help: '이 파드가 돈 회차 가운데 지금 − 가장 오래된 지난 만료 점수(초). 밀린 것이 없으면 0', registers: [] });
  readonly #ticks = new Counter({ name: 'seat_expiry_ticks_total', help: '만료 반복의 회차별 틱 결과 수', labelNames: ['outcome'] as const, registers: [] });

  readonly #sessionEnds = new Counter({ name: 'purchase_sessions_ended_total', help: '끝낸 구매 세션 수(reason: COMPLETED·LEFT·IDLE·MAX_STAY)', labelNames: ['reason'] as const, registers: [] });
  readonly #deferred = new Counter({ name: 'seat_hold_deferred_total', help: '503으로 미룬 홀드 요청 수(reason: not_ready·store_unavailable)', labelNames: ['reason'] as const, registers: [] });
  readonly #rebuilds = new Counter({ name: 'seat_rebuild_total', help: '좌석 Redis 다시 만들기(RB-06) 결과 수(result: rebuilt·ready·busy·failed)', labelNames: ['result'] as const, registers: [] });

  readonly #relaySent = new Counter({
    name: 'seat_stream_relay_sent_total',
    help: '좌석 Redis Stream 릴레이가 Kafka 확인을 받아 지운 항목 수(topic: trade.seats·trade.purchase-sessions)',
    labelNames: ['topic'] as const,
    registers: [],
  });
  readonly #relayDropped = new Counter({
    name: 'seat_stream_relay_dropped_total',
    help: '보낼 수 없어 확인해 넘긴 좌석 Stream 항목 수(reason: unknown_type·malformed·unmapped_seat)',
    labelNames: ['reason'] as const,
    registers: [],
  });
  readonly #relayFailures = new Counter({
    name: 'seat_stream_relay_failures_total',
    help: '좌석 Stream 릴레이가 실패한 틱 수(stage: read·publish·ack)',
    labelNames: ['stage'] as const,
    registers: [],
  });
  readonly #epochBumps = new Counter({
    name: 'seat_epoch_bumps_total',
    help: '장애 조치 뒤 회차 세대를 올린 수(좌석을 쓰는 Lua와 세대 올리기 감시가 올린 것 모두, 세대 키 bumps의 차이. 장애 조치 한 번에 많아야 그 샤드(주 노드)의 회차 수만큼)',
    registers: [],
  });

  /** 지표를 registry에 붙이고 자신을 돌려준다(main.ts가 service.metrics.registry로, 릴레이 프로세스가 relay 레지스트리로 한 번 부른다) */
  register(registry: Registry): this {
    for (const m of [
      this.#luaErrors,
      this.#lag,
      this.#ticks,
      this.#sessionEnds,
      this.#deferred,
      this.#rebuilds,
      this.#relaySent,
      this.#relayDropped,
      this.#relayFailures,
      this.#epochBumps,
      this.#released,
      this.#extended,
      this.#freezeTotal,
      this.#freezeSeconds,
      this.#pauseReads,
      this.#frozen,
    ]) {
      registry.registerMetric(m);
    }
    return this;
  }

  /** seat_lua_errors_total{script, code}를 1 올린다. 던지지 않는다(붙이기 전에도 센다) */
  holdReleased(reason: HoldReleaseReason, seats: number): void {
    this.#released.inc({ reason }, seats);
  }

  holdExtended(): void {
    this.#extended.inc();
  }

  holdFreezeBatch(op: 'freeze' | 'thaw', r: { moved: number; dropped: number; corrupt: number }, seconds: number): void {
    this.#freezeTotal.inc({ op, result: 'moved' }, r.moved);
    this.#freezeTotal.inc({ op, result: 'dropped' }, r.dropped);
    this.#freezeTotal.inc({ op, result: 'corrupt' }, r.corrupt);
    this.#freezeSeconds.observe({ op }, seconds);
  }

  pauseRead(result: 'ok' | 'stale' | 'failed'): void {
    this.#pauseReads.inc({ result });
  }

  frozenHolds(n: number): void {
    this.#frozen.set(n);
  }

  luaError(script: SeatLuaScript, code: SeatLuaErrorCode): void {
    this.#luaErrors.inc({ script, code });
  }

  /** seat_expiry_lag_seconds를 seconds(0 이상)로 둔다 */
  expiryLag(seconds: number): void {
    this.#lag.set(Math.max(0, seconds));
  }

  /** seat_expiry_ticks_total{outcome}을 1 올린다 */
  expiryTick(outcome: SweepOutcome): void {
    this.#ticks.inc({ outcome });
  }

  /** purchase_sessions_ended_total{reason}을 1 올린다 */
  sessionEnded(reason: SessionEndReason): void {
    this.#sessionEnds.inc({ reason });
  }

  /** seat_hold_deferred_total{reason}을 1 올린다. 던지지 않는다(붙이기 전에도 센다) */
  holdDeferred(reason: 'not_ready' | 'store_unavailable'): void {
    this.#deferred.inc({ reason });
  }

  /** seat_rebuild_total{result}을 1 올린다(SeatRebuilderSignals). 던지지 않는다 */
  rebuilt(result: 'rebuilt' | 'ready' | 'busy' | 'failed'): void {
    this.#rebuilds.inc({ result });
  }

  /** seat_stream_relay_sent_total{topic}을 n 올린다(SeatStreamRelaySignals). 던지지 않는다 */
  sent(topic: TradeTopic, n: number): void {
    this.#relaySent.inc({ topic }, n);
  }

  /** seat_stream_relay_dropped_total{reason}을 1 올린다(SeatStreamRelaySignals). 던지지 않는다 */
  dropped(reason: StreamDropReason): void {
    this.#relayDropped.inc({ reason });
  }

  /** seat_stream_relay_failures_total{stage}을 1 올린다(SeatStreamRelaySignals). 던지지 않는다 */
  failed(stage: 'read' | 'publish' | 'ack'): void {
    this.#relayFailures.inc({ stage });
  }

  /** seat_epoch_bumps_total을 n(1 이상의 정수, 감시가 본 bumps 차이) 올린다(SeatEpochWatchSignals, BUILD_ORDER PRF-168). 던지지 않는다(붙이기 전에도 센다) */
  epochBumped(n: number): void {
    this.#epochBumps.inc(n);
  }
}
