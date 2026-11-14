// 계약(docs/api/openapi.yaml)에서 만든 파일이다. 손으로 고치지 않는다: pnpm --filter @peaket/api-client gen(BUILD_ORDER BAS-041)

import type { Operation } from '../client';

/** 작업 이름(operationId, docs/api/guidelines.md §10) */
export type OperationId =
  | 'createAppeal'
  | 'createCancellationAccount'
  | 'createCompensationAccount'
  | 'createDeviceApproval'
  | 'createDeviceApprovalLookup'
  | 'createEventHold'
  | 'createEventReview'
  | 'createEventSubscription'
  | 'createHoldExtension'
  | 'createIdentityAccessToken'
  | 'createIdentityBoothReverification'
  | 'createIdentityLinkProposalSeparateAccount'
  | 'createIdentityMergeProposalConfirmation'
  | 'createIdentityMinorContractCheck'
  | 'createIdentityNicknameCheck'
  | 'createIdentitySignupCancellation'
  | 'createIdentitySignupCompletion'
  | 'createIdentityVerification'
  | 'createIdentityVerificationResult'
  | 'createInquiry'
  | 'createInquiryMessage'
  | 'createOpsAdminAccount'
  | 'createOpsAdminAccountDesignation'
  | 'createOpsAdminAccountInvitation'
  | 'createOpsAdminAccountRemoval'
  | 'createOpsApprovalRequest'
  | 'createOpsApprovalRequestApproval'
  | 'createOpsApprovalRequestRejection'
  | 'createOpsApprovalRequestWithdrawal'
  | 'createOpsArtist'
  | 'createOpsAuditCheckpoint'
  | 'createOpsAuthAccessToken'
  | 'createOpsAuthInvitationAcceptance'
  | 'createOpsAuthInvitationCompletion'
  | 'createOpsAuthInvitationPasskey'
  | 'createOpsAuthInvitationPasskeyRegistration'
  | 'createOpsAuthInvitationPassword'
  | 'createOpsAuthInvitationTotpConfirmation'
  | 'createOpsAuthInvitationTotpEnrollment'
  | 'createOpsAuthPasskey'
  | 'createOpsAuthPasskeyRegistration'
  | 'createOpsAuthPasswordChange'
  | 'createOpsAuthReauthentication'
  | 'createOpsAuthSession'
  | 'createOpsAuthUnlock'
  | 'createOpsAuthUnlockLink'
  | 'createOpsBotReviewSampleJudgement'
  | 'createOpsCaseReply'
  | 'createOpsCommand'
  | 'createOpsCommandApproval'
  | 'createOpsCommandExtension'
  | 'createOpsCommandPostReview'
  | 'createOpsCommandPostReviewConfirmation'
  | 'createOpsCommandRejection'
  | 'createOpsCommandRetry'
  | 'createOpsCommandReversion'
  | 'createOpsComplianceAccessFindingResolution'
  | 'createOpsComplianceAccessReviewCompletion'
  | 'createOpsComplianceDataRequest'
  | 'createOpsComplianceDataRequestApproval'
  | 'createOpsComplianceDataRequestDocument'
  | 'createOpsComplianceDataRequestExtractionRequest'
  | 'createOpsComplianceDataRequestRejection'
  | 'createOpsComplianceDataRequestSubmission'
  | 'createOpsComplianceIncident'
  | 'createOpsComplianceIncidentClosure'
  | 'createOpsComplianceIncidentDetermination'
  | 'createOpsComplianceIncidentFiling'
  | 'createOpsComplianceNotice'
  | 'createOpsComplianceNoticeDocument'
  | 'createOpsComplianceNoticeTakedown'
  | 'createOpsComplianceNoticeWithdrawal'
  | 'createOpsDecision'
  | 'createOpsEventCancellation'
  | 'createOpsEventCancellationApproval'
  | 'createOpsEventCancellationJudgement'
  | 'createOpsEventCancellationPause'
  | 'createOpsEventCancellationRejection'
  | 'createOpsEventCancellationResumption'
  | 'createOpsEventFraudClusterRun'
  | 'createOpsEventScaleChange'
  | 'createOpsEvidenceBundleExport'
  | 'createOpsEvidenceBundleHoldEndConfirmation'
  | 'createOpsEvidenceBundleHoldEndRequest'
  | 'createOpsExternalPost'
  | 'createOpsFanLookup'
  | 'createOpsFanUnmasking'
  | 'createOpsFraudCase'
  | 'createOpsFraudCaseActionRequest'
  | 'createOpsFraudCaseAppealRequest'
  | 'createOpsFraudCaseEvidenceBundle'
  | 'createOpsFraudCaseIpReveal'
  | 'createOpsHomeLayoutBannerImage'
  | 'createOpsNoticeTemplate'
  | 'createOpsNoticeTemplateApproval'
  | 'createOpsPartnerNotice'
  | 'createOpsPayoutBatch'
  | 'createOpsPayoutBatchPortoneExecution'
  | 'createOpsPlace'
  | 'createOpsPromoter'
  | 'createOpsPromoterContractTermChange'
  | 'createOpsResearchExport'
  | 'createOpsReviewModeration'
  | 'createOpsSaleReviewApproval'
  | 'createOpsSaleReviewRejection'
  | 'createOpsScannerDevice'
  | 'createOpsScannerDeviceEnrollmentCode'
  | 'createOpsScannerDeviceRevocation'
  | 'createOpsSettlementAdjustment'
  | 'createOpsSettlementDisputeDismissal'
  | 'createOrder'
  | 'createOrderPayment'
  | 'createOrderPaymentAcceptance'
  | 'createPartnerAuthAccessToken'
  | 'createPartnerAuthInvitationAcceptance'
  | 'createPartnerAuthInvitationCompletion'
  | 'createPartnerAuthInvitationPasskey'
  | 'createPartnerAuthInvitationPasskeyRegistration'
  | 'createPartnerAuthInvitationPassword'
  | 'createPartnerAuthInvitationTotpConfirmation'
  | 'createPartnerAuthInvitationTotpEnrollment'
  | 'createPartnerAuthPasskey'
  | 'createPartnerAuthPasskeyRegistration'
  | 'createPartnerAuthPasswordChange'
  | 'createPartnerAuthReauthentication'
  | 'createPartnerAuthSession'
  | 'createPartnerAuthUnlock'
  | 'createPartnerAuthUnlockLink'
  | 'createPartnerEventAttendeeExport'
  | 'createPartnerEventCancellation'
  | 'createPartnerEventSettlementExport'
  | 'createPartnerEventStaffInvitation'
  | 'createPartnerMerchDeliveryExport'
  | 'createPartnerMerchOrderItemArrivalConfirmation'
  | 'createPartnerMerchOrderItemArrivalRejection'
  | 'createPartnerMerchPickup'
  | 'createPartnerMerchShipmentImport'
  | 'createPartnerProduct'
  | 'createPartnerProduction'
  | 'createPartnerProductionEvent'
  | 'createPartnerProductionImage'
  | 'createPartnerProductionSaleReview'
  | 'createPartnerProductionSeatmap'
  | 'createPartnerProductionSeatmapImport'
  | 'createPartnerSaleEligibilityList'
  | 'createPartnerSellerProfileChangeRequest'
  | 'createPartnerSettlementDispute'
  | 'createPartnerStaffInvitation'
  | 'createPartnerWebhook'
  | 'createPartnerWebhookDeliveryRedelivery'
  | 'createPartnerWebhookSecretRotation'
  | 'createPushSubscription'
  | 'createQueueAdmission'
  | 'createQueueEntry'
  | 'createQueueLobbyParticipant'
  | 'createQueuePreVerification'
  | 'createQueueVerification'
  | 'createReviewImage'
  | 'createReviewReport'
  | 'createScannerBoothAuthorization'
  | 'createScannerDeviceAuthorization'
  | 'createScannerDeviceEnrollment'
  | 'createScannerFlagResolution'
  | 'createScannerScan'
  | 'createScannerToken'
  | 'createShopOrder'
  | 'createShopOrderCancellation'
  | 'createShopOrderPayment'
  | 'createShopOrderPaymentAcceptance'
  | 'createShopOrderReturn'
  | 'createStaffInvitationAcceptance'
  | 'createStaffInvitationLookup'
  | 'createStaffInvitationRejection'
  | 'createSubscriptionOptOut'
  | 'createTicketAddon'
  | 'createTicketBoothRequest'
  | 'createTicketCancellation'
  | 'createTicketDeviceKey'
  | 'createTicketReturn'
  | 'createTicketTransfer'
  | 'createTransferAcceptance'
  | 'createTransferRecipientLookup'
  | 'createTransferRejection'
  | 'createTransferWithdrawal'
  | 'deleteEventPurchaseSession'
  | 'deleteEventSubscriptions'
  | 'deleteHold'
  | 'deleteIdentityAccount'
  | 'deleteIdentityConsent'
  | 'deleteIdentityProvider'
  | 'deleteIdentityScannerSession'
  | 'deleteIdentitySession'
  | 'deleteMyOpsAuthSession'
  | 'deleteMyPartnerAuthSession'
  | 'deleteMyQueueEntry'
  | 'deleteMyQueueLobbyParticipant'
  | 'deleteOpsAdminAccountDesignation'
  | 'deleteOpsAdminAccountSession'
  | 'deleteOpsAdminAccountSessions'
  | 'deleteOpsAuthPasskey'
  | 'deletePartnerAuthPasskey'
  | 'deletePartnerProductionImage'
  | 'deletePartnerProductionSaleReview'
  | 'deletePartnerSaleEligibilityList'
  | 'deletePartnerStaff'
  | 'deleteProductionWish'
  | 'deletePushSubscription'
  | 'deleteReview'
  | 'getAppeal'
  | 'getCompensation'
  | 'getEvent'
  | 'getEventReviewEligibility'
  | 'getEventReviewSummary'
  | 'getEventSeatmapLayout'
  | 'getEventSeatmapSnapshot'
  | 'getFanSaleEligibility'
  | 'getHold'
  | 'getHome'
  | 'getHomeRankings'
  | 'getIdentityLinkProposal'
  | 'getIdentityMe'
  | 'getIdentityMergeProposal'
  | 'getIdentityProfile'
  | 'getIdentityProviders'
  | 'getIdentityScannerSessions'
  | 'getIdentitySessions'
  | 'getIdentityVerificationResult'
  | 'getInquiry'
  | 'getMyBookingRestriction'
  | 'getMyOpsAuthSession'
  | 'getOpsAdminAccount'
  | 'getOpsApprovalRequest'
  | 'getOpsAuditAnchor'
  | 'getOpsAuditAnchorVerification'
  | 'getOpsAuditCheckpoint'
  | 'getOpsAuditCheckpointVerification'
  | 'getOpsAuthPasskeys'
  | 'getOpsCase'
  | 'getOpsCommand'
  | 'getOpsComplianceDataRequest'
  | 'getOpsComplianceDocument'
  | 'getOpsComplianceIncident'
  | 'getOpsComplianceNotice'
  | 'getOpsEventBotReview'
  | 'getOpsEventCancellation'
  | 'getOpsEventDemandForecast'
  | 'getOpsEventFraudOverview'
  | 'getOpsEventLive'
  | 'getOpsEventReport'
  | 'getOpsEventReports'
  | 'getOpsEvidenceBundle'
  | 'getOpsFan'
  | 'getOpsFraudCase'
  | 'getOpsFraudCaseGraph'
  | 'getOpsFraudCaseReplayExport'
  | 'getOpsFraudCluster'
  | 'getOpsHomeLayout'
  | 'getOpsLive'
  | 'getOpsPromoter'
  | 'getOpsResearchExport'
  | 'getOpsWidget'
  | 'getOrder'
  | 'getOrderPaymentStatus'
  | 'getPartnerAuthPasskeys'
  | 'getPartnerEventCancellation'
  | 'getPartnerEventFraudReport'
  | 'getPartnerEventGateStatus'
  | 'getPartnerEventLiveSnapshot'
  | 'getPartnerEventReport'
  | 'getPartnerEventSettlements'
  | 'getPartnerMerchOrderDelivery'
  | 'getPartnerProduct'
  | 'getPartnerProduction'
  | 'getPartnerProductionSeatmap'
  | 'getPartnerSalePolicy'
  | 'getPartnerSeatmapTemplate'
  | 'getPartnerSeatmapTemplates'
  | 'getPartnerSellerProfile'
  | 'getPartnerTodoSummary'
  | 'getQueueBatchResult'
  | 'getQueueSegmentState'
  | 'getQueueShuffleProof'
  | 'getQueueShuffleResult'
  | 'getQueueVerification'
  | 'getReview'
  | 'getScannerEventChanges'
  | 'getScannerEventDevices'
  | 'getScannerEventPackage'
  | 'getScannerShift'
  | 'getSearchSuggestions'
  | 'getShopOrder'
  | 'getShopOrderPaymentStatus'
  | 'getShopProduct'
  | 'getTicket'
  | 'getTicketCancellationQuote'
  | 'getTransfer'
  | 'listAppeals'
  | 'listCompensations'
  | 'listEventReviews'
  | 'listFraudAppealRequests'
  | 'listInquiries'
  | 'listOpsAdminAccountPermissionChanges'
  | 'listOpsAdminAccounts'
  | 'listOpsApprovalRequests'
  | 'listOpsArtists'
  | 'listOpsAuditCheckpoints'
  | 'listOpsCases'
  | 'listOpsCommands'
  | 'listOpsComplianceAccessReviews'
  | 'listOpsComplianceDataRequests'
  | 'listOpsComplianceIncidents'
  | 'listOpsComplianceNotices'
  | 'listOpsDecisions'
  | 'listOpsEventBotReviewSamples'
  | 'listOpsEventCancellations'
  | 'listOpsEvidenceBundles'
  | 'listOpsExternalPosts'
  | 'listOpsFanCases'
  | 'listOpsFanOrders'
  | 'listOpsFanQueueEntries'
  | 'listOpsFanTickets'
  | 'listOpsFanTransfers'
  | 'listOpsFraudCases'
  | 'listOpsFraudClusters'
  | 'listOpsNoticeTemplates'
  | 'listOpsPartnerNotices'
  | 'listOpsPayoutBatches'
  | 'listOpsPlaces'
  | 'listOpsPromoterContractTerms'
  | 'listOpsPromoters'
  | 'listOpsReceivables'
  | 'listOpsSaleReviews'
  | 'listOpsScannerDevices'
  | 'listOpsSettlements'
  | 'listOrders'
  | 'listPartnerArtists'
  | 'listPartnerEventAttendeeExports'
  | 'listPartnerEventAttendees'
  | 'listPartnerEventFlags'
  | 'listPartnerEventStaff'
  | 'listPartnerMerchOrderItems'
  | 'listPartnerMerchOrderStats'
  | 'listPartnerPlaces'
  | 'listPartnerProductSettlements'
  | 'listPartnerProductions'
  | 'listPartnerProducts'
  | 'listPartnerSaleEligibilityLists'
  | 'listPartnerTeamAccounts'
  | 'listPartnerWebhookDeliveries'
  | 'listPartnerWebhooks'
  | 'listReviews'
  | 'listScannerEventFlags'
  | 'listSearchResults'
  | 'listShopOrders'
  | 'listShopProducts'
  | 'listStaffAssignments'
  | 'listSubscriptions'
  | 'listTicketAddons'
  | 'listTickets'
  | 'listTransfers'
  | 'listWishes'
  | 'putIdentityConsent'
  | 'putOpsAdminAccountRole'
  | 'putOpsArtistAliases'
  | 'putOpsHomeLayout'
  | 'putOpsPlaceAliases'
  | 'putOpsProductionAliases'
  | 'putPartnerEventDevicePlacement'
  | 'putPartnerEventEntryPolicy'
  | 'putPartnerMerchOrderItemShipment'
  | 'putPartnerPayoutAccount'
  | 'putPartnerProductionSeatmap'
  | 'putPartnerSalePolicy'
  | 'putProductionWish'
  | 'putScannerEventDevicePlacement'
  | 'putScannerShiftReadiness'
  | 'receivePortoneWebhook'
  | 'receiveTossWebhook'
  | 'updateIdentityProfile'
  | 'updateOpsCase'
  | 'updateOpsDecision'
  | 'updateOpsFraudCase'
  | 'updateOpsNoticeTemplate'
  | 'updateOpsPlace'
  | 'updatePartnerEvent'
  | 'updatePartnerProduct'
  | 'updatePartnerProduction'
  | 'updatePartnerProductionImage'
  | 'updatePartnerWebhook'
  | 'updateReview';

