// CS 처리함 모듈(BAT-425 GAT-130, F-06-2 GAT-280). 저장소·달력·경보 저장소는 AppModule이 DB/메모리로 골라 csCaseKit으로 묶어 넘긴다.
// 건 요청 처리기·기한 알림·실패한 승인 업무의 건은 다른 모듈(회차 취소·승인 업무)과 Kafka 소비자도 쓰므로 조립 때 한 벌만 만든다(csCaseKit).
// 기한 알림 배경 작업(1분 [가정])은 background가 켜진 때만 모듈 수명주기로 돈다(메모리 조립·시험은 끈다).
import { type DynamicModule, Inject, Injectable, Module, type OnApplicationBootstrap, type OnModuleDestroy, Optional } from '@nestjs/common';
import { CLOCK, type Clock, INTERNAL_TOKEN, InternalTokenGuard, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { RecordOpsAlert, type OpsAlertStore } from '../alerts/index.js';
import { CsApprovalFailureCases } from './application/approval-failure-cases.js';
import { CS_CASE_DEADLINE_TICK_MS, CsCaseDeadlineTick } from './application/cs-case-deadline-tick.js';
import { CsCases } from './application/cs-cases.js';
import { ReceiveCaseRequested } from './application/receive-case-requested.js';
import { weekendOnlyCalendar, type BusinessCalendar } from './domain/business-calendar.js';
import type { CsAssigneeDirectory, CsCaseDetailReader, CsCaseKind, CsCaseSignals, CsCaseStore } from './domain/cs-case.js';
import { CasesController } from './inbound/cases.controller.js';
import { OpsCasesController } from './inbound/ops-cases.controller.js';

export interface CsCaseKitOptions {
  readonly store: CsCaseStore;
  /** ops_alert 저장소(기한 경보 CS_CASE_DUE_SOON·CS_CASE_OVERDUE) */
  readonly alerts: OpsAlertStore;
  /** 영업일 달력(없으면 주말만 뺀다, local·ci) */
  readonly calendar?: BusinessCalendar;
  readonly signals?: CsCaseSignals;
}

/** 조립 때 한 벌만 만드는 CS 처리함 부품 */
export interface CsCaseKit {
  readonly store: CsCaseStore;
  readonly calendar: BusinessCalendar;
  readonly receive: ReceiveCaseRequested;
  readonly tick: CsCaseDeadlineTick;
  readonly approvalFailures: CsApprovalFailureCases;
}

export function csCaseKit(o: CsCaseKitOptions): CsCaseKit {
  const calendar = o.calendar ?? weekendOnlyCalendar;
  const receive = new ReceiveCaseRequested(o.store, { calendar, ...(o.signals ? { signals: o.signals } : {}) });
  // 경보 시각은 부르는 쪽 시각(createdAt·resolvedAt)으로 적는다
  const tick = new CsCaseDeadlineTick({ store: o.store, alerts: new RecordOpsAlert(o.alerts, () => Date.now()), calendar, ...(o.signals ? { signals: o.signals } : {}) });
  // 시스템이 닫는 쪽(resolveAsSystem)은 부르는 쪽 시각을 받으므로 시계가 필요 없다
  const systemCases = new CsCases({ store: o.store, clock: { now: () => Date.now() }, calendar, alerts: tick });
  return { store: o.store, calendar, receive, tick, approvalFailures: new CsApprovalFailureCases(receive, o.store, systemCases) };
}

export interface CasesModuleOptions {
  /** cs_lead 배정 대상 확인(identity 관리 계정). 없으면 다른 담당자에게 맡기기가 503이다 */
  readonly assignees?: CsAssigneeDirectory;
  /** 기한 알림 배경 작업. 없거나 enabled false면 켜지 않는다 */
  readonly background?: { readonly enabled: boolean; readonly intervalMs?: number };
  /** 종류별 상세 칸(F-06-7 등) */
  readonly detailReaders?: ReadonlyMap<CsCaseKind, CsCaseDetailReader>;
}

const CS_CASE_KIT = Symbol.for('peaket.ops.cs-case-kit');
const CS_CASE_BACKGROUND = Symbol.for('peaket.ops.cs-case-background');

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
              ...(o.detailReaders ? { detailReaders: o.detailReaders } : {}),
              ...(logger ? { log: { warn: (obj: object, msg: string) => logger.warn(obj, msg) } } : {}),
            }),
        },
        { provide: CS_CASE_BACKGROUND, useValue: { enabled: o.background?.enabled ?? false, intervalMs: o.background?.intervalMs ?? CS_CASE_DEADLINE_TICK_MS } },
        CsCaseDeadlineJob,
        { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
        InternalTokenGuard,
      ],
      exports: [ReceiveCaseRequested, CsCaseDeadlineTick, CsCases, CsCaseDeadlineJob],
    };
  }
}
