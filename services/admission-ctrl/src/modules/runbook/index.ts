// 런북 제어 명령 CLI의 공개 면(F-02-7). rb35의 CLI 진입점이 이 갈래를 위임한다.
export { isControlFile, isControlPreset, runControlCli, type ControlCliDeps } from './application/cli.js';
export { FileRunbookAuditSink } from './adapters/file-audit-sink.js';
export { GrpcRunbookControlTransport } from './adapters/grpc-control-transport.js';
export { MemoryRunbookAuditSink } from './adapters/memory-audit-sink.js';
export { S3RunbookAuditSink } from './adapters/s3-audit-sink.js';
export { CONTROL_PRESETS, isControlPreset as isControlPresetName, type ControlPreset, type RunbookAuditIntent, type RunbookAuditResult, type RunbookAuditSink, type RunbookControlAck, type RunbookControlRequest, type RunbookControlService, type RunbookControlTransport } from './domain/ports.js';
