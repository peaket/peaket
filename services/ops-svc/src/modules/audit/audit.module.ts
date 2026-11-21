// 감사 모듈(BAT-465 GAT-310·R-584 체크포인트, BAT-355 OPS-270 mac 작업자·5분 앵커·감사 기록 받기). 서비스는 AppModule이 DB/메모리로 골라 넘긴다.
// DB 조립이면 감사 체인 작업자·빈 행 경보·5분 앵커(AuditBackground)를 팩토리로 만들고 모듈 수명주기로 켠다(main.ts를 고치지 않는다).
// 팩토리가 환경 값을 본다: local·ci·demo가 아닌데 감사 체인 키 ID·넘길 리전·앵커 버킷이 없으면 던져 서비스가 시작하지 않는다(ADR-0341 결정 2·5).
// 감사 공개 앵커(BAT-360 OPS-280, ADR-0348): 이 프로세스는 서명 키를 갖지 않는다. 서명·공개 타임스탬프·게시는 게시 작업(jobs/audit-anchor.ts)만 하고,
// 여기서는 공개 행 검증(저장된 공개키)·검증 묶음 내보내기·1분 신호(지표·밀림 경보·서명 전 어긋남)만 한다.
import { randomUUID } from 'node:crypto';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock, type Database, INTERNAL_TOKEN, INTERNAL_TOKEN_REQUIRED, InternalTokenGuard, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import type { OpsAlertStore } from '../alerts/index.js';
import type { AuditIntakeStore } from './audit-intake.js';
import { AuditBackground, type AuditBackgroundOptions } from './background.js';
import { AuditChainWorker, AuditMacLagMonitor, AuditSignals, DrizzleAuditMacStore } from './chain-worker.js';
import { AuditCheckpointService, DrizzleAuditChain, DrizzleAuditCheckpointStore } from './checkpoint.js';
import { CheckpointSignalMonitor } from './checkpoint-signals.js';
import { auditEnvName, auditMacKeyFromEnv, macAnchorStoreFromEnv } from './config.js';
import { AuditAnchorsController, AuditCheckpointsController } from './inbound/checkpoints.controller.js';
import { InternalAuditRecordsController } from './inbound/internal-audit-records.controller.js';
import type { AuditMacKey } from './mac.js';
import { AuditMacAnchorer, type MacAnchorStore } from './mac-anchor.js';
import { AUDIT_BACKGROUND, AUDIT_CHECKPOINTS, AUDIT_INTAKE, AUDIT_SIGNALS } from './tokens.js';

export { AUDIT_BACKGROUND, AUDIT_CHECKPOINTS, AUDIT_INTAKE, AUDIT_SIGNALS } from './tokens.js';

/** DB 조립의 감사 체인 작업자 묶음. key·anchors를 주면 환경 값 대신 그것을 쓴다(시험) */
export interface AuditBackgroundWiring {
  readonly database: Database;
  readonly alerts: OpsAlertStore;
  readonly key?: AuditMacKey;
  readonly anchors?: MacAnchorStore;
  /** 없으면 process.env */
  readonly env?: Record<string, string | undefined>;
  /** 거짓이면 타이머를 켜지 않는다(설정 검사는 한다). 기본 참 */
  readonly enabled?: boolean;
  readonly options?: Partial<Omit<AuditBackgroundOptions, 'enabled'>>;
  /** 공개 앵커 신호가 서명 전 체크포인트를 검증할 서비스(없으면 어긋남 검증 없이 지표·밀림 경보만) */
  readonly checkpoints?: AuditCheckpointService;
}

export interface AuditModuleExtras {
  readonly intake?: AuditIntakeStore;
  readonly background?: AuditBackgroundWiring;
  /** 지표 묶음(없으면 만든다) */
  readonly signals?: AuditSignals;
}

/** 팩토리: 환경 값으로 키·앵커 저장소를 고르고 작업자 묶음을 만든다(설정이 틀리면 던진다) */
export function auditBackgroundOf(w: AuditBackgroundWiring, signals: AuditSignals, clock: Clock, logger: PlatformLogger | undefined, platformLocal: boolean): AuditBackground {
  const env = w.env ?? process.env;
  const envName = auditEnvName(env, platformLocal);
  const keyR = w.key ? { key: w.key } : auditMacKeyFromEnv(env, { envName, onFailover: (op) => signals.failover(op) });
  const anchorR = w.anchors ? { store: w.anchors } : macAnchorStoreFromEnv(env, { envName });
  const store = new DrizzleAuditMacStore(w.database);
  const warnings = [...('warning' in keyR && keyR.warning ? [keyR.warning] : []), ...('warning' in anchorR && anchorR.warning ? [anchorR.warning] : [])];
  const checkpointSource = new DrizzleAuditCheckpointStore(w.database);
  const checkpointSignals = new CheckpointSignalMonitor({
    source: checkpointSource,
    verify: w.checkpoints ? (id) => w.checkpoints!.verify(id) : (id) => new AuditCheckpointService(checkpointSource, new DrizzleAuditChain(w.database), () => clock.now()).verify(id),
    alerts: w.alerts,
    signals: signals.checkpoints,
    audit: new DrizzleAuditChain(w.database),
  });
  return new AuditBackground({
    worker: new AuditChainWorker({ store, key: keyR.key, alerts: w.alerts }),
    lease: store,
    monitor: new AuditMacLagMonitor(store, w.alerts, signals),
    anchorer: new AuditMacAnchorer(store, anchorR.store, keyR.key.keyId),
    checkpointSignals,
    now: () => clock.now(),
    ...(logger ? { logger } : {}),
    warnings,
    options: { holder: (env.PEAKET_POD ?? env.HOSTNAME ?? `ops-${randomUUID().slice(0, 8)}`).slice(0, 64), ...(w.options ?? {}), enabled: w.enabled ?? true },
  });
}

@Module({})
export class AuditModule {
  static register(checkpoints: AuditCheckpointService, extras: AuditModuleExtras = {}): DynamicModule {
    const signals = extras.signals ?? new AuditSignals();
    const background = extras.background;
    const providers: Provider[] = [
      { provide: AuditCheckpointService, useValue: checkpoints },
      { provide: AUDIT_CHECKPOINTS, useValue: checkpoints },
      { provide: AUDIT_SIGNALS, useValue: signals },
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      InternalTokenGuard,
    ];
    if (extras.intake) providers.push({ provide: AUDIT_INTAKE, useValue: extras.intake });
    if (background) {
      providers.push({
        provide: AUDIT_BACKGROUND,
        useFactory: (clock: Clock, logger?: PlatformLogger, internalTokenRequired?: boolean) =>
          auditBackgroundOf({ checkpoints, ...background }, signals, clock, logger, internalTokenRequired === false),
        inject: [CLOCK, { token: PLATFORM_LOGGER, optional: true }, { token: INTERNAL_TOKEN_REQUIRED, optional: true }],
      });
    }
    return {
      module: AuditModule,
      controllers: [AuditCheckpointsController, AuditAnchorsController, ...(extras.intake ? [InternalAuditRecordsController] : [])],
      providers,
      exports: [AUDIT_SIGNALS],
    };
  }
}
