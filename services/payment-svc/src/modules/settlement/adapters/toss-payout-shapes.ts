// 토스페이먼츠 지급대행 API의 본문 모양(F-07-6 LCH-110, ADR-0369 결정 1). 경로·칸 이름은 공개 안내를 읽은 모양 [가정]이고(정리 목록 C-03),
// 계약 때 결제사 원문으로 맞춘다. 시험의 대역 서버(test/support/toss-payout-fake.ts)가 같은 모양을 쓴다.
// v2 응답 봉투는 { version, traceId, entityType, entityBody }, 오류는 { version, traceId, error: { code, message } }다.
import { z } from 'zod';

const Money = z.object({ currency: z.string(), value: z.number() });

export const TossErrorBody = z.object({ error: z.object({ code: z.string().min(1), message: z.string().optional() }) });

export const TossPayoutItem = z.object({
  id: z.string().min(1),
  refPayoutId: z.string().min(1),
  status: z.enum(['REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELED']),
  error: z.object({ code: z.string(), message: z.string().optional() }).nullable().optional(),
});

export const TossPayoutsAccepted = z.object({ entityBody: z.object({ items: z.array(TossPayoutItem).min(1) }) });
export const TossPayoutOne = z.object({ entityBody: TossPayoutItem });

export const TossSellerStatusSchema = z.enum(['PENDING', 'APPROVAL_REQUIRED', 'PARTIALLY_APPROVED', 'APPROVED', 'KYC_REQUIRED', 'REJECTED']);
export const TossSellerBody = z.object({ entityBody: z.object({ id: z.string().min(1), status: TossSellerStatusSchema }) });

export const TossBalanceBody = z.object({ entityBody: z.object({ availableAmount: Money, pendingAmount: Money }) });

/** 정산 조회(v1): 행마다 fees: [{ type, fee }] */
export const TossSettlementRows = z.array(z.object({ fees: z.array(z.object({ type: z.string().optional(), fee: z.number() })).default([]) }));

/** 지급 요청 평문 한 건(배열로 보낸다). transactionDescription은 필수·1~7자다(토스 공개 문서, 값은 [가정]) */
export interface TossPayoutRequestItem {
  refPayoutId: string;
  destination: string;
  scheduleType: 'SCHEDULED';
  payoutDate: string;
  amount: { currency: 'KRW'; value: number };
  transactionDescription: string;
}

export const TOSS_TRANSACTION_DESCRIPTION = 'PEAKET';
