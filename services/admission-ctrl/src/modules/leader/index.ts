// 리더 컨텍스트의 공개 면(시작 파일은 이 파일로만 들어온다).
export { AdmissionLeader } from './application/admission-leader.js';
export { LeaderMetrics } from './application/leader-metrics.js';
export { LeaderModule, type LeaderModuleOptions } from './leader.module.js';
export { LEADER_STORE, type Elector, type LeaderControlResult, type LeaderControlStoreWrite, type LeaderStore } from './domain/ports.js';
export { PrometheusControlInputs } from './adapters/prometheus-control-inputs.js';
// 제어 gRPC 받는 쪽(F-02-1 OPS-300, ADR-0365 결정 2·5·6)
export { ApplyLeaderControl, type ApplyLeaderControlInput, type ApplyLeaderControlResult, type LeaderFence } from './application/apply-control.js';
export { LEADER_CONTROL_KINDS, LEADER_CONTROL_PLATFORM, LeaderControlRejected, leaderControlOf, type LeaderControlKind, type LeaderControlWrite } from './domain/control.js';
export { CONTROL_WRITE_LUA } from './adapters/leader-lua.js';
export { RedisLeaderStore, keys as leaderKeys } from './adapters/redis-leader-store.js';