/** 작업 서술 표(docs/frontend.md §4.1). 화면은 OPERATIONS.<작업 이름>을 api-client의 request에 넘기거나, 생성 훅을 쓴다 */
export const OPERATIONS = {
  createAppeal: {operationId: "createAppeal",method: "POST",path: "/v1/appeals",host: "api",kind: "write",cookie: true},
  createCancellationAccount: {operationId: "createCancellationAccount",method: "POST",path: "/v1/cancellations/{cancellationId}/account",host: "api",kind: "write",idempotent: true,cookie: true},
  createCompensationAccount: {operationId: "createCompensationAccount",method: "POST",path: "/v1/compensations/{compensationId}/account",host: "api",kind: "write",idempotent: true,cookie: true},
  createDeviceApproval: {operationId: "createDeviceApproval",method: "POST",path: "/v1/device-approvals",host: "api",kind: "write",cookie: true},
  createDeviceApprovalLookup: {operationId: "createDeviceApprovalLookup",method: "POST",path: "/v1/device-approval-lookups",host: "api",kind: "write",cookie: true},
  createEventHold: {operationId: "createEventHold",method: "POST",path: "/v1/events/{eventId}/holds",host: "api",kind: "write",idempotent: true,cookie: true,purchaseSigned: true},
  createEventReview: {operationId: "createEventReview",method: "POST",path: "/v1/events/{eventId}/reviews",host: "api",kind: "write",idempotent: true,cookie: true},
  createEventSubscription: {operationId: "createEventSubscription",method: "POST",path: "/v1/events/{eventId}/subscriptions",host: "api",kind: "write",cookie: true},
  createHoldExtension: {operationId: "createHoldExtension",method: "POST",path: "/v1/holds/{holdId}/extension",host: "api",kind: "write",cookie: true,purchaseSigned: true},
  createIdentityAccessToken: {operationId: "createIdentityAccessToken",method: "POST",path: "/v1/identity/access-tokens",host: "api",kind: "write",cookie: true},
  createIdentityBoothReverification: {operationId: "createIdentityBoothReverification",method: "POST",path: "/v1/identity/booth-reverifications",host: "api",kind: "write",cookie: true},
  createIdentityLinkProposalSeparateAccount: {operationId: "createIdentityLinkProposalSeparateAccount",method: "POST",path: "/v1/identity/link-proposals/{proposalId}/separate-account",host: "www",kind: "write",cookie: true},
  createIdentityMergeProposalConfirmation: {operationId: "createIdentityMergeProposalConfirmation",method: "POST",path: "/v1/identity/merge-proposals/{proposalId}/confirmation",host: "api",kind: "write",cookie: true},
  createIdentityMinorContractCheck: {operationId: "createIdentityMinorContractCheck",method: "POST",path: "/v1/identity/minor-contract-checks",host: "api",kind: "write",cookie: true},
  createIdentityNicknameCheck: {operationId: "createIdentityNicknameCheck",method: "POST",path: "/v1/identity/nickname-checks",host: "api",kind: "write",cookie: true},
  createIdentitySignupCancellation: {operationId: "createIdentitySignupCancellation",method: "POST",path: "/v1/identity/signup-cancellations",host: "api",kind: "write",cookie: true},
  createIdentitySignupCompletion: {operationId: "createIdentitySignupCompletion",method: "POST",path: "/v1/identity/signup-completions",host: "api",kind: "write",cookie: true},
  createIdentityVerification: {operationId: "createIdentityVerification",method: "POST",path: "/v1/identity/verifications",host: "api",kind: "write",cookie: true},
  createIdentityVerificationResult: {operationId: "createIdentityVerificationResult",method: "POST",path: "/v1/identity/verifications/{verificationId}/result",host: "api",kind: "write",cookie: true},
  createInquiry: {operationId: "createInquiry",method: "POST",path: "/v1/inquiries",host: "api",kind: "write",idempotent: true,cookie: true},
  createInquiryMessage: {operationId: "createInquiryMessage",method: "POST",path: "/v1/inquiries/{inquiryId}/messages",host: "api",kind: "write",idempotent: true,cookie: true},
  createOpsAdminAccount: {operationId: "createOpsAdminAccount",method: "POST",path: "/v1/ops/admin-accounts",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsAdminAccountDesignation: {operationId: "createOpsAdminAccountDesignation",method: "POST",path: "/v1/ops/admin-accounts/{adminAccountId}/designations",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsAdminAccountInvitation: {operationId: "createOpsAdminAccountInvitation",method: "POST",path: "/v1/ops/admin-accounts/{adminAccountId}/invitation",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsAdminAccountRemoval: {operationId: "createOpsAdminAccountRemoval",method: "POST",path: "/v1/ops/admin-accounts/{adminAccountId}/removal",host: "ops-api",kind: "write",cookie: true},
  createOpsApprovalRequest: {operationId: "createOpsApprovalRequest",method: "POST",path: "/v1/ops/approval-requests",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsApprovalRequestApproval: {operationId: "createOpsApprovalRequestApproval",method: "POST",path: "/v1/ops/approval-requests/{approvalId}/approvals",host: "ops-api",kind: "write",cookie: true},
  createOpsApprovalRequestRejection: {operationId: "createOpsApprovalRequestRejection",method: "POST",path: "/v1/ops/approval-requests/{approvalId}/rejections",host: "ops-api",kind: "write",cookie: true},
  createOpsApprovalRequestWithdrawal: {operationId: "createOpsApprovalRequestWithdrawal",method: "POST",path: "/v1/ops/approval-requests/{approvalId}/withdrawals",host: "ops-api",kind: "write",cookie: true},
  createOpsArtist: {operationId: "createOpsArtist",method: "POST",path: "/v1/ops/artists",host: "ops-api",kind: "write",cookie: true},
  createOpsAuditCheckpoint: {operationId: "createOpsAuditCheckpoint",method: "POST",path: "/v1/ops/audit-checkpoints",host: "ops-api",kind: "write",cookie: true},
  createOpsAuthAccessToken: {operationId: "createOpsAuthAccessToken",method: "POST",path: "/v1/ops/auth/access-tokens",host: "ops-api",kind: "write",cookie: true},
  createOpsAuthInvitationAcceptance: {operationId: "createOpsAuthInvitationAcceptance",method: "POST",path: "/v1/ops/auth/invitation-acceptances",host: "ops-api",kind: "write",cookie: false},
  createOpsAuthInvitationCompletion: {operationId: "createOpsAuthInvitationCompletion",method: "POST",path: "/v1/ops/auth/invitation-completions",host: "ops-api",kind: "write",cookie: false},
  createOpsAuthInvitationPasskey: {operationId: "createOpsAuthInvitationPasskey",method: "POST",path: "/v1/ops/auth/invitation-passkeys",host: "ops-api",kind: "write",cookie: false},
  createOpsAuthInvitationPasskeyRegistration: {operationId: "createOpsAuthInvitationPasskeyRegistration",method: "POST",path: "/v1/ops/auth/invitation-passkey-registrations",host: "ops-api",kind: "write",cookie: false},
  createOpsAuthInvitationPassword: {operationId: "createOpsAuthInvitationPassword",method: "POST",path: "/v1/ops/auth/invitation-passwords",host: "ops-api",kind: "write",cookie: false},
  createOpsAuthInvitationTotpConfirmation: {operationId: "createOpsAuthInvitationTotpConfirmation",method: "POST",path: "/v1/ops/auth/invitation-totp-confirmations",host: "ops-api",kind: "write",cookie: false},
  createOpsAuthInvitationTotpEnrollment: {operationId: "createOpsAuthInvitationTotpEnrollment",method: "POST",path: "/v1/ops/auth/invitation-totp-enrollments",host: "ops-api",kind: "write",cookie: false},
  createOpsAuthPasskey: {operationId: "createOpsAuthPasskey",method: "POST",path: "/v1/ops/auth/passkeys",host: "ops-api",kind: "write",cookie: true},
  createOpsAuthPasskeyRegistration: {operationId: "createOpsAuthPasskeyRegistration",method: "POST",path: "/v1/ops/auth/passkey-registrations",host: "ops-api",kind: "write",cookie: true},
  createOpsAuthPasswordChange: {operationId: "createOpsAuthPasswordChange",method: "POST",path: "/v1/ops/auth/password-changes",host: "ops-api",kind: "write",cookie: true},
  createOpsAuthReauthentication: {operationId: "createOpsAuthReauthentication",method: "POST",path: "/v1/ops/auth/reauthentications",host: "ops-api",kind: "write",cookie: true},
  createOpsAuthSession: {operationId: "createOpsAuthSession",method: "POST",path: "/v1/ops/auth/sessions",host: "ops-api",kind: "write",cookie: true},
  createOpsAuthUnlock: {operationId: "createOpsAuthUnlock",method: "POST",path: "/v1/ops/auth/unlocks",host: "ops-api",kind: "write",cookie: false},
  createOpsAuthUnlockLink: {operationId: "createOpsAuthUnlockLink",method: "POST",path: "/v1/ops/auth/unlock-links",host: "ops-api",kind: "write",cookie: false},
  createOpsBotReviewSampleJudgement: {operationId: "createOpsBotReviewSampleJudgement",method: "POST",path: "/v1/ops/bot-review-samples/{sampleId}/judgement",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsCaseReply: {operationId: "createOpsCaseReply",method: "POST",path: "/v1/ops/cases/{caseId}/replies",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsCommand: {operationId: "createOpsCommand",method: "POST",path: "/v1/ops/commands",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsCommandApproval: {operationId: "createOpsCommandApproval",method: "POST",path: "/v1/ops/commands/{commandId}/approvals",host: "ops-api",kind: "write",cookie: true},
  createOpsCommandExtension: {operationId: "createOpsCommandExtension",method: "POST",path: "/v1/ops/commands/{commandId}/extensions",host: "ops-api",kind: "write",cookie: true},
  createOpsCommandPostReview: {operationId: "createOpsCommandPostReview",method: "POST",path: "/v1/ops/commands/{commandId}/post-review",host: "ops-api",kind: "write",cookie: true},
  createOpsCommandPostReviewConfirmation: {operationId: "createOpsCommandPostReviewConfirmation",method: "POST",path: "/v1/ops/commands/{commandId}/post-review-confirmation",host: "ops-api",kind: "write",cookie: true},
  createOpsCommandRejection: {operationId: "createOpsCommandRejection",method: "POST",path: "/v1/ops/commands/{commandId}/rejections",host: "ops-api",kind: "write",cookie: true},
  createOpsCommandRetry: {operationId: "createOpsCommandRetry",method: "POST",path: "/v1/ops/commands/{commandId}/retries",host: "ops-api",kind: "write",cookie: true},
  createOpsCommandReversion: {operationId: "createOpsCommandReversion",method: "POST",path: "/v1/ops/commands/{commandId}/reversions",host: "ops-api",kind: "write",cookie: true},
  createOpsComplianceAccessFindingResolution: {operationId: "createOpsComplianceAccessFindingResolution",method: "POST",path: "/v1/ops/compliance/access-findings/{findingId}/resolution",host: "ops-api",kind: "write",cookie: true},
  createOpsComplianceAccessReviewCompletion: {operationId: "createOpsComplianceAccessReviewCompletion",method: "POST",path: "/v1/ops/compliance/access-reviews/{reviewId}/completion",host: "ops-api",kind: "write",cookie: true},
  createOpsComplianceDataRequest: {operationId: "createOpsComplianceDataRequest",method: "POST",path: "/v1/ops/compliance/data-requests",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsComplianceDataRequestApproval: {operationId: "createOpsComplianceDataRequestApproval",method: "POST",path: "/v1/ops/compliance/data-requests/{requestId}/approvals",host: "ops-api",kind: "write",cookie: true},
  createOpsComplianceDataRequestDocument: {operationId: "createOpsComplianceDataRequestDocument",method: "POST",path: "/v1/ops/compliance/data-requests/{requestId}/documents",host: "ops-api",kind: "upload",cookie: true},
  createOpsComplianceDataRequestExtractionRequest: {operationId: "createOpsComplianceDataRequestExtractionRequest",method: "POST",path: "/v1/ops/compliance/data-requests/{requestId}/extraction-requests",host: "ops-api",kind: "write",cookie: true},
  createOpsComplianceDataRequestRejection: {operationId: "createOpsComplianceDataRequestRejection",method: "POST",path: "/v1/ops/compliance/data-requests/{requestId}/rejections",host: "ops-api",kind: "write",cookie: true},
  createOpsComplianceDataRequestSubmission: {operationId: "createOpsComplianceDataRequestSubmission",method: "POST",path: "/v1/ops/compliance/data-requests/{requestId}/submission",host: "ops-api",kind: "write",cookie: true},
  createOpsComplianceIncident: {operationId: "createOpsComplianceIncident",method: "POST",path: "/v1/ops/compliance/incidents",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsComplianceIncidentClosure: {operationId: "createOpsComplianceIncidentClosure",method: "POST",path: "/v1/ops/compliance/incidents/{incidentId}/closure",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsComplianceIncidentDetermination: {operationId: "createOpsComplianceIncidentDetermination",method: "POST",path: "/v1/ops/compliance/incidents/{incidentId}/determination",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsComplianceIncidentFiling: {operationId: "createOpsComplianceIncidentFiling",method: "POST",path: "/v1/ops/compliance/incidents/{incidentId}/filings",host: "ops-api",kind: "write",cookie: true},
  createOpsComplianceNotice: {operationId: "createOpsComplianceNotice",method: "POST",path: "/v1/ops/compliance/notices",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsComplianceNoticeDocument: {operationId: "createOpsComplianceNoticeDocument",method: "POST",path: "/v1/ops/compliance/notices/{noticeId}/documents",host: "ops-api",kind: "upload",cookie: true},
  createOpsComplianceNoticeTakedown: {operationId: "createOpsComplianceNoticeTakedown",method: "POST",path: "/v1/ops/compliance/notices/{noticeId}/takedown",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsComplianceNoticeWithdrawal: {operationId: "createOpsComplianceNoticeWithdrawal",method: "POST",path: "/v1/ops/compliance/notices/{noticeId}/withdrawal",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsDecision: {operationId: "createOpsDecision",method: "POST",path: "/v1/ops/decisions",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsEventCancellation: {operationId: "createOpsEventCancellation",method: "POST",path: "/v1/ops/event-cancellations",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsEventCancellationApproval: {operationId: "createOpsEventCancellationApproval",method: "POST",path: "/v1/ops/event-cancellations/{requestId}/approvals",host: "ops-api",kind: "write",cookie: true},
  createOpsEventCancellationJudgement: {operationId: "createOpsEventCancellationJudgement",method: "POST",path: "/v1/ops/event-cancellations/{requestId}/judgement",host: "ops-api",kind: "write",cookie: true},
  createOpsEventCancellationPause: {operationId: "createOpsEventCancellationPause",method: "POST",path: "/v1/ops/event-cancellations/{requestId}/pauses",host: "ops-api",kind: "write",cookie: true},
  createOpsEventCancellationRejection: {operationId: "createOpsEventCancellationRejection",method: "POST",path: "/v1/ops/event-cancellations/{requestId}/rejections",host: "ops-api",kind: "write",cookie: true},
  createOpsEventCancellationResumption: {operationId: "createOpsEventCancellationResumption",method: "POST",path: "/v1/ops/event-cancellations/{requestId}/resumptions",host: "ops-api",kind: "write",cookie: true},
  createOpsEventFraudClusterRun: {operationId: "createOpsEventFraudClusterRun",method: "POST",path: "/v1/ops/events/{eventId}/fraud-cluster-runs",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsEventScaleChange: {operationId: "createOpsEventScaleChange",method: "POST",path: "/v1/ops/events/{eventId}/scale-changes",host: "ops-api",kind: "write",cookie: true},
  createOpsEvidenceBundleExport: {operationId: "createOpsEvidenceBundleExport",method: "POST",path: "/v1/ops/evidence-bundles/{bundleId}/exports",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsEvidenceBundleHoldEndConfirmation: {operationId: "createOpsEvidenceBundleHoldEndConfirmation",method: "POST",path: "/v1/ops/evidence-bundles/{bundleId}/hold-end-confirmations",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsEvidenceBundleHoldEndRequest: {operationId: "createOpsEvidenceBundleHoldEndRequest",method: "POST",path: "/v1/ops/evidence-bundles/{bundleId}/hold-end-requests",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsExternalPost: {operationId: "createOpsExternalPost",method: "POST",path: "/v1/ops/external-posts",host: "ops-api",kind: "upload",idempotent: true,cookie: true},
  createOpsFanLookup: {operationId: "createOpsFanLookup",method: "POST",path: "/v1/ops/fan-lookups",host: "ops-api",kind: "write",cookie: true},
  createOpsFanUnmasking: {operationId: "createOpsFanUnmasking",method: "POST",path: "/v1/ops/fans/{accountId}/unmaskings",host: "ops-api",kind: "write",cookie: true},
  createOpsFraudCase: {operationId: "createOpsFraudCase",method: "POST",path: "/v1/ops/fraud-cases",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsFraudCaseActionRequest: {operationId: "createOpsFraudCaseActionRequest",method: "POST",path: "/v1/ops/fraud-cases/{caseId}/action-requests",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsFraudCaseAppealRequest: {operationId: "createOpsFraudCaseAppealRequest",method: "POST",path: "/v1/ops/fraud-cases/{caseId}/appeal-requests",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsFraudCaseEvidenceBundle: {operationId: "createOpsFraudCaseEvidenceBundle",method: "POST",path: "/v1/ops/fraud-cases/{caseId}/evidence-bundles",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsFraudCaseIpReveal: {operationId: "createOpsFraudCaseIpReveal",method: "POST",path: "/v1/ops/fraud-cases/{caseId}/ip-reveals",host: "ops-api",kind: "write",cookie: true},
  createOpsHomeLayoutBannerImage: {operationId: "createOpsHomeLayoutBannerImage",method: "POST",path: "/v1/ops/home-layout/banner-images",host: "ops-api",kind: "upload",cookie: true},
  createOpsNoticeTemplate: {operationId: "createOpsNoticeTemplate",method: "POST",path: "/v1/ops/notice-templates",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsNoticeTemplateApproval: {operationId: "createOpsNoticeTemplateApproval",method: "POST",path: "/v1/ops/notice-templates/{templateId}/approvals",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  createOpsPartnerNotice: {operationId: "createOpsPartnerNotice",method: "POST",path: "/v1/ops/partner-notices",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsPayoutBatch: {operationId: "createOpsPayoutBatch",method: "POST",path: "/v1/ops/payout-batches",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsPayoutBatchPortoneExecution: {operationId: "createOpsPayoutBatchPortoneExecution",method: "POST",path: "/v1/ops/payout-batches/{batchId}/portone-execution",host: "ops-api",kind: "write",cookie: true},
  createOpsPlace: {operationId: "createOpsPlace",method: "POST",path: "/v1/ops/places",host: "ops-api",kind: "write",cookie: true},
  createOpsPromoter: {operationId: "createOpsPromoter",method: "POST",path: "/v1/ops/promoters",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsPromoterContractTermChange: {operationId: "createOpsPromoterContractTermChange",method: "POST",path: "/v1/ops/promoters/{promoterId}/contract-term-changes",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsResearchExport: {operationId: "createOpsResearchExport",method: "POST",path: "/v1/ops/research-exports",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsReviewModeration: {operationId: "createOpsReviewModeration",method: "POST",path: "/v1/ops/reviews/{reviewId}/moderation",host: "ops-api",kind: "write",cookie: true},
  createOpsSaleReviewApproval: {operationId: "createOpsSaleReviewApproval",method: "POST",path: "/v1/ops/sale-reviews/{productionId}/approvals",host: "ops-api",kind: "write",cookie: true},
  createOpsSaleReviewRejection: {operationId: "createOpsSaleReviewRejection",method: "POST",path: "/v1/ops/sale-reviews/{productionId}/rejections",host: "ops-api",kind: "write",cookie: true},
  createOpsScannerDevice: {operationId: "createOpsScannerDevice",method: "POST",path: "/v1/ops/scanner-devices",host: "ops-api",kind: "write",cookie: true},
  createOpsScannerDeviceEnrollmentCode: {operationId: "createOpsScannerDeviceEnrollmentCode",method: "POST",path: "/v1/ops/scanner-devices/{deviceId}/enrollment-code",host: "ops-api",kind: "write",cookie: true},
  createOpsScannerDeviceRevocation: {operationId: "createOpsScannerDeviceRevocation",method: "POST",path: "/v1/ops/scanner-devices/{deviceId}/revocation",host: "ops-api",kind: "write",cookie: true},
  createOpsSettlementAdjustment: {operationId: "createOpsSettlementAdjustment",method: "POST",path: "/v1/ops/settlements/{statementId}/adjustments",host: "ops-api",kind: "write",idempotent: true,cookie: true},
  createOpsSettlementDisputeDismissal: {operationId: "createOpsSettlementDisputeDismissal",method: "POST",path: "/v1/ops/settlements/{statementId}/dispute-dismissal",host: "ops-api",kind: "write",cookie: true},
  createOrder: {operationId: "createOrder",method: "POST",path: "/v1/orders",host: "api",kind: "write",idempotent: true,cookie: true,purchaseSigned: true},
  createOrderPayment: {operationId: "createOrderPayment",method: "POST",path: "/v1/orders/{orderId}/payments",host: "api",kind: "write",idempotent: true,cookie: true,purchaseSigned: true},
  createOrderPaymentAcceptance: {operationId: "createOrderPaymentAcceptance",method: "POST",path: "/v1/orders/{orderId}/payment-acceptance",host: "api",kind: "write",idempotent: true,cookie: true,purchaseSigned: true},
  createPartnerAuthAccessToken: {operationId: "createPartnerAuthAccessToken",method: "POST",path: "/v1/partner/auth/access-tokens",host: "partner-api",kind: "write",cookie: true},
  createPartnerAuthInvitationAcceptance: {operationId: "createPartnerAuthInvitationAcceptance",method: "POST",path: "/v1/partner/auth/invitation-acceptances",host: "partner-api",kind: "write",cookie: false},
  createPartnerAuthInvitationCompletion: {operationId: "createPartnerAuthInvitationCompletion",method: "POST",path: "/v1/partner/auth/invitation-completions",host: "partner-api",kind: "write",cookie: false},
  createPartnerAuthInvitationPasskey: {operationId: "createPartnerAuthInvitationPasskey",method: "POST",path: "/v1/partner/auth/invitation-passkeys",host: "partner-api",kind: "write",cookie: false},
  createPartnerAuthInvitationPasskeyRegistration: {operationId: "createPartnerAuthInvitationPasskeyRegistration",method: "POST",path: "/v1/partner/auth/invitation-passkey-registrations",host: "partner-api",kind: "write",cookie: false},
  createPartnerAuthInvitationPassword: {operationId: "createPartnerAuthInvitationPassword",method: "POST",path: "/v1/partner/auth/invitation-passwords",host: "partner-api",kind: "write",cookie: false},
  createPartnerAuthInvitationTotpConfirmation: {operationId: "createPartnerAuthInvitationTotpConfirmation",method: "POST",path: "/v1/partner/auth/invitation-totp-confirmations",host: "partner-api",kind: "write",cookie: false},
  createPartnerAuthInvitationTotpEnrollment: {operationId: "createPartnerAuthInvitationTotpEnrollment",method: "POST",path: "/v1/partner/auth/invitation-totp-enrollments",host: "partner-api",kind: "write",cookie: false},
  createPartnerAuthPasskey: {operationId: "createPartnerAuthPasskey",method: "POST",path: "/v1/partner/auth/passkeys",host: "partner-api",kind: "write",cookie: true},
  createPartnerAuthPasskeyRegistration: {operationId: "createPartnerAuthPasskeyRegistration",method: "POST",path: "/v1/partner/auth/passkey-registrations",host: "partner-api",kind: "write",cookie: true},
  createPartnerAuthPasswordChange: {operationId: "createPartnerAuthPasswordChange",method: "POST",path: "/v1/partner/auth/password-changes",host: "partner-api",kind: "write",cookie: true},
  createPartnerAuthReauthentication: {operationId: "createPartnerAuthReauthentication",method: "POST",path: "/v1/partner/auth/reauthentications",host: "partner-api",kind: "write",cookie: true},
  createPartnerAuthSession: {operationId: "createPartnerAuthSession",method: "POST",path: "/v1/partner/auth/sessions",host: "partner-api",kind: "write",cookie: true},
  createPartnerAuthUnlock: {operationId: "createPartnerAuthUnlock",method: "POST",path: "/v1/partner/auth/unlocks",host: "partner-api",kind: "write",cookie: false},
  createPartnerAuthUnlockLink: {operationId: "createPartnerAuthUnlockLink",method: "POST",path: "/v1/partner/auth/unlock-links",host: "partner-api",kind: "write",cookie: false},
  createPartnerEventAttendeeExport: {operationId: "createPartnerEventAttendeeExport",method: "POST",path: "/v1/partner/events/{eventId}/attendee-exports",host: "partner-api",kind: "write",cookie: true},
  createPartnerEventCancellation: {operationId: "createPartnerEventCancellation",method: "POST",path: "/v1/partner/events/{eventId}/cancellation",host: "partner-api",kind: "write",idempotent: true,cookie: true},
  createPartnerEventSettlementExport: {operationId: "createPartnerEventSettlementExport",method: "POST",path: "/v1/partner/events/{eventId}/settlement-exports",host: "partner-api",kind: "write",cookie: true},
  createPartnerEventStaffInvitation: {operationId: "createPartnerEventStaffInvitation",method: "POST",path: "/v1/partner/events/{eventId}/staff-invitations",host: "partner-api",kind: "write",cookie: true},
  createPartnerMerchDeliveryExport: {operationId: "createPartnerMerchDeliveryExport",method: "POST",path: "/v1/partner/merch-delivery-exports",host: "partner-api",kind: "write",cookie: true},
  createPartnerMerchOrderItemArrivalConfirmation: {operationId: "createPartnerMerchOrderItemArrivalConfirmation",method: "POST",path: "/v1/partner/merch-order-items/{itemId}/arrival-confirmation",host: "partner-api",kind: "write",idempotent: true,cookie: true},
  createPartnerMerchOrderItemArrivalRejection: {operationId: "createPartnerMerchOrderItemArrivalRejection",method: "POST",path: "/v1/partner/merch-order-items/{itemId}/arrival-rejection",host: "partner-api",kind: "write",idempotent: true,cookie: true},
  createPartnerMerchPickup: {operationId: "createPartnerMerchPickup",method: "POST",path: "/v1/partner/merch-pickups",host: "partner-api",kind: "write",idempotent: true,cookie: true},
  createPartnerMerchShipmentImport: {operationId: "createPartnerMerchShipmentImport",method: "POST",path: "/v1/partner/merch-shipment-imports",host: "partner-api",kind: "upload",idempotent: true,cookie: true},
  createPartnerProduct: {operationId: "createPartnerProduct",method: "POST",path: "/v1/partner/products",host: "partner-api",kind: "write",cookie: true},
  createPartnerProduction: {operationId: "createPartnerProduction",method: "POST",path: "/v1/partner/productions",host: "partner-api",kind: "write",idempotent: true,cookie: true},
  createPartnerProductionEvent: {operationId: "createPartnerProductionEvent",method: "POST",path: "/v1/partner/productions/{productionId}/events",host: "partner-api",kind: "write",idempotent: true,cookie: true},
  createPartnerProductionImage: {operationId: "createPartnerProductionImage",method: "POST",path: "/v1/partner/productions/{productionId}/images",host: "partner-api",kind: "upload",cookie: true},
  createPartnerProductionSaleReview: {operationId: "createPartnerProductionSaleReview",method: "POST",path: "/v1/partner/productions/{productionId}/sale-review",host: "partner-api",kind: "write",cookie: true},
  createPartnerProductionSeatmap: {operationId: "createPartnerProductionSeatmap",method: "POST",path: "/v1/partner/productions/{productionId}/seatmap",host: "partner-api",kind: "write",cookie: true},
  createPartnerProductionSeatmapImport: {operationId: "createPartnerProductionSeatmapImport",method: "POST",path: "/v1/partner/productions/{productionId}/seatmap-imports",host: "partner-api",kind: "upload",cookie: true},
  createPartnerSaleEligibilityList: {operationId: "createPartnerSaleEligibilityList",method: "POST",path: "/v1/partner/productions/{productionId}/sale-eligibility-lists",host: "partner-api",kind: "upload",cookie: true},
  createPartnerSellerProfileChangeRequest: {operationId: "createPartnerSellerProfileChangeRequest",method: "POST",path: "/v1/partner/seller-profile/change-requests",host: "partner-api",kind: "write",idempotent: true,cookie: true},
  createPartnerSettlementDispute: {operationId: "createPartnerSettlementDispute",method: "POST",path: "/v1/partner/settlements/{statementId}/disputes",host: "partner-api",kind: "write",idempotent: true,cookie: true},
  createPartnerStaffInvitation: {operationId: "createPartnerStaffInvitation",method: "POST",path: "/v1/partner/staff/{assignmentId}/invitation",host: "partner-api",kind: "write",cookie: true},
  createPartnerWebhook: {operationId: "createPartnerWebhook",method: "POST",path: "/v1/partner/webhooks",host: "partner-api",kind: "write",cookie: true},
  createPartnerWebhookDeliveryRedelivery: {operationId: "createPartnerWebhookDeliveryRedelivery",method: "POST",path: "/v1/partner/webhook-deliveries/{deliveryId}/redeliveries",host: "partner-api",kind: "write",cookie: true},
  createPartnerWebhookSecretRotation: {operationId: "createPartnerWebhookSecretRotation",method: "POST",path: "/v1/partner/webhooks/{endpointId}/secret-rotations",host: "partner-api",kind: "write",cookie: true},
  createPushSubscription: {operationId: "createPushSubscription",method: "POST",path: "/v1/push-subscriptions",host: "api",kind: "write",cookie: true},
  createQueueAdmission: {operationId: "createQueueAdmission",method: "POST",path: "/v1/queues/{eventId}/admission",host: "queue",kind: "write",cookie: true,t0: true},
  createQueueEntry: {operationId: "createQueueEntry",method: "POST",path: "/v1/queues/{eventId}/entries",host: "queue",kind: "write",cookie: true,t0: true},
  createQueueLobbyParticipant: {operationId: "createQueueLobbyParticipant",method: "POST",path: "/v1/queues/{eventId}/lobby-participants",host: "queue",kind: "write",cookie: true},
  createQueuePreVerification: {operationId: "createQueuePreVerification",method: "POST",path: "/v1/queues/{eventId}/pre-verifications",host: "queue",kind: "write",cookie: true},
  createQueueVerification: {operationId: "createQueueVerification",method: "POST",path: "/v1/queues/{eventId}/verification",host: "queue",kind: "write",cookie: true},
  createReviewImage: {operationId: "createReviewImage",method: "POST",path: "/v1/review-images",host: "api",kind: "upload",cookie: true},
  createReviewReport: {operationId: "createReviewReport",method: "POST",path: "/v1/reviews/{reviewId}/reports",host: "api",kind: "write",idempotent: true,cookie: true},
  createScannerBoothAuthorization: {operationId: "createScannerBoothAuthorization",method: "POST",path: "/v1/scanner/booth-authorizations",host: "scanner-api",kind: "write",cookie: false},
  createScannerDeviceAuthorization: {operationId: "createScannerDeviceAuthorization",method: "POST",path: "/v1/scanner/device-authorizations",host: "scanner-api",kind: "write",cookie: false},
  createScannerDeviceEnrollment: {operationId: "createScannerDeviceEnrollment",method: "POST",path: "/v1/scanner/device-enrollments",host: "scanner-api",kind: "write",cookie: false},
  createScannerFlagResolution: {operationId: "createScannerFlagResolution",method: "POST",path: "/v1/scanner/flags/{flagId}/resolution",host: "scanner-api",kind: "write",cookie: false},
  createScannerScan: {operationId: "createScannerScan",method: "POST",path: "/v1/scanner/scans",host: "scanner-api",kind: "write",cookie: false},
  createScannerToken: {operationId: "createScannerToken",method: "POST",path: "/v1/scanner/token",host: "scanner-api",kind: "write",cookie: false},
  createShopOrder: {operationId: "createShopOrder",method: "POST",path: "/v1/shop/orders",host: "api",kind: "write",idempotent: true,cookie: true},
  createShopOrderCancellation: {operationId: "createShopOrderCancellation",method: "POST",path: "/v1/shop/orders/{orderId}/cancellations",host: "api",kind: "write",idempotent: true,cookie: true},
  createShopOrderPayment: {operationId: "createShopOrderPayment",method: "POST",path: "/v1/shop/orders/{orderId}/payments",host: "api",kind: "write",idempotent: true,cookie: true},
  createShopOrderPaymentAcceptance: {operationId: "createShopOrderPaymentAcceptance",method: "POST",path: "/v1/shop/orders/{orderId}/payment-acceptance",host: "api",kind: "write",idempotent: true,cookie: true},
  createShopOrderReturn: {operationId: "createShopOrderReturn",method: "POST",path: "/v1/shop/orders/{orderId}/returns",host: "api",kind: "write",idempotent: true,cookie: true},
  createStaffInvitationAcceptance: {operationId: "createStaffInvitationAcceptance",method: "POST",path: "/v1/staff-invitation-acceptances",host: "api",kind: "write",cookie: true},
  createStaffInvitationLookup: {operationId: "createStaffInvitationLookup",method: "POST",path: "/v1/staff-invitation-lookups",host: "api",kind: "write",cookie: true},
  createStaffInvitationRejection: {operationId: "createStaffInvitationRejection",method: "POST",path: "/v1/staff-invitation-rejections",host: "api",kind: "write",cookie: true},
  createSubscriptionOptOut: {operationId: "createSubscriptionOptOut",method: "POST",path: "/v1/subscription-opt-outs/{optOutToken}",host: "api",kind: "write",cookie: false},
  createTicketAddon: {operationId: "createTicketAddon",method: "POST",path: "/v1/tickets/{ticketId}/addons",host: "api",kind: "write",idempotent: true,cookie: true},
  createTicketBoothRequest: {operationId: "createTicketBoothRequest",method: "POST",path: "/v1/tickets/{ticketId}/booth-requests",host: "api",kind: "write",cookie: true},
  createTicketCancellation: {operationId: "createTicketCancellation",method: "POST",path: "/v1/tickets/{ticketId}/cancellation",host: "api",kind: "write",idempotent: true,cookie: true},
  createTicketDeviceKey: {operationId: "createTicketDeviceKey",method: "POST",path: "/v1/tickets/{ticketId}/device-keys",host: "api",kind: "write",cookie: true},
  createTicketReturn: {operationId: "createTicketReturn",method: "POST",path: "/v1/tickets/{ticketId}/returns",host: "api",kind: "write",idempotent: true,cookie: true},
  createTicketTransfer: {operationId: "createTicketTransfer",method: "POST",path: "/v1/tickets/{ticketId}/transfers",host: "api",kind: "write",idempotent: true,cookie: true},
  createTransferAcceptance: {operationId: "createTransferAcceptance",method: "POST",path: "/v1/transfers/{offerId}/acceptance",host: "api",kind: "write",idempotent: true,cookie: true},
  createTransferRecipientLookup: {operationId: "createTransferRecipientLookup",method: "POST",path: "/v1/transfer-recipient-lookups",host: "api",kind: "write",cookie: true},
  createTransferRejection: {operationId: "createTransferRejection",method: "POST",path: "/v1/transfers/{offerId}/rejection",host: "api",kind: "write",idempotent: true,cookie: true},
  createTransferWithdrawal: {operationId: "createTransferWithdrawal",method: "POST",path: "/v1/transfers/{offerId}/withdrawal",host: "api",kind: "write",idempotent: true,cookie: true},
  deleteEventPurchaseSession: {operationId: "deleteEventPurchaseSession",method: "DELETE",path: "/v1/events/{eventId}/purchase-session",host: "api",kind: "write",cookie: true,purchaseSigned: true},
  deleteEventSubscriptions: {operationId: "deleteEventSubscriptions",method: "DELETE",path: "/v1/events/{eventId}/subscriptions",host: "api",kind: "write",cookie: true,query: ["kind"]},
  deleteHold: {operationId: "deleteHold",method: "DELETE",path: "/v1/holds/{holdId}",host: "api",kind: "write",cookie: true,purchaseSigned: true},
  deleteIdentityAccount: {operationId: "deleteIdentityAccount",method: "DELETE",path: "/v1/identity/account",host: "api",kind: "write",cookie: true},
  deleteIdentityConsent: {operationId: "deleteIdentityConsent",method: "DELETE",path: "/v1/identity/consents/{kind}",host: "api",kind: "write",cookie: true},
  deleteIdentityProvider: {operationId: "deleteIdentityProvider",method: "DELETE",path: "/v1/identity/providers/{provider}",host: "api",kind: "write",cookie: true},
  deleteIdentityScannerSession: {operationId: "deleteIdentityScannerSession",method: "DELETE",path: "/v1/identity/scanner-sessions/{sessionId}",host: "api",kind: "write",cookie: true},
  deleteIdentitySession: {operationId: "deleteIdentitySession",method: "DELETE",path: "/v1/identity/sessions/{sessionId}",host: "api",kind: "write",cookie: true},
  deleteMyOpsAuthSession: {operationId: "deleteMyOpsAuthSession",method: "DELETE",path: "/v1/ops/auth/sessions/me",host: "ops-api",kind: "write",cookie: true},
  deleteMyPartnerAuthSession: {operationId: "deleteMyPartnerAuthSession",method: "DELETE",path: "/v1/partner/auth/sessions/me",host: "partner-api",kind: "write",cookie: true},
  deleteMyQueueEntry: {operationId: "deleteMyQueueEntry",method: "DELETE",path: "/v1/queues/{eventId}/entries/me",host: "queue",kind: "write",cookie: true},
  deleteMyQueueLobbyParticipant: {operationId: "deleteMyQueueLobbyParticipant",method: "DELETE",path: "/v1/queues/{eventId}/lobby-participants/me",host: "queue",kind: "write",cookie: true},
  deleteOpsAdminAccountDesignation: {operationId: "deleteOpsAdminAccountDesignation",method: "DELETE",path: "/v1/ops/admin-accounts/{adminAccountId}/designations/{kind}",host: "ops-api",kind: "write",cookie: true},
  deleteOpsAdminAccountSession: {operationId: "deleteOpsAdminAccountSession",method: "DELETE",path: "/v1/ops/admin-accounts/{adminAccountId}/sessions/{sessionId}",host: "ops-api",kind: "write",cookie: true},
  deleteOpsAdminAccountSessions: {operationId: "deleteOpsAdminAccountSessions",method: "DELETE",path: "/v1/ops/admin-accounts/{adminAccountId}/sessions",host: "ops-api",kind: "write",cookie: true},
  deleteOpsAuthPasskey: {operationId: "deleteOpsAuthPasskey",method: "DELETE",path: "/v1/ops/auth/passkeys/{passkeyId}",host: "ops-api",kind: "write",cookie: true},
  deletePartnerAuthPasskey: {operationId: "deletePartnerAuthPasskey",method: "DELETE",path: "/v1/partner/auth/passkeys/{passkeyId}",host: "partner-api",kind: "write",cookie: true},
  deletePartnerProductionImage: {operationId: "deletePartnerProductionImage",method: "DELETE",path: "/v1/partner/productions/{productionId}/images/{imageId}",host: "partner-api",kind: "write",cookie: true},
  deletePartnerProductionSaleReview: {operationId: "deletePartnerProductionSaleReview",method: "DELETE",path: "/v1/partner/productions/{productionId}/sale-review",host: "partner-api",kind: "write",cookie: true},
  deletePartnerSaleEligibilityList: {operationId: "deletePartnerSaleEligibilityList",method: "DELETE",path: "/v1/partner/productions/{productionId}/sale-eligibility-lists/{listKey}",host: "partner-api",kind: "write",cookie: true},
  deletePartnerStaff: {operationId: "deletePartnerStaff",method: "DELETE",path: "/v1/partner/staff/{assignmentId}",host: "partner-api",kind: "write",cookie: true},
  deleteProductionWish: {operationId: "deleteProductionWish",method: "DELETE",path: "/v1/productions/{productionId}/wish",host: "api",kind: "write",cookie: true},
  deletePushSubscription: {operationId: "deletePushSubscription",method: "DELETE",path: "/v1/push-subscriptions/{subscriptionKey}",host: "api",kind: "write",cookie: true},
  deleteReview: {operationId: "deleteReview",method: "DELETE",path: "/v1/reviews/{reviewId}",host: "api",kind: "write",cookie: true},
  getAppeal: {operationId: "getAppeal",method: "GET",path: "/v1/appeals/{appealId}",host: "api",kind: "read",cookie: true},
  getCompensation: {operationId: "getCompensation",method: "GET",path: "/v1/compensations/{compensationId}",host: "api",kind: "read",cookie: true},
  getEvent: {operationId: "getEvent",method: "GET",path: "/v1/events/{eventId}",host: "api",kind: "read",cookie: false},
  getEventReviewEligibility: {operationId: "getEventReviewEligibility",method: "GET",path: "/v1/events/{eventId}/review-eligibility",host: "api",kind: "read",cookie: true},
  getEventReviewSummary: {operationId: "getEventReviewSummary",method: "GET",path: "/v1/events/{eventId}/review-summary",host: "api",kind: "read",cookie: false},
  getEventSeatmapLayout: {operationId: "getEventSeatmapLayout",method: "GET",path: "/v1/events/{eventId}/seatmap-layouts/{layoutVersion}.json",host: "www",kind: "read",cookie: false},
  getEventSeatmapSnapshot: {operationId: "getEventSeatmapSnapshot",method: "GET",path: "/v1/events/{eventId}/seatmap-snapshot",host: "api",kind: "read",cookie: true,query: ["section"]},
  getFanSaleEligibility: {operationId: "getFanSaleEligibility",method: "GET",path: "/v1/events/{eventId}/sale-eligibility",host: "api",kind: "read",cookie: true},
  getHold: {operationId: "getHold",method: "GET",path: "/v1/holds/{holdId}",host: "api",kind: "read",cookie: true},
  getHome: {operationId: "getHome",method: "GET",path: "/v1/home",host: "api",kind: "read",cookie: false},
  getHomeRankings: {operationId: "getHomeRankings",method: "GET",path: "/v1/home/rankings.json",host: "www",kind: "read",cookie: false},
  getIdentityLinkProposal: {operationId: "getIdentityLinkProposal",method: "GET",path: "/v1/identity/link-proposals/{proposalId}",host: "www",kind: "read",cookie: true},
  getIdentityMe: {operationId: "getIdentityMe",method: "GET",path: "/v1/identity/me",host: "api",kind: "read",cookie: true},
  getIdentityMergeProposal: {operationId: "getIdentityMergeProposal",method: "GET",path: "/v1/identity/merge-proposals/{proposalId}",host: "api",kind: "read",cookie: true},
  getIdentityProfile: {operationId: "getIdentityProfile",method: "GET",path: "/v1/identity/profile",host: "api",kind: "read",cookie: true},
  getIdentityProviders: {operationId: "getIdentityProviders",method: "GET",path: "/v1/identity/providers",host: "api",kind: "read",cookie: true},
  getIdentityScannerSessions: {operationId: "getIdentityScannerSessions",method: "GET",path: "/v1/identity/scanner-sessions",host: "api",kind: "read",cookie: true},
  getIdentitySessions: {operationId: "getIdentitySessions",method: "GET",path: "/v1/identity/sessions",host: "api",kind: "read",cookie: true},
  getIdentityVerificationResult: {operationId: "getIdentityVerificationResult",method: "GET",path: "/v1/identity/verifications/{verificationId}/result",host: "api",kind: "read",cookie: true},
  getInquiry: {operationId: "getInquiry",method: "GET",path: "/v1/inquiries/{inquiryId}",host: "api",kind: "read",cookie: true},
  getMyBookingRestriction: {operationId: "getMyBookingRestriction",method: "GET",path: "/v1/booking-restrictions/me",host: "api",kind: "read",cookie: true},
  getMyOpsAuthSession: {operationId: "getMyOpsAuthSession",method: "GET",path: "/v1/ops/auth/sessions/me",host: "ops-api",kind: "read",cookie: true},
  getOpsAdminAccount: {operationId: "getOpsAdminAccount",method: "GET",path: "/v1/ops/admin-accounts/{adminAccountId}",host: "ops-api",kind: "read",cookie: true},
  getOpsApprovalRequest: {operationId: "getOpsApprovalRequest",method: "GET",path: "/v1/ops/approval-requests/{approvalId}",host: "ops-api",kind: "read",cookie: true},
  getOpsAuditAnchor: {operationId: "getOpsAuditAnchor",method: "GET",path: "/v1/ops/audit-anchors/{checkpointId}",host: "ops-api",kind: "read",cookie: false},
  getOpsAuditAnchorVerification: {operationId: "getOpsAuditAnchorVerification",method: "GET",path: "/v1/ops/audit-anchors/{checkpointId}/verification",host: "ops-api",kind: "read",cookie: false},
  getOpsAuditCheckpoint: {operationId: "getOpsAuditCheckpoint",method: "GET",path: "/v1/ops/audit-checkpoints/{checkpointId}",host: "ops-api",kind: "read",cookie: true},
  getOpsAuditCheckpointVerification: {operationId: "getOpsAuditCheckpointVerification",method: "GET",path: "/v1/ops/audit-checkpoints/{checkpointId}/verification",host: "ops-api",kind: "read",cookie: true},
  getOpsAuthPasskeys: {operationId: "getOpsAuthPasskeys",method: "GET",path: "/v1/ops/auth/passkeys",host: "ops-api",kind: "read",cookie: true},
  getOpsCase: {operationId: "getOpsCase",method: "GET",path: "/v1/ops/cases/{caseId}",host: "ops-api",kind: "read",cookie: true},
  getOpsCommand: {operationId: "getOpsCommand",method: "GET",path: "/v1/ops/commands/{commandId}",host: "ops-api",kind: "read",cookie: true},
  getOpsComplianceDataRequest: {operationId: "getOpsComplianceDataRequest",method: "GET",path: "/v1/ops/compliance/data-requests/{requestId}",host: "ops-api",kind: "read",cookie: true},
  getOpsComplianceDocument: {operationId: "getOpsComplianceDocument",method: "GET",path: "/v1/ops/compliance/documents/{documentId}",host: "ops-api",kind: "read",cookie: true},
  getOpsComplianceIncident: {operationId: "getOpsComplianceIncident",method: "GET",path: "/v1/ops/compliance/incidents/{incidentId}",host: "ops-api",kind: "read",cookie: true},
  getOpsComplianceNotice: {operationId: "getOpsComplianceNotice",method: "GET",path: "/v1/ops/compliance/notices/{noticeId}",host: "ops-api",kind: "read",cookie: true},
  getOpsEventBotReview: {operationId: "getOpsEventBotReview",method: "GET",path: "/v1/ops/events/{eventId}/bot-review",host: "ops-api",kind: "read",cookie: true},
  getOpsEventCancellation: {operationId: "getOpsEventCancellation",method: "GET",path: "/v1/ops/event-cancellations/{requestId}",host: "ops-api",kind: "read",cookie: true},
  getOpsEventDemandForecast: {operationId: "getOpsEventDemandForecast",method: "GET",path: "/v1/ops/events/{eventId}/demand-forecast",host: "ops-api",kind: "read",cookie: true},
  getOpsEventFraudOverview: {operationId: "getOpsEventFraudOverview",method: "GET",path: "/v1/ops/events/{eventId}/fraud-overview",host: "ops-api",kind: "read",cookie: true},
  getOpsEventLive: {operationId: "getOpsEventLive",method: "GET",path: "/v1/ops/events/{eventId}/live",host: "ops-api",kind: "read",cookie: true,sse: true,query: ["widgets"]},
  getOpsEventReport: {operationId: "getOpsEventReport",method: "GET",path: "/v1/ops/events/{eventId}/reports/{stage}",host: "ops-api",kind: "read",cookie: true},
  getOpsEventReports: {operationId: "getOpsEventReports",method: "GET",path: "/v1/ops/events/{eventId}/reports",host: "ops-api",kind: "read",cookie: true},
  getOpsEvidenceBundle: {operationId: "getOpsEvidenceBundle",method: "GET",path: "/v1/ops/evidence-bundles/{bundleId}",host: "ops-api",kind: "read",cookie: true},
  getOpsFan: {operationId: "getOpsFan",method: "GET",path: "/v1/ops/fans/{accountId}",host: "ops-api",kind: "read",cookie: true},
  getOpsFraudCase: {operationId: "getOpsFraudCase",method: "GET",path: "/v1/ops/fraud-cases/{caseId}",host: "ops-api",kind: "read",cookie: true},
  getOpsFraudCaseGraph: {operationId: "getOpsFraudCaseGraph",method: "GET",path: "/v1/ops/fraud-cases/{caseId}/graph",host: "ops-api",kind: "read",cookie: true},
  getOpsFraudCaseReplayExport: {operationId: "getOpsFraudCaseReplayExport",method: "GET",path: "/v1/ops/fraud-cases/{caseId}/replay-export",host: "ops-api",kind: "read",cookie: true,query: ["fromMs","toMs"]},
  getOpsFraudCluster: {operationId: "getOpsFraudCluster",method: "GET",path: "/v1/ops/fraud-clusters/{clusterId}",host: "ops-api",kind: "read",cookie: true},
  getOpsHomeLayout: {operationId: "getOpsHomeLayout",method: "GET",path: "/v1/ops/home-layout",host: "ops-api",kind: "read",cookie: true},
  getOpsLive: {operationId: "getOpsLive",method: "GET",path: "/v1/ops/live",host: "ops-api",kind: "read",cookie: true,sse: true,query: ["eventId"]},
  getOpsPromoter: {operationId: "getOpsPromoter",method: "GET",path: "/v1/ops/promoters/{promoterId}",host: "ops-api",kind: "read",cookie: true},
  getOpsResearchExport: {operationId: "getOpsResearchExport",method: "GET",path: "/v1/ops/research-exports/{exportId}",host: "ops-api",kind: "read",cookie: true},
  getOpsWidget: {operationId: "getOpsWidget",method: "GET",path: "/v1/ops/widgets/{widgetKey}",host: "ops-api",kind: "read",cookie: true,query: ["eventId","from","to"]},
  getOrder: {operationId: "getOrder",method: "GET",path: "/v1/orders/{orderId}",host: "api",kind: "read",cookie: true},
  getOrderPaymentStatus: {operationId: "getOrderPaymentStatus",method: "GET",path: "/v1/orders/{orderId}/payment-status",host: "api",kind: "longpoll",cookie: true},
  getPartnerAuthPasskeys: {operationId: "getPartnerAuthPasskeys",method: "GET",path: "/v1/partner/auth/passkeys",host: "partner-api",kind: "read",cookie: true},
  getPartnerEventCancellation: {operationId: "getPartnerEventCancellation",method: "GET",path: "/v1/partner/events/{eventId}/cancellation",host: "partner-api",kind: "read",cookie: true},
  getPartnerEventFraudReport: {operationId: "getPartnerEventFraudReport",method: "GET",path: "/v1/partner/events/{eventId}/fraud-report",host: "partner-api",kind: "read",cookie: true},
  getPartnerEventGateStatus: {operationId: "getPartnerEventGateStatus",method: "GET",path: "/v1/partner/events/{eventId}/gate-status",host: "partner-api",kind: "read",cookie: true},
  getPartnerEventLiveSnapshot: {operationId: "getPartnerEventLiveSnapshot",method: "GET",path: "/v1/partner/events/{eventId}/live-snapshot",host: "partner-api",kind: "read",cookie: true},
  getPartnerEventReport: {operationId: "getPartnerEventReport",method: "GET",path: "/v1/partner/events/{eventId}/report",host: "partner-api",kind: "read",cookie: true},
  getPartnerEventSettlements: {operationId: "getPartnerEventSettlements",method: "GET",path: "/v1/partner/events/{eventId}/settlements",host: "partner-api",kind: "read",cookie: true},
  getPartnerMerchOrderDelivery: {operationId: "getPartnerMerchOrderDelivery",method: "GET",path: "/v1/partner/merch-orders/{orderId}/delivery",host: "partner-api",kind: "read",cookie: true},
  getPartnerProduct: {operationId: "getPartnerProduct",method: "GET",path: "/v1/partner/products/{productId}",host: "partner-api",kind: "read",cookie: true},
  getPartnerProduction: {operationId: "getPartnerProduction",method: "GET",path: "/v1/partner/productions/{productionId}",host: "partner-api",kind: "read",cookie: true},
  getPartnerProductionSeatmap: {operationId: "getPartnerProductionSeatmap",method: "GET",path: "/v1/partner/productions/{productionId}/seatmap",host: "partner-api",kind: "read",cookie: true,query: ["fromTemplate"]},
  getPartnerSalePolicy: {operationId: "getPartnerSalePolicy",method: "GET",path: "/v1/partner/productions/{productionId}/sale-policy",host: "partner-api",kind: "read",cookie: true},
  getPartnerSeatmapTemplate: {operationId: "getPartnerSeatmapTemplate",method: "GET",path: "/v1/partner/seatmap-templates/{templateId}",host: "partner-api",kind: "read",cookie: true},
  getPartnerSeatmapTemplates: {operationId: "getPartnerSeatmapTemplates",method: "GET",path: "/v1/partner/seatmap-templates",host: "partner-api",kind: "read",cookie: true},
  getPartnerSellerProfile: {operationId: "getPartnerSellerProfile",method: "GET",path: "/v1/partner/seller-profile",host: "partner-api",kind: "read",cookie: true},
  getPartnerTodoSummary: {operationId: "getPartnerTodoSummary",method: "GET",path: "/v1/partner/todo-summary",host: "partner-api",kind: "read",cookie: true},
  getQueueBatchResult: {operationId: "getQueueBatchResult",method: "GET",path: "/v1/queues/{eventId}/batch-results/{hashPrefix}.json",host: "queue-files",kind: "queue-file",cookie: false},
  getQueueSegmentState: {operationId: "getQueueSegmentState",method: "GET",path: "/v1/queues/{eventId}/segment-states/{segment}.json",host: "queue-files",kind: "queue-file",cookie: false,cache: "no-store"},
  getQueueShuffleProof: {operationId: "getQueueShuffleProof",method: "GET",path: "/v1/queues/{eventId}/shuffle-proof",host: "queue",kind: "read",cookie: false},
  getQueueShuffleResult: {operationId: "getQueueShuffleResult",method: "GET",path: "/v1/queues/{eventId}/shuffle-results/{hashPrefix}.json",host: "queue-files",kind: "queue-file",cookie: false},
  getQueueVerification: {operationId: "getQueueVerification",method: "GET",path: "/v1/queues/{eventId}/verification",host: "queue",kind: "read",cookie: true},
  getReview: {operationId: "getReview",method: "GET",path: "/v1/reviews/{reviewId}",host: "api",kind: "read",cookie: true},
  getScannerEventChanges: {operationId: "getScannerEventChanges",method: "GET",path: "/v1/scanner/events/{eventId}/changes",host: "scanner-api",kind: "read",cookie: false,query: ["after","limit"]},
  getScannerEventDevices: {operationId: "getScannerEventDevices",method: "GET",path: "/v1/scanner/events/{eventId}/devices",host: "scanner-api",kind: "read",cookie: false},
  getScannerEventPackage: {operationId: "getScannerEventPackage",method: "GET",path: "/v1/scanner/events/{eventId}/package",host: "scanner-api",kind: "read",cookie: false},
  getScannerShift: {operationId: "getScannerShift",method: "GET",path: "/v1/scanner/shift",host: "scanner-api",kind: "read",cookie: false},
  getSearchSuggestions: {operationId: "getSearchSuggestions",method: "GET",path: "/v1/search/suggestions",host: "api",kind: "read",cookie: false,query: ["q"]},
  getShopOrder: {operationId: "getShopOrder",method: "GET",path: "/v1/shop/orders/{orderId}",host: "api",kind: "read",cookie: true},
  getShopOrderPaymentStatus: {operationId: "getShopOrderPaymentStatus",method: "GET",path: "/v1/shop/orders/{orderId}/payment-status",host: "api",kind: "longpoll",cookie: true},
  getShopProduct: {operationId: "getShopProduct",method: "GET",path: "/v1/shop/products/{productId}",host: "api",kind: "read",cookie: false},
  getTicket: {operationId: "getTicket",method: "GET",path: "/v1/tickets/{ticketId}",host: "api",kind: "read",cookie: true},
  getTicketCancellationQuote: {operationId: "getTicketCancellationQuote",method: "GET",path: "/v1/tickets/{ticketId}/cancellation-quote",host: "api",kind: "read",cookie: true},
  getTransfer: {operationId: "getTransfer",method: "GET",path: "/v1/transfers/{offerId}",host: "api",kind: "read",cookie: true},
  listAppeals: {operationId: "listAppeals",method: "GET",path: "/v1/appeals",host: "api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listCompensations: {operationId: "listCompensations",method: "GET",path: "/v1/compensations",host: "api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listEventReviews: {operationId: "listEventReviews",method: "GET",path: "/v1/events/{eventId}/reviews",host: "api",kind: "read",cookie: true,query: ["cursor","limit","sort"]},
  listFraudAppealRequests: {operationId: "listFraudAppealRequests",method: "GET",path: "/v1/fraud-appeal-requests",host: "api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listInquiries: {operationId: "listInquiries",method: "GET",path: "/v1/inquiries",host: "api",kind: "read",cookie: true,query: ["limit","page","status"]},
  listOpsAdminAccountPermissionChanges: {operationId: "listOpsAdminAccountPermissionChanges",method: "GET",path: "/v1/ops/admin-accounts/{adminAccountId}/permission-changes",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listOpsAdminAccounts: {operationId: "listOpsAdminAccounts",method: "GET",path: "/v1/ops/admin-accounts",host: "ops-api",kind: "read",cookie: true,query: ["cursor","group","limit","promoterId","status"]},
  listOpsApprovalRequests: {operationId: "listOpsApprovalRequests",method: "GET",path: "/v1/ops/approval-requests",host: "ops-api",kind: "read",cookie: true,query: ["awaitingMyApproval","cursor","kind","limit","requestedByMe","status"]},
  listOpsArtists: {operationId: "listOpsArtists",method: "GET",path: "/v1/ops/artists",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","q"]},
  listOpsAuditCheckpoints: {operationId: "listOpsAuditCheckpoints",method: "GET",path: "/v1/ops/audit-checkpoints",host: "ops-api",kind: "read",cookie: true,query: ["limit"]},
  listOpsCases: {operationId: "listOpsCases",method: "GET",path: "/v1/ops/cases",host: "ops-api",kind: "read",cookie: true,query: ["cursor","dueWithinDays","kind","limit"]},
  listOpsCommands: {operationId: "listOpsCommands",method: "GET",path: "/v1/ops/commands",host: "ops-api",kind: "read",cookie: true,query: ["cursor","eventId","limit","state","type","updatedAfter"]},
  listOpsComplianceAccessReviews: {operationId: "listOpsComplianceAccessReviews",method: "GET",path: "/v1/ops/compliance/access-reviews",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","period"]},
  listOpsComplianceDataRequests: {operationId: "listOpsComplianceDataRequests",method: "GET",path: "/v1/ops/compliance/data-requests",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","sort","status"]},
  listOpsComplianceIncidents: {operationId: "listOpsComplianceIncidents",method: "GET",path: "/v1/ops/compliance/incidents",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","sort","status"]},
  listOpsComplianceNotices: {operationId: "listOpsComplianceNotices",method: "GET",path: "/v1/ops/compliance/notices",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","sort","status"]},
  listOpsDecisions: {operationId: "listOpsDecisions",method: "GET",path: "/v1/ops/decisions",host: "ops-api",kind: "read",cookie: true,query: ["checkResult","cursor","eventId","limit","status"]},
  listOpsEventBotReviewSamples: {operationId: "listOpsEventBotReviewSamples",method: "GET",path: "/v1/ops/events/{eventId}/bot-review-samples",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","status"]},
  listOpsEventCancellations: {operationId: "listOpsEventCancellations",method: "GET",path: "/v1/ops/event-cancellations",host: "ops-api",kind: "read",cookie: true,query: ["cursor","eventId","limit","status"]},
  listOpsEvidenceBundles: {operationId: "listOpsEvidenceBundles",method: "GET",path: "/v1/ops/evidence-bundles",host: "ops-api",kind: "read",cookie: true,query: ["cursor","eventId","limit"]},
  listOpsExternalPosts: {operationId: "listOpsExternalPosts",method: "GET",path: "/v1/ops/external-posts",host: "ops-api",kind: "read",cookie: true,query: ["cursor","eventId","limit"]},
  listOpsFanCases: {operationId: "listOpsFanCases",method: "GET",path: "/v1/ops/fans/{accountId}/cases",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listOpsFanOrders: {operationId: "listOpsFanOrders",method: "GET",path: "/v1/ops/fans/{accountId}/orders",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listOpsFanQueueEntries: {operationId: "listOpsFanQueueEntries",method: "GET",path: "/v1/ops/fans/{accountId}/queue-entries",host: "ops-api",kind: "read",cookie: true,query: ["caseId","cursor","limit"]},
  listOpsFanTickets: {operationId: "listOpsFanTickets",method: "GET",path: "/v1/ops/fans/{accountId}/tickets",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listOpsFanTransfers: {operationId: "listOpsFanTransfers",method: "GET",path: "/v1/ops/fans/{accountId}/transfers",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listOpsFraudCases: {operationId: "listOpsFraudCases",method: "GET",path: "/v1/ops/fraud-cases",host: "ops-api",kind: "read",cookie: true,query: ["cursor","eventId","limit","status"]},
  listOpsFraudClusters: {operationId: "listOpsFraudClusters",method: "GET",path: "/v1/ops/fraud-clusters",host: "ops-api",kind: "read",cookie: true,query: ["cursor","eventId","limit","sort"]},
  listOpsNoticeTemplates: {operationId: "listOpsNoticeTemplates",method: "GET",path: "/v1/ops/notice-templates",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","status"]},
  listOpsPartnerNotices: {operationId: "listOpsPartnerNotices",method: "GET",path: "/v1/ops/partner-notices",host: "ops-api",kind: "read",cookie: true,query: ["cursor","eventId","limit"]},
  listOpsPayoutBatches: {operationId: "listOpsPayoutBatches",method: "GET",path: "/v1/ops/payout-batches",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","payoutDate","pg","pgStore","status"]},
  listOpsPlaces: {operationId: "listOpsPlaces",method: "GET",path: "/v1/ops/places",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","q"]},
  listOpsPromoterContractTerms: {operationId: "listOpsPromoterContractTerms",method: "GET",path: "/v1/ops/promoters/{promoterId}/contract-terms",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listOpsPromoters: {operationId: "listOpsPromoters",method: "GET",path: "/v1/ops/promoters",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","q"]},
  listOpsReceivables: {operationId: "listOpsReceivables",method: "GET",path: "/v1/ops/receivables",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listOpsSaleReviews: {operationId: "listOpsSaleReviews",method: "GET",path: "/v1/ops/sale-reviews",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit","status"]},
  listOpsScannerDevices: {operationId: "listOpsScannerDevices",method: "GET",path: "/v1/ops/scanner-devices",host: "ops-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listOpsSettlements: {operationId: "listOpsSettlements",method: "GET",path: "/v1/ops/settlements",host: "ops-api",kind: "read",cookie: true,query: ["cursor","kind","limit","payoutDate","pg","pgStore","status"]},
  listOrders: {operationId: "listOrders",method: "GET",path: "/v1/orders",host: "api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listPartnerArtists: {operationId: "listPartnerArtists",method: "GET",path: "/v1/partner/artists",host: "partner-api",kind: "read",cookie: true,query: ["cursor","limit","q"]},
  listPartnerEventAttendeeExports: {operationId: "listPartnerEventAttendeeExports",method: "GET",path: "/v1/partner/events/{eventId}/attendee-exports",host: "partner-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listPartnerEventAttendees: {operationId: "listPartnerEventAttendees",method: "GET",path: "/v1/partner/events/{eventId}/attendees",host: "partner-api",kind: "read",cookie: true,query: ["cursor","limit","orderId","tier"]},
  listPartnerEventFlags: {operationId: "listPartnerEventFlags",method: "GET",path: "/v1/partner/events/{eventId}/flags",host: "partner-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listPartnerEventStaff: {operationId: "listPartnerEventStaff",method: "GET",path: "/v1/partner/events/{eventId}/staff",host: "partner-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listPartnerMerchOrderItems: {operationId: "listPartnerMerchOrderItems",method: "GET",path: "/v1/partner/merch-order-items",host: "partner-api",kind: "read",cookie: true,query: ["cursor","from","fulfillment","limit","productId","status","to"]},
  listPartnerMerchOrderStats: {operationId: "listPartnerMerchOrderStats",method: "GET",path: "/v1/partner/merch-order-stats",host: "partner-api",kind: "read",cookie: true,query: ["cursor","from","limit","linkedProductionId","to"]},
  listPartnerPlaces: {operationId: "listPartnerPlaces",method: "GET",path: "/v1/partner/places",host: "partner-api",kind: "read",cookie: true,query: ["cursor","limit","q"]},
  listPartnerProductSettlements: {operationId: "listPartnerProductSettlements",method: "GET",path: "/v1/partner/product-settlements",host: "partner-api",kind: "read",cookie: true,query: ["cursor","from","limit","pgStore","to"]},
  listPartnerProductions: {operationId: "listPartnerProductions",method: "GET",path: "/v1/partner/productions",host: "partner-api",kind: "read",cookie: true,query: ["cursor","from","hasApprovalHistory","limit","q","saleReview","saleStatus","to"]},
  listPartnerProducts: {operationId: "listPartnerProducts",method: "GET",path: "/v1/partner/products",host: "partner-api",kind: "read",cookie: true,query: ["cursor","limit","linkedProductionId","q","status","ticketLinked"]},
  listPartnerSaleEligibilityLists: {operationId: "listPartnerSaleEligibilityLists",method: "GET",path: "/v1/partner/productions/{productionId}/sale-eligibility-lists",host: "partner-api",kind: "read",cookie: true},
  listPartnerTeamAccounts: {operationId: "listPartnerTeamAccounts",method: "GET",path: "/v1/partner/team-accounts",host: "partner-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listPartnerWebhookDeliveries: {operationId: "listPartnerWebhookDeliveries",method: "GET",path: "/v1/partner/webhooks/{endpointId}/deliveries",host: "partner-api",kind: "read",cookie: true,query: ["cursor","limit","status"]},
  listPartnerWebhooks: {operationId: "listPartnerWebhooks",method: "GET",path: "/v1/partner/webhooks",host: "partner-api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listReviews: {operationId: "listReviews",method: "GET",path: "/v1/reviews",host: "api",kind: "read",cookie: true,query: ["cursor","limit","status"]},
  listScannerEventFlags: {operationId: "listScannerEventFlags",method: "GET",path: "/v1/scanner/events/{eventId}/flags",host: "scanner-api",kind: "read",cookie: false,query: ["cursor","limit"]},
  listSearchResults: {operationId: "listSearchResults",method: "GET",path: "/v1/search",host: "api",kind: "read",cookie: false,query: ["artistId","dateFrom","dateTo","genre","includePast","limit","noConvert","page","placeId","q","sort","status"]},
  listShopOrders: {operationId: "listShopOrders",method: "GET",path: "/v1/shop/orders",host: "api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listShopProducts: {operationId: "listShopProducts",method: "GET",path: "/v1/shop/products",host: "api",kind: "read",cookie: false,query: ["cursor","limit","linkedEventId","type"]},
  listStaffAssignments: {operationId: "listStaffAssignments",method: "GET",path: "/v1/staff-assignments",host: "api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listSubscriptions: {operationId: "listSubscriptions",method: "GET",path: "/v1/subscriptions",host: "api",kind: "read",cookie: true,query: ["cursor","eventIds","limit"]},
  listTicketAddons: {operationId: "listTicketAddons",method: "GET",path: "/v1/tickets/{ticketId}/addons",host: "api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listTickets: {operationId: "listTickets",method: "GET",path: "/v1/tickets",host: "api",kind: "read",cookie: true,query: ["cursor","limit"]},
  listTransfers: {operationId: "listTransfers",method: "GET",path: "/v1/transfers",host: "api",kind: "read",cookie: true,query: ["cursor","limit","status"]},
  listWishes: {operationId: "listWishes",method: "GET",path: "/v1/wishes",host: "api",kind: "read",cookie: true,query: ["cursor","limit","productionIds"]},
  putIdentityConsent: {operationId: "putIdentityConsent",method: "PUT",path: "/v1/identity/consents/{kind}",host: "api",kind: "write",cookie: true},
  putOpsAdminAccountRole: {operationId: "putOpsAdminAccountRole",method: "PUT",path: "/v1/ops/admin-accounts/{adminAccountId}/role",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  putOpsArtistAliases: {operationId: "putOpsArtistAliases",method: "PUT",path: "/v1/ops/artists/{artistId}/aliases",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  putOpsHomeLayout: {operationId: "putOpsHomeLayout",method: "PUT",path: "/v1/ops/home-layout",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  putOpsPlaceAliases: {operationId: "putOpsPlaceAliases",method: "PUT",path: "/v1/ops/places/{placeId}/aliases",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  putOpsProductionAliases: {operationId: "putOpsProductionAliases",method: "PUT",path: "/v1/ops/productions/{productionId}/aliases",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  putPartnerEventDevicePlacement: {operationId: "putPartnerEventDevicePlacement",method: "PUT",path: "/v1/partner/events/{eventId}/device-placements/{deviceId}",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  putPartnerEventEntryPolicy: {operationId: "putPartnerEventEntryPolicy",method: "PUT",path: "/v1/partner/events/{eventId}/entry-policy",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  putPartnerMerchOrderItemShipment: {operationId: "putPartnerMerchOrderItemShipment",method: "PUT",path: "/v1/partner/merch-order-items/{itemId}/shipment",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  putPartnerPayoutAccount: {operationId: "putPartnerPayoutAccount",method: "PUT",path: "/v1/partner/payout-account",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  putPartnerProductionSeatmap: {operationId: "putPartnerProductionSeatmap",method: "PUT",path: "/v1/partner/productions/{productionId}/seatmap",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  putPartnerSalePolicy: {operationId: "putPartnerSalePolicy",method: "PUT",path: "/v1/partner/productions/{productionId}/sale-policy",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  putProductionWish: {operationId: "putProductionWish",method: "PUT",path: "/v1/productions/{productionId}/wish",host: "api",kind: "write",cookie: true},
  putScannerEventDevicePlacement: {operationId: "putScannerEventDevicePlacement",method: "PUT",path: "/v1/scanner/events/{eventId}/device-placements/{deviceId}",host: "scanner-api",kind: "write",cookie: false,ifMatch: true},
  putScannerShiftReadiness: {operationId: "putScannerShiftReadiness",method: "PUT",path: "/v1/scanner/shift/readiness",host: "scanner-api",kind: "write",cookie: false},
  receivePortoneWebhook: {operationId: "receivePortoneWebhook",method: "POST",path: "/v1/webhooks/portone",host: "partner-api",kind: "write",cookie: false},
  receiveTossWebhook: {operationId: "receiveTossWebhook",method: "POST",path: "/v1/webhooks/toss",host: "partner-api",kind: "write",cookie: false},
  updateIdentityProfile: {operationId: "updateIdentityProfile",method: "PATCH",path: "/v1/identity/profile",host: "api",kind: "write",cookie: true},
  updateOpsCase: {operationId: "updateOpsCase",method: "PATCH",path: "/v1/ops/cases/{caseId}",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  updateOpsDecision: {operationId: "updateOpsDecision",method: "PATCH",path: "/v1/ops/decisions/{decisionId}",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  updateOpsFraudCase: {operationId: "updateOpsFraudCase",method: "PATCH",path: "/v1/ops/fraud-cases/{caseId}",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  updateOpsNoticeTemplate: {operationId: "updateOpsNoticeTemplate",method: "PATCH",path: "/v1/ops/notice-templates/{templateId}",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  updateOpsPlace: {operationId: "updateOpsPlace",method: "PATCH",path: "/v1/ops/places/{placeId}",host: "ops-api",kind: "write",cookie: true,ifMatch: true},
  updatePartnerEvent: {operationId: "updatePartnerEvent",method: "PATCH",path: "/v1/partner/events/{eventId}",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  updatePartnerProduct: {operationId: "updatePartnerProduct",method: "PATCH",path: "/v1/partner/products/{productId}",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  updatePartnerProduction: {operationId: "updatePartnerProduction",method: "PATCH",path: "/v1/partner/productions/{productionId}",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  updatePartnerProductionImage: {operationId: "updatePartnerProductionImage",method: "PATCH",path: "/v1/partner/productions/{productionId}/images/{imageId}",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  updatePartnerWebhook: {operationId: "updatePartnerWebhook",method: "PATCH",path: "/v1/partner/webhooks/{endpointId}",host: "partner-api",kind: "write",cookie: true,ifMatch: true},
  updateReview: {operationId: "updateReview",method: "PATCH",path: "/v1/reviews/{reviewId}",host: "api",kind: "write",cookie: true},
} as const satisfies Record<OperationId, Operation & { operationId: OperationId }>;
