// F-04-19 연구 내보내기 모듈. 조사 모듈과 다른 배포(ops-research)에서 조립한다.
import { type DynamicModule, Module } from '@nestjs/common';
import { ResearchExports } from './application/research-exports.js';
import { ResearchExportsController } from './inbound/research-exports.controller.js';
import type {
  PseudonymizationLog,
  ResearchAlerts,
  ResearchAuditSink,
  ResearchDesignations,
  ResearchExportBuffer,
  ResearchExportConfig,
  ResearchExportStore,
  ResearchSchedule,
  ResearchSilverSource,
} from './domain/ports.js';

export interface ResearchExportsModuleDeps {
  readonly store: ResearchExportStore;
  readonly buffer: ResearchExportBuffer;
  readonly silver: ResearchSilverSource;
  readonly audit: ResearchAuditSink;
  readonly log: PseudonymizationLog;
  readonly config: ResearchExportConfig;
  readonly alerts: ResearchAlerts;
  readonly identity: ResearchDesignations;
  readonly schedule: ResearchSchedule;
  readonly now: () => number;
}

@Module({})
export class ResearchExportsModule {
  static register(deps: ResearchExportsModuleDeps): DynamicModule {
    const service = new ResearchExports({
      store: deps.store,
      buffer: deps.buffer,
      silver: deps.silver,
      audit: deps.audit,
      log: deps.log,
      config: deps.config,
      alerts: deps.alerts,
      identity: deps.identity,
      schedule: deps.schedule,
      now: deps.now,
    });
    return {
      module: ResearchExportsModule,
      controllers: [ResearchExportsController],
      providers: [{ provide: ResearchExports, useValue: service }],
      exports: [ResearchExports],
    };
  }
}
