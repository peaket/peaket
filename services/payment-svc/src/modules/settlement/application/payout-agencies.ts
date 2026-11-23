// 지급대행 등록 한 길(F-07-7 계획 I-03, ADR-0370 결정 1·3, settlement §3·§6).
// 판매 승인 요청(REGISTER)과 정산 계좌 변경(CHANGE)이 같은 차례를 쓴다: 포트원 예금주 조회 → 이름 비교 → 포트원 파트너 → 토스 두 상점 셀러.
// 계좌번호는 이 함수 인자로만 받아 결제사 요청에 넘기고, 저장·로그·오류 메시지·감사에 넣지 않는다(오류는 결제사 이름과 상태만).
import type { Clock } from '@peaket/platform';
import { holderMatches } from '../domain/holder-name.js';
import type { PayoutAccountInput, PayoutCompany, PortonePlatformTransport, SettlementStore, TossPayoutTransport, TossSellerRegistration } from '../domain/ports.js';
import type { PortonePayoutConfig } from '../domain/payout-adapters.js';
import { SettlementProblem, type PayoutAgencyResults, type PgStore, type TossSellerRecord } from '../domain/settlement.js';
import { TOSS_SELLER_STORES, tossRefSellerId } from '../domain/toss-seller.js';

export interface PayoutAgencySyncInput {
  promoterId: string;
  mode: 'REGISTER' | 'CHANGE';
  businessType: 'INDIVIDUAL_BUSINESS' | 'CORPORATE';
  company: PayoutCompany;
  account: PayoutAccountInput;
}

export interface PayoutAgencySyncResult {
  /** 포트원 예금주 조회를 했는가(포트원 플랫폼이 꺼진 등록 요청이면 false) */
  holderChecked: boolean;
  holderMatched: boolean;
  agencies: PayoutAgencyResults;
}

const ALL_SKIPPED: PayoutAgencyResults = { PORTONE: 'SKIPPED', TOSS_STANDARD: 'SKIPPED', TOSS_ESCROW: 'SKIPPED' };
const TOSS_AGENCY = { STANDARD: 'TOSS_STANDARD', ESCROW: 'TOSS_ESCROW' } as const satisfies Record<PgStore, keyof PayoutAgencyResults>;

/** PEAKET이 정해 포트원에 등록하는 파트너 ID [가정 모양, 계획 §5.1 (나)] */
export const portonePartnerIdOf = (promoterId: string): string => `peaket-${promoterId}`;

const gatewayUnavailable = () => new SettlementProblem('payout-gateway-unavailable', 503, '지급대행을 아직 시작할 수 없습니다');
const lookupUnavailable = () => new SettlementProblem('payout-holder-lookup-unavailable', 503, '예금주를 확인할 수 없습니다');

export class PayoutAgencies {
  constructor(
    private readonly d: {
      store: SettlementStore;
      portone: PortonePlatformTransport | undefined;
      portoneConfig: PortonePayoutConfig | undefined;
      toss: TossPayoutTransport | undefined;
      clock: Clock;
    },
  ) {}

