// CS 처리함 모듈(BAT-425 GAT-130, F-06-2 GAT-280). 저장소·달력·경보 저장소는 AppModule이 DB/메모리로 골라 csCaseKit으로 묶어 넘긴다.
// 건 요청 처리기·기한 알림·실패한 승인 업무의 건은 다른 모듈(회차 취소·승인 업무)과 Kafka 소비자도 쓰므로 조립 때 한 벌만 만든다(csCaseKit).
// 기한 알림 배경 작업(1분 [가정])은 background가 켜진 때만 모듈 수명주기로 돈다(메모리 조립·시험은 끈다).
// 추가 검증 이의(F-06-7): 보낼 호출 배경 작업 CsCaseDispatchJob(10초 [가정])도 dispatchBackground가 켜진 때만 돈다. 시험은 runOnce()로 한 바퀴를 돈다.
import { type DynamicModule, Inject, Injectable, Module, type OnApplicationBootstrap, type OnModuleDestroy, Optional } from '@nestjs/common';
import { CLOCK, type Clock, INTERNAL_TOKEN, InternalTokenGuard, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { RecordOpsAlert, type OpsAlertStore } from '../alerts/index.js';
import { MemoryAuditChain } from '../audit/index.js';
import { CsApprovalFailureCases } from './application/approval-failure-cases.js';
import { CS_CASE_DEADLINE_TICK_MS, CsCaseDeadlineTick } from './application/cs-case-deadline-tick.js';
import { CsCaseDispatch } from './application/cs-case-dispatch.js';
import { CsCases } from './application/cs-cases.js';
import { AppealCases } from './application/appeal-cases.js';
import { CaseInquiryDetail, CaseReplies, type SupportCaseReplyPort } from './application/case-replies.js';
import { RestrictionAppealDecision } from './application/restriction-appeal-decision.js';
import { ReceiveCaseRequested } from './application/receive-case-requested.js';
import { VerificationAppealDecision } from './application/verification-appeal-decision.js';
import { VerificationAppealDetail } from './application/verification-appeal-detail.js';
import { weekendOnlyCalendar, type BusinessCalendar } from './domain/business-calendar.js';
import type { CsAssigneeDirectory, CsCaseDetailReader, CsCaseKind, CsCaseSignals, CsCaseStore } from './domain/cs-case.js';
import { CS_CASE_KIT } from './domain/cs-case.js';
import { CS_CASE_DISPATCH_TICK_MS, type CsAppealPorts, type CsAppealStore } from './domain/verification-appeal.js';
import { CasesController } from './inbound/cases.controller.js';
import { OpsCasesController } from './inbound/ops-cases.controller.js';

export interface CsCaseKitOptions {
  /** 건 저장소(추가 검증 이의 행·보낼 호출도 같은 저장소가 한 트랜잭션으로 쓴다) */
  readonly store: CsCaseStore & CsAppealStore;
  /** ops_alert 저장소(기한 경보 CS_CASE_DUE_SOON·CS_CASE_OVERDUE) */
  readonly alerts: OpsAlertStore;
  /** 영업일 달력(없으면 주말만 뺀다, local·ci) */
  readonly calendar?: BusinessCalendar;
  readonly signals?: CsCaseSignals;
  /** 추가 검증 이의 처리 포트(queue·trust·identity gRPC, 지표). 없는 칸은 NOT_CONFIGURED로 쌓는다 */
  readonly appeals?: CsAppealPorts;
  /** 예매 제한·부정 예매 소명(F-06-4). 없으면 APPEAL 건을 원본에 잇지 않는다 */
  readonly restrictions?: import('../restrictions/index.js').OpsRestrictionsWiring;
  /** 문의 답변·닫기(F-06-5). core SupportCaseService gRPC */
  readonly supportCases?: SupportCaseReplyPort;
  /** 감사 체인(답변 기록) */
  readonly audit?: import('../audit/index.js').AuditChain;
}

/** 조립 때 한 벌만 만드는 CS 처리함 부품 */
export interface CsCaseKit {
  readonly store: CsCaseStore & CsAppealStore;
  readonly calendar: BusinessCalendar;
  readonly receive: ReceiveCaseRequested;
  readonly tick: CsCaseDeadlineTick;
  readonly approvalFailures: CsApprovalFailureCases;
  readonly appealPorts: CsAppealPorts;
  readonly dispatch: CsCaseDispatch;
  readonly appealCases?: AppealCases;
  readonly audit?: import('../audit/index.js').AuditChain;
  readonly supportCases?: SupportCaseReplyPort;
}

export function csCaseKit(o: CsCaseKitOptions): CsCaseKit {
  const calendar = o.calendar ?? weekendOnlyCalendar;
  const appealCases = o.restrictions ? new AppealCases({ store: o.store, restrictions: o.restrictions, clock: { now: () => Date.now() } }) : undefined;
  const receive = new ReceiveCaseRequested(o.store, {
    calendar,
    ...(o.signals ? { signals: o.signals } : {}),
    ...(o.supportCases ? { supportCases: o.supportCases } : {}),
    ...(appealCases ? { onOpened: (c: import('./domain/cs-case.js').CsCase, nowMs: number) => appealCases.onOpened(c, nowMs) } : {}),
  });
  // 경보 시각은 부르는 쪽 시각(createdAt·resolvedAt)으로 적는다
  const tick = new CsCaseDeadlineTick({ store: o.store, alerts: new RecordOpsAlert(o.alerts, () => Date.now()), calendar, ...(o.signals ? { signals: o.signals } : {}) });
  // 시스템이 닫는 쪽(resolveAsSystem)은 부르는 쪽 시각을 받으므로 시계가 필요 없다
  const systemCases = new CsCases({ store: o.store, clock: { now: () => Date.now() }, calendar, alerts: tick });
  const appealPorts = o.appeals ?? {};
  // 반영 실패 경보 시각은 부르는 쪽 시각(앱 시계)으로 적는다
  const dispatch = new CsCaseDispatch({ store: o.store, ports: appealPorts, alerts: new RecordOpsAlert(o.alerts, () => Date.now()) });
  return { store: o.store, calendar, receive, tick, approvalFailures: new CsApprovalFailureCases(receive, o.store, systemCases), appealPorts, dispatch, ...(appealCases ? { appealCases } : {}), ...(o.audit ? { audit: o.audit } : {}), ...(o.supportCases ? { supportCases: o.supportCases } : {}) };
}

export interface CasesModuleOptions {
  /** cs_lead 배정 대상 확인(identity 관리 계정). 없으면 다른 담당자에게 맡기기가 503이다 */
  readonly assignees?: CsAssigneeDirectory;
  /** 기한 알림 배경 작업. 없거나 enabled false면 켜지 않는다 */
  readonly background?: { readonly enabled: boolean; readonly intervalMs?: number };
  /** 종류별 상세 칸(추가 검증 이의는 늘 더한다) */
  readonly detailReaders?: ReadonlyMap<CsCaseKind, CsCaseDetailReader>;
  /** 보낼 호출 배경 작업(F-06-7). 없거나 enabled false면 켜지 않는다 */
  readonly dispatchBackground?: { readonly enabled: boolean; readonly intervalMs?: number };
  /** 예매 제한 소명 판단(F-06-4). 없으면 결정 경로가 503이다 */
  readonly restrictions?: import('../restrictions/index.js').OpsRestrictionsWiring;
  /** 문의 답변·닫기(F-06-5) */
  readonly supportCases?: SupportCaseReplyPort;
}

const CS_CASE_BACKGROUND = Symbol.for('peaket.ops.cs-case-background');
const CS_CASE_DISPATCH_BACKGROUND = Symbol.for('peaket.ops.cs-case-dispatch-background');

/** 보낼 호출 배경 작업(10초 [가정]). 한 바퀴씩만 돌고(겹치지 않게) 실패해도 다음 바퀴에 다시 한다 */
@Injectable()
export class CsCaseDispatchJob implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly dispatch: CsCaseDispatch,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CS_CASE_DISPATCH_BACKGROUND) private readonly options: { readonly enabled: boolean; readonly intervalMs: number },
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled || this.#timer) return;
    this.#timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    this.#timer.unref();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.dispatch.run(this.clock.now());
    } catch (err) {
      this.logger?.warn({ event: 'cs-case-dispatch-tick-failed', err: err instanceof Error ? err.name : 'unknown' }, 'CS 처리함 보낼 호출 한 바퀴가 실패했다(다음 바퀴에 다시)');
    } finally {
      this.#running = false;
    }
  }
}

