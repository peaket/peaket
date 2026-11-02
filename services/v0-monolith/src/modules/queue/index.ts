// 이 모듈의 공개 파일. 다른 컨텍스트는 층 폴더가 아니라 이 파일로만 가져온다(층 규칙).
export { QueueModule, type QueueModuleOptions } from './queue.module.js';
export { createAdmissionReader, createQueueAdmin, type AdmissionReader, type QueueAdmin } from './queue-admin.js';
export { POLL_FAR_MS, POLL_MID_MS, POLL_NEAR_MS, etaSeconds, pollIntervalMs } from './domain/polling.js';
export {
  ADMISSION_GRACE_MS,
  ADMIT_PER_SECOND_MAX,
  ADMIT_PER_SECOND_MIN,
  EVENT_ID_PATTERN,
  type QueueConfig,
  type ServingLogEntry,
  type TickResult,
} from './domain/queue.js';
export type { AdmissionView, EntryView, QueueStatusView } from './application/queue-service.js';
