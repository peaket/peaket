// 관리 재인증 확인기의 공개 이름(계획 BAT-045 §5). 구현은 payouts의 JwksApprovalVerifier를 act 셋으로 넓혀 재사용한다.
export { JwksApprovalVerifier as AdminReauth, JwksApprovalVerifier } from '../../payouts/index.js';
export { ReauthUnavailable } from '../../payouts/index.js';
