// local·ci 전용 '발행 성공' 대역(PEAKET_CASE_REQUESTS_STUB=accept). Kafka를 띄우지 못하는 PC에서 화면을 실제 queue-svc에 이어 볼 때 쓴다(BAT-200 계획 §3.4 '실제 서버 연결').
// 건 요청을 내지 않고 받은 것으로 친다. 실제 발행은 CI의 Kafka 통합 시험(test-int/case-requests.int.test.ts)이 본다. 시작 파일이 local·ci 밖에서는 이 대역을 거절한다.
import type { CaseRequestPublisher } from '../domain/ports.js';
import type { CaseRequest } from '../domain/verification.js';

export class LocalCaseRequests implements CaseRequestPublisher {
  constructor(private readonly onPublish: (c: CaseRequest) => void = () => undefined) {}

  async publish(c: CaseRequest): Promise<void> {
    this.onPublish(c);
  }
}
