// 운영 명령 모듈의 주입 토큰. 모듈과 컨트롤러가 서로 순환 import하지 않게 따로 둔다.
export const COMMAND_STORE = Symbol('ops.COMMAND_STORE');
export const COMMAND_EXECUTOR = Symbol('ops.COMMAND_EXECUTOR');
/** 위험 명령 재인증 확인기(act=OPS_COMMAND, ADR-0322). 없으면 위험 명령은 503이다 */
export const COMMAND_REAUTH = Symbol('ops.COMMAND_REAUTH');
