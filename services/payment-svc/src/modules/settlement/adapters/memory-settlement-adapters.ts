// 시험·개발용 정산 어댑터. 실제 결제 원장·KYC·지급대행은 Drizzle/외부 어댑터가 맡는다.
import type { PayoutGateway, PayoutSubmitResult, ReauthVerifier, SettlementPaymentSource, VerifiedReauth } from '../domain/ports.js';
import type { PaymentFact, Pg } from '../domain/settlement.js';
import { SettlementProblem } from '../domain/settlement.js';

export class MemorySettlementPaymentSource implements SettlementPaymentSource {
  readonly rows = new Map<string, PaymentFact[]>();
  set(eventId: string, pg: Pg, rows: PaymentFact[]): void {
    this.rows.set(`${eventId}:${pg}`, rows);
  }
  async listEventPayments(eventId: string, pg: Pg): Promise<PaymentFact[]> {
    return this.rows.get(`${eventId}:${pg}`) ?? [];
  }
}

/** 시험용 재인증 확인. 운영은 JWKS 확인 어댑터를 쓴다. */
export class MemoryReauthVerifier implements ReauthVerifier {
  constructor(private readonly token = 'test-reauth') {}
  async verify(token: string | undefined, o: { sessionId: string; act: string }): Promise<VerifiedReauth> {
    if (token !== this.token) throw new SettlementProblem('reauth-required', 403, '다시 인증해 주세요');
    return { jti: 'test-jti', accountId: 'test-account', sessionId: o.sessionId, act: o.act, factors: ['password', 'totp', 'passkey'] };
  }
}

/** 포트원은 공개 지급 생성 API가 없어 콘솔 실행 기록만 남긴다(settlement §5.3). */
export class ManualPortonePayoutGateway implements PayoutGateway {
  readonly pg = 'PORTONE' as const;
  async submit(): Promise<PayoutSubmitResult> {
    return { status: 'SUBMITTED' };
  }
}

/** 토스 지급대행 JWE·API 키가 아직 없다. 상태를 바꾸지 않고 503으로 막는다. */
export class UnavailableTossPayoutGateway implements PayoutGateway {
  readonly pg = 'TOSS' as const;
  async submit(): Promise<PayoutSubmitResult> {
    throw new SettlementProblem('payout-gateway-unavailable', 503, '토스페이먼츠 지급대행을 아직 시작할 수 없습니다');
  }
}
