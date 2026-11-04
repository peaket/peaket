// 계약(docs/api/openapi.yaml)에서 만든 파일이다. 손으로 고치지 않는다: pnpm --filter @peaket/api-client gen(BUILD_ORDER BAS-041)

/** 이름 붙은 오류(RFC 9457 type의 마지막 경로, openapi x-peaket-problem-types, docs/api/guidelines.md §2) */
export type ProblemType =
  | 'admin-account-locked'
  | 'admin-account-state-conflict'
  | 'admin-email-in-use'
  | 'admin-login-busy'
  | 'admin-login-code-invalid'
  | 'admin-login-failed'
  | 'admin-login-step-invalid'
  | 'admin-login-unavailable'
  | 'admin-role-not-allowed'
  | 'admission-token-invalid'
  | 'already-admitted'
  | 'already-reported'
  | 'already-verified'
  | 'already-waiting'
  | 'approval-reason-required'
  | 'approval-scope-invalid'
  | 'artist-exists'
  | 'authz-unavailable'
  | 'auto-assign-not-supported'
  | 'batching'
  | 'booking-restricted'
  | 'booth-mismatch'
  | 'cancel-deadline-passed'
  | 'case-not-actioned'
  | 'commander-removal-needs-role-change'
  | 'consent-required'
  | 'consent-version-outdated'
  | 'current-password-invalid'
  | 'data-request-required'
  | 'deadline-exceeded'
  | 'dependency-unavailable'
  | 'designation-conflict'
  | 'designation-exists'
  | 'designation-target-not-commander'
  | 'designation-target-not-eligible'
  | 'duplicate-account'
  | 'duplicate-admission'
  | 'entry-started'
  | 'first-partner-account-must-be-admin'
  | 'fraud-approver-ineligible'
  | 'fraud-case-exists'
  | 'fraud-case-state'
  | 'fraud-report-not-ready'
  | 'fraud-run-in-progress'
  | 'fraud-run-not-failed'
  | 'fraud-run-retrying'
  | 'fraud-summary-not-viewed'
  | 'human-check-required'
  | 'human-check-unavailable'
  | 'idempotency-key-invalid'
  | 'idempotency-key-reused'
  | 'idempotency-request-in-progress'
  | 'identity-required'
  | 'identity-verification-required'
  | 'inquiry-closed'
  | 'invalid-seat'
  | 'investigation-source-expired'
  | 'investigator-required'
  | 'jwks-not-found'
  | 'last-login-method'
  | 'last-partner-admin'
  | 'login-provider-not-linked'
  | 'manual-selection-required'
  | 'merge-blocked'
  | 'merge-check-unavailable'
  | 'merge-invariant-violated'
  | 'merge-proposal-not-found'
  | 'next-invalid'
  | 'no-placement'
  | 'not-found'
  | 'not-payer'
  | 'open-interval-conflict'
  | 'open-passed'
  | 'order-expired'
  | 'other-partner-device'
  | 'outside-staff-hours'
  | 'password-change-required'
  | 'password-rejected'
  | 'payment-attempts-exceeded'
  | 'pickup-slot-unavailable'
  | 'place-exists'
  | 'precondition-failed'
  | 'precondition-required'
  | 'preverify-invalid'
  | 'priority-grant-not-found'
  | 'priority-seat-only'
  | 'promoter-mismatch'
  | 'provider-down'
  | 'pseudonym-handler-required'
  | 'pseudonymization-review-pending'
  | 'purchase-limit-exceeded'
  | 'purchase-seq-reused'
  | 'purchase-session-ended'
  | 'purchase-signature-invalid'
  | 'purpose-not-supported'
  | 'push-key-invalid'
  | 'push-service-not-allowed'
  | 'query-too-short'
  | 'queue-not-found'
  | 'queue-not-open'
  | 'queue-recovering'
  | 'queue-ticket-expired'
  | 'queue-ticket-invalid'
  | 'queue-ticket-removed'
  | 'reauth-required'
  | 'refresh-token-invalid'
  | 'research-export-not-ready'
  | 'restriction-too-long'
  | 'retention-ended'
  | 'review-already-written'
  | 'review-event-cancelled'
  | 'review-not-ended'
  | 'review-not-purchaser'
  | 'role-group-mismatch'
  | 'rotation-too-soon'
  | 'sale-ended'
  | 'sale-not-suspended'
  | 'sale-paused'
  | 'scale-change-closed'
  | 'seat-already-held'
  | 'seat-recently-released'
  | 'seat-store-unavailable'
  | 'seatmap-geometry-locked'
  | 'seatmap-invalid'
  | 'seatmap-replace-required'
  | 'self-target-forbidden'
  | 'server-busy'
  | 'sold-out'
  | 'staff-assignment-missing'
  | 'subscription-limit'
  | 'transfer-locked'
  | 'trigger-deferred'
  | 'under-14'
  | 'unknown-promoter'
  | 'unlock-code-invalid'
  | 'unlock-link-invalid'
  | 'unlock-link-resend-limit'
  | 'verification-not-found'
  | 'webhook-url-not-allowed'
  | 'wish-limit'
  | 'withdrawal-confirmation-required';

