// 운영 명령 모듈(GAT-110 첫 몫, BAT-465 실행·재시도, BAT-355 수명주기). 저장소는 AppModule이 DB/메모리로 골라 넘긴다.
// 정비 작업 타이머는 모듈 수명주기(CommandMaintenanceJob)가 켜고 끈다. 지표 묶음(COMMAND_SIGNALS)은 시작 조립이 서비스 레지스트리에 붙인다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { INTERNAL_TOKEN, InternalTokenGuard, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import type { AuditCheckpointService } from '../audit/index.js';
import { ComputeDryRun } from './application/compute-dry-run.js';
import { CreateCommand, PreviewCommand } from './application/create-command.js';
import { DecideCommand } from './application/decide-command.js';
import { ControlAwareExecutor, ControlDispatcher, type ControlFanout } from './application/dispatch-control.js';
import { ExecuteCommand } from './application/execute-command.js';
import { PgAssignmentGate } from './application/pg-assignment-gate.js';
import { GetCommand } from './application/get-command.js';
import { HandleCommandEvent } from './application/handle-command-event.js';
import { ListCommands } from './application/list-commands.js';
import { MaintainCommands, type MaintainCommandsOptions } from './application/maintain-commands.js';
import { PostReviews } from './application/post-review.js';
import { RetryCommand } from './application/retry-command.js';
import { ExtendCommand, RevertCommand } from './application/revert-command.js';
import { COMMAND_MAINTENANCE_INTERVAL_MS, type CommandType } from './domain/command.js';
import type { DryRunSource } from './domain/dry-run.js';
import type { CancelledEventGuard, CommandExecutor, CommandSignals, CommandStore, ControlDeliveries, OnsaleStartSource, PgAssignmentCheck } from './domain/ports.js';
import type { ProtectedRangeList } from './domain/protected-ranges.js';
import { LogCommandSecurityEvents, PromCommandSignals } from './adapters/command-signals.js';
import { UnavailableDryRunSource } from './adapters/unavailable-dry-run-source.js';
import { OpsEventLog, OpsEventStore } from './adapters/ops-event-log.js';
import type { ActiveCommanders, BlockIpSetReader } from './domain/ports.js';
import type { OpsAlertStore } from '../alerts/index.js';
import type { ApprovalReauthVerifier } from '../payouts/index.js';
import { CommandDryRunsController } from './inbound/command-dry-runs.controller.js';
import { CommandMaintenanceJob, type CommandMaintenanceOptions } from './inbound/command-maintenance.job.js';
import { CommandsController } from './inbound/commands.controller.js';
import { InternalCommandEventsController } from './inbound/internal-command-events.controller.js';
import { PostReviewController } from './inbound/post-review.controller.js';
import { COMMAND_EXECUTOR, COMMAND_MAINTENANCE_OPTIONS, COMMAND_OPS_EVENTS, COMMAND_REAUTH, COMMAND_SECURITY_EVENTS, COMMAND_SIGNALS, COMMAND_STORE } from './tokens.js';

export { COMMAND_STORE, COMMAND_EXECUTOR, COMMAND_REAUTH, COMMAND_SECURITY_EVENTS, COMMAND_SIGNALS, COMMAND_MAINTENANCE_OPTIONS, COMMAND_OPS_EVENTS } from './tokens.js';

