// 회차 취소 요청 모듈 조립. AppModule이 저장소·purchase-svc 일괄 환불 시작기와 BAT-420 GAT-110 의존(판매 중지 확인·판매 멈춤·
// 미리보기·진행률 읽기·파트너 소속 확인·판정 대기 건)을 골라 넘긴다. 시각은 서비스 시계(CLOCK), 경고는 서비스 로거로 남긴다.
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import type { AuditChain } from '../audit/audit.js';
import type { BusinessCalendar } from '../cases/index.js';
import { EventCancellations, type EventCancellationReauth } from './application/event-cancellations.js';
import type {
  CoreApplyStore,
  CoreEventStatus,
  EventCancellationCases,
  EventCancellationStore,
  EventOwnerLookup,
  EventRefundHolds,
  EventRefundReader,
  EventRefundStarter,
  EventSaleStopper,
  PartnerEventCancellationStore,
  PgCircuitReader,
  SaleSuspensionLookup,
} from './domain/ports.js';
import { EventCancellationsController } from './inbound/event-cancellations.controller.js';
import { PartnerAdminGuard, PartnerEventCancellationController } from './inbound/partner-event-cancellation.controller.js';

export interface EventCancellationsModuleDeps {
  readonly store: EventCancellationStore;
  /** 없으면 확정·정지·재개가 503이다 */
  readonly refunds?: EventRefundStarter;
  /** 요청·판정·확정·반려·정지·재개를 감사 체인에 남긴다 */
  readonly audit?: AuditChain;
  /** commander 요청과 확정의 X-Reauth-Token 검증기. 없으면 둘 다 503이다 */
  readonly reauth?: EventCancellationReauth;
  /** 판매 중지 확인(ops 명령 기록). 없으면 commander 요청을 받지 않는다(409 sale-not-suspended) */
  readonly suspension?: SaleSuspensionLookup;
  /** 확정 때 판매 멈춤. 없으면 회차 취소 확정이 503 sale-stop-unavailable이다 */
  readonly stopper?: EventSaleStopper;
  /** 미리보기·진행률 읽기. 없으면 판정이 503 event-refund-unavailable(JUDGED에 남음)이다 */
  readonly reader?: EventRefundReader;
  /** payment 서킷 상태(재개 조건, F-07-15 I-06) */
  readonly circuits?: PgCircuitReader;
  /** 파트너 소속 확인(core 판매 설정). 없으면 파트너 경로가 503 authz-unavailable이다 */
  readonly owners?: EventOwnerLookup;
  /** CS 처리함 '판정 대기' 건 */
  readonly cases?: EventCancellationCases;
  /** purchase-svc 환급 미룸(SetEventRefundHold, BAT-420 몫 D). 없으면 CANCEL 요청·판정·확정이 503 event-refund-unavailable이다 */
  readonly holds?: EventRefundHolds;
  /** 파트너 경로 전용 저장소(파트너 DB 풀, 세션 테넌트로 행 보안, 웨이브 끝 리뷰 S2). 없으면(메모리 조립) 관제 저장소를 쓴다 */
  readonly partnerStore?: PartnerEventCancellationStore;
  /** 지표 ops_event_cancellation_revert_failures_total(웨이브 끝 리뷰 K4). 없으면 오류 로그만 남긴다 */
  readonly revertFailures?: { inc(): void };
  /** core 회차 상태 반영(BAT-420-rest GAT-110). 없으면 부르지 않는다. 반영 표시는 저장소가 CoreApplyStore면 그것이다 */
  readonly core?: CoreEventStatus;
  /** 지표 ops_event_cancellation_core_apply_failures_total */
  readonly coreApplyFailures?: { inc(): void };
  /** 영업일 달력(판정 기한, F-06-2 ADR-0364 결정 2). 없으면 주말만 뺀다 */
  readonly calendar?: BusinessCalendar;
}

const isCoreApplyStore = (s: unknown): s is CoreApplyStore =>
  typeof (s as Partial<CoreApplyStore>).claimCoreApplies === 'function' && typeof (s as Partial<CoreApplyStore>).markCoreApplied === 'function' && typeof (s as Partial<CoreApplyStore>).markCoreApplyOverdue === 'function' && typeof (s as Partial<CoreApplyStore>).deferCoreApply === 'function';

@Module({})
export class EventCancellationsModule {
  static register(deps: EventCancellationsModuleDeps): DynamicModule {
    return {
      module: EventCancellationsModule,
      controllers: [EventCancellationsController, PartnerEventCancellationController],
      providers: [
        PartnerAdminGuard,
        {
          provide: EventCancellations,
          inject: [CLOCK, PLATFORM_LOGGER],
          useFactory: (clock: Clock, logger: PlatformLogger) =>
            new EventCancellations(deps.store, deps.refunds, () => clock.now(), deps.audit, deps.reauth, {
              ...(deps.suspension ? { suspension: deps.suspension } : {}),
              ...(deps.stopper ? { stopper: deps.stopper } : {}),
              ...(deps.reader ? { reader: deps.reader } : {}),
        ...(deps.circuits ? { circuits: deps.circuits } : {}),
              ...(deps.owners ? { owners: deps.owners } : {}),
              ...(deps.cases ? { cases: deps.cases } : {}),
              ...(deps.holds ? { holds: deps.holds } : {}),
              ...(deps.partnerStore ? { partnerStore: deps.partnerStore } : {}),
              ...(deps.revertFailures ? { revertFailures: deps.revertFailures } : {}),
              ...(deps.core ? { core: deps.core } : {}),
              ...(isCoreApplyStore(deps.store) ? { coreApplies: deps.store } : {}),
              ...(deps.coreApplyFailures ? { coreApplyFailures: deps.coreApplyFailures } : {}),
              ...(deps.calendar ? { calendar: deps.calendar } : {}),
              log: { warn: (obj, msg) => logger.warn(obj, msg), error: (obj, msg) => logger.error(obj, msg) },
            }),
        },
      ],
    };
  }
}