export const PROBLEM_TYPE_BASE = "https://peaket.example/problems/";

/** 이름마다 상태 코드와 제목(제목은 화면에 보이지 않는다. 화면은 문구 키로 고른다, docs/frontend.md §5.12) */
export const PROBLEM_TYPES = {
  'admin-account-locked': { status: 423, title: "계정이 잠겼습니다" },
  'admin-account-state-conflict': { status: 409, title: "지금 계정 상태에서는 할 수 없습니다" },
  'admin-email-in-use': { status: 409, title: "이미 쓰는 이메일입니다" },
  'admin-login-busy': { status: 429, title: "잠시 뒤 다시 시도해 주세요" },
  'admin-login-code-invalid': { status: 401, title: "인증 앱 코드가 맞지 않습니다" },
  'admin-login-failed': { status: 401, title: "이메일이나 비밀번호가 맞지 않습니다" },
  'admin-login-step-invalid': { status: 401, title: "처음부터 다시 로그인해 주세요" },
  'admin-login-unavailable': { status: 503, title: "잠시 뒤 다시 시도해 주세요" },
  'admin-role-not-allowed': { status: 403, title: "이 역할로는 초대할 수 없습니다" },
  'admission-token-invalid': { status: 401, title: "입장 확인이 끝났습니다" },
  'already-admitted': { status: 409, title: "이 회차에 이미 입장했습니다" },
  'already-reported': { status: 409, title: "이미 신고한 후기입니다" },
  'already-verified': { status: 409, title: "이미 본인확인을 마친 계정입니다" },
  'already-waiting': { status: 409, title: "이미 다른 곳에서 대기 중입니다" },
  'approval-reason-required': { status: 422, title: "승인 사유를 적어 주세요" },
  'approval-scope-invalid': { status: 422, title: "요청 범위 밖의 대상입니다" },
  'artist-exists': { status: 409, title: "같은 이름의 아티스트가 있습니다" },
  'authz-unavailable': { status: 503, title: "권한을 확인하지 못했습니다" },
  'auto-assign-not-supported': { status: 400, title: "좌석 자동 배정은 아직 받지 않습니다" },
  'batching': { status: 503, title: "순서를 정하는 중입니다. 잠시 뒤 다시 시도해 주세요" },
  'booking-restricted': { status: 403, title: "예매가 제한된 계정입니다" },
  'booth-mismatch': { status: 409, title: "티켓 보유자와 다른 분입니다" },
  'cancel-deadline-passed': { status: 409, title: "취소할 수 있는 시각이 지났습니다" },
  'case-not-actioned': { status: 409, title: "조치하지 않은 사건입니다" },
  'commander-removal-needs-role-change': { status: 409, title: "commander 역할을 먼저 바꿔 주세요" },
  'consent-required': { status: 422, title: "동의가 필요합니다" },
  'consent-version-outdated': { status: 422, title: "동의 문안이 바뀌었습니다. 다시 확인해 주세요" },
  'current-password-invalid': { status: 422, title: "지금 비밀번호가 맞지 않습니다" },
  'data-request-required': { status: 422, title: "접수된 기관 요청이 필요합니다" },
  'deadline-exceeded': { status: 504, title: "남은 처리 시간이 모자라 요청을 끝내지 못했습니다" },
  'dependency-unavailable': { status: 503, title: "의존 서비스를 잠시 쓸 수 없습니다" },
  'designation-conflict': { status: 409, title: "함께 가질 수 없는 지정이 있습니다" },
  'designation-exists': { status: 409, title: "이미 같은 지정이 있습니다" },
  'designation-target-not-commander': { status: 422, title: "commander 계정에만 줄 수 있는 지정입니다" },
  'designation-target-not-eligible': { status: 422, title: "이 계정에는 줄 수 없는 지정입니다" },
  'duplicate-account': { status: 409, title: "이미 다른 계정에서 본인확인한 분입니다. 그 계정으로 로그인해 주세요" },
  'duplicate-admission': { status: 409, title: "이미 다른 기기나 탭에서 입장했습니다" },
  'entry-started': { status: 409, title: "입장이 시작되어 할 수 없습니다" },
  'first-partner-account-must-be-admin': { status: 422, title: "파트너사의 첫 계정은 관리자여야 합니다" },
  'fraud-approver-ineligible': { status: 403, title: "이 사건을 승인할 수 없는 계정입니다" },
  'fraud-case-exists': { status: 409, title: "이 묶음으로 만든 사건이 이미 있습니다" },
  'fraud-case-state': { status: 409, title: "지금 사건 상태에서는 할 수 없습니다" },
  'fraud-report-not-ready': { status: 404, title: "부정 예매 리포트가 아직 없습니다" },
  'fraud-run-in-progress': { status: 409, title: "분석이 아직 돌고 있습니다" },
  'fraud-run-not-failed': { status: 409, title: "다시 돌릴 실패한 분석이 없습니다" },
  'fraud-run-retrying': { status: 409, title: "분석을 자동으로 다시 시도하고 있습니다" },
  'fraud-summary-not-viewed': { status: 409, title: "사건 요약을 먼저 열어 보세요" },
  'human-check-required': { status: 428, title: "사람 확인을 마친 뒤 다시 시도해 주세요" },
  'human-check-unavailable': { status: 503, title: "잠시 뒤 다시 시도해 주세요" },
  'idempotency-key-invalid': { status: 400, title: "멱등 키(Idempotency-Key)가 없거나 형식이 맞지 않습니다" },
  'idempotency-key-reused': { status: 422, title: "같은 멱등 키를 다른 요청에 썼습니다" },
  'idempotency-request-in-progress': { status: 409, title: "같은 요청을 아직 처리하고 있습니다" },
  'identity-required': { status: 403, title: "휴대폰 본인확인을 먼저 해 주세요" },
  'identity-verification-required': { status: 403, title: "휴대폰 본인확인을 먼저 해 주세요" },
  'inquiry-closed': { status: 409, title: "닫힌 문의입니다" },
  'invalid-seat': { status: 422, title: "고를 수 없는 좌석이 있습니다" },
  'investigation-source-expired': { status: 410, title: "조사 원천 보존 기간이 끝났습니다" },
  'investigator-required': { status: 403, title: "부정 거래 조사관만 할 수 있습니다" },
  'jwks-not-found': { status: 404, title: "없는 공개키 묶음입니다" },
  'last-login-method': { status: 409, title: "마지막 로그인 수단은 해제할 수 없습니다" },
  'last-partner-admin': { status: 409, title: "마지막 파트너 관리자는 바꿀 수 없습니다" },
  'login-provider-not-linked': { status: 404, title: "연결된 로그인 수단이 아닙니다" },
  'manual-selection-required': { status: 409, title: "좌석을 직접 골라 주세요" },
  'merge-blocked': { status: 409, title: "지금은 두 계정을 합칠 수 없습니다" },
  'merge-check-unavailable': { status: 503, title: "잠시 뒤 다시 시도해 주세요" },
  'merge-invariant-violated': { status: 409, title: "지금은 두 계정을 합칠 수 없습니다. 고객센터로 문의해 주세요" },
  'merge-proposal-not-found': { status: 404, title: "병합 제안이 없거나 시간이 지났습니다" },
  'next-invalid': { status: 400, title: "돌아갈 주소가 같은 출처 경로가 아닙니다" },
  'no-placement': { status: 409, title: "배치되지 않은 기기입니다" },
  'not-found': { status: 404, title: "찾을 수 없습니다" },
  'not-payer': { status: 403, title: "결제한 분만 할 수 있습니다" },
  'open-interval-conflict': { status: 409, title: "다른 대규모 공연과 오픈 시각이 겹칩니다" },
  'open-passed': { status: 410, title: "오픈 시각이 지났습니다" },
  'order-expired': { status: 409, title: "결제하지 않아 끝난 주문입니다" },
  'other-partner-device': { status: 403, title: "다른 파트너사의 기기입니다" },
  'outside-staff-hours': { status: 403, title: "근무 시간이 아닙니다" },
  'password-change-required': { status: 403, title: "비밀번호를 먼저 바꿔 주세요" },
  'password-rejected': { status: 422, title: "쓸 수 없는 비밀번호입니다" },
  'payment-attempts-exceeded': { status: 409, title: "결제 시도 횟수를 넘었습니다" },
  'pickup-slot-unavailable': { status: 422, title: "고를 수 없는 수령 시간대입니다" },
  'place-exists': { status: 409, title: "같은 공연장이 있습니다" },
  'precondition-failed': { status: 412, title: "다른 사람이 먼저 고쳤습니다" },
  'precondition-required': { status: 428, title: "고칠 판(If-Match)을 보내 주세요" },
  'preverify-invalid': { status: 403, title: "사람 확인을 다시 해 주세요" },
  'priority-grant-not-found': { status: 404, title: "쓸 수 있는 우선 구매 권리가 없습니다" },
  'priority-seat-only': { status: 409, title: "우선 구매 권리의 좌석만 고를 수 있습니다" },
  'promoter-mismatch': { status: 422, title: "계정의 파트너사와 다릅니다" },
  'provider-down': { status: 503, title: "지금은 본인확인을 할 수 없습니다" },
  'pseudonym-handler-required': { status: 403, title: "가명정보 취급자만 할 수 있습니다" },
  'pseudonymization-review-pending': { status: 403, title: "가명 처리 검토 중입니다" },
  'purchase-limit-exceeded': { status: 422, title: "1인 구매 한도를 넘었습니다" },
  'purchase-seq-reused': { status: 401, title: "이미 받은 요청 번호입니다" },
  'purchase-session-ended': { status: 401, title: "예매 시간이 끝났습니다" },
  'purchase-signature-invalid': { status: 401, title: "요청 서명을 확인하지 못했습니다" },
  'purpose-not-supported': { status: 400, title: "아직 받지 않는 본인확인 목적입니다" },
  'push-key-invalid': { status: 422, title: "웹 푸시 키가 맞지 않습니다" },
  'push-service-not-allowed': { status: 422, title: "받지 않는 웹 푸시 서비스입니다" },
  'query-too-short': { status: 400, title: "검색어가 너무 짧습니다" },
  'queue-not-found': { status: 404, title: "이 회차의 대기열이 열리지 않았습니다" },
  'queue-not-open': { status: 409, title: "아직 예매가 열리지 않았습니다" },
  'queue-recovering': { status: 503, title: "대기열을 다시 맞추는 중입니다. 잠시 뒤 다시 시도해 주세요" },
  'queue-ticket-expired': { status: 410, title: "입장 시간이 지났습니다" },
  'queue-ticket-invalid': { status: 403, title: "대기표를 확인할 수 없습니다" },
  'queue-ticket-removed': { status: 410, title: "이 대기표는 더 쓸 수 없습니다" },
  'reauth-required': { status: 403, title: "다시 인증해 주세요" },
  'refresh-token-invalid': { status: 401, title: "다시 로그인해 주세요" },
  'research-export-not-ready': { status: 409, title: "연구용 내보내기를 아직 만드는 중입니다" },
  'restriction-too-long': { status: 422, title: "이용 제한은 1년을 넘길 수 없습니다" },
  'retention-ended': { status: 410, title: "보관 기간이 끝났습니다" },
  'review-already-written': { status: 409, title: "이 회차의 후기를 이미 썼습니다" },
  'review-event-cancelled': { status: 403, title: "취소된 회차에는 후기를 쓸 수 없습니다" },
  'review-not-ended': { status: 403, title: "공연이 끝난 뒤에 후기를 쓸 수 있습니다" },
  'review-not-purchaser': { status: 403, title: "이 회차를 예매한 분만 후기를 쓸 수 있습니다" },
  'role-group-mismatch': { status: 422, title: "파트너 역할과 관제 역할 사이는 바꿀 수 없습니다" },
  'rotation-too-soon': { status: 409, title: "비밀을 방금 바꿨습니다. 잠시 뒤 다시 시도해 주세요" },
  'sale-ended': { status: 410, title: "판매 시간이 끝났습니다" },
  'sale-not-suspended': { status: 409, title: "판매 중지된 공연이 아닙니다" },
  'sale-paused': { status: 423, title: "판매가 잠시 멈췄습니다" },
  'scale-change-closed': { status: 409, title: "규모를 바꿀 수 있는 시각이 지났습니다" },
  'seat-already-held': { status: 409, title: "좌석이 이미 선택되었습니다" },
  'seat-recently-released': { status: 409, title: "방금 놓은 좌석은 잠시 뒤에 다시 고를 수 있습니다" },
  'seat-store-unavailable': { status: 503, title: "좌석 정보를 잠시 쓸 수 없습니다" },
  'seatmap-geometry-locked': { status: 409, title: "판매가 시작되어 좌석 배치는 바꿀 수 없습니다" },
  'seatmap-invalid': { status: 422, title: "좌석맵에 고칠 곳이 있습니다" },
  'seatmap-replace-required': { status: 409, title: "좌석이 있는 좌석맵은 바꾸기로만 가져올 수 있습니다" },
  'self-target-forbidden': { status: 403, title: "자기 계정에는 할 수 없습니다" },
  'server-busy': { status: 429, title: "요청이 많아 잠시 처리하지 못했습니다" },
  'sold-out': { status: 410, title: "매진되었습니다" },
  'staff-assignment-missing': { status: 403, title: "이 회차의 스태프 배정이 없습니다" },
  'subscription-limit': { status: 422, title: "알림 신청 수를 넘었습니다" },
  'transfer-locked': { status: 409, title: "지금은 양도할 수 없는 티켓입니다" },
  'trigger-deferred': { status: 409, title: "판정 보류 중인 지표입니다" },
  'under-14': { status: 403, title: "만 14세 미만은 피켓을 이용할 수 없습니다" },
  'unknown-promoter': { status: 422, title: "등록되지 않은 파트너사입니다" },
  'unlock-code-invalid': { status: 422, title: "코드가 맞지 않습니다" },
  'unlock-link-invalid': { status: 410, title: "이 링크는 더 쓸 수 없습니다" },
  'unlock-link-resend-limit': { status: 429, title: "해제 링크는 1시간에 3번까지 다시 받을 수 있습니다" },
  'verification-not-found': { status: 404, title: "본인확인 건을 찾을 수 없습니다" },
  'webhook-url-not-allowed': { status: 400, title: "받지 않는 웹훅 주소입니다" },
  'wish-limit': { status: 422, title: "찜 수를 넘었습니다" },
  'withdrawal-confirmation-required': { status: 409, title: "탈퇴 전에 확인해 주세요" },
} as const satisfies Record<ProblemType, { status: number; title: string }>;