  #now(): Date {
    return new Date(this.d.clock.now());
  }

  /**
   * 차례대로 부른다. 불일치는 결제사를 부르지 않고 holderMatched false를 돌려준다(던지는 것은 부르는 쪽).
   * 조회 실패는 503 payout-holder-lookup-unavailable, 등록이 있는데 꺼진 결제사(또는 셀러 수정이 없는 토스 전송)는 503 payout-gateway-unavailable이고 아무것도 부르지 않는다.
   * 결제사 한 곳 실패는 던지지 않고 FAILED로 돌려준다(성공한 곳의 등록 행은 남는다).
   */
  async sync(input: PayoutAgencySyncInput): Promise<PayoutAgencySyncResult> {
    const { store } = this.d;
    const portone = this.d.portone && this.d.portoneConfig ? { transport: this.d.portone, config: this.d.portoneConfig } : undefined;
    const partner = await store.findPortonePartner(input.promoterId);
    const sellers = new Map<PgStore, TossSellerRecord>();
    for (const pgStore of TOSS_SELLER_STORES) {
      const row = await store.findTossSeller(input.promoterId, pgStore);
      if (row) sellers.set(pgStore, row);
    }
    // 계좌 변경은 예금주를 조회할 수 없으면 받지 않는다(포트원 플랫폼 꺼짐, ADR-0370 결정 3)
    if (!portone && input.mode === 'CHANGE') throw lookupUnavailable();
    // 등록이 있던 결제사가 지금 꺼져 있으면 건너뛰지 않고 멈춘다(ADR-0370 결정 3)
    if (partner && !portone) throw gatewayUnavailable();
    // 토스 셀러 행이 있는데 지급대행이 꺼졌거나 전송에 셀러 수정이 없으면 그 상점을 바꿀 수 없다(계획 §5.1 (타) 결정 1)
    if (sellers.size > 0 && typeof this.d.toss?.updateSeller !== 'function') throw gatewayUnavailable();
    if (!portone) {
      // 포트원 플랫폼이 꺼지면 예금주를 조회할 수 없다. 등록 요청은 지금처럼 모양만 본다
      return { holderChecked: false, holderMatched: false, agencies: { ...ALL_SKIPPED } };
    }
    let holder: { holderName: string } | null;
    try {
      holder = await portone.transport.lookupHolder({ bankCode: input.account.bankCode, accountNumber: input.account.accountNumber });
    } catch {
      throw lookupUnavailable();
    }
    // 파트너가 적은 이름이 아니라 결제사 조회 결과를 판매자 상호·대표자와 견준다(settlement §3)
    if (!holder || !holderMatches(holder.holderName, { legalName: input.company.name, representative: input.company.representativeName })) {
      return { holderChecked: true, holderMatched: false, agencies: { ...ALL_SKIPPED } };
    }
    const agencies: PayoutAgencyResults = { ...ALL_SKIPPED };
    agencies.PORTONE = await this.#portone(portone, partner, input);
    for (const pgStore of TOSS_SELLER_STORES) agencies[TOSS_AGENCY[pgStore]] = await this.#toss(pgStore, sellers.get(pgStore), input);
    return { holderChecked: true, holderMatched: true, agencies };
  }

  async #portone(portone: { transport: PortonePlatformTransport; config: PortonePayoutConfig }, partner: Awaited<ReturnType<SettlementStore['findPortonePartner']>>, input: PayoutAgencySyncInput): Promise<PayoutAgencyResults['PORTONE']> {
    try {
      if (partner) {
        // 등록 요청을 다시 받으면(한 곳 실패 뒤 다시 보냄) 이미 등록된 파트너는 부르지 않는다
        if (input.mode === 'REGISTER') return 'REGISTERED';
        await portone.transport.updatePartnerAccount(partner.portonePartnerId, input.account);
        const now = this.#now();
        await this.d.store.savePortonePartner({ ...partner, accountUpdatedAt: now, updatedAt: now });
        return 'UPDATED';
      }
      const created = await portone.transport.registerPartner({ partnerId: portonePartnerIdOf(input.promoterId), contractId: portone.config.contractId, company: input.company, account: input.account });
      const now = this.#now();
      await this.d.store.savePortonePartner({
        promoterId: input.promoterId,
        portonePartnerId: created.partnerId,
        contractId: portone.config.contractId,
        registeredAt: now,
        accountUpdatedAt: now,
        lastAccountCheck: null,
        lastAccountCheckedAt: null,
        updatedAt: now,
      });
      return 'REGISTERED';
    } catch {
      return 'FAILED';
    }
  }

  async #toss(pgStore: PgStore, row: TossSellerRecord | undefined, input: PayoutAgencySyncInput): Promise<PayoutAgencyResults['TOSS_STANDARD']> {
    const toss = this.d.toss;
    if (!toss) return 'SKIPPED';
    const body: TossSellerRegistration = { refSellerId: tossRefSellerId(input.promoterId, pgStore), businessType: input.businessType, company: input.company, account: input.account };
    try {
      if (row) {
        if (input.mode === 'REGISTER') return 'REGISTERED';
        if (typeof toss.updateSeller !== 'function') throw gatewayUnavailable();
        const updated = await toss.updateSeller(pgStore, row.tossSellerId, body);
        const now = this.#now();
        await this.d.store.saveTossSeller({ ...row, status: updated.status, statusCheckedAt: now, updatedAt: now });
        return 'UPDATED';
      }
      const created = await toss.registerSeller(pgStore, body);
      const now = this.#now();
      await this.d.store.saveTossSeller({ promoterId: input.promoterId, pgStore, tossSellerId: created.tossSellerId, refSellerId: body.refSellerId, status: created.status, businessType: input.businessType, registeredAt: now, statusCheckedAt: now, updatedAt: now });
      return 'REGISTERED';
    } catch {
      return 'FAILED';
    }
  }
}
