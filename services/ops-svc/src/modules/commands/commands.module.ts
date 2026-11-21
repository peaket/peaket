// 운영 명령 모듈(GAT-110 첫 몫, BAT-465 실행·재시도, BAT-355 수명주기). 저장소는 AppModule이 DB/메모리로 골라 넘긴다.
// 정비 작업 타이머는 모듈 수명주기(CommandMaintenanceJob)가 켜고 끈다. 지표 묶음(COMMAND_SIGNALS)은 시작 조립이 서비스 레지스트리에 붙인다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { INTERNAL_TOKEN, InternalTokenGuard, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import type { AuditCheckpointService } from '../audit/index.js';
import { ComputeDryRun } from './application/compute-dry-run.js';
import { CreateCommand, PreviewCommand } from './application/create-command.js';
import { DecideCommand } from './application/decide-command.js';
import { ExecuteCommand } from './application/execute-command.js';
import { GetCommand } from './application/get-command.js';
import { HandleCommandEvent } from './application/handle-command-event.js';
import { ListCommands } from './application/list-commands.js';
import { MaintainCommands, type MaintainCommandsOptions } from './application/maintain-commands.js';
import { RetryCommand } from './application/retry-command.js';
import { ExtendCommand, RevertCommand } from './application/revert-command.js';
import { COMMAND_MAINTENANCE_INTERVAL_MS, type CommandType } from './domain/command.js';
import type { DryRunSource } from './domain/dry-run.js';
import type { CancelledEventGuard, CommandExecutor, CommandSignals, CommandStore } from './domain/ports.js';
import type { ProtectedRangeList } from './domain/protected-ranges.js';
import { LogCommandSecurityEvents, PromCommandSignals } from './adapters/command-signals.js';
import { UnavailableDryRunSource } from './adapters/unavailable-dry-run-source.js';
import type { ApprovalReauthVerifier } from '../payouts/index.js';
import { CommandDryRunsController } from './inbound/command-dry-runs.controller.js';
import { CommandMaintenanceJob, type CommandMaintenanceOptions } from './inbound/command-maintenance.job.js';
import { CommandsController } from './inbound/commands.controller.js';
import { InternalCommandEventsController } from './inbound/internal-command-events.controller.js';
import { COMMAND_EXECUTOR, COMMAND_MAINTENANCE_OPTIONS, COMMAND_REAUTH, COMMAND_SECURITY_EVENTS, COMMAND_SIGNALS, COMMAND_STORE } from './tokens.js';

export { COMMAND_STORE, COMMAND_EXECUTOR, COMMAND_REAUTH, COMMAND_SECURITY_EVENTS, COMMAND_SIGNALS, COMMAND_MAINTENANCE_OPTIONS } from './tokens.js';

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
}

@Module({})
export class CommandsModule {
  static register(
    store: CommandStore,
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
    const security = new LogCommandSecurityEvents();
    const dryRun = new ComputeDryRun({
      ...(extras.dryRunSources ? { sources: extras.dryRunSources } : {}),
      fallback: new UnavailableDryRunSource(),
      ...(extras.protectedRanges ? { protectedRanges: extras.protectedRanges } : {}),
      signals,
    });
    const execution = new ExecuteCommand(store, executor, checkpoints, guard);
    const wired = executor ? execution : undefined;
    const createCommand = new CreateCommand(store, wired, guard, { dryRun, security });
    const maintain = new MaintainCommands(store, dryRun, extras.maintenance ?? {});
    const maintenance: CommandMaintenanceOptions = { enabled: extras.maintenance?.enabled ?? false, intervalMs: extras.maintenance?.intervalMs ?? COMMAND_MAINTENANCE_INTERVAL_MS };
    // HTTP 수신기와 Kafka 소비자가 같은 처리기를 쓴다(두 길로 같은 사건이 와도 한 번만 만든다).
    onCommandEvent?.(new HandleCommandEvent({ createCommand, store }));
    const providers: Provider[] = [
      { provide: COMMAND_STORE, useValue: store },
      { provide: COMMAND_EXECUTOR, useValue: executor },
      { provide: COMMAND_REAUTH, useValue: reauth },
      { provide: COMMAND_SIGNALS, useValue: signals },
      { provide: COMMAND_SECURITY_EVENTS, useFactory: (logger?: PlatformLogger) => security.attach(logger), inject: [{ token: PLATFORM_LOGGER, optional: true }] },
      { provide: COMMAND_MAINTENANCE_OPTIONS, useValue: maintenance },
      { provide: ExecuteCommand, useValue: execution },
      { provide: CreateCommand, useValue: createCommand },
      { provide: PreviewCommand, useValue: new PreviewCommand(createCommand) },
      { provide: MaintainCommands, useValue: maintain },
      { provide: ListCommands, useFactory: () => new ListCommands(store) },
      { provide: GetCommand, useFactory: () => new GetCommand(store) },
      // 승인 뒤 실행과 되돌리기 승인 뒤 되돌림 보내기에 실행기를 쓴다(실행기가 없으면 실행 없이 상태만 바뀐다)
      { provide: DecideCommand, useFactory: () => new DecideCommand(store, wired) },
      { provide: RetryCommand, useFactory: () => new RetryCommand(store, execution) },
      { provide: RevertCommand, useFactory: () => new RevertCommand(store, executor) },
      { provide: ExtendCommand, useFactory: () => new ExtendCommand(store, executor) },
      CommandMaintenanceJob,
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
    ];
    return {
      module: CommandsModule,
      controllers: [CommandsController, CommandDryRunsController, InternalCommandEventsController],
      providers,
      exports: [MaintainCommands, COMMAND_SIGNALS],
    };
  }
}
