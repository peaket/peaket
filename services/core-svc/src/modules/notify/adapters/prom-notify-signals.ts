// F-06-8 예매 확정 알림 지표. 지표는 registers: []로 만들고 register(registry)로 붙인다(PromOrderSignals와 같은 꼴).
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { NotifySignals } from '../domain/fan-notify-ports.js';

export class PromNotifySignals implements NotifySignals {
  readonly #dueBacklog = new Gauge({
    name: 'delivery_job_due_backlog',
    help: '보낼 때가 지난 낱건 발송 작업 수(정상이면 0에 가깝다)',
    labelNames: ['kind'] as const,
    registers: [],
  });
  readonly #emailSent = new Counter({ name: 'notify_email_send_total', help: '이메일 발송 성공 수(예매 확정)', registers: [] });
  readonly #emailFailed = new Counter({ name: 'notify_email_failures_total', help: '이메일 발송 실패 수(예매 확정)', registers: [] });
  readonly #templateMissing = new Counter({
    name: 'notify_template_missing_total',
    help: '그 언어의 문안이 없어 ko로 보낸 수(예매 확정)',
    labelNames: ['locale'] as const,
    registers: [],
  });
  readonly #latency = new Gauge({
    name: 'notify_delivery_latency_seconds',
    help: '확정 사건을 받은 뒤 실제로 보낸 지연(초, 마지막 값)',
    labelNames: ['kind', 'channel'] as const,
    registers: [],
  });
  readonly #slow = new Counter({
    name: 'notify_delivery_latency_over_5m_total',
    help: '확정 사건을 받은 뒤 5분 [가정]을 넘겨 보낸 수',
    labelNames: ['kind', 'channel'] as const,
    registers: [],
  });
  readonly #dead = new Counter({
    name: 'notify_dead_total',
    help: '끝내 보내지 못한(DEAD) 알림 수(1건이면 SEV3)',
    labelNames: ['kind'] as const,
    registers: [],
  });
  readonly #suppressed = new Counter({
    name: 'notify_suppressed_total',
    help: '보내지 않기로 한 알림 수(not_confirmed·not_allowed)',
    labelNames: ['reason'] as const,
    registers: [],
  });
  readonly #tierMissing = new Counter({ name: 'notify_tier_name_missing_total', help: '등급 이름이 없어 좌석 N매로 적은 수', registers: [] });
  readonly #bookingNoInvalid = new Counter({ name: 'notify_booking_number_invalid_total', help: '예매번호가 없거나 모양이 틀려 작업을 만들지 않은 수(SEV3)', registers: [] });

  register(registry: Registry): this {
    registry.registerMetric(this.#dueBacklog);
    registry.registerMetric(this.#emailSent);
    registry.registerMetric(this.#emailFailed);
    registry.registerMetric(this.#templateMissing);
    registry.registerMetric(this.#latency);
    registry.registerMetric(this.#slow);
    registry.registerMetric(this.#dead);
    registry.registerMetric(this.#suppressed);
    registry.registerMetric(this.#tierMissing);
    registry.registerMetric(this.#bookingNoInvalid);
    return this;
  }

  dueBacklog(kind: string, count: number): void {
    this.#dueBacklog.set({ kind }, count);
  }
  deliveryLatency(kind: string, channel: string, seconds: number): void {
    this.#latency.set({ kind, channel }, seconds);
  }
  templateMissing(locale: string): void {
    this.#templateMissing.inc({ locale });
  }
  emailSent(): void {
    this.#emailSent.inc();
  }
  emailFailed(): void {
    this.#emailFailed.inc();
  }
  dead(kind: string): void {
    this.#dead.inc({ kind });
  }
  latencyOverTarget(kind: string, channel: string, seconds: number): void {
    this.#latency.set({ kind, channel }, seconds);
    this.#slow.inc({ kind, channel });
  }
  suppressed(reason: 'not_confirmed' | 'not_allowed'): void {
    this.#suppressed.inc({ reason });
  }
  tierNameMissing(): void {
    this.#tierMissing.inc();
  }
  bookingNoInvalid(): void {
    this.#bookingNoInvalid.inc();
  }
}
