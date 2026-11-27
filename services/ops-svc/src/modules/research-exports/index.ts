// F-04-19 연구 내보내기 공개 면. 다른 컨텍스트·시험은 이 파일로만 가져온다.
export { ResearchExportsModule, type ResearchExportsModuleDeps } from './research-exports.module.js';
export { ResearchExports, ResearchProblem, type ResearchExportsDeps } from './application/research-exports.js';
export { ResearchExportsController } from './inbound/research-exports.controller.js';
export { MemoryResearchExportStore } from './adapters/memory-research-store.js';
export { MemoryResearchExportBuffer } from './adapters/memory-buffer.js';
export { UnavailableResearchSilverSource } from './adapters/unavailable-silver.js';
export { LoggingResearchAlerts } from './adapters/logging-alerts.js';
export { DrizzleResearchExportStore } from './adapters/db/drizzle-research-store.js';
export { DrizzlePseudonymizationLog } from './adapters/db/drizzle-pseudonymization-log.js';
export * from './domain/research-export.js';
export type {
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
