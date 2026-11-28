// F-06-1 POL-034: 병합 흡수 계정 통지 실패 지표. 실패해도 병합은 계속하고 여기서만 센다.
import { Counter, type Registry } from '@prometheus-io/client';

export class MergeNoticeSignals {
  readonly #failed = new Counter({
    name: 'merge_notice_failed',
    help: '계정 병합 흡수 계정 완료 통지를 보내지 못한 횟수(사유: unavailable·deadline·rejected). 병합은 막지 않는다',
    labelNames: ['reason'] as const,
    registers: [],
  });

  failed(reason: string): void {
    this.#failed.inc({ reason });
  }

  register(registry: Registry): void {
    registry.registerMetric(this.#failed);
  }
}
