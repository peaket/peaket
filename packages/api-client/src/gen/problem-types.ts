// 계약(docs/api/openapi.yaml)에서 만든 파일이다. 손으로 고치지 않는다: pnpm --filter @peaket/api-client gen(BUILD_ORDER BAS-041)

/** 이름 붙은 오류(RFC 9457 type의 마지막 경로, openapi x-peaket-problem-types, docs/api/guidelines.md §2) */
export type ProblemType =
  | 'admin-account-locked'
  | 'admin-account-state-conflict'
  | 'admin-account-unavailable'
  | 'admin-email-in-use'
  | 'admin-login-busy'
  | 'admin-login-code-invalid'
  | 'admin-login-failed'
  | 'admin-login-step-invalid'
  | 'admin-login-unavailable'
  | 'admin-role-not-allowed'
  | 'admission-token-invalid'
  | 'alert-issue-relay-unavailable'
  | 'already-admitted'
  | 'already-approved'
  | 'already-reported'
  | 'already-verified'
  | 'already-waiting'
  | 'anchor-unavailable'
  | 'approval-conflict'
  | 'approval-reason-required'
  | 'approval-role-required'
  | 'approval-scope-invalid'
  | 'approval-self-not-allowed'
  | 'approver-ineligible'
  | 'artist-exists'
  | 'assignment-required'
  | 'audit-chain-broken'
  | 'authz-unavailable'
  | 'auto-assign-not-supported'
  | 'auto-condition-invalid'
  | 'batching'
  | 'booking-restricted'
  | 'booth-mismatch'
  | 'booth-not-authorized'
  | 'bot-review-already-recorded'
  | 'bot-review-assign-conflict'
  | 'bot-review-claim-in-progress'
  | 'bot-review-evidence-required'
  | 'bot-review-label-unavailable'
  | 'bot-review-source-unavailable'
  | 'cancel-deadline-passed'
  | 'cancellation-conflict'
  | 'cancellation-not-account-pending'
  | 'case-action-not-applicable'
  | 'case-already-resolved'
  | 'case-assignee-invalid'
  | 'case-not-actioned'
  | 'case-result-note-required'
  | 'case-status-transition-invalid'
  | 'case-update-not-allowed'
  | 'checkpoint-empty'
  | 'checkpoint-not-ready'
  | 'command-dispatch-failed'
  | 'command-not-executable'
  | 'command-not-failed'
  | 'command-not-pending'
  | 'command-not-revertible'
  | 'command-out-of-range'
  | 'command-requester-cannot-approve'
  | 'command-role-forbidden'
  | 'commander-removal-needs-role-change'
  | 'commander-required'
  | 'compensation-not-account-pending'
  | 'compensation-transfer-failed'
  | 'compensation-transfer-unavailable'
  | 'consent-required'
  | 'consent-version-outdated'
  | 'contract-apply-failed'
  | 'contract-approval-conflict'
  | 'contract-approval-not-pending'
  | 'contract-change-pending'
  | 'contract-terms-changed'
  | 'contract-terms-missing'
  | 'current-password-invalid'
  | 'data-request-required'
  | 'deadline-exceeded'
  | 'dependency-unavailable'
  | 'designation-conflict'
  | 'designation-exists'
  | 'designation-target-not-commander'
  | 'designation-target-not-eligible'
  | 'device-approval-conflict'
  | 'device-revoked'
  | 'device-unregistered'
  | 'duplicate-account'
  | 'duplicate-admission'
  | 'enrollment-code-expired'
  | 'enrollment-rate-limited'
  | 'entry-closed-too-early'
  | 'entry-recorded'
  | 'entry-started'
  | 'escrow-partial-not-allowed'
  | 'event-cancellation-active'
  | 'event-cancellation-conflict'
  | 'event-cancelled'
  | 'event-ended'
  | 'event-refund-unavailable'
  | 'event-schedule-invalid'
  | 'event-settlement-source-unavailable'
  | 'event-status-conflict'
  | 'event-suspended'
  | 'export-format-unavailable'
  | 'first-partner-account-must-be-admin'
  | 'fraud-approver-ineligible'
  | 'fraud-case-exists'
  | 'fraud-case-state'
  | 'fraud-report-not-ready'
  | 'fraud-run-in-progress'
  | 'fraud-run-not-failed'
  | 'fraud-run-retrying'
  | 'fraud-summary-not-viewed'
  | 'guarantee-basis-unavailable'
  | 'guarantee-capacity-exhausted'
  | 'guarantee-conflict'
  | 'guarantee-contract-missing'
  | 'guarantee-contract-unavailable'
  | 'guarantee-not-due'
  | 'guarantee-not-open'
  | 'hold-already-extended'
  | 'hold-already-ordered'
  | 'hold-in-payment'
  | 'hold-not-found'
  | 'human-check-required'
  | 'human-check-unavailable'
  | 'idempotency-key-invalid'
  | 'idempotency-key-reused'
  | 'idempotency-request-in-progress'
  | 'identity-required'
  | 'identity-verification-required'
  | 'image-limit-exceeded'
  | 'image-processing-unavailable'
  | 'image-spec-invalid'
  | 'image-too-large'
  | 'image-type-unsupported'
  | 'inquiry-closed'
  | 'invalid-auto-condition'
  | 'invalid-body'
  | 'invalid-command'
  | 'invalid-device-key'
  | 'invalid-dpop-proof'
  | 'invalid-enrollment-code'
  | 'invalid-notify-event'
  | 'invalid-placement'
  | 'invalid-priority-grant'
  | 'invalid-query'
  | 'invalid-seat'
  | 'investigation-source-expired'
  | 'investigator-required'
  | 'invitation-invalid'
  | 'invitation-step-invalid'
  | 'invitation-step-out-of-order'
  | 'judgement-not-allowed'
  | 'judgement-required'
  | 'judgement-window-closed'
  | 'jwks-not-found'
  | 'last-login-method'
  | 'last-partner-admin'
  | 'last-passkey'
  | 'lobby-closed'
  | 'lobby-participant-not-found'
  | 'login-provider-not-linked'
  | 'manual-selection-required'
  | 'member-code-lookup-unavailable'
  | 'merch-cancel-not-allowed'
  | 'merch-item-state-conflict'
  | 'merch-options-invalid'
  | 'merch-order-in-progress'
  | 'merch-order-mixed'
  | 'merch-product-unavailable'
  | 'merch-quantity-limit-exceeded'
  | 'merch-return-not-allowed'
  | 'merch-sold-out'
  | 'merge-blocked'
  | 'merge-check-unavailable'
  | 'merge-invariant-violated'
  | 'merge-proposal-not-found'
  | 'new-payment-paused'
  | 'next-invalid'
  | 'nickname-check-limited'
  | 'nickname-invalid'
  | 'nickname-taken'
  | 'no-placement'
  | 'not-found'
  | 'not-payer'
  | 'not-running'
  | 'not-verifying'
  | 'notification-resend-not-allowed'
  | 'notification-template-activation-forbidden'
  | 'notification-template-hash-mismatch'
  | 'notification-template-invalid-state'
  | 'notification-template-review-required'
  | 'notification-template-version-exists'
  | 'notify-sender-unavailable'
  | 'onsale-window-unavailable'
  | 'open-interval-conflict'
  | 'open-maintenance-window'
  | 'open-passed'
  | 'open-too-close'
  | 'order-expired'
  | 'other-partner-device'
  | 'outside-staff-hours'
  | 'partner-admin-required'
  | 'passkey-assertion-invalid'
  | 'passkey-attestation-invalid'
  | 'passkey-exists'
  | 'passkey-limit'
  | 'passkey-not-registered'
  | 'passkey-registration-invalid'
  | 'password-change-required'
  | 'password-rejected'
  | 'payer-holds'
  | 'payment-already-accepted'
  | 'payment-attempt-mismatch'
  | 'payment-attempts-exceeded'
  | 'payment-not-accepted'
  | 'payout-account-change-hold'
  | 'payout-account-holder-mismatch'
  | 'payout-account-mismatch'
  | 'payout-agency-update-failed'
  | 'payout-approval-conflict'
  | 'payout-balance-insufficient'
  | 'payout-batch-amount-mismatch'
  | 'payout-batch-empty'
  | 'payout-batch-exists'
  | 'payout-batch-not-approved'
  | 'payout-batch-not-portone'
  | 'payout-batch-statement-conflict'
  | 'payout-dependency-unavailable'
  | 'payout-gateway-unavailable'
  | 'payout-holder-lookup-unavailable'
  | 'payout-kyc-required'
  | 'payout-not-retryable'
  | 'payout-retry-approval-required'
  | 'payout-sale-suspended'
  | 'payout-seller-unverified'
  | 'pg-balance-unavailable'
  | 'pg-check-unavailable'
  | 'pg-fallback-same-provider'
  | 'pg-unavailable'
  | 'pickup-slot-unavailable'
  | 'place-exists'
  | 'portone-transfer-conflict'
  | 'post-review-conflict'
  | 'post-review-invalid'
  | 'post-review-not-executor'
  | 'post-review-self-confirm'
  | 'poster-not-deletable'
  | 'postponement-date-invalid'
  | 'precondition-failed'
  | 'precondition-required'
  | 'preverify-invalid'
  | 'preview-required'
  | 'priority-grant-already-used'
  | 'priority-grant-in-use'
  | 'priority-grant-not-found'
  | 'priority-seat-only'
  | 'product-attributes-invalid'
  | 'product-fulfillment-invalid'
  | 'product-limited-qty-invalid'
  | 'product-return-address-required'
  | 'product-return-shipping-fee-required'
  | 'product-settlement-source-unavailable'
  | 'product-shipping-fee-required'
  | 'product-ticket-link-invalid'
  | 'product-type-invalid'
  | 'production-suspended'
  | 'promoter-mismatch'
  | 'provider-down'
  | 'proxy-approval-forbidden'
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
  | 'queue-entry-not-found'
  | 'queue-not-found'
  | 'queue-not-open'
  | 'queue-order-invalid'
  | 'queue-recovering'
  | 'queue-request-limited'
  | 'queue-ticket-expired'
  | 'queue-ticket-invalid'
  | 'queue-ticket-removed'
  | 'readiness-source-unavailable'
  | 'reauth-code-invalid'
  | 'reauth-required'
  | 'reauth-step-invalid'
  | 'reauth-unavailable'
  | 'recalculation-conflict'
  | 'recipient-not-found'
  | 'recommended-reason-required'
  | 'refresh-token-invalid'
  | 'refund-account-required'
  | 'refund-rejected'
  | 'reissue-at-booth'
  | 'reissue-required'
  | 'rejection-not-allowed'
  | 'reoffer-not-allowed'
  | 'report-limited'
  | 'research-export-not-ready'
  | 'restriction-too-long'
  | 'retention-ended'
  | 'review-already-written'
  | 'review-eligibility-unavailable'
  | 'review-event-cancelled'
  | 'review-hidden-by-notice'
  | 'review-not-author'
  | 'review-not-ended'
  | 'review-not-purchaser'
  | 'review-self-report'
  | 'role-group-mismatch'
  | 'rotation-too-soon'
  | 'sale-eligibility-list-limit'
  | 'sale-eligibility-list-locked'
  | 'sale-eligibility-required'
  | 'sale-eligibility-upload-limited'
  | 'sale-eligibility-upload-rejected'
  | 'sale-eligibility-upload-too-large'
  | 'sale-ended'
  | 'sale-not-publishable'
  | 'sale-not-suspended'
  | 'sale-paused'
  | 'sale-policy-denied'
  | 'sale-policy-invalid'
  | 'sale-review-list-missing'
  | 'sale-review-not-approved'
  | 'sale-review-not-cancellable'
  | 'sale-review-not-submitted'
  | 'sale-review-payout-registration-incomplete'
  | 'sale-review-request-invalid'
  | 'sale-review-scales-missing'
  | 'sale-setting-locked'
  | 'sale-stop-unavailable'
  | 'sale-suspension-conflict'
  | 'scale-change-closed'
  | 'scale-change-not-approved'
  | 'scale-change-not-up'
  | 'scanner-auth-unavailable'
  | 'scanner-device-inactive'
  | 'scanner-device-key-in-use'
  | 'scanner-device-not-found'
  | 'scanner-event-mismatch'
  | 'scanner-flag-not-found'
  | 'scanner-login-rate-limited'
  | 'scanner-origin-forbidden'
  | 'scanner-override-forbidden'
  | 'scanner-placement-reentry-not-allowed'
  | 'seat-already-held'
  | 'seat-recently-released'
  | 'seat-store-unavailable'
  | 'seatmap-geometry-locked'
  | 'seatmap-import-rejected'
  | 'seatmap-import-too-large'
  | 'seatmap-invalid'
  | 'seatmap-publish-unavailable'
  | 'seatmap-replace-required'
  | 'seatmap-worker-unavailable'
  | 'self-target-forbidden'
  | 'self-transfer'
  | 'seq-not-in-checkpoint'
  | 'server-busy'
  | 'session-not-found'
  | 'settlement-adjustment-already-applied'
  | 'settlement-commission-rate-invalid'
  | 'settlement-dependency-unavailable'
  | 'settlement-dispute-window-closed'
  | 'settlement-not-disputable'
  | 'settlement-state-conflict'
  | 'signup-already-completed'
  | 'sold-out'
  | 'staff-account-inactive'
  | 'staff-assignment-exists'
  | 'staff-assignment-missing'
  | 'staff-invitation-already-accepted'
  | 'staff-invitation-duplicate'
  | 'staff-invitation-email-mismatch'
  | 'staff-invitation-email-unverified'
  | 'staff-invite-mail-unavailable'
  | 'statement-recalculation-pending'
  | 'subscription-limit'
  | 'ticket-ended'
  | 'too-many-requests'
  | 'toss-seller-registration-failed'
  | 'transfer-closed'
  | 'transfer-expired'
  | 'transfer-locked'
  | 'transfer-lookup-limited'
  | 'transfer-not-allowed'
  | 'transfer-not-offered'
  | 'transfer-pending'
  | 'trigger-deferred'
  | 'under-14'
  | 'unknown-promoter'
  | 'unknown-widget-key'
  | 'unlock-code-invalid'
  | 'unlock-link-invalid'
  | 'unlock-link-resend-limit'
  | 'user-code-unavailable'
  | 'verification-not-found'
  | 'verification-submit-limited'
  | 'version-conflict'
  | 'webhook-delivery-not-redeliverable'
  | 'webhook-url-not-allowed'
  | 'wish-limit'
  | 'withdrawal-confirmation-required'
  | 'withdrawal-pending';

