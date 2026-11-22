// 리더 컨텍스트의 공개 면(시작 파일은 이 파일로만 들어온다).
export { AdmissionLeader } from './application/admission-leader.js';
export { LeaderMetrics } from './application/leader-metrics.js';
export { LeaderModule, type LeaderModuleOptions } from './leader.module.js';
export { LEADER_STORE, type Elector, type LeaderControlResult, type LeaderControlStoreWrite, type LeaderStore } from './domain/ports.js';
export { PrometheusControlInputs } from './adapters/prometheus-control-inputs.js';
// 제어 gRPC 받는 쪽(F-02-1 OPS-300, ADR-0365 결정 2·5·6)
export { ApplyLeaderControl, type ApplyLeaderControlInput, type ApplyLeaderControlResult, type LeaderFence } from './application/apply-control.js';
export { LEADER_CONTROL_KINDS, LEADER_CONTROL_PLATFORM, LeaderControlRejected, PG_GROUP_KEY, leaderControlOf, type LeaderControlKind, type LeaderControlWrite } from './domain/control.js';
export { CONTROL_WRITE_LUA } from './adapters/leader-lua.js';
export { RedisLeaderStore, keys as leaderKeys } from './adapters/redis-leader-store.js';
// 명령 6 대체 결제사 전환의 결제사 묶음 차례와 낮춘 채널 상한 비율(F-02-2 OPS-310, ADR-0366 결정 4·10)
export { PG_FALLBACK_GROUP, PG_RATIO_KEYS, PG_RATIO_MAX, PG_RATIO_MIN, PG_RATIO_QUERY, pgGroupOf, pgRatioOf, pgWithRatio, type PgFields } from './domain/pg-ratio.js';
