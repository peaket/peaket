// settlement 모듈 조립. 저장소·결제 원장·지급 어댑터·재인증 확인을 밖에서 받는다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, CLOCK, INTERNAL_TOKEN } from '@peaket/platform';
import { Settlements } from './application/settlements.js';
import type {
  AdjustmentApprovalVerifier,
  DueEventSettlementSource,
  EventCommissionRateSource,
  PayoutAccountAuditSink,
  PayoutApprovalVerifier,
  PayoutGateway,
  PortonePlatformTransport,
  SettlementAlertSink,
  PgBalanceSource,
  PgLedgerSource,
  ProductSettlementSource,
  PromoterContractSource,
  ReauthVerifier,
  SaleSuspensionSource,
  SettlementApprovalLog,
  SettlementCaseNotice,
  SettlementPaymentSource,
  SettlementSignals,
  SettlementStore,
  TossPayoutTransport,
} from './domain/ports.js';
import type { PortonePayoutConfig, TossPayoutTerms } from './domain/payout-adapters.js';
import {
  ADJUSTMENT_APPROVAL_VERIFIER,
  PAYOUT_APPROVAL_VERIFIER,
  PAYOUT_GATEWAY,
  PG_BALANCE_SOURCE,
  PROMOTER_CONTRACT_SOURCE,
  REAUTH_VERIFIER,
  SALE_SUSPENSION_SOURCE,
  SETTLEMENT_APPROVAL_LOG,
  SETTLEMENT_CASE_NOTICE,
  SETTLEMENT_COMMISSION_SOURCE,
  SETTLEMENT_HOLIDAYS,
  SETTLEMENT_EVENT_SOURCE,
  SETTLEMENT_PAYMENT_SOURCE,
  SETTLEMENT_PRODUCT_SOURCE,
  SETTLEMENT_STORE,
} from './domain/ports.js';
import { PartnerSettlementController } from './inbound/partner-settlement.controller.js';
import { InternalSettlementController } from './inbound/internal-settlement.controller.js';
import { InternalRecalculationController } from './inbound/internal-recalculation.controller.js';

export interface SettlementModuleDeps {
  readonly store: SettlementStore;
  readonly payments: SettlementPaymentSource;
  readonly products?: ProductSettlementSource;
  readonly events?: DueEventSettlementSource;
  readonly eventCommission?: EventCommissionRateSource;
  readonly approvals: PayoutApprovalVerifier;
  readonly saleSuspensions: SaleSuspensionSource;
  readonly promoterContracts?: PromoterContractSource;
  readonly pgBalance?: PgBalanceSource;
  readonly gateways: readonly PayoutGateway[];
  readonly reauth: ReauthVerifier;
  readonly commissionRateBp?: number;
  readonly log?: SettlementApprovalLog;
  /** ops-svc CS 처리함 '정산 이의' 건(ADR-0368 결정 5). 없으면 정산 일꾼이 다시 보낼 이의로 남는다 */
  readonly caseNotice?: SettlementCaseNotice;
  /** ops-svc 조정 승인 기록 대조(ADR-0368 결정 8). 없으면 조정 적용은 503 */
  readonly adjustmentApprovals?: AdjustmentApprovalVerifier;
  /** KST 공휴일(PEAKET_HOLIDAY_CALENDAR_FILE). 없으면 주말만 뺀다 */
  readonly holidays?: ReadonlySet<string>;
  /** 토스 지급대행 전송(F-07-6 ADR-0369). 없으면 셀러 등록 503이고 토스 자동 일을 하지 않는다 */
  readonly tossTransport?: TossPayoutTransport;
  /** 정산 지급 지표(ADR-0369 결정 12) */
  readonly signals?: SettlementSignals;
  /** 토스 지급대행 이용료 계약 조건 */
  readonly tossTerms?: TossPayoutTerms;
  /** 결제사 잔액 대사의 장부 원천 */
  readonly pgLedger?: PgLedgerSource;
  /** 포트원 플랫폼 전송·설정(F-07-7 ADR-0370). 없으면 포트원 지급대행 꺼짐 */
  readonly portone?: PortonePlatformTransport;
  readonly portoneConfig?: PortonePayoutConfig;
  /** ops 감사 받기·운영 경보 받기(F-07-7) */
  readonly payoutAccountAudit?: PayoutAccountAuditSink;
  readonly alerts?: SettlementAlertSink;
}

