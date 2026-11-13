// 생성물: docs/api/proto/peaket/ticket/v1/ticket.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const ticketV1Ticket: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "ticket": {
          "nested": {
            "v1": {
              "nested": {
                "TicketService": {
                  "methods": {
                    "IssueTickets": {
                      "requestType": "IssueTicketsRequest",
                      "responseType": "IssueTicketsResponse"
                    },
                    "VoidTickets": {
                      "requestType": "VoidTicketsRequest",
                      "responseType": "VoidTicketsResponse"
                    },
                    "CancelTickets": {
                      "requestType": "CancelTicketsRequest",
                      "responseType": "CancelTicketsResponse"
                    },
                    "OperatorCancelTickets": {
                      "requestType": "OperatorCancelTicketsRequest",
                      "responseType": "OperatorCancelTicketsResponse"
                    },
                    "CheckReviewEligibility": {
                      "requestType": "CheckReviewEligibilityRequest",
                      "responseType": "CheckReviewEligibilityResponse"
                    },
                    "ListHeldTickets": {
                      "requestType": "ListHeldTicketsRequest",
                      "responseType": "ListHeldTicketsResponse"
                    },
                    "ListTickets": {
                      "requestType": "ListTicketsRequest",
                      "responseType": "ListTicketsResponse"
                    }
                  }
                },
                "IssueTicketsRequest": {
                  "fields": {
                    "order_id": {
                      "type": "string",
                      "id": 1
                    },
                    "event_id": {
                      "type": "string",
                      "id": 2
                    },
                    "payer_account_id": {
                      "type": "string",
                      "id": 3
                    },
                    "seat_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "issue_generation": {
                      "type": "int64",
                      "id": 5
                    },
                    "event_starts_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 6
                    }
                  }
                },
                "VoidTicketsRequest": {
                  "fields": {
                    "order_id": {
                      "type": "string",
                      "id": 1
                    },
                    "event_id": {
                      "type": "string",
                      "id": 2
                    },
                    "issue_generation": {
                      "type": "int64",
                      "id": 3
                    }
                  }
                },
                "VoidTicketsResponse": {
                  "fields": {
                    "voided": {
                      "type": "int32",
                      "id": 1
                    },
                    "already_entered": {
                      "type": "int32",
                      "id": 2
                    }
                  }
                },
                "TicketStatus": {
                  "values": {
                    "TICKET_STATUS_UNSPECIFIED": 0,
                    "TICKET_STATUS_ISSUED": 1,
                    "TICKET_STATUS_ACTIVE": 2,
                    "TICKET_STATUS_TRANSFER_PENDING": 3,
                    "TICKET_STATUS_CANCEL_REQUESTED": 4,
                    "TICKET_STATUS_REFUNDED": 5,
                    "TICKET_STATUS_VOIDED": 6
                  }
                },
                "IssuedTicket": {
                  "fields": {
                    "ticket_id": {
                      "type": "string",
                      "id": 1
                    },
                    "seat_id": {
                      "type": "string",
                      "id": 2
                    },
                    "status": {
                      "type": "TicketStatus",
                      "id": 3
                    },
                    "order_id": {
                      "type": "string",
                      "id": 4
                    },
                    "event_id": {
                      "type": "string",
                      "id": 5
                    },
                    "qr_payload": {
                      "type": "string",
                      "id": 6
                    },
                    "ticket_key": {
                      "type": "string",
                      "id": 7
                    }
                  }
                },
                "IssueTicketsResponse": {
                  "fields": {
                    "tickets": {
                      "rule": "repeated",
                      "type": "IssuedTicket",
                      "id": 1
                    }
                  }
                },
                "CancelTicketsRequest": {
                  "fields": {
                    "order_id": {
                      "type": "string",
                      "id": 1
                    },
                    "ticket_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    },
                    "requested_by_account_id": {
                      "type": "string",
                      "id": 3
                    },
                    "cancellation_id": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "CancelTicketResult": {
                  "values": {
                    "CANCEL_TICKET_RESULT_UNSPECIFIED": 0,
                    "CANCEL_TICKET_RESULT_REFUND_NOW": 1,
                    "CANCEL_TICKET_RESULT_REFUND_AFTER_CLOSE": 2,
                    "CANCEL_TICKET_RESULT_NOT_PAYER_HOLDER": 3,
                    "CANCEL_TICKET_RESULT_TRANSFER_PENDING": 4,
                    "CANCEL_TICKET_RESULT_EVENT_STARTED": 5,
                    "CANCEL_TICKET_RESULT_ALREADY_CANCELLED": 6
                  }
                },
                "CancelTicketOutcome": {
                  "fields": {
                    "ticket_id": {
                      "type": "string",
                      "id": 1
                    },
                    "result": {
                      "type": "CancelTicketResult",
                      "id": 2
                    }
                  }
                },
                "CancelTicketsResponse": {
                  "fields": {
                    "outcomes": {
                      "rule": "repeated",
                      "type": "CancelTicketOutcome",
                      "id": 1
                    }
                  }
                },
                "OperatorCancelTarget": {
                  "fields": {
                    "ticket_id": {
                      "type": "string",
                      "id": 1
                    },
                    "expected_holder_account_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "OperatorCancelTicketsRequest": {
                  "fields": {
                    "approval_id": {
                      "type": "string",
                      "id": 1
                    },
                    "fraud_case_id": {
                      "type": "string",
                      "id": 2
                    },
                    "event_id": {
                      "type": "string",
                      "id": 3
                    },
                    "targets": {
                      "rule": "repeated",
                      "type": "OperatorCancelTarget",
                      "id": 4
                    }
                  }
                },
                "OperatorCancelResult": {
                  "values": {
                    "OPERATOR_CANCEL_RESULT_UNSPECIFIED": 0,
                    "OPERATOR_CANCEL_RESULT_CANCELED": 1,
                    "OPERATOR_CANCEL_RESULT_SKIPPED_ALREADY_ENDED": 2,
                    "OPERATOR_CANCEL_RESULT_SKIPPED_ENTRY_RECORDED": 3,
                    "OPERATOR_CANCEL_RESULT_SKIPPED_HOLDER_CHANGED": 4
                  }
                },
                "OperatorCancelOutcome": {
                  "fields": {
                    "ticket_id": {
                      "type": "string",
                      "id": 1
                    },
                    "result": {
                      "type": "OperatorCancelResult",
                      "id": 2
                    },
                    "order_id": {
                      "type": "string",
                      "id": 3
                    },
                    "withdrawn_transfer_offer_id": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "OperatorCancelTicketsResponse": {
                  "fields": {
                    "outcomes": {
                      "rule": "repeated",
                      "type": "OperatorCancelOutcome",
                      "id": 1
                    }
                  }
                },
                "CheckReviewEligibilityRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "event_id": {
                      "type": "string",
                      "id": 2
                    },
                    "event_ends_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 3
                    }
                  }
                },
                "ReviewIneligibleReason": {
                  "values": {
                    "REVIEW_INELIGIBLE_REASON_UNSPECIFIED": 0,
                    "REVIEW_INELIGIBLE_REASON_NOT_ENDED": 1,
                    "REVIEW_INELIGIBLE_REASON_NOT_PAYER": 2,
                    "REVIEW_INELIGIBLE_REASON_NO_VALID_TICKET": 3,
                    "REVIEW_INELIGIBLE_REASON_EVENT_CANCELLED": 4
                  }
                },
                "CheckReviewEligibilityResponse": {
                  "fields": {
                    "eligible": {
                      "type": "bool",
                      "id": 1
                    },
                    "basis_order_id": {
                      "type": "string",
                      "id": 2
                    },
                    "reason": {
                      "type": "ReviewIneligibleReason",
                      "id": 3
                    }
                  }
                },
                "ListHeldTicketsRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "event_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "HeldTicket": {
                  "fields": {
                    "ticket_id": {
                      "type": "string",
                      "id": 1
                    },
                    "status": {
                      "type": "TicketStatus",
                      "id": 2
                    }
                  }
                },
                "ListHeldTicketsResponse": {
                  "fields": {
                    "tickets": {
                      "rule": "repeated",
                      "type": "HeldTicket",
                      "id": 1
                    }
                  }
                },
                "ListTicketsRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "cursor": {
                      "type": "string",
                      "id": 2
                    },
                    "limit": {
                      "type": "int32",
                      "id": 3
                    }
                  }
                },
                "WalletTicket": {
                  "fields": {
                    "ticket_id": {
                      "type": "string",
                      "id": 1
                    },
                    "order_id": {
                      "type": "string",
                      "id": 2
                    },
                    "event_id": {
                      "type": "string",
                      "id": 3
                    },
                    "seat_id": {
                      "type": "string",
                      "id": 4
                    },
                    "status": {
                      "type": "TicketStatus",
                      "id": 5
                    },
                    "issued_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 6
                    },
                    "qr_payload": {
                      "type": "string",
                      "id": 7
                    }
                  }
                },
                "ListTicketsResponse": {
                  "fields": {
                    "tickets": {
                      "rule": "repeated",
                      "type": "WalletTicket",
                      "id": 1
                    },
                    "next_cursor": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ScannerDeviceService": {
                  "methods": {
                    "ListScannerDevices": {
                      "requestType": "ListScannerDevicesRequest",
                      "responseType": "ListScannerDevicesResponse"
                    },
                    "RegisterScannerDevice": {
                      "requestType": "RegisterScannerDeviceRequest",
                      "responseType": "RegisterScannerDeviceResponse"
                    },
                    "RevokeScannerDevice": {
                      "requestType": "RevokeScannerDeviceRequest",
                      "responseType": "RevokeScannerDeviceResponse"
                    },
                    "ReissueEnrollmentCode": {
                      "requestType": "ReissueEnrollmentCodeRequest",
                      "responseType": "ReissueEnrollmentCodeResponse"
                    }
                  }
                },
                "ScannerDeviceStatus": {
                  "values": {
                    "SCANNER_DEVICE_STATUS_UNSPECIFIED": 0,
                    "SCANNER_DEVICE_STATUS_ACTIVE": 1,
                    "SCANNER_DEVICE_STATUS_REVOKED": 2,
                    "SCANNER_DEVICE_STATUS_RETIRED": 3
                  }
                },
                "ScannerCredentialType": {
                  "values": {
                    "SCANNER_CREDENTIAL_TYPE_UNSPECIFIED": 0,
                    "SCANNER_CREDENTIAL_TYPE_DEVICE_KEY": 1,
                    "SCANNER_CREDENTIAL_TYPE_MTLS_CERT": 2
                  }
                },
                "ScannerDevice": {
                  "fields": {
                    "device_id": {
                      "type": "string",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "promoter_id": {
                      "type": "string",
                      "id": 3
                    },
                    "status": {
                      "type": "ScannerDeviceStatus",
                      "id": 4
                    },
                    "credential_type": {
                      "type": "ScannerCredentialType",
                      "id": 5
                    },
                    "cert_expires_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 6
                    },
                    "last_seen_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 7
                    }
                  }
                },
                "ListScannerDevicesRequest": {
                  "fields": {
                    "cursor": {
                      "type": "string",
                      "id": 1
                    },
                    "limit": {
                      "type": "int32",
                      "id": 2
                    }
                  }
                },
                "ListScannerDevicesResponse": {
                  "fields": {
                    "devices": {
                      "rule": "repeated",
                      "type": "ScannerDevice",
                      "id": 1
                    },
                    "next_cursor": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "RegisterScannerDeviceRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "promoter_id": {
                      "type": "string",
                      "id": 3
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "EnrollmentCode": {
                  "fields": {
                    "code": {
                      "type": "string",
                      "id": 1
                    },
                    "expires_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 2
                    }
                  }
                },
                "RegisterScannerDeviceResponse": {
                  "fields": {
                    "device": {
                      "type": "ScannerDevice",
                      "id": 1
                    },
                    "enrollment_code": {
                      "type": "EnrollmentCode",
                      "id": 2
                    },
                    "already_done": {
                      "type": "bool",
                      "id": 3
                    }
                  }
                },
                "RevokeScannerDeviceRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "device_id": {
                      "type": "string",
                      "id": 2
                    },
                    "reason": {
                      "type": "string",
                      "id": 3
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "RevokeScannerDeviceResponse": {
                  "fields": {
                    "device": {
                      "type": "ScannerDevice",
                      "id": 1
                    }
                  }
                },
                "ReissueEnrollmentCodeRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "device_id": {
                      "type": "string",
                      "id": 2
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ReissueEnrollmentCodeResponse": {
                  "fields": {
                    "enrollment_code": {
                      "type": "EnrollmentCode",
                      "id": 1
                    },
                    "already_done": {
                      "type": "bool",
                      "id": 2
                    }
                  }
                },
                "AccountMergeCheckService": {
                  "methods": {
                    "CheckAccountMerge": {
                      "requestType": "CheckAccountMergeRequest",
                      "responseType": "CheckAccountMergeResponse"
                    }
                  }
                },
                "CheckAccountMergeRequest": {
                  "fields": {
                    "primary_account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "absorbed_account_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "MergeBlockReason": {
                  "values": {
                    "MERGE_BLOCK_REASON_UNSPECIFIED": 0,
                    "MERGE_BLOCK_REASON_ABSORBED_HAS_TICKETS": 1,
                    "MERGE_BLOCK_REASON_TICKET_IN_ENTRY_WINDOW": 2
                  }
                },
                "MergeBlock": {
                  "fields": {
                    "reason": {
                      "type": "MergeBlockReason",
                      "id": 1
                    },
                    "account_id": {
                      "type": "string",
                      "id": 2
                    },
                    "ref_id": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "CheckAccountMergeResponse": {
                  "fields": {
                    "blocks": {
                      "rule": "repeated",
                      "type": "MergeBlock",
                      "id": 1
                    }
                  }
                },
                "TicketReclaimService": {
                  "methods": {
                    "ReclaimTicket": {
                      "requestType": "ReclaimTicketRequest",
                      "responseType": "ReclaimTicketResponse"
                    }
                  }
                },
                "ReclaimTicketRequest": {
                  "fields": {
                    "approval_id": {
                      "type": "string",
                      "id": 1
                    },
                    "ticket_id": {
                      "type": "string",
                      "id": 2
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ReclaimResult": {
                  "values": {
                    "RECLAIM_RESULT_UNSPECIFIED": 0,
                    "RECLAIM_RESULT_RECLAIMED": 1,
                    "RECLAIM_RESULT_ENTRY_STARTED": 2,
                    "RECLAIM_RESULT_NOT_RECLAIMABLE": 3
                  }
                },
                "ReclaimTicketResponse": {
                  "fields": {
                    "result": {
                      "type": "ReclaimResult",
                      "id": 1
                    }
                  }
                },
                "ScannerDeviceLookupService": {
                  "methods": {
                    "GetScannerDeviceByCredential": {
                      "requestType": "GetScannerDeviceByCredentialRequest",
                      "responseType": "GetScannerDeviceByCredentialResponse"
                    }
                  }
                },
                "GetScannerDeviceByCredentialRequest": {
                  "fields": {
                    "credential_type": {
                      "type": "ScannerCredentialType",
                      "id": 1
                    },
                    "credential_thumbprint": {
                      "type": "bytes",
                      "id": 2
                    }
                  }
                },
                "GetScannerDeviceByCredentialResponse": {
                  "fields": {
                    "found": {
                      "type": "bool",
                      "id": 1
                    },
                    "device_id": {
                      "type": "string",
                      "id": 2
                    },
                    "status": {
                      "type": "ScannerDeviceStatus",
                      "id": 3
                    },
                    "name": {
                      "type": "string",
                      "id": 4
                    },
                    "promoter_id": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "TransferLockService": {
                  "methods": {
                    "SetTransferLock": {
                      "requestType": "SetTransferLockRequest",
                      "responseType": "SetTransferLockResponse"
                    }
                  }
                },
                "SetTransferLockRequest": {
                  "fields": {
                    "case_id": {
                      "type": "string",
                      "id": 1
                    },
                    "version": {
                      "type": "int64",
                      "id": 2
                    },
                    "ticket_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "locked": {
                      "type": "bool",
                      "id": 4
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 5
                    },
                    "event_id": {
                      "type": "string",
                      "id": 6
                    },
                    "account_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 7
                    },
                    "expires_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 8
                    }
                  }
                },
                "TransferLockResult": {
                  "values": {
                    "TRANSFER_LOCK_RESULT_UNSPECIFIED": 0,
                    "TRANSFER_LOCK_RESULT_LOCKED": 1,
                    "TRANSFER_LOCK_RESULT_UNLOCKED": 2,
                    "TRANSFER_LOCK_RESULT_OTHER_CASE": 3,
                    "TRANSFER_LOCK_RESULT_ENTRY_STARTED": 4,
                    "TRANSFER_LOCK_RESULT_TICKET_CLOSED": 5
                  }
                },
                "TransferLockOutcome": {
                  "fields": {
                    "ticket_id": {
                      "type": "string",
                      "id": 1
                    },
                    "result": {
                      "type": "TransferLockResult",
                      "id": 2
                    },
                    "withdrawn_offer_id": {
                      "type": "string",
                      "id": 3
                    },
                    "holder_account_id": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "SetTransferLockResponse": {
                  "fields": {
                    "outcomes": {
                      "rule": "repeated",
                      "type": "TransferLockOutcome",
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
