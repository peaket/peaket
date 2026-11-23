// 정산 시험 공용 대역(BAT-625). 승인·판매 중지 의존성이 없는 시험은 이 빈 대역을 쓴다.
import type { PayoutApprovalVerifier, SaleSuspensionSource, SettlementStore } from '../src/modules/settlement/domain/ports.js';
import type { PgStore, TossSellerRecord, TossSellerStatus } from '../src/modules/settlement/domain/settlement.js';

export const noApprovals: PayoutApprovalVerifier = { verify: async () => undefined };
export const noSaleSuspensions: SaleSuspensionSource = { listSuspended: async () => new Set() };

/**
 * 파트너·결제 상점의 토스 셀러 한 행(payment 0029 toss_seller, F-07-6 ADR-0369 결정 3·4). 토스 정산서는 그 상점 셀러가
 * PARTIALLY_APPROVED·APPROVED일 때만 지급 묶음에 들어가므로, 토스 묶음을 만드는 시험은 이것을 심는다. 기본은 묶을 수 있는 가장 낮은 상태다
 */
export async function seedTossSeller(
  store: Pick<SettlementStore, 'saveTossSeller'>,
  promoterId: string,
  o: { pgStore?: PgStore; status?: TossSellerStatus; tossSellerId?: string; at?: Date } = {},
): Promise<TossSellerRecord> {
  const pgStore = o.pgStore ?? 'STANDARD';
  const at = o.at ?? new Date('2026-11-01T00:00:00.000Z');
  const record: TossSellerRecord = {
    promoterId,
    pgStore,
    tossSellerId: o.tossSellerId ?? `seller-${promoterId}-${pgStore}`,
    refSellerId: `${promoterId}-${pgStore}`,
    status: o.status ?? 'PARTIALLY_APPROVED',
    businessType: 'CORPORATE',
    registeredAt: at,
    statusCheckedAt: at,
    updatedAt: at,
  };
  await store.saveTossSeller(record);
  return record;
}

/** 두 결제 상점 모두(일반·에스크로) */
export async function seedTossSellers(store: Pick<SettlementStore, 'saveTossSeller'>, promoterId: string, status: TossSellerStatus = 'PARTIALLY_APPROVED'): Promise<void> {
  await seedTossSeller(store, promoterId, { pgStore: 'STANDARD', status });
  await seedTossSeller(store, promoterId, { pgStore: 'ESCROW', status });
}
