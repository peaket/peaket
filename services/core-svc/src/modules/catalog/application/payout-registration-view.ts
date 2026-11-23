// 관제 상세(판매 승인 SCR-048·파트너사 SCR-065)에 싣는 지급대행 등록 값(F-07-7, ADR-0370 결정 4, openapi OpsPayoutAccountSummary·OpsPgRegistration).
// payment 등록 읽기를 그대로 옮기고, 결제사의 셀러·파트너 ID 원문은 싣지 않는다. 읽기가 실패해도 상세는 200이고 둘 다 꺼진 모양이다.
import { type PlatformLogger, ProblemError } from '@peaket/platform';
import { PAYOUT_REGISTRATION_OFF, type PayoutRegistrationPort, type PayoutRegistrationView } from '../domain/payout-registration-port.js';

/** 관제 상세의 지급대행 등록 값(openapi OpsPayoutAccountSummary·OpsPgRegistration). CS 두 역할에게 정산 계좌는 null이다 */
export async function payoutRegistrationOf(
  payout: PayoutRegistrationPort,
  promoterId: string,
  role: string | undefined,
  logger?: Pick<PlatformLogger, 'warn'>,
): Promise<{ payoutAccount: PayoutRegistrationView['payoutAccount']; pgRegistration: Pick<PayoutRegistrationView, 'tossEnabled' | 'portoneEnabled' | 'tossSellers' | 'portonePartnerRegistered'> }> {
  let view: PayoutRegistrationView;
  try {
    view = await payout.read(promoterId);
  } catch (err) {
    // 상세는 막지 않는다. 승인 판정은 따로 다시 읽으므로 fail-closed가 깨지지 않는다(계획 I-05)
    logger?.warn({ event: 'payout_registration_read_failed', promoterId, err: err instanceof ProblemError ? err.slug : (err as Error).name }, '지급대행 등록을 읽지 못해 상세에 둘 다 꺼진 모양을 싣는다');
    view = PAYOUT_REGISTRATION_OFF;
  }
  const cs = role === 'cs_agent' || role === 'cs_lead';
  return {
    payoutAccount: cs || view.payoutAccount === null ? null : { bankCode: view.payoutAccount.bankCode, last4: view.payoutAccount.last4, holdUntil: view.payoutAccount.holdUntil, holderVerified: view.payoutAccount.holderVerified },
    pgRegistration: {
      tossEnabled: view.tossEnabled,
      portoneEnabled: view.portoneEnabled,
      tossSellers: view.tossSellers.map((s) => ({ pgStore: s.pgStore, status: s.status })),
      portonePartnerRegistered: view.portonePartnerRegistered,
    },
  };
}