@Injectable()
export class CsCaseDeadlineJob implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly tick: CsCaseDeadlineTick,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CS_CASE_BACKGROUND) private readonly options: { readonly enabled: boolean; readonly intervalMs: number },
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled || this.#timer) return;
    this.#timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    this.#timer.unref();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 한 바퀴(겹치지 않게 한 번에 하나). 실패해도 다음 바퀴에 다시 한다 */
  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.tick.run(this.clock.now());
    } catch (err) {
      this.logger?.warn({ event: 'cs-case-deadline-tick-failed', err: err instanceof Error ? err.name : 'unknown' }, 'CS 처리함 기한 알림 한 바퀴가 실패했다(다음 바퀴에 다시)');
    } finally {
      this.#running = false;
    }
  }
}

@Module({})
export class CasesModule {
  static register(kit: CsCaseKit, o: CasesModuleOptions = {}): DynamicModule {
    return {
      module: CasesModule,
      controllers: [CasesController, OpsCasesController],
      providers: [
        { provide: CS_CASE_KIT, useValue: kit },
        { provide: ReceiveCaseRequested, useValue: kit.receive },
        { provide: CsCaseDeadlineTick, useValue: kit.tick },
        { provide: CsCaseDispatch, useValue: kit.dispatch },
        {
          provide: CsCases,
          inject: [CLOCK, { token: PLATFORM_LOGGER, optional: true }],
          useFactory: (clock: Clock, logger?: PlatformLogger) =>
            new CsCases({
              store: kit.store,
              clock,
              calendar: kit.calendar,
              alerts: kit.tick,
              ...(o.assignees ? { assignees: o.assignees } : {}),
              detailReaders: new Map<CsCaseKind, CsCaseDetailReader>([
                ...(o.detailReaders ?? new Map<CsCaseKind, CsCaseDetailReader>()),
                ['VERIFICATION_APPEAL', new VerificationAppealDetail({ store: kit.store, ports: kit.appealPorts, dispatch: kit.dispatch, clock })],
                ...(o.supportCases
                  ? ([
                      ['INQUIRY', new CaseInquiryDetail(o.supportCases)],
                      ['DISPUTE', new CaseInquiryDetail(o.supportCases)],
                      ['MINOR_CONTRACT_CANCEL', new CaseInquiryDetail(o.supportCases)],
                    ] as [CsCaseKind, CsCaseDetailReader][])
                  : []),
              ]),
              ...(logger ? { log: { warn: (obj: object, msg: string) => logger.warn(obj, msg) } } : {}),
            }),
        },
        {
          provide: VerificationAppealDecision,
          inject: [CsCases, CLOCK, { token: PLATFORM_LOGGER, optional: true }],
          useFactory: (cases: CsCases, clock: Clock, logger?: PlatformLogger) =>
            new VerificationAppealDecision({
              cases,
              caseStore: kit.store,
              store: kit.store,
              dispatch: kit.dispatch,
              clock,
              ...(logger ? { log: { warn: (obj: object, msg: string) => logger.warn(obj, msg) } } : {}),
            }),
        },
        {
          provide: RestrictionAppealDecision,
          inject: [CsCases, CLOCK],
          useFactory: (cases: CsCases, clock: Clock) =>
            new RestrictionAppealDecision({
              cases,
              store: kit.store,
              clock,
              restrictions: o.restrictions ?? { engineRef: {} },
            }),
        },
        {
          provide: CaseReplies,
          inject: [CsCases, CLOCK, { token: PLATFORM_LOGGER, optional: true }],
          useFactory: (cases: CsCases, clock: Clock, logger?: PlatformLogger) =>
            new CaseReplies({
              cases,
              clock,
              audit: kit.audit ?? new MemoryAuditChain(),
              ...(kit.supportCases ? { supportCases: kit.supportCases } : {}),
              ...(logger ? { logger: { warn: (obj: object, msg: string) => logger.warn(obj, msg) } } : {}),
            }),
        },
        { provide: CS_CASE_BACKGROUND, useValue: { enabled: o.background?.enabled ?? false, intervalMs: o.background?.intervalMs ?? CS_CASE_DEADLINE_TICK_MS } },
        CsCaseDeadlineJob,
        { provide: CS_CASE_DISPATCH_BACKGROUND, useValue: { enabled: o.dispatchBackground?.enabled ?? false, intervalMs: o.dispatchBackground?.intervalMs ?? CS_CASE_DISPATCH_TICK_MS } },
        CsCaseDispatchJob,
        { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
        InternalTokenGuard,
      ],
      exports: [ReceiveCaseRequested, CsCaseDeadlineTick, CsCases, CsCaseDeadlineJob, CsCaseDispatchJob],
    };
  }
}
