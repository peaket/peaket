// 감사 모듈의 주입 토큰. 모듈·컨트롤러가 서로를 import하지 않게 따로 둔다.
export const AUDIT_CHECKPOINTS = Symbol('ops.AUDIT_CHECKPOINTS');
export const AUDIT_ANCHOR_SIGNER = Symbol('ops.AUDIT_ANCHOR_SIGNER');
/** 다른 서비스의 감사 기록 받기 저장소(ADR-0341 결정 7) */
export const AUDIT_INTAKE = Symbol('ops.AUDIT_INTAKE');
/** 감사 체인 지표 묶음(ops_audit_mac_lag_seconds·ops_audit_kms_failover_total). 시작 조립이 서비스 레지스트리에 붙인다 */
export const AUDIT_SIGNALS = Symbol('ops.AUDIT_SIGNALS');
/** 감사 체인 작업자·빈 행 경보·5분 앵커 묶음(AuditBackground) */
export const AUDIT_BACKGROUND = Symbol('ops.AUDIT_BACKGROUND');
