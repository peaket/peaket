// 감사 모듈의 주입 토큰. 모듈·컨트롤러가 서로를 import하지 않게 따로 둔다.
export const AUDIT_CHECKPOINTS = Symbol('ops.AUDIT_CHECKPOINTS');
export const AUDIT_ANCHOR_SIGNER = Symbol('ops.AUDIT_ANCHOR_SIGNER');