/** 운영 명령 모듈의 덧붙임(BAT-355). 주지 않으면 원천 unavailable·기본 보호 목록·정비 꺼짐이다 */
export interface CommandsModuleExtras {
  /** 유형별 dry-run 센 값 원천(BAT-365가 실제 원천을 넣는다). 없는 유형은 unavailable 어댑터 */
  readonly dryRunSources?: Partial<Record<CommandType, DryRunSource>>;
  /** 명령 4 보호 대역 목록(시험이 시험용 목록을 넣는다). 없으면 ADR-0339의 첫 목록 */
  readonly protectedRanges?: ProtectedRangeList;
  /** 정비 작업(30초 [가정]). DB 조립이 켠다 */
  readonly maintenance?: { readonly enabled: boolean; readonly intervalMs?: number } & MaintainCommandsOptions;
  /** 지표(없으면 Prometheus 묶음을 만들어 COMMAND_SIGNALS로 내놓는다) */
  readonly signals?: CommandSignals;
  /**
   * 명령 12 온세일 윈도우(core-svc 판매 설정)·하위 결제사 판정(payment-svc gRPC)의 원천(ADR-0349 결정 2·3, BAT-360). 없으면 명령 12가 503이다.
   * 주면 실행기 없이도 명령 12를 접수 뒤 바로 실행한다(설정 사건은 저장소 Outbox로 낸다)
   */
  readonly pgAssignment?: { readonly onsale?: OnsaleStartSource; readonly pgCheck?: PgAssignmentCheck; readonly onsaleTimeoutMs?: number; readonly pgCheckTimeoutMs?: number };
  /** 명령 3·11 사후 검토(ADR-0349 결정 7): 1인 기간 판정(identity 활성 commander)과 기한 넘김 SEV3 경보 저장소. commanders가 없으면 실행자의 검토는 503이다 */
  readonly postReviews?: { readonly commanders?: ActiveCommanders; readonly alerts?: OpsAlertStore };
  /** 명령 4 만료 확인이 읽는 WAF IP 집합 둘(ADR-0349 결정 10). 없으면 명령 4는 정비가 AUTO_EXPIRED로 적지 않는다 */
  readonly blockIpSets?: BlockIpSetReader;
  /** 운영 사건 줄 ops_event(ADR-0349 결정 8). 없으면 서비스 로거로 낸다(시험이 받는 쪽을 넣는다) */
  readonly opsEvents?: OpsEventLog;
  /**
   * 제어 gRPC 퍼뜨리기(F-02-1 OPS-300, ADR-0365 결정 3·4). 주면 명령 1·2·3·7·11은 배경 작업이 준비된 모든 파드에 보내 ack로 ACKED가 되고,
   * 되돌리기·연장·만료 되돌림은 새 판으로 보낸다. deliveries가 있으면 상세가 전파 상태(delivery)를 싣는다. 없으면 전처럼 실행기가 보낸다(target-not-wired)
   */
  readonly control?: { readonly fanout: ControlFanout; readonly deliveries?: ControlDeliveries; readonly clock?: { now(): number } };
}