export const PROBLEM_TYPE_BASE = "https://peaket.example/problems/";

/** 이름마다 상태 코드와 제목(제목은 화면에 보이지 않는다. 화면은 문구 키로 고른다, docs/frontend.md §5.12) */
export const PROBLEM_TYPES = {
  'admin-account-locked': { status: 423, title: "계정이 잠겼습니다" },
  'admin-account-state-conflict': { status: 409, title: "지금 계정 상태에서는 할 수 없습니다" },
  'admin-account-unavailable': { status: 503, title: "관리 계정 서비스에 닿지 못했습니다" },
  'admin-email-in-use': { status: 409, title: "이미 쓰는 이메일입니다" },
  'admin-login-busy': { status: 429, title: "잠시 뒤 다시 시도해 주세요" },
  'admin-login-code-invalid': { status: 401, title: "인증 앱 코드가 맞지 않습니다" },
  'admin-login-failed': { status: 401, title: "이메일이나 비밀번호가 맞지 않습니다" },
  'admin-login-step-invalid': { status: 401, title: "처음부터 다시 로그인해 주세요" },
  'admin-login-unavailable': { status: 503, title: "잠시 뒤 다시 시도해 주세요" },
  'admin-role-not-allowed': { status: 403, title: "이 역할로는 초대할 수 없습니다" },
  'admission-token-invalid': { status: 401, title: "입장 확인이 끝났습니다" },
  'alert-issue-relay-unavailable': { status: 502, title: "경보 티켓을 만들지 못했습니다" },
  'already-admitted': { status: 409, title: "이 회차에 이미 입장했습니다" },
  'already-approved': { status: 409, title: "이미 확정된 요청입니다" },
  'already-reported': { status: 409, title: "이미 신고한 후기입니다" },
  'already-verified': { status: 409, title: "이미 본인확인을 마친 계정입니다" },
  'already-waiting': { status: 409, title: "이미 다른 곳에서 대기 중입니다" },
  'anchor-unavailable': { status: 503, title: "외부 앵커를 지금 쓸 수 없습니다" },
  'approval-conflict': { status: 409, title: "다른 사람이 먼저 처리했습니다" },
  'approval-reason-required': { status: 422, title: "승인 사유를 적어 주세요" },
  'approval-role-required': { status: 403, title: "commander만 승인할 수 있습니다" },
  'approval-scope-invalid': { status: 422, title: "요청 범위 밖의 대상입니다" },
  'approval-self-not-allowed': { status: 403, title: "요청자는 승인할 수 없습니다" },
  'approver-ineligible': { status: 403, title: "판정자는 확정할 수 없습니다" },
  'artist-exists': { status: 409, title: "같은 이름의 아티스트가 있습니다" },
  'assignment-required': { status: 422, title: "승인할 배정을 하나 골라 주세요" },
  'audit-chain-broken': { status: 409, title: "감사 체인 구간이 비었습니다" },
  'authz-unavailable': { status: 503, title: "권한을 확인하지 못했습니다" },
  'auto-assign-not-supported': { status: 400, title: "좌석 자동 배정은 아직 받지 않습니다" },
  'auto-condition-invalid': { status: 400, title: "희망 조건이 올바르지 않습니다" },
  'batching': { status: 503, title: "순서를 정하는 중입니다. 잠시 뒤 다시 시도해 주세요" },
  'booking-restricted': { status: 403, title: "예매가 제한된 계정입니다" },
  'booth-mismatch': { status: 409, title: "티켓 보유자와 다른 분입니다" },
  'booth-not-authorized': { status: 403, title: "부스 재발급 허용이 없거나 10분이 지났습니다" },
  'bot-review-already-recorded': { status: 409, title: "이미 판정을 기록한 표본입니다" },
  'bot-review-assign-conflict': { status: 409, title: "표본 배치를 만드는 요청이 겹쳤습니다" },
  'bot-review-claim-in-progress': { status: 409, title: "다른 요청이 이 표본의 판정을 반영하는 중입니다" },
  'bot-review-evidence-required': { status: 422, title: "사람 기준 표본을 봇으로 판정하려면 행동 요약 밖의 근거가 필요합니다" },
  'bot-review-label-unavailable': { status: 503, title: "봇 라벨을 반영하지 못했습니다" },
  'bot-review-source-unavailable': { status: 503, title: "표본 후보 원장에 닿지 못했습니다" },
  'cancel-deadline-passed': { status: 409, title: "취소할 수 있는 시각이 지났습니다" },
  'cancellation-conflict': { status: 409, title: "지금은 취소할 수 없습니다" },
  'cancellation-not-account-pending': { status: 409, title: "환급 계좌를 기다리는 취소가 아닙니다" },
  'case-action-not-applicable': { status: 409, title: "이 건 종류에는 이 처리가 없습니다" },
  'case-already-resolved': { status: 409, title: "이미 해결한 건입니다" },
  'case-assignee-invalid': { status: 422, title: "맡길 수 없는 계정입니다" },
  'case-not-actioned': { status: 409, title: "조치하지 않은 사건입니다" },
  'case-result-note-required': { status: 422, title: "결과 메모를 적어 주세요" },
  'case-status-transition-invalid': { status: 422, title: "지금 상태에서 바꿀 수 없는 상태입니다" },
  'case-update-not-allowed': { status: 403, title: "이 건을 고칠 수 있는 역할이 아닙니다" },
  'checkpoint-empty': { status: 409, title: "묶을 감사 기록이 없습니다" },
  'checkpoint-not-ready': { status: 409, title: "아직 서명하지 않았거나 옛 체크포인트입니다" },
  'command-dispatch-failed': { status: 502, title: "명령을 대상에 보내지 못했습니다. 다시 시도해 주세요" },
  'command-not-executable': { status: 409, title: "실행할 수 있는 명령이 아닙니다" },
  'command-not-failed': { status: 409, title: "실패한 명령만 다시 시도할 수 있습니다" },
  'command-not-pending': { status: 409, title: "승인 대기 중인 명령이 아닙니다" },
  'command-not-revertible': { status: 409, title: "되돌릴 수 있는 명령이 아닙니다" },
  'command-out-of-range': { status: 422, title: "안전 허용 범위 밖의 명령입니다" },
  'command-requester-cannot-approve': { status: 403, title: "요청한 분은 승인할 수 없습니다" },
  'command-role-forbidden': { status: 403, title: "이 명령을 할 수 있는 역할이 아닙니다" },
  'commander-removal-needs-role-change': { status: 409, title: "commander 역할을 먼저 바꿔 주세요" },
  'commander-required': { status: 403, title: "간격 예외는 commander만 쓸 수 있습니다" },
  'compensation-not-account-pending': { status: 409, title: "배상 계좌를 기다리는 건이 아닙니다" },
  'compensation-transfer-failed': { status: 422, title: "배상금 송금이 실패했습니다. 고객센터가 이어 봅니다" },
  'compensation-transfer-unavailable': { status: 503, title: "지금은 배상금을 보낼 수 없습니다" },
  'consent-required': { status: 422, title: "동의가 필요합니다" },
  'consent-version-outdated': { status: 422, title: "동의 문안이 바뀌었습니다. 다시 확인해 주세요" },
  'contract-apply-failed': { status: 503, title: "계약 조건을 적용하지 못했습니다" },
  'contract-approval-conflict': { status: 409, title: "다른 사람이 먼저 처리했습니다" },
  'contract-approval-not-pending': { status: 409, title: "승인 대기 중인 계약 변경이 아닙니다" },
  'contract-change-pending': { status: 409, title: "이미 승인 대기 중인 계약 변경이 있습니다" },
  'contract-terms-changed': { status: 409, title: "그 사이 지금 계약이 바뀌었습니다" },
  'contract-terms-missing': { status: 409, title: "지금 계약 조건이 없습니다" },
  'current-password-invalid': { status: 422, title: "지금 비밀번호가 맞지 않습니다" },
  'data-request-required': { status: 422, title: "접수된 기관 요청이 필요합니다" },
  'deadline-exceeded': { status: 504, title: "남은 처리 시간이 모자라 요청을 끝내지 못했습니다" },
  'dependency-unavailable': { status: 503, title: "의존 서비스를 잠시 쓸 수 없습니다" },
  'designation-conflict': { status: 409, title: "함께 가질 수 없는 지정이 있습니다" },
  'designation-exists': { status: 409, title: "이미 같은 지정이 있습니다" },
  'designation-target-not-commander': { status: 422, title: "commander 계정에만 줄 수 있는 지정입니다" },
  'designation-target-not-eligible': { status: 422, title: "이 계정에는 줄 수 없는 지정입니다" },
  'device-approval-conflict': { status: 409, title: "다른 승인이 먼저 처리되었습니다. 새 승인을 시작해 주세요" },
  'device-revoked': { status: 403, title: "폐기된 스캐너 기기입니다" },
  'device-unregistered': { status: 403, title: "등록되지 않은 스캐너 기기입니다" },
  'duplicate-account': { status: 409, title: "이미 다른 계정에서 본인확인한 분입니다. 그 계정으로 로그인해 주세요" },
  'duplicate-admission': { status: 409, title: "이미 다른 기기나 탭에서 입장했습니다" },
  'enrollment-code-expired': { status: 410, title: "등록 코드가 만료되었거나 이미 사용되었습니다" },
  'enrollment-rate-limited': { status: 429, title: "등록 시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요" },
  'entry-closed-too-early': { status: 422, title: "역할 유효 끝보다 이른 마감 시각입니다" },
  'entry-recorded': { status: 409, title: "입장 기록이 있어 돌려줄 수 없습니다" },
  'entry-started': { status: 409, title: "입장이 시작되어 할 수 없습니다" },
  'escrow-partial-not-allowed': { status: 409, title: "구매를 확정한 뒤에 일부 상품을 취소·반품할 수 있습니다" },
  'event-cancellation-active': { status: 409, title: "이미 진행 중인 회차 취소 요청이 있습니다" },
  'event-cancellation-conflict': { status: 409, title: "다른 사람이 먼저 처리했습니다" },
  'event-cancelled': { status: 409, title: "취소가 확정된 회차입니다" },
  'event-ended': { status: 409, title: "공연이 끝나 요청할 수 없습니다" },
  'event-refund-unavailable': { status: 503, title: "일괄 환불 실행기를 쓸 수 없습니다" },
  'event-schedule-invalid': { status: 422, title: "회차 일정이 맞지 않습니다" },
  'event-settlement-source-unavailable': { status: 503, title: "회차 정산 원천을 읽을 수 없습니다" },
  'event-status-conflict': { status: 409, title: "회차 상태와 맞지 않습니다" },
  'event-suspended': { status: 410, title: "판매가 중지된 공연입니다" },
  'export-format-unavailable': { status: 503, title: "이 파일 형식은 아직 만들 수 없습니다" },
  'first-partner-account-must-be-admin': { status: 422, title: "파트너사의 첫 계정은 관리자여야 합니다" },
  'fraud-approver-ineligible': { status: 403, title: "이 사건을 승인할 수 없는 계정입니다" },
  'fraud-case-exists': { status: 409, title: "이 묶음으로 만든 사건이 이미 있습니다" },
  'fraud-case-state': { status: 409, title: "지금 사건 상태에서는 할 수 없습니다" },
  'fraud-report-not-ready': { status: 404, title: "부정 예매 리포트가 아직 없습니다" },
  'fraud-run-in-progress': { status: 409, title: "분석이 아직 돌고 있습니다" },
  'fraud-run-not-failed': { status: 409, title: "다시 돌릴 실패한 분석이 없습니다" },
  'fraud-run-retrying': { status: 409, title: "분석을 자동으로 다시 시도하고 있습니다" },
  'fraud-summary-not-viewed': { status: 409, title: "사건 요약을 먼저 열어 보세요" },
  'guarantee-basis-unavailable': { status: 422, title: "보증 한도를 계산할 정산서가 없습니다" },
  'guarantee-capacity-exhausted': { status: 409, title: "계약 보증 한도를 모두 썼습니다" },
  'guarantee-conflict': { status: 409, title: "미수금 잔액이 다른 처리와 겹쳤습니다" },
  'guarantee-contract-missing': { status: 409, title: "지금 계약 조건이 없습니다" },
  'guarantee-contract-unavailable': { status: 503, title: "보증 계약을 확인할 수 없습니다" },
  'guarantee-not-due': { status: 409, title: "미수금 발생 30일이 지나야 보증으로 충당할 수 있습니다" },
  'guarantee-not-open': { status: 409, title: "열린 미수금이 아닙니다" },
  'hold-already-extended': { status: 409, title: "이미 연장한 홀드입니다" },
  'hold-already-ordered': { status: 409, title: "이 좌석으로 만든 주문이 이미 있습니다" },
  'hold-in-payment': { status: 409, title: "결제가 진행 중인 홀드입니다" },
  'hold-not-found': { status: 404, title: "홀드를 찾을 수 없습니다" },
  'human-check-required': { status: 428, title: "사람 확인을 마친 뒤 다시 시도해 주세요" },
  'human-check-unavailable': { status: 503, title: "잠시 뒤 다시 시도해 주세요" },
  'idempotency-key-invalid': { status: 400, title: "멱등 키(Idempotency-Key)가 없거나 형식이 맞지 않습니다" },
  'idempotency-key-reused': { status: 422, title: "같은 멱등 키를 다른 요청에 썼습니다" },
  'idempotency-request-in-progress': { status: 409, title: "같은 요청을 아직 처리하고 있습니다" },
  'identity-required': { status: 403, title: "휴대폰 본인확인을 먼저 해 주세요" },
  'identity-verification-required': { status: 403, title: "휴대폰 본인확인을 먼저 해 주세요" },
  'image-limit-exceeded': { status: 409, title: "포스터 1장과 상세 이미지 10장까지 올릴 수 있습니다" },
  'image-processing-unavailable': { status: 503, title: "이미지를 잠시 확인할 수 없습니다" },
  'image-spec-invalid': { status: 422, title: "이미지 기준에 맞지 않습니다" },
  'image-too-large': { status: 413, title: "한 장에 10MB까지 올릴 수 있습니다" },
  'image-type-unsupported': { status: 415, title: "JPEG, PNG, WebP 이미지만 올릴 수 있습니다" },
  'inquiry-closed': { status: 409, title: "닫힌 문의입니다" },
  'invalid-auto-condition': { status: 422, title: "희망 조건을 다시 확인해 주세요" },
  'invalid-body': { status: 400, title: "요청 본문이 올바르지 않습니다" },
  'invalid-command': { status: 422, title: "명령 값이 올바르지 않습니다" },
  'invalid-device-key': { status: 422, title: "기기 공개키가 P-256 곡선 위의 점이 아닙니다" },
  'invalid-dpop-proof': { status: 400, title: "DPoP 증명이 올바르지 않습니다" },
  'invalid-enrollment-code': { status: 400, title: "등록 코드 형식이 올바르지 않습니다" },
  'invalid-notify-event': { status: 422, title: "알림 사건이 올바르지 않습니다" },
  'invalid-placement': { status: 400, title: "기기 배치 입력이 올바르지 않습니다" },
  'invalid-priority-grant': { status: 400, title: "우선 구매 권리 요청이 올바르지 않습니다" },
  'invalid-query': { status: 400, title: "목록 조건이 올바르지 않습니다" },
  'invalid-seat': { status: 422, title: "고를 수 없는 좌석이 있습니다" },
  'investigation-source-expired': { status: 410, title: "조사 원천 보존 기간이 끝났습니다" },
  'investigator-required': { status: 403, title: "부정 거래 조사관만 할 수 있습니다" },
  'invitation-invalid': { status: 410, title: "초대가 만료되었습니다" },
  'invitation-step-invalid': { status: 410, title: "처음부터 다시 진행해 주세요" },
  'invitation-step-out-of-order': { status: 409, title: "앞 단계를 먼저 마쳐 주세요" },
  'judgement-not-allowed': { status: 409, title: "지금은 판정할 수 없습니다" },
  'judgement-required': { status: 409, title: "판정 전에는 확정할 수 없습니다" },
  'judgement-window-closed': { status: 409, title: "지금은 Go/No-Go 판정을 받지 않습니다" },
  'jwks-not-found': { status: 404, title: "없는 공개키 묶음입니다" },
  'last-login-method': { status: 409, title: "마지막 로그인 수단은 해제할 수 없습니다" },
  'last-partner-admin': { status: 409, title: "마지막 파트너 관리자는 바꿀 수 없습니다" },
  'last-passkey': { status: 409, title: "마지막 패스키는 지울 수 없습니다" },
  'lobby-closed': { status: 409, title: "로비가 닫혔습니다" },
  'lobby-participant-not-found': { status: 404, title: "로비 참가 기록이 없습니다" },
  'login-provider-not-linked': { status: 404, title: "연결된 로그인 수단이 아닙니다" },
  'manual-selection-required': { status: 409, title: "좌석을 직접 골라 주세요" },
  'member-code-lookup-unavailable': { status: 503, title: "회원 코드를 잠시 확인할 수 없습니다" },
  'merch-cancel-not-allowed': { status: 409, title: "이미 보냈거나 받은 상품은 취소할 수 없습니다" },
  'merch-item-state-conflict': { status: 409, title: "지금 주문 상태에서는 할 수 없습니다" },
  'merch-options-invalid': { status: 422, title: "고를 수 없는 옵션입니다" },
  'merch-order-in-progress': { status: 409, title: "같은 상품의 다른 주문을 처리하고 있습니다. 잠시 뒤 다시 시도해 주세요" },
  'merch-order-mixed': { status: 422, title: "판매자나 수령 방식이 다른 상품은 한 주문에 담을 수 없습니다" },
  'merch-product-unavailable': { status: 422, title: "지금 이 방법으로 살 수 없는 상품입니다" },
  'merch-quantity-limit-exceeded': { status: 422, title: "한 계정이 살 수 있는 수량을 넘었습니다" },
  'merch-return-not-allowed': { status: 409, title: "반품할 수 없는 상품이 있습니다" },
  'merch-sold-out': { status: 409, title: "품절된 상품입니다" },
  'merge-blocked': { status: 409, title: "지금은 두 계정을 합칠 수 없습니다" },
  'merge-check-unavailable': { status: 503, title: "잠시 뒤 다시 시도해 주세요" },
  'merge-invariant-violated': { status: 409, title: "지금은 두 계정을 합칠 수 없습니다. 고객센터로 문의해 주세요" },
  'merge-proposal-not-found': { status: 404, title: "병합 제안이 없거나 시간이 지났습니다" },
  'new-payment-paused': { status: 503, title: "새 결제를 잠시 멈췄습니다" },
  'next-invalid': { status: 400, title: "돌아갈 주소가 같은 출처 경로가 아닙니다" },
  'nickname-check-limited': { status: 429, title: "닉네임 확인을 너무 많이 했습니다. 잠시 뒤 다시 시도해 주세요" },
  'nickname-invalid': { status: 400, title: "닉네임 꼴이 맞지 않습니다" },
  'nickname-taken': { status: 409, title: "이미 사용 중인 닉네임입니다" },
  'no-placement': { status: 409, title: "배치되지 않은 기기입니다" },
  'not-found': { status: 404, title: "찾을 수 없습니다" },
  'not-payer': { status: 403, title: "결제한 분만 할 수 있습니다" },
  'not-running': { status: 409, title: "진행 중인 요청이 아닙니다" },
  'not-verifying': { status: 409, title: "추가 검증 중인 대기표가 아닙니다" },
  'notification-resend-not-allowed': { status: 409, title: "지금은 다시 보낼 수 없습니다" },
  'notification-template-activation-forbidden': { status: 403, title: "제출자와 다른 사람이 활성해야 합니다" },
  'notification-template-hash-mismatch': { status: 409, title: "검토한 문안과 지금 코드가 다릅니다" },
  'notification-template-invalid-state': { status: 409, title: "지금 상태에서는 할 수 없습니다" },
  'notification-template-review-required': { status: 409, title: "내부 검토를 마쳐야 합니다" },
  'notification-template-version-exists': { status: 409, title: "이미 있는 템플릿 판입니다" },
  'notify-sender-unavailable': { status: 503, title: "알림 발송기를 쓸 수 없습니다" },
  'onsale-window-unavailable': { status: 503, title: "온세일 윈도우를 지금 확인할 수 없습니다" },
  'open-interval-conflict': { status: 409, title: "다른 대규모 공연과 오픈 시각이 겹칩니다" },
  'open-maintenance-window': { status: 409, title: "정비 시간에는 오픈할 수 없습니다" },
  'open-passed': { status: 410, title: "오픈 시각이 지났습니다" },
  'open-too-close': { status: 409, title: "다른 공연과 오픈 시각이 5분 안입니다" },
  'order-expired': { status: 409, title: "결제하지 않아 끝난 주문입니다" },
  'other-partner-device': { status: 403, title: "다른 파트너사의 기기입니다" },
  'outside-staff-hours': { status: 403, title: "근무 시간이 아닙니다" },
  'partner-admin-required': { status: 403, title: "파트너 관리자만 할 수 있습니다" },
  'passkey-assertion-invalid': { status: 422, title: "패스키를 확인하지 못했습니다" },
  'passkey-attestation-invalid': { status: 422, title: "패스키를 등록하지 못했습니다" },
  'passkey-exists': { status: 409, title: "이미 등록한 패스키입니다" },
  'passkey-limit': { status: 409, title: "패스키는 10개까지 등록할 수 있습니다" },
  'passkey-not-registered': { status: 409, title: "등록한 패스키가 없습니다" },
  'passkey-registration-invalid': { status: 410, title: "처음부터 다시 등록해 주세요" },
  'password-change-required': { status: 403, title: "비밀번호를 먼저 바꿔 주세요" },
  'password-rejected': { status: 422, title: "쓸 수 없는 비밀번호입니다" },
  'payer-holds': { status: 409, title: "이미 결제자가 보유한 티켓입니다" },
  'payment-already-accepted': { status: 409, title: "이 주문의 결제를 이미 접수했습니다" },
  'payment-attempt-mismatch': { status: 409, title: "결제 시도와 맞지 않습니다. 결제를 다시 시작해 주세요" },
  'payment-attempts-exceeded': { status: 409, title: "결제 시도 횟수를 넘었습니다" },
  'payment-not-accepted': { status: 409, title: "아직 결제를 접수하지 않은 주문입니다" },
  'payout-account-change-hold': { status: 409, title: "정산 계좌 변경 보류 중이라 지급할 수 없습니다" },
  'payout-account-holder-mismatch': { status: 422, title: "예금주가 판매자 상호나 대표자와 다릅니다" },
  'payout-account-mismatch': { status: 409, title: "예금주가 확인되지 않은 정산 계좌라 지급할 수 없습니다" },
  'payout-agency-update-failed': { status: 502, title: "결제사에 정산 계좌를 반영하지 못했습니다" },
  'payout-approval-conflict': { status: 409, title: "다른 사람이 먼저 처리했습니다" },
  'payout-balance-insufficient': { status: 409, title: "결제사 잔액이 모자라 지급일을 미룹니다" },
  'payout-batch-amount-mismatch': { status: 409, title: "승인한 지급 금액과 정산서 합계가 다릅니다" },
  'payout-batch-empty': { status: 409, title: "지급할 확정 정산서가 없습니다" },
  'payout-batch-exists': { status: 409, title: "이미 지급 묶음이 있습니다" },
  'payout-batch-not-approved': { status: 409, title: "승인된 지급 묶음이 아닙니다" },
  'payout-batch-not-portone': { status: 409, title: "포트원 지급 묶음이 아닙니다" },
  'payout-batch-statement-conflict': { status: 409, title: "확정 정산서가 아닌 건이 지급 묶음에 섞였습니다" },
  'payout-dependency-unavailable': { status: 503, title: "지급 서비스에 연결하지 못했습니다" },
  'payout-gateway-unavailable': { status: 503, title: "지급대행을 아직 시작할 수 없습니다" },
  'payout-holder-lookup-unavailable': { status: 503, title: "예금주를 확인할 수 없습니다" },
  'payout-kyc-required': { status: 409, title: "KYC 확인이 끝나지 않아 지급할 수 없습니다" },
  'payout-not-retryable': { status: 409, title: "실패한 지급 건만 다시 보낼 수 있습니다" },
  'payout-retry-approval-required': { status: 409, title: "금액이나 셀러를 바꾼 재요청은 새 지급 묶음 승인이 필요합니다" },
  'payout-sale-suspended': { status: 409, title: "판매 중지된 공연의 정산서라 지급할 수 없습니다" },
  'payout-seller-unverified': { status: 409, title: "판매자 확인이 끝나지 않아 정산 계좌를 받을 수 없습니다" },
  'pg-balance-unavailable': { status: 503, title: "결제사 잔액을 확인할 수 없습니다" },
  'pg-check-unavailable': { status: 503, title: "결제사 지정을 지금 확인할 수 없습니다" },
  'pg-fallback-same-provider': { status: 422, title: "대체 결제사가 기본 결제사와 같은 하위 결제사를 거칩니다" },
  'pg-unavailable': { status: 503, title: "결제를 잠시 시작할 수 없습니다" },
  'pickup-slot-unavailable': { status: 422, title: "고를 수 없는 수령 시간대입니다" },
  'place-exists': { status: 409, title: "같은 공연장이 있습니다" },
  'portone-transfer-conflict': { status: 502, title: "포트원 수기 정산건이 정산서와 맞지 않습니다" },
  'post-review-conflict': { status: 409, title: "지금 사후 검토 상태에서는 할 수 없습니다" },
  'post-review-invalid': { status: 422, title: "사후 검토 보고서 값이 올바르지 않습니다" },
  'post-review-not-executor': { status: 403, title: "명령을 실행한 commander만 제출할 수 있습니다" },
  'post-review-self-confirm': { status: 403, title: "실행한 분은 검토할 수 없습니다. 다른 commander가 검토합니다" },
  'poster-not-deletable': { status: 409, title: "포스터는 지우지 않고 바꿉니다" },
  'postponement-date-invalid': { status: 422, title: "바뀐 공연 시작 시각이 올바르지 않습니다" },
  'precondition-failed': { status: 412, title: "다른 사람이 먼저 고쳤습니다" },
  'precondition-required': { status: 428, title: "고칠 판(If-Match)을 보내 주세요" },
  'preverify-invalid': { status: 403, title: "사람 확인을 다시 해 주세요" },
  'preview-required': { status: 409, title: "미리보기를 계산한 뒤 확정할 수 있습니다" },
  'priority-grant-already-used': { status: 409, title: "이미 사용한 우선 구매 권리입니다" },
  'priority-grant-in-use': { status: 409, title: "지금 쓸 수 없는 우선 구매 권리입니다" },
  'priority-grant-not-found': { status: 404, title: "쓸 수 있는 우선 구매 권리가 없습니다" },
  'priority-seat-only': { status: 409, title: "우선 구매 권리의 좌석만 고를 수 있습니다" },
  'product-attributes-invalid': { status: 422, title: "상품 속성이 상품 유형에 맞지 않습니다" },
  'product-fulfillment-invalid': { status: 422, title: "수령 방식이 맞지 않습니다" },
  'product-limited-qty-invalid': { status: 422, title: "한정 수량이 맞지 않습니다" },
  'product-return-address-required': { status: 422, title: "택배 상품은 반품 받을 주소가 필요합니다" },
  'product-return-shipping-fee-required': { status: 422, title: "택배 상품은 반품 배송비가 필요합니다" },
  'product-settlement-source-unavailable': { status: 503, title: "상품 정산 원천을 읽을 수 없습니다" },
  'product-shipping-fee-required': { status: 422, title: "택배 상품은 배송비가 필요합니다" },
  'product-ticket-link-invalid': { status: 422, title: "티켓 연동 여부와 연결 회차가 맞지 않습니다" },
  'product-type-invalid': { status: 422, title: "쓸 수 없는 상품 유형입니다" },
  'production-suspended': { status: 409, title: "판매 중지 중에는 바꿀 수 없습니다" },
  'promoter-mismatch': { status: 422, title: "계정의 파트너사와 다릅니다" },
  'provider-down': { status: 503, title: "지금은 본인확인을 할 수 없습니다" },
  'proxy-approval-forbidden': { status: 403, title: "대리 승인은 현장 책임자만 할 수 있습니다" },
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
  'queue-entry-not-found': { status: 404, title: "이 회차에 대기 참여가 없습니다" },
  'queue-not-found': { status: 404, title: "이 회차의 대기열이 열리지 않았습니다" },
  'queue-not-open': { status: 409, title: "아직 예매가 열리지 않았습니다" },
  'queue-order-invalid': { status: 422, title: "로비 셔플과 오픈 직후 묶음을 둘 다 끌 수는 없습니다" },
  'queue-recovering': { status: 503, title: "대기열을 다시 맞추는 중입니다. 잠시 뒤 다시 시도해 주세요" },
  'queue-request-limited': { status: 429, title: "요청이 많아 잠시 뒤 다시 시도해 주세요" },
  'queue-ticket-expired': { status: 410, title: "입장 시간이 지났습니다" },
  'queue-ticket-invalid': { status: 403, title: "대기표를 확인할 수 없습니다" },
  'queue-ticket-removed': { status: 410, title: "이 대기표는 더 쓸 수 없습니다" },
  'readiness-source-unavailable': { status: 503, title: "점검 원천을 읽지 못했습니다" },
  'reauth-code-invalid': { status: 422, title: "인증 앱 코드가 맞지 않습니다" },
  'reauth-required': { status: 403, title: "다시 인증해 주세요" },
  'reauth-step-invalid': { status: 410, title: "처음부터 다시 인증해 주세요" },
  'reauth-unavailable': { status: 503, title: "재인증 검증기를 쓸 수 없습니다" },
  'recalculation-conflict': { status: 409, title: "같은 요청 ID로 다른 회차·종류의 다시 계산이 있습니다" },
  'recipient-not-found': { status: 404, title: "받을 수 있는 회원을 찾지 못했습니다" },
  'recommended-reason-required': { status: 422, title: "실패한 권고 항목의 사유를 적어 주세요" },
  'refresh-token-invalid': { status: 401, title: "다시 로그인해 주세요" },
  'refund-account-required': { status: 422, title: "환불받을 계좌를 입력해 주세요" },
  'refund-rejected': { status: 422, title: "결제사가 환급을 거절했습니다. 고객센터가 이어 봅니다" },
  'reissue-at-booth': { status: 403, title: "입장이 시작되어 현장 부스에서만 다시 받을 수 있습니다" },
  'reissue-required': { status: 403, title: "이 티켓은 다른 기기에 입장 키가 있습니다. 다시 로그인한 뒤 이 휴대폰으로 받을 수 있습니다" },
  'rejection-not-allowed': { status: 403, title: "판정 전 반려는 commander만 할 수 있습니다" },
  'reoffer-not-allowed': { status: 409, title: "받은 티켓은 다시 양도할 수 없습니다. 결제자에게 돌려주세요" },
  'report-limited': { status: 429, title: "오늘은 더 신고할 수 없습니다" },
  'research-export-not-ready': { status: 409, title: "연구용 내보내기를 아직 만드는 중입니다" },
  'restriction-too-long': { status: 422, title: "이용 제한은 1년을 넘길 수 없습니다" },
  'retention-ended': { status: 410, title: "보관 기간이 끝났습니다" },
  'review-already-written': { status: 409, title: "이 회차의 후기를 이미 썼습니다" },
  'review-eligibility-unavailable': { status: 503, title: "후기 자격을 잠시 확인할 수 없습니다" },
  'review-event-cancelled': { status: 403, title: "취소된 회차에는 후기를 쓸 수 없습니다" },
  'review-hidden-by-notice': { status: 409, title: "통보로 가린 후기는 고칠 수 없습니다" },
  'review-not-author': { status: 403, title: "내 후기만 고칠 수 있습니다" },
  'review-not-ended': { status: 403, title: "공연이 끝난 뒤에 후기를 쓸 수 있습니다" },
  'review-not-purchaser': { status: 403, title: "이 회차를 예매한 분만 후기를 쓸 수 있습니다" },
  'review-self-report': { status: 403, title: "내 후기는 신고할 수 없습니다" },
  'role-group-mismatch': { status: 422, title: "파트너 역할과 관제 역할 사이는 바꿀 수 없습니다" },
  'rotation-too-soon': { status: 409, title: "비밀을 방금 바꿨습니다. 잠시 뒤 다시 시도해 주세요" },
  'sale-eligibility-list-limit': { status: 409, title: "판매 자격 명단은 공연마다 10개까지 둘 수 있습니다" },
  'sale-eligibility-list-locked': { status: 409, title: "판매 자격 명단이 잠겨 바꿀 수 없습니다" },
  'sale-eligibility-required': { status: 403, title: "이 판매 단계의 예매 대상이 아닙니다" },
  'sale-eligibility-upload-limited': { status: 429, title: "명단을 너무 자주 올렸습니다. 잠시 뒤 다시 올려 주세요" },
  'sale-eligibility-upload-rejected': { status: 422, title: "명단 파일을 읽지 않았습니다" },
  'sale-eligibility-upload-too-large': { status: 413, title: "명단 파일은 8MB까지 올릴 수 있습니다" },
  'sale-ended': { status: 410, title: "판매 시간이 끝났습니다" },
  'sale-not-publishable': { status: 409, title: "판매를 열 수 없는 회차입니다" },
  'sale-not-suspended': { status: 409, title: "판매 중지된 공연이 아닙니다" },
  'sale-paused': { status: 423, title: "판매가 잠시 멈췄습니다" },
  'sale-policy-denied': { status: 403, title: "판매 정책에 따라 지금은 예매할 수 없습니다" },
  'sale-policy-invalid': { status: 422, title: "판매 정책 규칙에 고칠 곳이 있습니다" },
  'sale-review-list-missing': { status: 422, title: "판매 정책이 쓰는 명단이 없습니다" },
  'sale-review-not-approved': { status: 409, title: "판매 승인된 공연만 회차 설정을 쓸 수 있습니다" },
  'sale-review-not-cancellable': { status: 409, title: "거둘 판매 승인 변경 요청이 없습니다" },
  'sale-review-not-submitted': { status: 409, title: "판매 승인 대기 중인 공연이 아닙니다" },
  'sale-review-payout-registration-incomplete': { status: 409, title: "지급대행 등록이 끝나지 않아 승인할 수 없습니다" },
  'sale-review-request-invalid': { status: 422, title: "판매 승인 요청을 받을 수 없습니다" },
  'sale-review-scales-missing': { status: 422, title: "모든 회차의 공연 규모를 정해 주세요" },
  'sale-setting-locked': { status: 409, title: "지금은 바꿀 수 없는 항목입니다" },
  'sale-stop-unavailable': { status: 503, title: "판매를 멈추지 못해 확정하지 않았습니다" },
  'sale-suspension-conflict': { status: 409, title: "판매 승인 상태와 맞지 않습니다" },
  'scale-change-closed': { status: 409, title: "규모를 바꿀 수 있는 시각이 지났습니다" },
  'scale-change-not-approved': { status: 422, title: "판매 승인된 공연만 규모를 올릴 수 있습니다" },
  'scale-change-not-up': { status: 422, title: "지금보다 큰 규모로만 올릴 수 있습니다" },
  'scanner-auth-unavailable': { status: 503, title: "스캐너 기기·세션을 확인하지 못했습니다" },
  'scanner-device-inactive': { status: 409, title: "폐기·퇴역한 스캐너 기기입니다" },
  'scanner-device-key-in-use': { status: 409, title: "이미 다른 기기에 묶인 기기 키입니다" },
  'scanner-device-not-found': { status: 404, title: "스캐너 기기를 찾을 수 없습니다" },
  'scanner-event-mismatch': { status: 403, title: "스캐너 세션의 회차와 요청 회차가 다릅니다" },
  'scanner-flag-not-found': { status: 404, title: "이상 표시를 찾을 수 없습니다" },
  'scanner-login-rate-limited': { status: 429, title: "승인 요청이 너무 잦습니다" },
  'scanner-origin-forbidden': { status: 403, title: "스캐너 앱 출처가 아닙니다" },
  'scanner-override-forbidden': { status: 403, title: "예외 통과는 현장 책임자 본인 세션에서만 할 수 있습니다" },
  'scanner-placement-reentry-not-allowed': { status: 422, title: "재입장을 허용하지 않는 회차에는 퇴장 모드를 배치할 수 없습니다" },
  'seat-already-held': { status: 409, title: "좌석이 이미 선택되었습니다" },
  'seat-recently-released': { status: 409, title: "방금 놓은 좌석은 잠시 뒤에 다시 고를 수 있습니다" },
  'seat-store-unavailable': { status: 503, title: "좌석 정보를 잠시 쓸 수 없습니다" },
  'seatmap-geometry-locked': { status: 409, title: "판매가 시작되어 좌석 배치는 바꿀 수 없습니다" },
  'seatmap-import-rejected': { status: 422, title: "좌석맵 파일을 읽지 않았습니다" },
  'seatmap-import-too-large': { status: 413, title: "좌석맵 파일은 10MB까지 올릴 수 있습니다" },
  'seatmap-invalid': { status: 422, title: "좌석맵에 고칠 곳이 있습니다" },
  'seatmap-publish-unavailable': { status: 503, title: "좌석맵 파일을 잠시 게시할 수 없습니다" },
  'seatmap-replace-required': { status: 409, title: "좌석이 있는 좌석맵은 바꾸기로만 가져올 수 있습니다" },
  'seatmap-worker-unavailable': { status: 503, title: "좌석맵 파일을 잠시 확인할 수 없습니다" },
  'self-target-forbidden': { status: 403, title: "자기 계정에는 할 수 없습니다" },
  'self-transfer': { status: 422, title: "자신에게는 양도할 수 없습니다" },
  'seq-not-in-checkpoint': { status: 422, title: "그 체크포인트가 덮지 않는 기록입니다" },
  'server-busy': { status: 429, title: "요청이 많아 잠시 처리하지 못했습니다" },
  'session-not-found': { status: 404, title: "로그인한 기기가 아니거나 이미 로그아웃했습니다" },
  'settlement-adjustment-already-applied': { status: 409, title: "조정이 이미 적용되어 반려할 수 없습니다" },
  'settlement-commission-rate-invalid': { status: 422, title: "수수료율이 맞지 않습니다" },
  'settlement-dependency-unavailable': { status: 503, title: "정산 서비스에 연결하지 못했습니다" },
  'settlement-dispute-window-closed': { status: 409, title: "이의 기간이 끝났습니다" },
  'settlement-not-disputable': { status: 409, title: "지금은 이의를 낼 수 없는 정산서입니다" },
  'settlement-state-conflict': { status: 409, title: "정산서 상태가 다른 처리와 겹쳤습니다" },
  'signup-already-completed': { status: 409, title: "이미 가입을 마친 계정입니다" },
  'sold-out': { status: 410, title: "매진되었습니다" },
  'staff-account-inactive': { status: 403, title: "배정할 수 없는 계정 상태입니다" },
  'staff-assignment-exists': { status: 409, title: "이미 이 회차에 배정된 계정입니다" },
  'staff-assignment-missing': { status: 403, title: "이 회차의 스태프 배정이 없습니다" },
  'staff-invitation-already-accepted': { status: 409, title: "이미 수락했거나 끝난 배정입니다" },
  'staff-invitation-duplicate': { status: 422, title: "같은 이메일을 두 번 초대할 수 없습니다" },
  'staff-invitation-email-mismatch': { status: 403, title: "초대 이메일과 검증된 계정 이메일이 다릅니다" },
  'staff-invitation-email-unverified': { status: 403, title: "계정에 검증된 이메일이 없습니다" },
  'staff-invite-mail-unavailable': { status: 503, title: "지금은 초대 메일을 보낼 수 없습니다" },
  'statement-recalculation-pending': { status: 409, title: "회차 취소 다시 계산을 기다리는 정산서입니다" },
  'subscription-limit': { status: 422, title: "알림 신청 수를 넘었습니다" },
  'ticket-ended': { status: 409, title: "이미 끝난 티켓입니다" },
  'too-many-requests': { status: 429, title: "24시간 안에 이미 다시 받았습니다" },
  'toss-seller-registration-failed': { status: 502, title: "결제사 셀러 등록에 실패했습니다" },
  'transfer-closed': { status: 409, title: "양도 마감(공연 시작 2시간 전)이 지났습니다" },
  'transfer-expired': { status: 409, title: "양도 요청 기한이 지났습니다" },
  'transfer-locked': { status: 409, title: "지금은 양도할 수 없는 티켓입니다" },
  'transfer-lookup-limited': { status: 429, title: "받는 사람 확인 횟수를 넘었습니다" },
  'transfer-not-allowed': { status: 403, title: "양도로 보유자가 바뀐 티켓만 새 기기를 등록할 수 있습니다" },
  'transfer-not-offered': { status: 409, title: "진행 중인 양도 요청이 아닙니다" },
  'transfer-pending': { status: 409, title: "양도 요청을 철회한 뒤 취소할 수 있습니다" },
  'trigger-deferred': { status: 409, title: "판정 보류 중인 지표입니다" },
  'under-14': { status: 403, title: "만 14세 미만은 피켓을 이용할 수 없습니다" },
  'unknown-promoter': { status: 422, title: "등록되지 않은 파트너사입니다" },
  'unknown-widget-key': { status: 422, title: "모르는 위젯 키입니다" },
  'unlock-code-invalid': { status: 422, title: "코드가 맞지 않습니다" },
  'unlock-link-invalid': { status: 410, title: "이 링크는 더 쓸 수 없습니다" },
  'unlock-link-resend-limit': { status: 429, title: "해제 링크는 1시간에 3번까지 다시 받을 수 있습니다" },
  'user-code-unavailable': { status: 409, title: "확인 코드를 새로 받아 주세요" },
  'verification-not-found': { status: 404, title: "본인확인 건을 찾을 수 없습니다" },
  'verification-submit-limited': { status: 429, title: "확인을 너무 많이 시도했습니다. 잠시 뒤 다시 시도해 주세요" },
  'version-conflict': { status: 409, title: "다른 요청이 먼저 처리되었습니다" },
  'webhook-delivery-not-redeliverable': { status: 409, title: "지금은 다시 보낼 수 없습니다" },
  'webhook-url-not-allowed': { status: 400, title: "받지 않는 웹훅 주소입니다" },
  'wish-limit': { status: 422, title: "찜 수를 넘었습니다" },
  'withdrawal-confirmation-required': { status: 409, title: "탈퇴 전에 확인해 주세요" },
  'withdrawal-pending': { status: 409, title: "탈퇴 처리 중에는 새 예매를 할 수 없습니다" },
} as const satisfies Record<ProblemType, { status: number; title: string }>;
