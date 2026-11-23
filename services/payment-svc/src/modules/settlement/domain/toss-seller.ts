// 토스페이먼츠 셀러 등록·상점별 셀러 상태 규칙(F-07-6 LCH-110, settlement §3·§6, ADR-0369 결정 3·4).
// 셀러는 파트너·결제 상점(일반·에스크로)마다 따로 등록하고 상점마다 toss_seller 한 행을 둔다. 상태는 셀러 단건 조회 결과로만 바꾼다.
// 등록 본문의 계좌번호는 결제사로 넘길 때만 쓰고 저장·로그·응답·예외 메시지에 남기지 않는다(ASVS 16.2.5).
import { z } from 'zod';
import { SettlementProblem, type PgStore, type TossSellerStatus } from './settlement.js';

/** 토스 정산서를 지급 묶음에 넣을 수 있는 셀러 상태(ADR-0369 결정 4). 그 밖(없음 포함)은 HELD·KYC다 */
export const BATCHABLE_TOSS_SELLER_STATUSES: ReadonlySet<TossSellerStatus> = new Set<TossSellerStatus>(['PARTIALLY_APPROVED', 'APPROVED']);

export const isBatchableTossSeller = (status: TossSellerStatus | undefined): boolean => status !== undefined && BATCHABLE_TOSS_SELLER_STATUSES.has(status);

/** PEAKET이 정한 셀러 참조 ID({파트너 ID}-{상점} [가정], data.md toss_seller.ref_seller_id) */
export const tossRefSellerId = (promoterId: string, pgStore: PgStore): string => `${promoterId}-${pgStore}`;

/** 셀러 등록의 상점 차례(응답 sellers도 이 차례다) */
export const TOSS_SELLER_STORES: readonly PgStore[] = ['STANDARD', 'ESCROW'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 셀러 등록 본문(I-03). 은행 코드는 정산 계좌와 같은 모양, 계좌번호는 숫자 6~20자리 */
export const TossSellerRegistrationBody = z.object({
  promoterId: z.string().regex(UUID),
  businessType: z.enum(['INDIVIDUAL_BUSINESS', 'CORPORATE']),
  company: z.object({
    name: z.string().trim().min(1).max(100),
    representativeName: z.string().trim().min(1).max(100),
    businessRegistrationNumber: z.string().regex(/^\d{10}$/),
    email: z.email().max(254),
    phone: z.string().regex(/^[0-9+-]{7,20}$/),
  }),
  account: z.object({
    bankCode: z.string().regex(/^[0-9A-Z]{2,10}$/),
    accountNumber: z.string().regex(/^\d{6,20}$/),
    holderName: z.string().trim().min(1).max(100),
  }),
});

export type TossSellerRegistrationInput = z.infer<typeof TossSellerRegistrationBody>;

/** 본문을 읽는다. 틀리면 422 invalid-query이고 메시지에 받은 값(계좌번호)을 싣지 않는다 */
export function parseTossSellerRegistration(input: unknown): TossSellerRegistrationInput {
  const parsed = TossSellerRegistrationBody.safeParse(input);
  if (!parsed.success) throw new SettlementProblem('invalid-query', 422, '셀러 등록 본문이 맞지 않습니다');
  return parsed.data;
}
