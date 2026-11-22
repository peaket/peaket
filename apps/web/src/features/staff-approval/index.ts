// SCR-051 스캐너 승인(휴대폰 쪽, BUILD_ORDER F-05-7, ADR-0362). 이 파일은 경로 별칭 없이 읽힌다(node 시험·실제 서버 연결 시험).
// 브라우저에 잇는 것은 browser.ts(browserStaffApprovalApi)에 있다.
export {
  afterDecide,
  approvalCodeLabel,
  approvalLookupOf,
  createStaffApprovalApi,
  loadApproval,
  type ApprovalAssignment,
  type ApprovalAssignmentView,
  type ApprovalLiveState,
  type ApprovalLoad,
  type ApprovalLookup,
  type ApprovalLookupAnswer,
  type ApprovalView,
  type DecideAnswer,
  type LookupDenyReason,
  type StaffApprovalApi,
} from './flow.ts';
