// 운영 명령 모듈의 주입 토큰. 모듈과 컨트롤러가 서로 순환 import하지 않게 따로 둔다.
export const COMMAND_STORE = Symbol('ops.COMMAND_STORE');
export const COMMAND_EXECUTOR = Symbol('ops.COMMAND_EXECUTOR');
/** 위험 명령 재인증 확인기(act=OPS_COMMAND, ADR-0322). 없으면 위험 명령은 503이다 */
export const COMMAND_REAUTH = Symbol('ops.COMMAND_REAUTH');
/** 보안 사건 로그(ops_block_protected_range·ops_command_authz_denied) */
export const COMMAND_SECURITY_EVENTS = Symbol('ops.COMMAND_SECURITY_EVENTS');
/** 정비 작업 타이머 설정 */
export const COMMAND_MAINTENANCE_OPTIONS = Symbol('ops.COMMAND_MAINTENANCE_OPTIONS');
/** 정비 작업의 덧붙임(적용 확인 바퀴·온세일 표본, F-02-5). 없으면 그 바퀴는 돌지 않는다 */
export const COMMAND_MAINTENANCE_EXTRAS = Symbol('ops.COMMAND_MAINTENANCE_EXTRAS');
/** 운영 명령 지표(ops_command_dry_run_unavailable_total). 시작 조립이 서비스 레지스트리에 붙인다 */
export const COMMAND_SIGNALS = Symbol('ops.COMMAND_SIGNALS');
/** 운영 사건 줄 ops_event(ADR-0349 결정 8). 모듈 조립이 서비스 로거를 붙인다 */
export const COMMAND_OPS_EVENTS = Symbol('ops.COMMAND_OPS_EVENTS');
