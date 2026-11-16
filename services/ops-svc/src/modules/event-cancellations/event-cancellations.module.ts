// 회차 취소 요청 모듈 조립. AppModule이 저장소·purchase-svc 일괄 환불 시작기와 BAT-420 GAT-110 의존(판매 중지 확인·판매 멈춤·
// 미리보기·진행률 읽기·파트너 소속 확인·판정 대기 건)을 골라 넘긴다. 시각은 서비스 시계(CLOCK), 경고는 서비스 로거로 남긴다.
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import type { AuditChain } from '../audit/audit.js';
import { EventCancellations, type EventCancellationReauth } from './application/event-cancellations.js';
import type { EventCancellationCases, EventCancellationStore, EventOwnerLookup, EventRefundReader, EventRefundStarter, EventSaleStopper, SaleSuspensionLookup } from './domain/ports.js';
import { EventCancellationsController } from './inbound/event-cancellations.controller.js';
import { PartnerEventCancellationController } from './inbound/partner-event-cancellation.controller.js';

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
  /** 파트너 소속 확인(core 판매 설정). 없으면 파트너 경로가 503 authz-unavailable이다 */
  readonly owners?: EventOwnerLookup;
  /** CS 처리함 '판정 대기' 건 */
  readonly cases?: EventCancellationCases;
}

@Module({})
export class EventCancellationsModule {
  static register(deps: EventCancellationsModuleDeps): DynamicModule {
    return {
      module: EventCancellationsModule,
      controllers: [EventCancellationsController, PartnerEventCancellationController],
      providers: [
        {
          provide: EventCancellations,
          inject: [CLOCK, PLATFORM_LOGGER],
          useFactory: (clock: Clock, logger: PlatformLogger) =>
            new EventCancellations(deps.store, deps.refunds, () => clock.now(), deps.audit, deps.reauth, {
              ...(deps.suspension ? { suspension: deps.suspension } : {}),
              ...(deps.stopper ? { stopper: deps.stopper } : {}),
              ...(deps.reader ? { reader: deps.reader } : {}),
              ...(deps.owners ? { owners: deps.owners } : {}),
              ...(deps.cases ? { cases: deps.cases } : {}),
              log: { warn: (obj, msg) => logger.warn(obj, msg) },
            }),
        },
      ],
    };
  }
}
