// 판매 자격 명단 운영 지표(docs/features/queue-admission.md §3 '판매 자격 명단' 운영 확인 표, 리뷰 C2·D6).
// - sale_eligibility_upload_total{result}: 올리기 결과(ok·locked·rejected·lookup_unavailable)
// - sale_eligibility_copy_total{result}: 사본 넘기기·지우기 결과(ok·failed)
// - sale_eligibility_copy_pending: 넘기지 못한 명단과 다시 지울 기록의 수(정비 일이 센다. 잠금 시각이 지났는데 0보다 크면 SEV2)
// 서비스 프로세스(올리기·커밋 뒤 사본)와 relay 프로세스(정비 일)가 각자 한 벌을 만들어 자기 등록부에 단다.
import { Counter, Gauge, type Registry } from '@peaket/platform';

export type UploadResult = 'ok' | 'locked' | 'rejected' | 'lookup_unavailable';

export class SaleEligibilityMetrics {
  readonly #upload = new Counter({ name: 'sale_eligibility_upload_total', help: '판매 자격 명단 올리기 결과(result: ok·locked·rejected·lookup_unavailable)', labelNames: ['result'] as const, registers: [] });
  readonly #copy = new Counter({ name: 'sale_eligibility_copy_total', help: '판매 자격 명단 사본 넘기기·지우기 결과(result: ok·failed)', labelNames: ['result'] as const, registers: [] });
  readonly #pending = new Gauge({ name: 'sale_eligibility_copy_pending', help: '넘기지 못한 판매 자격 명단과 다시 지울 사본 기록의 수(정비 일이 센다)', registers: [] });

  register(registry: Registry): this {
    for (const m of [this.#upload, this.#copy, this.#pending]) registry.registerMetric(m);
    return this;
  }

  upload(result: UploadResult): void {
    this.#upload.inc({ result });
  }

  copy(result: 'ok' | 'failed'): void {
    this.#copy.inc({ result });
  }

  pending(n: number): void {
    this.#pending.set(n);
  }
}
