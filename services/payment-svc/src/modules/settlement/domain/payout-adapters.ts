// 지급대행 어댑터의 순수 부분(토스 지급 웹훅 서명·JWE 설정 경계, 포트원 출금 대사·잔액 원장).
// 실제 키·계정이 없으므로 전송은 503으로 막고, 서명·대사 규칙만 시험 가능하게 둔다(settlement §5.2·§5.3·§5.5, J-T6·J-T20·J-T25).
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TossPayoutWebhookInput {
  /** v1: 뒤 base64. 키 교체 중이면 공백으로 이어 최대 4개 */
  signature: string | undefined;
  /** 보안 키(현재·옛 키) */
  secrets: readonly string[];
  /** raw body */
  body: string;
  /** tosspayments-webhook-transmission-time */
  transmissionTime: string;
  now: Date;
  /** 허용 시각 차이 [가정] 5분 */
  toleranceMs?: number;
}

export type TossWebhookVerdict = 'OK' | 'SIGNATURE_MISMATCH' | 'STALE';

/** 토스 지급 웹훅 서명을 상수 시간으로 비교한다. 서명이 여럿이면 하나만 맞아도 받는다(J-T6). */
export function verifyTossPayoutSignature(input: TossPayoutWebhookInput): TossWebhookVerdict {
  if (!input.signature) return 'SIGNATURE_MISMATCH';
  const sent = Date.parse(input.transmissionTime);
  if (!Number.isFinite(sent)) return 'STALE';
  if (Math.abs(input.now.getTime() - sent) > (input.toleranceMs ?? 5 * 60_000)) return 'STALE';
  const actual = input.signature
    .split(/\s+/)
    .map((part) => part.replace(/^v1:/, '').trim())
    .filter(Boolean);
  const expected = input.secrets.map((secret) => createHmac('sha256', secret).update(input.body).digest('base64'));
  for (const a of actual) {
    for (const e of expected) {
      const ab = Buffer.from(a);
      const eb = Buffer.from(e);
      if (ab.length === eb.length && timingSafeEqual(ab, eb)) return 'OK';
    }
  }
  return 'SIGNATURE_MISMATCH';
}

/** 토스 지급대행 설정. JWE 키·API 키가 없으면 실행하지 않는다(503). */
export interface TossPayoutConfig {
  apiKey: string;
  jweKeyId: string;
  jwePublicKeyPem: string;
  webhookSecrets: readonly string[];
}

export function tossPayoutConfigured(env: Record<string, string | undefined>): TossPayoutConfig | undefined {
  const apiKey = env.PEAKET_PG_TOSS_PAYOUT_API_KEY?.trim();
  const jweKeyId = env.PEAKET_PG_TOSS_PAYOUT_JWE_KEY_ID?.trim();
  const jwePublicKeyPem = env.PEAKET_PG_TOSS_PAYOUT_JWE_PUBLIC_KEY?.replaceAll('\\n', '\n').trim();
  const secrets = (env.PEAKET_PG_TOSS_PAYOUT_WEBHOOK_SECRETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!apiKey || !jweKeyId || !jwePublicKeyPem || secrets.length === 0) return undefined;
  return { apiKey, jweKeyId, jwePublicKeyPem, webhookSecrets: secrets };
}

export interface PortonePayoutFact {
  payoutId: string;
  statementId: string;
  amount: number;
  bankCode: string | null;
  accountLast4: string | null;
  status: 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELED';
}

export interface PortoneTransferFact {
  transferId: string;
  withdrawalType: string;
  payoutId: string | null;
  amount: number;
  bankCode: string | null;
  accountLast4: string | null;
  holderName: string | null;
  transferredAt: Date;
}

export interface PortonePartnerAccountFact {
  promoterId: string;
  legalName: string;
  representative: string;
  bankCode: string;
  accountLast4: string;
}

export type WithdrawalCheck = 'MATCHED' | 'MISMATCH' | 'MISSING' | 'UNLINKED';

export interface WithdrawalReconciliation {
  payoutId: string;
  transferId: string | null;
  check: WithdrawalCheck;
  reasons: string[];
}

/** 예금주 표기 차이를 흡수한다(㈜·(주)·주식회사·공백·대소문자, J-T8). */
export function normalizeHolderName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/\s+/g, '')
    .replaceAll('(주)', '')
    .replaceAll('㈜', '')
    .replaceAll('주식회사', '')
    .replaceAll('co.,ltd.', '')
    .replaceAll('co.ltd.', '')
    .replaceAll('ltd.', '')
    .replaceAll(',', '');
}

/**
 * 포트원 출금 대사(settlement §5.3, J-T20). 지급 건마다 이체 ID·금액·계좌·예금주를 본다.
 * 지급 건과 이어지지 않는 출금은 UNLINKED, 완료인데 출금이 없으면 MISSING이다.
 */
export function reconcilePortoneWithdrawals(input: {
  payouts: readonly PortonePayoutFact[];
  transfers: readonly PortoneTransferFact[];
  accounts: ReadonlyMap<string, PortonePartnerAccountFact>;
  promoterOfPayout: (payoutId: string) => string | undefined;
}): WithdrawalReconciliation[] {
  const used = new Set<string>();
  const out: WithdrawalReconciliation[] = [];
  for (const p of input.payouts) {
    const promoterId = input.promoterOfPayout(p.payoutId);
    const account = promoterId ? input.accounts.get(promoterId) : undefined;
    const transfer = input.transfers.find((t) => !used.has(t.transferId) && (t.payoutId === p.payoutId || (t.amount === p.amount && t.bankCode === p.bankCode && t.accountLast4 === p.accountLast4)));
    if (!transfer) {
      if (p.status === 'COMPLETED') out.push({ payoutId: p.payoutId, transferId: null, check: 'MISSING', reasons: ['no-withdrawal'] });
      continue;
    }
    used.add(transfer.transferId);
    const reasons: string[] = [];
    if (transfer.amount !== p.amount) reasons.push('amount');
    if (transfer.bankCode !== p.bankCode || transfer.accountLast4 !== p.accountLast4) reasons.push('account');
    if (account && transfer.holderName && normalizeHolderName(transfer.holderName) !== normalizeHolderName(account.legalName) && normalizeHolderName(transfer.holderName) !== normalizeHolderName(account.representative)) reasons.push('holder');
    out.push({ payoutId: p.payoutId, transferId: transfer.transferId, check: reasons.length === 0 ? 'MATCHED' : 'MISMATCH', reasons });
  }
  for (const t of input.transfers) if (!used.has(t.transferId)) out.push({ payoutId: t.payoutId ?? '', transferId: t.transferId, check: 'UNLINKED', reasons: ['not-linked'] });
  return out;
}

/** 지급대행 잔액 원장: 있어야 할 잔액 = 대사 완료 승인 − 취소·환불 − 결제사 수수료 − 완료 지급 − PEAKET 몫 인출(settlement §5.5). */
export function ledgerBalance(input: { approvedAmount: number; refundedAmount: number; pgFees: number; paidOut: number; peaketWithdrawn: number }): number {
  return input.approvedAmount - input.refundedAmount - input.pgFees - input.paidOut - input.peaketWithdrawn;
}
