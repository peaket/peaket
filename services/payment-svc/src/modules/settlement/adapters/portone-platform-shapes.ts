// 포트원 플랫폼(파트너 정산) API 응답 모양 한 곳(F-07-7 계획 I-02, ADR-0370 결정 1·7·8, guidelines §8 포트원 플랫폼 행).
// 공개 명세 v1.16.0을 읽고 정한 모양 [가정]이고 계약 때 원문으로 맞춘다(계획 정리 목록 C-01). 칸 이름이 바뀌면 SHAPE로 거부한다(J-T22 ③).
// 은행은 PEAKET 두 자리 은행 코드(packages/validation의 토스 두 자리 표)와 포트원 Bank 열거값을 이 파일의 대응표 하나로 바꾼다(계획 §5.1 (파) (라)).
import { z } from 'zod';

/**
 * PEAKET 두 자리 은행 코드(토스 두 자리 표) → 포트원 Bank 열거값. 결제 환불 계좌의 대응표(payment 모듈 payment-gateway.ts PORTONE_BANK_OF, 2026-11-19 [가정])와 같은 값이다.
 * 지급대행 쪽 대응표는 이 한 곳이다(계획 §5.1 (파) (라)). 실제 서버 대조 때 두 곳을 함께 고친다
 */
const PORTONE_BANK_OF: ReadonlyMap<string, string> = new Map([
  ['02', 'KDB'],
  ['03', 'IBK'],
  ['06', 'KOOKMIN'],
  ['07', 'SUHYUP'],
  ['11', 'NONGHYUP'],
  ['12', 'LOCAL_NONGHYUP'],
  ['20', 'WOORI'],
  ['23', 'SC_FIRST'],
  ['27', 'CITI'],
  ['31', 'DAEGU'],
  ['32', 'BUSAN'],
  ['34', 'GWANGJU'],
  ['35', 'JEJU'],
  ['37', 'JEONBUK'],
  ['39', 'KYONGNAM'],
  ['45', 'KFCC'],
  ['48', 'SHINHYUP'],
  ['50', 'SAVINGS_BANK'],
  ['54', 'HSBC'],
  ['64', 'NFCF'],
  ['71', 'POST'],
  ['81', 'HANA'],
  ['88', 'SHINHAN'],
  ['89', 'K_BANK'],
  ['90', 'KAKAO'],
  ['92', 'TOSS'],
]);
const CODE_OF_ENUM: ReadonlyMap<string, string> = new Map([...PORTONE_BANK_OF].map(([code, e]) => [e, code] as const));

/** PEAKET 두 자리 은행 코드 → 포트원 Bank 열거값. 표에 없으면 undefined */
export function portoneBankEnum(bankCode: string): string | undefined {
  return PORTONE_BANK_OF.get(bankCode);
}

/** 포트원 Bank 열거값 → PEAKET 두 자리 은행 코드. 모르면 undefined */
export function peaketBankCode(bankEnum: string): string | undefined {
  return CODE_OF_ENUM.get(bankEnum);
}

export const HolderAnswer = z.object({ holderName: z.string().min(1) }).passthrough();

const Account = z.object({ bank: z.string().min(1), number: z.string().min(1), holder: z.string().min(1) }).passthrough();

export const PartnerView = z.object({ id: z.string().min(1), account: Account }).passthrough();
export const PartnerAnswer = z.object({ partner: PartnerView }).passthrough();
export const ScheduleAnswer = z.object({ account: Account }).passthrough();

export const TransferView = z.object({ id: z.string().min(1), settlementAmount: z.number().int(), settlementDate: z.string().min(1), status: z.string().min(1) }).passthrough();
export const TransferAnswer = z.object({ transfer: TransferView }).passthrough();

const PayoutStatus = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'STOPPED', 'CANCELLED']);
export const PayoutsAnswer = z
  .object({
    items: z.array(z.object({ id: z.string().min(1), transferId: z.string().min(1), status: PayoutStatus, completedAt: z.string().nullable(), failureCode: z.string().nullable() }).passthrough()),
  })
  .passthrough();

export const AccountTransfersAnswer = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().min(1),
          type: z.enum(['WITHDRAWAL', 'DEPOSIT']),
          withdrawalType: z.string().nullable(),
          payoutId: z.string().nullable(),
          amount: z.number().int(),
          bank: z.string().nullable(),
          accountNumber: z.string().nullable(),
          holderName: z.string().nullable(),
          balance: z.number().int().nullable(),
          tradedAt: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const PartnerSettlementsAnswer = z.object({ items: z.array(z.object({ partnerId: z.string().min(1), transferId: z.string().min(1), settlementAmount: z.number().int() }).passthrough()) }).passthrough();
