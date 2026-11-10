// 추가 검증 지표(docs/features/bot-defense.md §15 '추가 검증 제출이 돈다'·'이의가 처리함으로 간다'). 라벨은 가짓수가 적은 result 하나다(사유 범주는 정규 로그 줄에만, §16).
import { Counter, type Registry } from '@peaket/platform';
import type { AppealResult, SubmissionResult, VerificationSignals } from '../domain/ports.js';

export class PromVerificationSignals implements VerificationSignals {
  readonly #submissions = new Counter({
    name: 'queue_verification_submissions_total',
    help: '추가 검증 제출(challengeToken) 결과(passed 통과, challenge_failed 사람 확인 실패, reverify_required 본인확인 재통과 없음, person_mismatch 다른 사람, unavailable trust·identity 무응답 503, rate_limited 제출 한도 429)',
    labelNames: ['result'] as const,
    registers: [],
  });
  readonly #appeals = new Counter({
    name: 'queue_verification_appeals_total',
    help: '추가 검증 이의 접수 결과(accepted 건 요청 발행, duplicate 이미 접수한 이의, publish_failed 발행 실패·2초 넘김 503)',
    labelNames: ['result'] as const,
    registers: [],
  });

  register(registry: Registry): void {
    registry.registerMetric(this.#submissions);
    registry.registerMetric(this.#appeals);
  }

  submission(result: SubmissionResult): void {
    this.#submissions.inc({ result });
  }

  appeal(result: AppealResult): void {
    this.#appeals.inc({ result });
  }
}
