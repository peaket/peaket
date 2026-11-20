// 상품 게시 수수료율의 원천: promoter_contract의 지금 계약을 읽는다(BAT-615 LCH-070, ADR-0320 결정 6, settlement §4.5).
// 파트너 상품 경로의 core_partner 풀과 테넌트 트랜잭션(app.tenant_id)으로 읽는다. 계약이 없으면 실패한다
// (임의 1000bp로 대신하지 않는다. 1000bp는 기존 행 백필에만 쓴다). promoter 표는 파트너에게 열지 않는다.
// shop의 CommissionRateSource 포트와 모양이 같아 구조로 맞는다(카탈로그가 계약 표를 소유한다).
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import { promoterContract } from './schema.js';

export class DrizzleCommissionRate {
  constructor(private readonly db: Database) {}

  async rateBp(promoterId: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const periods = await tx
        .select({ commissionRateBp: promoterContract.commissionRateBp })
        .from(promoterContract)
        .where(and(eq(promoterContract.promoterId, promoterId), sql`upper_inf(${promoterContract.validDuring})`))
        .limit(1);
      if (periods[0]) return periods[0].commissionRateBp;
      throw new Error('계약 조건이 없어 상품 수수료율을 정할 수 없다');
    }, { tenantId: promoterId });
  }
}
