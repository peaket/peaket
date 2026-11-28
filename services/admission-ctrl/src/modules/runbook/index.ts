// 런북 제어 명령 CLI의 공개 면(F-02-7). rb35의 CLI 진입점이 이 갈래를 위임한다.
export { isControlFile, isControlPreset, runControlCli, type ControlCliDeps } from './application/cli.js';
export { CONTROL_PRESETS, isControlPreset as isControlPresetName, type ControlPreset, type RunbookAuditIntent, type RunbookAuditResult, type RunbookAuditSink, type RunbookControlAck, type RunbookControlRequest, type RunbookControlService, type RunbookControlTransport } from './domain/ports.js';
