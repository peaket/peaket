// 포트원 플랫폼이 켜진 포트원 지급 갈래(F-07-7 계획 §5.1 (가), ADR-0370 결정 7).
// 수기 정산건 만들기·지급 건·T9·PAYOUT_SCHEDULED 쓰기는 Settlements.executeBatch가 전송(PortonePlatformTransport)으로 직접 하고(한 트랜잭션에 묶어야 하므로),
// 이 갈래는 '포트원 플랫폼이 켜져 있다'는 표시와 전송을 들고 있다. 꺼진 조립은 ManualPortonePayoutGateway(콘솔 실행 기록)다.
import type { PayoutGateway, PayoutSubmitResult, PortonePlatformTransport } from '../domain/ports.js';

export class PortonePlatformPayoutGateway implements PayoutGateway {
  readonly pg = 'PORTONE' as const;
  constructor(readonly transport: PortonePlatformTransport) {}
  async submit(): Promise<PayoutSubmitResult> {
    return { status: 'SUBMITTED', groups: [] };
  }
}
