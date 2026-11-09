// 생성물: docs/api/proto/peaket/identity/v1/identity.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const identityV1Identity: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "identity": {
          "nested": {
            "v1": {
              "nested": {
                "IdentityService": {
                  "methods": {
                    "GetVerificationStatus": {
                      "requestType": "GetVerificationStatusRequest",
                      "responseType": "GetVerificationStatusResponse"
                    }
                  }
                },
                "GetVerificationStatusRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "session_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "GetVerificationStatusResponse": {
                  "fields": {
                    "verified": {
                      "type": "bool",
                      "id": 1
                    },
                    "pid": {
                      "type": "string",
                      "id": 2
                    },
                    "previous_pid": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "SessionService": {
                  "methods": {
                    "CreateSession": {
                      "requestType": "CreateSessionRequest",
                      "responseType": "CreateSessionResponse"
                    },
                    "GetLinkProposal": {
                      "requestType": "GetLinkProposalRequest",
                      "responseType": "GetLinkProposalResponse"
                    },
                    "SeparateAccount": {
                      "requestType": "SeparateAccountRequest",
                      "responseType": "CreateSessionResponse"
                    },
                    "AddProvider": {
                      "requestType": "AddProviderRequest",
                      "responseType": "AddProviderResponse"
                    },
                    "EndSession": {
                      "requestType": "EndSessionRequest",
                      "responseType": "EndSessionResponse"
                    },
                    "IssueReauthToken": {
                      "requestType": "IssueReauthTokenRequest",
                      "responseType": "IssueReauthTokenResponse"
                    }
                  }
                },
                "Provider": {
                  "values": {
                    "PROVIDER_UNSPECIFIED": 0,
                    "PROVIDER_KAKAO": 1,
                    "PROVIDER_NAVER": 2,
                    "PROVIDER_GOOGLE": 3
                  }
                },
                "CreateSessionRequest": {
                  "fields": {
                    "idempotency_key": {
                      "type": "string",
                      "id": 1
                    },
                    "provider": {
                      "type": "Provider",
                      "id": 2
                    },
                    "provider_user_id": {
                      "type": "string",
                      "id": 3
                    },
                    "email": {
                      "type": "string",
                      "id": 4
                    },
                    "email_verified": {
                      "type": "bool",
                      "id": 5
                    },
                    "link_proposal_id": {
                      "type": "string",
                      "id": 6
                    },
                    "device_id": {
                      "type": "string",
                      "id": 7
                    },
                    "client_ip": {
                      "type": "string",
                      "id": 8
                    },
                    "user_agent": {
                      "type": "string",
                      "id": 9
                    },
                    "auth_methods": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 10
                    },
                    "link_binding": {
                      "type": "string",
                      "id": 12
                    },
                    "asn": {
                      "type": "int64",
                      "id": 11
                    }
                  }
                },
                "CreateSessionResponse": {
                  "oneofs": {
                    "outcome": {
                      "oneof": [
                        "session",
                        "link_proposal_id",
                        "link_mismatch"
                      ]
                    }
                  },
                  "fields": {
                    "session": {
                      "type": "SessionTokens",
                      "id": 1
                    },
                    "link_proposal_id": {
                      "type": "string",
                      "id": 2
                    },
                    "link_mismatch": {
                      "type": "LinkMismatch",
                      "id": 5
                    },
                    "new_account": {
                      "type": "bool",
                      "id": 3
                    },
                    "link_binding": {
                      "type": "string",
                      "id": 4
                    },
                    "linked_provider": {
                      "type": "Provider",
                      "id": 6
                    }
                  }
                },
                "LinkMismatch": {
                  "fields": {
                    "attempts_left": {
                      "type": "int32",
                      "id": 1
                    }
                  }
                },
                "GetLinkProposalRequest": {
                  "fields": {
                    "link_proposal_id": {
                      "type": "string",
                      "id": 1
                    },
                    "link_binding": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "GetLinkProposalResponse": {
                  "fields": {
                    "existing_provider": {
                      "type": "Provider",
                      "id": 1
                    },
                    "new_provider": {
                      "type": "Provider",
                      "id": 2
                    },
                    "expires_at_ms": {
                      "type": "int64",
                      "id": 3
                    },
                    "attempts_left": {
                      "type": "int32",
                      "id": 4
                    }
                  }
                },
                "AddProviderRequest": {
                  "fields": {
                    "session_id": {
                      "type": "string",
                      "id": 1
                    },
                    "account_id": {
                      "type": "string",
                      "id": 2
                    },
                    "reauth_token": {
                      "type": "string",
                      "id": 3
                    },
                    "provider": {
                      "type": "Provider",
                      "id": 4
                    },
                    "provider_user_id": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "AddProviderResult": {
                  "values": {
                    "ADD_PROVIDER_RESULT_UNSPECIFIED": 0,
                    "ADD_PROVIDER_RESULT_LINKED": 1,
                    "ADD_PROVIDER_RESULT_ALREADY_LINKED": 2,
                    "ADD_PROVIDER_RESULT_PROVIDER_TYPE_TAKEN": 3,
                    "ADD_PROVIDER_RESULT_OTHER_ACCOUNT": 4,
                    "ADD_PROVIDER_RESULT_REAUTH_REQUIRED": 5
                  }
                },
                "AddProviderResponse": {
                  "fields": {
                    "result": {
                      "type": "AddProviderResult",
                      "id": 1
                    },
                    "merge_proposal_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "SeparateAccountRequest": {
                  "fields": {
                    "link_proposal_id": {
                      "type": "string",
                      "id": 1
                    },
                    "link_binding": {
                      "type": "string",
                      "id": 2
                    },
                    "idempotency_key": {
                      "type": "string",
                      "id": 3
                    },
                    "device_id": {
                      "type": "string",
                      "id": 4
                    },
                    "user_agent": {
                      "type": "string",
                      "id": 5
                    },
                    "auth_methods": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "SessionTokens": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "session_id": {
                      "type": "string",
                      "id": 2
                    },
                    "access_token": {
                      "type": "string",
                      "id": 3
                    },
                    "access_token_expires_at_ms": {
                      "type": "int64",
                      "id": 4
                    },
                    "refresh_token": {
                      "type": "string",
                      "id": 5
                    },
                    "refresh_token_expires_at_ms": {
                      "type": "int64",
                      "id": 6
                    }
                  }
                },
                "EndSessionRequest": {
                  "fields": {
                    "session_id": {
                      "type": "string",
                      "id": 1
                    },
                    "account_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "EndSessionResponse": {
                  "fields": {
                    "ended": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "ReauthStrength": {
                  "values": {
                    "REAUTH_STRENGTH_UNSPECIFIED": 0,
                    "REAUTH_STRENGTH_VERIFIED": 1,
                    "REAUTH_STRENGTH_REQUESTED": 2
                  }
                },
                "IssueReauthTokenRequest": {
                  "fields": {
                    "session_id": {
                      "type": "string",
                      "id": 1
                    },
                    "account_id": {
                      "type": "string",
                      "id": 2
                    },
                    "provider": {
                      "type": "Provider",
                      "id": 3
                    },
                    "provider_user_id": {
                      "type": "string",
                      "id": 4
                    },
                    "strength": {
                      "type": "ReauthStrength",
                      "id": 5
                    },
                    "client_ip": {
                      "type": "string",
                      "id": 6
                    },
                    "user_agent": {
                      "type": "string",
                      "id": 7
                    },
                    "purpose": {
                      "type": "ReauthPurpose",
                      "id": 8
                    }
                  }
                },
                "ReauthPurpose": {
                  "values": {
                    "REAUTH_PURPOSE_UNSPECIFIED": 0,
                    "REAUTH_PURPOSE_SENSITIVE": 1,
                    "REAUTH_PURPOSE_HIGH_RISK": 2
                  }
                },
                "ReauthResult": {
                  "values": {
                    "REAUTH_RESULT_UNSPECIFIED": 0,
                    "REAUTH_RESULT_ISSUED": 1,
                    "REAUTH_RESULT_ACCOUNT_MISMATCH": 2,
                    "REAUTH_RESULT_REVERIFY_REQUIRED": 3
                  }
                },
                "IssueReauthTokenResponse": {
                  "fields": {
                    "result": {
                      "type": "ReauthResult",
                      "id": 1
                    },
                    "reauth_token": {
                      "type": "string",
                      "id": 2
                    },
                    "reauth_token_expires_at_ms": {
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "AccountHoldService": {
                  "methods": {
                    "SetAccountHold": {
                      "requestType": "SetAccountHoldRequest",
                      "responseType": "SetAccountHoldResponse"
                    }
                  }
                },
                "AccountHoldKind": {
                  "values": {
                    "ACCOUNT_HOLD_KIND_UNSPECIFIED": 0,
                    "ACCOUNT_HOLD_KIND_VERIFICATION_APPEAL": 1,
                    "ACCOUNT_HOLD_KIND_DISPUTE": 2,
                    "ACCOUNT_HOLD_KIND_APPEAL": 3
                  }
                },
                "AccountHoldState": {
                  "values": {
                    "ACCOUNT_HOLD_STATE_UNSPECIFIED": 0,
                    "ACCOUNT_HOLD_STATE_OPEN": 1,
                    "ACCOUNT_HOLD_STATE_CLOSED": 2
                  }
                },
                "SetAccountHoldRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "kind": {
                      "type": "AccountHoldKind",
                      "id": 2
                    },
                    "source_ref": {
                      "type": "string",
                      "id": 3
                    },
                    "state": {
                      "type": "AccountHoldState",
                      "id": 4
                    },
                    "source_version": {
                      "type": "int64",
                      "id": 5
                    }
                  }
                },
                "SetAccountHoldResponse": {
                  "fields": {
                    "changed": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "ScannerSessionQueryService": {
                  "methods": {
                    "ListActiveScannerSessions": {
                      "requestType": "ListActiveScannerSessionsRequest",
                      "responseType": "ListActiveScannerSessionsResponse"
                    }
                  }
                },
                "ListActiveScannerSessionsRequest": {
                  "fields": {
                    "device_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "ActiveScannerSession": {
                  "fields": {
                    "device_id": {
                      "type": "string",
                      "id": 1
                    },
                    "nickname": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ListActiveScannerSessionsResponse": {
                  "fields": {
                    "sessions": {
                      "rule": "repeated",
                      "type": "ActiveScannerSession",
                      "id": 1
                    }
                  }
                },
                "ScannerSessionCheckService": {
                  "methods": {
                    "CheckScannerSession": {
                      "requestType": "CheckScannerSessionRequest",
                      "responseType": "CheckScannerSessionResponse"
                    }
                  }
                },
                "CheckScannerSessionRequest": {
                  "fields": {
                    "scanner_session_id": {
                      "type": "string",
                      "id": 1
                    },
                    "device_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "StaffRole": {
                  "values": {
                    "STAFF_ROLE_UNSPECIFIED": 0,
                    "STAFF_ROLE_GATE_STAFF": 1,
                    "STAFF_ROLE_GATE_LEAD": 2
                  }
                },
                "CheckScannerSessionResponse": {
                  "fields": {
                    "valid": {
                      "type": "bool",
                      "id": 1
                    },
                    "role": {
                      "type": "StaffRole",
                      "id": 2
                    },
                    "event_id": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "RecipientQueryService": {
                  "methods": {
                    "BatchGetRecipients": {
                      "requestType": "BatchGetRecipientsRequest",
                      "responseType": "BatchGetRecipientsResponse"
                    }
                  }
                },
                "BatchGetRecipientsRequest": {
                  "fields": {
                    "account_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    },
                    "include_email": {
                      "type": "bool",
                      "id": 2
                    }
                  }
                },
                "RecipientStatus": {
                  "values": {
                    "RECIPIENT_STATUS_UNSPECIFIED": 0,
                    "RECIPIENT_STATUS_ACTIVE": 1,
                    "RECIPIENT_STATUS_WITHDRAWAL_PENDING": 2,
                    "RECIPIENT_STATUS_MERGED": 3,
                    "RECIPIENT_STATUS_DELETED": 4,
                    "RECIPIENT_STATUS_NOT_FOUND": 5
                  }
                },
                "Recipient": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "status": {
                      "type": "RecipientStatus",
                      "id": 2
                    },
                    "verified": {
                      "type": "bool",
                      "id": 3
                    },
                    "locale": {
                      "type": "string",
                      "id": 4
                    },
                    "email": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "BatchGetRecipientsResponse": {
                  "fields": {
                    "recipients": {
                      "rule": "repeated",
                      "type": "Recipient",
                      "id": 1
                    }
                  }
                },
                "AdminSessionService": {
                  "methods": {
                    "TerminateAdminSessions": {
                      "requestType": "TerminateAdminSessionsRequest",
                      "responseType": "TerminateAdminSessionsResponse"
                    }
                  }
                },
                "TerminateAdminSessionsRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "admin_account_id": {
                      "type": "string",
                      "id": 2
                    },
                    "session_id": {
                      "type": "string",
                      "id": 3
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "TerminateAdminSessionsResponse": {
                  "fields": {
                    "ended_count": {
                      "type": "int32",
                      "id": 1
                    },
                    "already_done": {
                      "type": "bool",
                      "id": 2
                    }
                  }
                },
                "ReverificationCheckService": {
                  "methods": {
                    "CheckReverification": {
                      "requestType": "CheckReverificationRequest",
                      "responseType": "CheckReverificationResponse"
                    }
                  }
                },
                "CheckReverificationRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "pid": {
                      "type": "string",
                      "id": 2
                    },
                    "not_before_ms": {
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "ReverificationResult": {
                  "values": {
                    "REVERIFICATION_RESULT_UNSPECIFIED": 0,
                    "REVERIFICATION_RESULT_PASSED": 1,
                    "REVERIFICATION_RESULT_NOT_FOUND": 2,
                    "REVERIFICATION_RESULT_PERSON_MISMATCH": 3
                  }
                },
                "CheckReverificationResponse": {
                  "fields": {
                    "result": {
                      "type": "ReverificationResult",
                      "id": 1
                    },
                    "verified_at_ms": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "AdminAuthzService": {
                  "methods": {
                    "GetAdminAuthz": {
                      "requestType": "GetAdminAuthzRequest",
                      "responseType": "GetAdminAuthzResponse"
                    }
                  }
                },
                "GetAdminAuthzRequest": {
                  "fields": {
                    "admin_account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "session_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "GetAdminAuthzResponse": {
                  "fields": {
                    "valid": {
                      "type": "bool",
                      "id": 1
                    },
                    "role": {
                      "type": "string",
                      "id": 2
                    },
                    "tenant_id": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "AdminDesignationService": {
                  "methods": {
                    "GetAdminDesignations": {
                      "requestType": "GetAdminDesignationsRequest",
                      "responseType": "GetAdminDesignationsResponse"
                    }
                  }
                },
                "GetAdminDesignationsRequest": {
                  "fields": {
                    "admin_account_id": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "DesignationKind": {
                  "values": {
                    "DESIGNATION_KIND_UNSPECIFIED": 0,
                    "DESIGNATION_KIND_ACCESS_REVIEWER": 1,
                    "DESIGNATION_KIND_PSEUDONYM_HANDLER": 2,
                    "DESIGNATION_KIND_FRAUD_INVESTIGATOR": 3
                  }
                },
                "GetAdminDesignationsResponse": {
                  "fields": {
                    "kinds": {
                      "rule": "repeated",
                      "type": "DesignationKind",
                      "id": 1
                    },
                    "recently_revoked": {
                      "rule": "repeated",
                      "type": "RevokedDesignation",
                      "id": 2
                    }
                  }
                },
                "RevokedDesignation": {
                  "fields": {
                    "kind": {
                      "type": "DesignationKind",
                      "id": 1
                    },
                    "revoked_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 2
                    }
                  }
                },
                "AdminAccountService": {
                  "methods": {
                    "ListAdminAccounts": {
                      "requestType": "ListAdminAccountsRequest",
                      "responseType": "ListAdminAccountsResponse"
                    },
                    "GetAdminAccount": {
                      "requestType": "GetAdminAccountRequest",
                      "responseType": "GetAdminAccountResponse"
                    },
                    "InviteAdminAccount": {
                      "requestType": "InviteAdminAccountRequest",
                      "responseType": "AdminAccountChangeResponse"
                    },
                    "ChangeAdminRole": {
                      "requestType": "ChangeAdminRoleRequest",
                      "responseType": "AdminAccountChangeResponse"
                    },
                    "ReinviteAdminAccount": {
                      "requestType": "ReinviteAdminAccountRequest",
                      "responseType": "AdminAccountChangeResponse"
                    },
                    "RemoveAdminAccount": {
                      "requestType": "RemoveAdminAccountRequest",
                      "responseType": "AdminAccountChangeResponse"
                    },
                    "SetAdminDesignation": {
                      "requestType": "SetAdminDesignationRequest",
                      "responseType": "AdminAccountChangeResponse"
                    },
                    "RevokeAdminDesignation": {
                      "requestType": "RevokeAdminDesignationRequest",
                      "responseType": "AdminAccountChangeResponse"
                    }
                  }
                },
                "AdminRole": {
                  "values": {
                    "ADMIN_ROLE_UNSPECIFIED": 0,
                    "ADMIN_ROLE_VIEWER": 1,
                    "ADMIN_ROLE_OPERATOR": 2,
                    "ADMIN_ROLE_COMMANDER": 3,
                    "ADMIN_ROLE_CS_AGENT": 4,
                    "ADMIN_ROLE_CS_LEAD": 5,
                    "ADMIN_ROLE_PARTNER_ADMIN": 6,
                    "ADMIN_ROLE_PARTNER_MEMBER": 7
                  }
                },
                "AdminAccountGroup": {
                  "values": {
                    "ADMIN_ACCOUNT_GROUP_UNSPECIFIED": 0,
                    "ADMIN_ACCOUNT_GROUP_OPS": 1,
                    "ADMIN_ACCOUNT_GROUP_PARTNER": 2
                  }
                },
                "AdminAccountStatus": {
                  "values": {
                    "ADMIN_ACCOUNT_STATUS_UNSPECIFIED": 0,
                    "ADMIN_ACCOUNT_STATUS_INVITED": 1,
                    "ADMIN_ACCOUNT_STATUS_ACTIVE": 2,
                    "ADMIN_ACCOUNT_STATUS_INVITE_EXPIRED": 3,
                    "ADMIN_ACCOUNT_STATUS_REMOVED": 4
                  }
                },
                "AdminLockKind": {
                  "values": {
                    "ADMIN_LOCK_KIND_UNSPECIFIED": 0,
                    "ADMIN_LOCK_KIND_NONE": 1,
                    "ADMIN_LOCK_KIND_TIMED": 2,
                    "ADMIN_LOCK_KIND_PROTECT": 3
                  }
                },
                "AdminLockReason": {
                  "values": {
                    "ADMIN_LOCK_REASON_UNSPECIFIED": 0,
                    "ADMIN_LOCK_REASON_FAILED_ATTEMPTS": 1,
                    "ADMIN_LOCK_REASON_SECOND_FACTOR_FAILURES": 2,
                    "ADMIN_LOCK_REASON_PASSWORD_FAILURE_TOTAL": 3
                  }
                },
                "AdminAccount": {
                  "fields": {
                    "admin_account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "email_masked": {
                      "type": "string",
                      "id": 2
                    },
                    "group": {
                      "type": "AdminAccountGroup",
                      "id": 3
                    },
                    "role": {
                      "type": "AdminRole",
                      "id": 4
                    },
                    "promoter_id": {
                      "type": "string",
                      "id": 5
                    },
                    "status": {
                      "type": "AdminAccountStatus",
                      "id": 6
                    },
                    "lock_kind": {
                      "type": "AdminLockKind",
                      "id": 7
                    },
                    "lock_reason": {
                      "type": "AdminLockReason",
                      "id": 8
                    },
                    "locked_until_ms": {
                      "type": "int64",
                      "id": 9
                    },
                    "totp_enrolled": {
                      "type": "bool",
                      "id": 10
                    },
                    "passkey_count": {
                      "type": "int32",
                      "id": 11
                    },
                    "designations": {
                      "rule": "repeated",
                      "type": "DesignationKind",
                      "id": 12
                    },
                    "invite_expires_at_ms": {
                      "type": "int64",
                      "id": 13
                    },
                    "last_login_at_ms": {
                      "type": "int64",
                      "id": 14
                    },
                    "removed_at_ms": {
                      "type": "int64",
                      "id": 15
                    },
                    "display_name": {
                      "type": "string",
                      "id": 17
                    },
                    "version": {
                      "type": "int64",
                      "id": 16
                    }
                  }
                },
                "AdminSessionSummary": {
                  "fields": {
                    "session_id": {
                      "type": "string",
                      "id": 1
                    },
                    "browser": {
                      "type": "string",
                      "id": 2
                    },
                    "os": {
                      "type": "string",
                      "id": 3
                    },
                    "created_at_ms": {
                      "type": "int64",
                      "id": 4
                    },
                    "last_active_at_ms": {
                      "type": "int64",
                      "id": 5
                    }
                  }
                },
                "ListAdminAccountsRequest": {
                  "fields": {
                    "group": {
                      "type": "AdminAccountGroup",
                      "id": 1
                    },
                    "promoter_id": {
                      "type": "string",
                      "id": 2
                    },
                    "status": {
                      "type": "AdminAccountStatus",
                      "id": 3
                    },
                    "page_token": {
                      "type": "string",
                      "id": 4
                    },
                    "page_size": {
                      "type": "int32",
                      "id": 5
                    }
                  }
                },
                "ListAdminAccountsResponse": {
                  "fields": {
                    "accounts": {
                      "rule": "repeated",
                      "type": "AdminAccount",
                      "id": 1
                    },
                    "next_page_token": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "GetAdminAccountRequest": {
                  "fields": {
                    "admin_account_id": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "GetAdminAccountResponse": {
                  "fields": {
                    "account": {
                      "type": "AdminAccount",
                      "id": 1
                    },
                    "sessions": {
                      "rule": "repeated",
                      "type": "AdminSessionSummary",
                      "id": 2
                    }
                  }
                },
                "InviteAdminAccountRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 2
                    },
                    "email": {
                      "type": "string",
                      "id": 3
                    },
                    "role": {
                      "type": "AdminRole",
                      "id": 4
                    },
                    "display_name": {
                      "type": "string",
                      "id": 6
                    },
                    "promoter_id": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "ChangeAdminRoleRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 2
                    },
                    "admin_account_id": {
                      "type": "string",
                      "id": 3
                    },
                    "role": {
                      "type": "AdminRole",
                      "id": 4
                    },
                    "expected_version": {
                      "type": "int64",
                      "id": 5
                    },
                    "approval_id": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "ReinviteReason": {
                  "values": {
                    "REINVITE_REASON_UNSPECIFIED": 0,
                    "REINVITE_REASON_RESEND": 1,
                    "REINVITE_REASON_PROTECT_LOCK": 2,
                    "REINVITE_REASON_CREDENTIAL_LOST": 3
                  }
                },
                "ReinviteAdminAccountRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 2
                    },
                    "admin_account_id": {
                      "type": "string",
                      "id": 3
                    },
                    "reason": {
                      "type": "ReinviteReason",
                      "id": 4
                    }
                  }
                },
                "RemoveAdminAccountRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 2
                    },
                    "admin_account_id": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "SetAdminDesignationRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 2
                    },
                    "admin_account_id": {
                      "type": "string",
                      "id": 3
                    },
                    "kind": {
                      "type": "DesignationKind",
                      "id": 4
                    },
                    "basis": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "RevokeAdminDesignationRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 2
                    },
                    "admin_account_id": {
                      "type": "string",
                      "id": 3
                    },
                    "kind": {
                      "type": "DesignationKind",
                      "id": 4
                    }
                  }
                },
                "AdminAccountResult": {
                  "values": {
                    "ADMIN_ACCOUNT_RESULT_UNSPECIFIED": 0,
                    "ADMIN_ACCOUNT_RESULT_OK": 1,
                    "ADMIN_ACCOUNT_RESULT_ROLE_NOT_ALLOWED": 2,
                    "ADMIN_ACCOUNT_RESULT_SELF_TARGET": 3,
                    "ADMIN_ACCOUNT_RESULT_LAST_PARTNER_ADMIN": 4,
                    "ADMIN_ACCOUNT_RESULT_STATE_CONFLICT": 5,
                    "ADMIN_ACCOUNT_RESULT_EMAIL_IN_USE": 6,
                    "ADMIN_ACCOUNT_RESULT_ROLE_GROUP_MISMATCH": 7,
                    "ADMIN_ACCOUNT_RESULT_PROMOTER_MISMATCH": 8,
                    "ADMIN_ACCOUNT_RESULT_FIRST_PARTNER_ACCOUNT_MUST_BE_ADMIN": 9,
                    "ADMIN_ACCOUNT_RESULT_VERSION_MISMATCH": 10,
                    "ADMIN_ACCOUNT_RESULT_APPROVAL_REQUIRED": 11,
                    "ADMIN_ACCOUNT_RESULT_COMMANDER_REMOVAL_NEEDS_ROLE_CHANGE": 12,
                    "ADMIN_ACCOUNT_RESULT_DESIGNATION_TARGET_NOT_COMMANDER": 13,
                    "ADMIN_ACCOUNT_RESULT_DESIGNATION_EXISTS": 14,
                    "ADMIN_ACCOUNT_RESULT_DESIGNATION_TARGET_NOT_ELIGIBLE": 15,
                    "ADMIN_ACCOUNT_RESULT_DESIGNATION_CONFLICT": 16
                  }
                },
                "AdminAccountChangeResponse": {
                  "fields": {
                    "result": {
                      "type": "AdminAccountResult",
                      "id": 1
                    },
                    "account": {
                      "type": "AdminAccount",
                      "id": 2
                    },
                    "already_done": {
                      "type": "bool",
                      "id": 3
                    }
                  }
                },
                "InvestigationRefService": {
                  "methods": {
                    "BatchGetInvestigationRefs": {
                      "requestType": "BatchGetInvestigationRefsRequest",
                      "responseType": "BatchGetInvestigationRefsResponse"
                    }
                  }
                },
                "BatchGetInvestigationRefsRequest": {
                  "fields": {
                    "account_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "ContactRefKind": {
                  "values": {
                    "CONTACT_REF_KIND_UNSPECIFIED": 0,
                    "CONTACT_REF_KIND_PHONE": 1,
                    "CONTACT_REF_KIND_EMAIL": 2
                  }
                },
                "ContactRef": {
                  "fields": {
                    "kind": {
                      "type": "ContactRefKind",
                      "id": 1
                    },
                    "ref": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "IdentityConflict": {
                  "fields": {
                    "other_account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "attempted_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 2
                    }
                  }
                },
                "InvestigationRefs": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "contact_refs": {
                      "rule": "repeated",
                      "type": "ContactRef",
                      "id": 2
                    },
                    "device_refs": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    },
                    "identity_conflicts": {
                      "rule": "repeated",
                      "type": "IdentityConflict",
                      "id": 4
                    }
                  }
                },
                "BatchGetInvestigationRefsResponse": {
                  "fields": {
                    "items": {
                      "rule": "repeated",
                      "type": "InvestigationRefs",
                      "id": 1
                    }
                  }
                },
                "ContactRefService": {
                  "methods": {
                    "ComputeContactRef": {
                      "requestType": "ComputeContactRefRequest",
                      "responseType": "ComputeContactRefResponse"
                    }
                  }
                },
                "ComputeContactRefRequest": {
                  "fields": {
                    "phone_e164": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "ComputeContactRefResponse": {
                  "fields": {
                    "contact_ref": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "RestrictedCiHoldService": {
                  "methods": {
                    "SetRestrictedCiHold": {
                      "requestType": "SetRestrictedCiHoldRequest",
                      "responseType": "SetRestrictedCiHoldResponse"
                    }
                  }
                },
                "RestrictedCiHoldState": {
                  "values": {
                    "RESTRICTED_CI_HOLD_STATE_UNSPECIFIED": 0,
                    "RESTRICTED_CI_HOLD_STATE_CASE_OPEN": 1,
                    "RESTRICTED_CI_HOLD_STATE_RESTRICTED": 2,
                    "RESTRICTED_CI_HOLD_STATE_RELEASED": 3
                  }
                },
                "SetRestrictedCiHoldRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "fraud_case_id": {
                      "type": "string",
                      "id": 2
                    },
                    "until": {
                      "type": "google.protobuf.Timestamp",
                      "id": 3
                    },
                    "state": {
                      "type": "RestrictedCiHoldState",
                      "id": 4
                    },
                    "version": {
                      "type": "int64",
                      "id": 5
                    }
                  }
                },
                "RestrictedCiHoldResult": {
                  "values": {
                    "RESTRICTED_CI_HOLD_RESULT_UNSPECIFIED": 0,
                    "RESTRICTED_CI_HOLD_RESULT_OK": 1,
                    "RESTRICTED_CI_HOLD_RESULT_NO_VERIFICATION": 2,
                    "RESTRICTED_CI_HOLD_RESULT_STALE": 3
                  }
                },
                "SetRestrictedCiHoldResponse": {
                  "fields": {
                    "result": {
                      "type": "RestrictedCiHoldResult",
                      "id": 1
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "google": {
      "nested": {
        "protobuf": {
          "nested": {
            "Timestamp": {
              "fields": {
                "seconds": {
                  "type": "int64",
                  "id": 1
                },
                "nanos": {
                  "type": "int32",
                  "id": 2
                }
              }
            }
          }
        }
      }
    }
  }
};