@Module({})
export class SettlementModule {
  static register(deps: SettlementModuleDeps): DynamicModule {
    const providers: Provider[] = [
      { provide: SETTLEMENT_STORE, useValue: deps.store },
      { provide: SETTLEMENT_PAYMENT_SOURCE, useValue: deps.payments },
      { provide: SETTLEMENT_PRODUCT_SOURCE, useValue: deps.products },
      { provide: SETTLEMENT_EVENT_SOURCE, useValue: deps.events },
      { provide: SETTLEMENT_COMMISSION_SOURCE, useValue: deps.eventCommission },
      { provide: PAYOUT_APPROVAL_VERIFIER, useValue: deps.approvals },
      { provide: SALE_SUSPENSION_SOURCE, useValue: deps.saleSuspensions },
      { provide: PROMOTER_CONTRACT_SOURCE, useValue: deps.promoterContracts },
      { provide: PG_BALANCE_SOURCE, useValue: deps.pgBalance },
      { provide: SETTLEMENT_APPROVAL_LOG, useValue: deps.log },
      { provide: PAYOUT_GATEWAY, useValue: deps.gateways },
      { provide: REAUTH_VERIFIER, useValue: deps.reauth },
      { provide: SETTLEMENT_CASE_NOTICE, useValue: deps.caseNotice },
      { provide: ADJUSTMENT_APPROVAL_VERIFIER, useValue: deps.adjustmentApprovals },
      { provide: SETTLEMENT_HOLIDAYS, useValue: deps.holidays },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      {
        provide: Settlements,
        useFactory: (
          store: SettlementStore,
          payments: SettlementPaymentSource,
          products: ProductSettlementSource | undefined,
          events: DueEventSettlementSource | undefined,
          eventCommission: EventCommissionRateSource | undefined,
          approvals: PayoutApprovalVerifier,
          saleSuspensions: SaleSuspensionSource,
          promoterContracts: PromoterContractSource | undefined,
          pgBalance: PgBalanceSource | undefined,
          log: SettlementApprovalLog | undefined,
          gateways: readonly PayoutGateway[],
          reauth: ReauthVerifier,
          clock: Clock,
          caseNotice: SettlementCaseNotice | undefined,
          adjustmentApprovals: AdjustmentApprovalVerifier | undefined,
          holidays: ReadonlySet<string> | undefined,
        ) =>
          new Settlements({
            store,
            payments,
            ...(products ? { products } : {}),
            ...(events ? { events } : {}),
            ...(eventCommission ? { eventCommission } : {}),
            approvals,
            saleSuspensions,
            ...(promoterContracts ? { promoterContracts } : {}),
            ...(pgBalance ? { pgBalance } : {}),
            ...(log ? { log } : {}),
            gateways,
            reauth,
            clock,
            ...(deps.commissionRateBp !== undefined ? { commissionRateBp: deps.commissionRateBp } : {}),
            ...(caseNotice ? { caseNotice } : {}),
            ...(adjustmentApprovals ? { adjustmentApprovals } : {}),
            ...(holidays ? { holidays } : {}),
            ...(deps.tossTransport ? { tossTransport: deps.tossTransport } : {}),
            ...(deps.signals ? { signals: deps.signals } : {}),
            ...(deps.tossTerms ? { tossTerms: deps.tossTerms } : {}),
            ...(deps.pgLedger ? { pgLedger: deps.pgLedger } : {}),
            ...(deps.portone ? { portone: deps.portone } : {}),
            ...(deps.portoneConfig ? { portoneConfig: deps.portoneConfig } : {}),
            ...(deps.payoutAccountAudit ? { payoutAccountAudit: deps.payoutAccountAudit } : {}),
            ...(deps.alerts ? { alerts: deps.alerts } : {}),
          }),
        inject: [
          SETTLEMENT_STORE,
          SETTLEMENT_PAYMENT_SOURCE,
          SETTLEMENT_PRODUCT_SOURCE,
          SETTLEMENT_EVENT_SOURCE,
          SETTLEMENT_COMMISSION_SOURCE,
          PAYOUT_APPROVAL_VERIFIER,
          SALE_SUSPENSION_SOURCE,
          PROMOTER_CONTRACT_SOURCE,
          PG_BALANCE_SOURCE,
          SETTLEMENT_APPROVAL_LOG,
          PAYOUT_GATEWAY,
          REAUTH_VERIFIER,
          CLOCK,
          SETTLEMENT_CASE_NOTICE,
          ADJUSTMENT_APPROVAL_VERIFIER,
          SETTLEMENT_HOLIDAYS,
        ],
      },
    ];
    return { module: SettlementModule, controllers: [PartnerSettlementController, InternalSettlementController, InternalRecalculationController], providers };
  }
}
