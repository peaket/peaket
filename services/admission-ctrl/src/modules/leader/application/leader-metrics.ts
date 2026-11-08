// 리더 지표(docs/observability.md §8, ADR-0104 결정 6, ADR-0182 결정 8). 회차 이름표는 진행 중인 회차만큼만 생긴다.
import { Counter, Gauge, Histogram, LATENCY_BUCKETS_SECONDS, type Registry } from '@peaket/platform';
import { type Decrease, INPUT_KINDS, type Journey } from '../domain/aimd.js';
import type { TickResult } from '../domain/ports.js';

export const LEADER_METRICS = Symbol('admission.LeaderMetrics');

/** 한 주기의 자동 제어 결과(ADR-0226) */
export interface ControlEvent {
  target: number;
  decreases: Decrease[];
  suppressed: number;
  ignored: Journey[];
  staleKinds: string[];
}

export class LeaderMetrics {
  readonly #inFlight = new Gauge({ name: 'admission_in_flight', help: '오는 중(불렀지만 아직 입장 확정을 보내지 않은 것으로 보는 인원)', labelNames: ['event_id'] as const, registers: [] });
  readonly #ratio = new Gauge({ name: 'admission_ratio', help: '입장 비율(불린 지 10~60초인 전진에서 입장 확정을 요청한 비율, 표본이 없으면 1)', labelNames: ['event_id'] as const, registers: [] });
  readonly #soon = new Gauge({ name: 'admission_soon_waiting', help: '곧 입장 대기열 인원', labelNames: ['event_id'] as const, registers: [] });
  readonly #dropped = new Counter({ name: 'admission_soon_dropped_total', help: '다시 오지 않아 곧 입장 대기열에서 뺀 항목 수', registers: [] });
  readonly #loop = new Histogram({ name: 'admission_loop_duration_seconds', help: '리더 루프 한 주기 시간', buckets: [...LATENCY_BUCKETS_SECONDS], registers: [] });
  readonly #leader = new Gauge({ name: 'admission_leader', help: '이 파드가 Lease 리더인가(1/0)', registers: [] });
  readonly #fenced = new Counter({ name: 'admission_fenced_total', help: '더 새 리더 세대가 있어 거절된 리더 쓰기 수', registers: [] });
  readonly #leaseFailures = new Counter({ name: 'admission_lease_renew_failures_total', help: 'Lease 읽기·만들기·고치기 실패 수', registers: [] });
  readonly #publish = new Counter({ name: 'admission_batch_publish_total', help: '묶음 게시 호출 결과(PUBLISHED·REPAIRED·ALREADY·NOT_CLOSED·WAITING_BEACON·WAITING_REPLICA·NO_SCHEDULE)', labelNames: ['status'] as const, registers: [] });

  readonly #arrivalSlots = new Counter({ name: 'admission_arrival_slots_closed_total', help: '진입 Degraded의 도착 시각 칸을 닫은 수', registers: [] });
  readonly #arrivalNumbers = new Counter({ name: 'admission_arrival_numbers_returned_total', help: '닫은 도착 시각 칸에서 빠진 번호로 돌린 번호 수', registers: [] });

  readonly #slots = new Gauge({ name: 'admission_slots_used', help: '예매 단계 지금 인원(입장 자리 수, 지난 자리를 뺀 값)', labelNames: ['event_id'] as const, registers: [] });
  readonly #target = new Gauge({ name: 'admission_target', help: '지금 쓰는 동시 입장 목표(결제사·합산 나누기 뒤, targetNow와 같다)', labelNames: ['event_id'] as const, registers: [] });
  readonly #stale = new Gauge({ name: 'admission_control_input_stale', help: '제어 입력 없음(입력별 1/0)', labelNames: ['event_id', 'input'] as const, registers: [] });
  readonly #decrease = new Counter({ name: 'admission_target_decrease_total', help: '동시 입장 목표 감축 수(사유별, 예산 감축은 여정 포함)', labelNames: ['reason', 'journey'] as const, registers: [] });
  readonly #suppressed = new Counter({ name: 'admission_decrease_suppressed_total', help: '감축 확인 시간 동안 막은 AIMD 감축 수', registers: [] });
  readonly #ignored = new Counter({ name: 'admission_budget_signal_ignored_total', help: '연동 여정이 아니라 감축하지 않은 예산 신호 수', labelNames: ['journey'] as const, registers: [] });
  readonly #openGaps = new Gauge({ name: 'admission_open_gap_violations', help: '진행 중인 회차끼리 오픈 시각이 5분 [가정]보다 가까운 쌍의 수', registers: [] });

  register(registry: Registry): this {
    for (const m of [this.#inFlight, this.#ratio, this.#soon, this.#dropped, this.#loop, this.#leader, this.#fenced, this.#leaseFailures, this.#publish, this.#arrivalSlots, this.#arrivalNumbers, this.#slots, this.#target, this.#stale, this.#decrease, this.#suppressed, this.#ignored, this.#openGaps]) registry.registerMetric(m);
    return this;
  }

  /** 한 주기의 자동 제어 결과(입력 없음·감축·막은 감축·무시한 예산 신호) */
  control(eventId: string, e: ControlEvent): void {
    this.#target.set({ event_id: eventId }, e.target);
    const stale = new Set(e.staleKinds);
    for (const input of INPUT_KINDS) this.#stale.set({ event_id: eventId, input }, stale.has(input) ? 1 : 0);
    for (const d of e.decreases) this.#decrease.inc({ reason: d.reason, journey: d.journey ?? '' });
    if (e.suppressed > 0) this.#suppressed.inc(e.suppressed);
    for (const journey of e.ignored) this.#ignored.inc({ journey });
  }

  openGaps(n: number): void {
    this.#openGaps.set(n);
  }

  arrival(slots: number, returned: number): void {
    if (slots > 0) this.#arrivalSlots.inc(slots);
    if (returned > 0) this.#arrivalNumbers.inc(returned);
  }

  event(eventId: string, r: Extract<TickResult, { kind: 'OK' }>): void {
    this.#inFlight.set({ event_id: eventId }, r.inFlight);
    this.#slots.set({ event_id: eventId }, r.slots);
    this.#soon.set({ event_id: eventId }, r.soon);
    this.#ratio.set({ event_id: eventId }, r.ratio);
    if (r.dropped > 0) this.#dropped.inc(r.dropped);
  }

  loop(seconds: number): void {
    this.#loop.observe(seconds);
  }

  leader(v: boolean): void {
    this.#leader.set(v ? 1 : 0);
  }

  fenced(): void {
    this.#fenced.inc();
  }

  leaseFailure(): void {
    this.#leaseFailures.inc();
  }

  publish(status: string): void {
    this.#publish.inc({ status });
  }

  /** 끝난 회차의 이름표를 지운다(이름표 수가 진행 중인 회차만큼만 남게) */
  forget(eventId: string): void {
    this.#inFlight.remove({ event_id: eventId });
    this.#soon.remove({ event_id: eventId });
    this.#ratio.remove({ event_id: eventId });
    this.#slots.remove({ event_id: eventId });
    this.#target.remove({ event_id: eventId });
    for (const input of INPUT_KINDS) this.#stale.remove({ event_id: eventId, input });
  }
}
