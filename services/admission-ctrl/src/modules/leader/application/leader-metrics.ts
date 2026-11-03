// 리더 지표(docs/observability.md §8, ADR-0104 결정 6, ADR-0182 결정 8). 회차 이름표는 진행 중인 회차만큼만 생긴다.
import { Counter, Gauge, Histogram, LATENCY_BUCKETS_SECONDS, type Registry } from '@peaket/platform';
import type { TickResult } from '../domain/ports.js';

export const LEADER_METRICS = Symbol('admission.LeaderMetrics');

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

  register(registry: Registry): this {
    for (const m of [this.#inFlight, this.#ratio, this.#soon, this.#dropped, this.#loop, this.#leader, this.#fenced, this.#leaseFailures, this.#publish]) registry.registerMetric(m);
    return this;
  }

  event(eventId: string, r: Extract<TickResult, { kind: 'OK' }>): void {
    this.#inFlight.set({ event_id: eventId }, r.inFlight);
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
  }
}
