// SCR-050 초대 수락·거절과 SCR-061 내 현장 배정 목록(BUILD_ORDER F-05-7, ADR-0362). 이 파일은 경로 별칭 없이 읽힌다(node 시험·실제 서버 연결 시험).
// 브라우저에 잇는 것은 browser.ts(browserStaffInvitationApi·isLiveStaff)에 있다.
export {
  afterAccept,
  afterReject,
  ASSIGNMENTS_PAGE_LIMIT,
  canAcceptIn,
  consentLinesOf,
  createStaffInvitationApi,
  invitationLookupOf,
  loadInvitation,
  STAFF_RETRY_TEXT,
  type AcceptAnswer,
  type AssignmentsAnswer,
  type ConsentLine,
  type InvitationLiveState,
  type InvitationLoad,
  type InvitationLookup,
  type LookupAnswer,
  type RejectAnswer,
  type StaffInvitationApi,
} from './flow.ts';