@Module({})
export class CommandsModule {
  static register(
    /** 명령 저장소. 모듈 안 쓰임새는 운영 사건 줄을 내는 감싼 저장소를 쓰고, COMMAND_STORE는 이 원래 저장소다 */
    rawStore: CommandStore,
    executor?: CommandExecutor,
    checkpoints?: AuditCheckpointService,
    onCommandEvent?: (h: HandleCommandEvent) => void,
    /** 회차 취소 확정 회차의 판매 재개 막기(BAT-420 GAT-110 H). 만들 때·실행 때 함께 본다 */
    guard?: CancelledEventGuard,
    /** 위험 명령 재인증 확인기(act=OPS_COMMAND, BAT-045 BOT-140). 없으면 위험 명령이 503이다 */
    reauth?: ApprovalReauthVerifier,
    extras: CommandsModuleExtras = {},
  ): DynamicModule {
    const signals = extras.signals ?? new PromCommandSignals();
    // 운영 사건 줄은 감싼 저장소가 쓰기 트랜잭션이 끝난 뒤에만 낸다(ADR-0349 결정 8)
    const opsEvents = extras.opsEvents ?? new OpsEventLog();
    const store: CommandStore = new OpsEventStore(rawStore, opsEvents);
    const security = new LogCommandSecurityEvents();
    const dryRun = new ComputeDryRun({
      ...(extras.dryRunSources ? { sources: extras.dryRunSources } : {}),
      fallback: new UnavailableDryRunSource(),
      ...(extras.protectedRanges ? { protectedRanges: extras.protectedRanges } : {}),
      signals,
    });
    // 명령 12 판정은 미리보기·접수·실행 직전이 같은 객체를 쓴다(ADR-0349 결정 2·3)
    const pgGate = new PgAssignmentGate(extras.pgAssignment ?? {});
    // 제어 gRPC 배경 보내기(F-02-1). 되돌림·연장은 같은 보내기의 새 판이다(ControlAwareExecutor)
    const dispatcher = extras.control ? new ControlDispatcher({ store, fanout: extras.control.fanout, clock: extras.control.clock ?? { now: () => Date.now() } }) : undefined;
    const sender: CommandExecutor | undefined = dispatcher ? new ControlAwareExecutor(executor, dispatcher) : executor;
    const execution = new ExecuteCommand(store, sender, checkpoints, guard, { pgGate, ...(dispatcher ? { control: dispatcher } : {}) });
    const wired = sender || extras.pgAssignment ? execution : undefined;
    const createCommand = new CreateCommand(store, wired, guard, { dryRun, security, pgGate });
    const postReviews = new PostReviews({ store, ...(extras.postReviews?.commanders ? { commanders: extras.postReviews.commanders } : {}), ...(extras.postReviews?.alerts ? { alerts: extras.postReviews.alerts } : {}) });
    const maintain = new MaintainCommands(store, dryRun, extras.maintenance ?? {}, { postReviews, ...(extras.blockIpSets ? { blockIpSets: extras.blockIpSets } : {}), ...(dispatcher ? { control: dispatcher } : {}) });
    const maintenance: CommandMaintenanceOptions = { enabled: extras.maintenance?.enabled ?? false, intervalMs: extras.maintenance?.intervalMs ?? COMMAND_MAINTENANCE_INTERVAL_MS };
    // HTTP 수신기와 Kafka 소비자가 같은 처리기를 쓴다(두 길로 같은 사건이 와도 한 번만 만든다).
    onCommandEvent?.(new HandleCommandEvent({ createCommand, store }));
    const providers: Provider[] = [
      { provide: COMMAND_STORE, useValue: rawStore },
      { provide: COMMAND_OPS_EVENTS, useFactory: (logger?: PlatformLogger) => opsEvents.attach(logger), inject: [{ token: PLATFORM_LOGGER, optional: true }] },
      { provide: PostReviews, useValue: postReviews },
      { provide: COMMAND_EXECUTOR, useValue: executor },
      { provide: ControlDispatcher, useValue: dispatcher },
      { provide: COMMAND_REAUTH, useValue: reauth },
      { provide: COMMAND_SIGNALS, useValue: signals },
      { provide: COMMAND_SECURITY_EVENTS, useFactory: (logger?: PlatformLogger) => security.attach(logger), inject: [{ token: PLATFORM_LOGGER, optional: true }] },
      { provide: COMMAND_MAINTENANCE_OPTIONS, useValue: maintenance },
      { provide: ExecuteCommand, useValue: execution },
      { provide: CreateCommand, useValue: createCommand },
      { provide: PreviewCommand, useValue: new PreviewCommand(createCommand) },
      { provide: MaintainCommands, useValue: maintain },
      { provide: ListCommands, useFactory: () => new ListCommands(store) },
      { provide: GetCommand, useFactory: () => new GetCommand(store, extras.control?.deliveries) },
      // 승인 뒤 실행과 되돌리기 승인 뒤 되돌림 보내기에 실행기를 쓴다(실행기가 없으면 실행 없이 상태만 바뀐다)
      { provide: DecideCommand, useFactory: () => new DecideCommand(store, wired) },
      { provide: RetryCommand, useFactory: () => new RetryCommand(store, execution) },
      { provide: RevertCommand, useFactory: () => new RevertCommand(store, sender) },
      { provide: ExtendCommand, useFactory: () => new ExtendCommand(store, sender) },
      CommandMaintenanceJob,
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
    ];
    return {
      module: CommandsModule,
      controllers: [CommandsController, CommandDryRunsController, InternalCommandEventsController, PostReviewController],
      providers,
      exports: [MaintainCommands, COMMAND_SIGNALS, PostReviews, ControlDispatcher],
    };
  }
}
