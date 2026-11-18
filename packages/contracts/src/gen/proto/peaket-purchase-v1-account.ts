// 생성물: docs/api/proto/peaket/purchase/v1/account.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const purchaseV1Account: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "purchase": {
          "nested": {
            "v1": {
              "nested": {
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
                    "MERGE_BLOCK_REASON_SEAT_HOLD": 1,
                    "MERGE_BLOCK_REASON_PURCHASE_SESSION": 2,
                    "MERGE_BLOCK_REASON_PAYMENT_PENDING_ORDER": 3
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
                    },
                    "absorbed_orders": {
                      "type": "int32",
                      "id": 2
                    }
                  }
                },
                "BookingRestrictionService": {
                  "methods": {
                    "SetBookingRestriction": {
                      "requestType": "SetBookingRestrictionRequest",
                      "responseType": "SetBookingRestrictionResponse"
                    }
                  }
                },
                "BookingRestrictionState": {
                  "values": {
                    "BOOKING_RESTRICTION_STATE_UNSPECIFIED": 0,
                    "BOOKING_RESTRICTION_STATE_ACTIVE": 1,
                    "BOOKING_RESTRICTION_STATE_LIFTED": 2
                  }
                },
                "SetBookingRestrictionRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "restriction_id": {
                      "type": "string",
                      "id": 2
                    },
                    "state": {
                      "type": "BookingRestrictionState",
                      "id": 3
                    },
                    "ends_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 4
                    },
                    "version": {
                      "type": "int64",
                      "id": 5
                    }
                  }
                },
                "SetBookingRestrictionResponse": {
                  "fields": {
                    "changed": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "PriorityPurchaseService": {
                  "methods": {
                    "GrantPriorityPurchase": {
                      "requestType": "GrantPriorityPurchaseRequest",
                      "responseType": "GrantPriorityPurchaseResponse"
                    },
                    "WithdrawPriorityPurchase": {
                      "requestType": "WithdrawPriorityPurchaseRequest",
                      "responseType": "WithdrawPriorityPurchaseResponse"
                    }
                  }
                },
                "WithdrawPriorityPurchaseRequest": {
                  "fields": {
                    "grant_id": {
                      "type": "string",
                      "id": 1
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "WithdrawPriorityPurchaseResponse": {
                  "fields": {
                    "grant_id": {
                      "type": "string",
                      "id": 1
                    },
                    "event_id": {
                      "type": "string",
                      "id": 2
                    },
                    "account_id": {
                      "type": "string",
                      "id": 3
                    },
                    "status": {
                      "type": "PriorityGrantState",
                      "id": 4
                    },
                    "expires_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 5
                    },
                    "version": {
                      "type": "int64",
                      "id": 6
                    }
                  }
                },
                "PriorityGrantState": {
                  "values": {
                    "PRIORITY_GRANT_STATE_UNSPECIFIED": 0,
                    "PRIORITY_GRANT_STATE_OFFERED": 1,
                    "PRIORITY_GRANT_STATE_USED": 2,
                    "PRIORITY_GRANT_STATE_EXPIRED": 3,
                    "PRIORITY_GRANT_STATE_WITHDRAWN": 4
                  }
                },
                "GrantPriorityPurchaseRequest": {
                  "fields": {
                    "fraud_case_id": {
                      "type": "string",
                      "id": 1
                    },
                    "event_id": {
                      "type": "string",
                      "id": 2
                    },
                    "account_id": {
                      "type": "string",
                      "id": 3
                    },
                    "cancelled_ticket_id": {
                      "type": "string",
                      "id": 4
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "PriorityGrantResult": {
                  "values": {
                    "PRIORITY_GRANT_RESULT_UNSPECIFIED": 0,
                    "PRIORITY_GRANT_RESULT_SAME_SEAT": 1,
                    "PRIORITY_GRANT_RESULT_SAME_TIER": 2,
                    "PRIORITY_GRANT_RESULT_NO_SEAT": 3,
                    "PRIORITY_GRANT_RESULT_ENTRY_STARTED": 4
                  }
                },
                "GrantPriorityPurchaseResponse": {
                  "fields": {
                    "result": {
                      "type": "PriorityGrantResult",
                      "id": 1
                    },
                    "grant_id": {
                      "type": "string",
                      "id": 2
                    },
                    "seat_id": {
                      "type": "string",
                      "id": 3
                    },
                    "price": {
                      "type": "int64",
                      "id": 4
                    },
                    "expires_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 5
                    },
                    "version": {
                      "type": "int64",
                      "id": 6
                    }
                  }
                },
                "WithdrawalParticipantService": {
                  "methods": {
                    "ProcessAccountWithdrawal": {
                      "requestType": "ProcessAccountWithdrawalRequest",
                      "responseType": "ProcessAccountWithdrawalResponse"
                    }
                  }
                },
                "ProcessAccountWithdrawalRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "WithdrawalParticipantState": {
                  "values": {
                    "WITHDRAWAL_PARTICIPANT_STATE_UNSPECIFIED": 0,
                    "WITHDRAWAL_PARTICIPANT_STATE_DONE": 1,
                    "WITHDRAWAL_PARTICIPANT_STATE_PENDING": 2
                  }
                },
                "WithdrawalPendingReason": {
                  "values": {
                    "WITHDRAWAL_PENDING_REASON_UNSPECIFIED": 0,
                    "WITHDRAWAL_PENDING_REASON_PAYMENT_PENDING_ORDER": 1,
                    "WITHDRAWAL_PENDING_REASON_DEPOSIT_CANCEL_PENDING": 2
                  }
                },
                "ProcessAccountWithdrawalResponse": {
                  "fields": {
                    "state": {
                      "type": "WithdrawalParticipantState",
                      "id": 1
                    },
                    "reasons": {
                      "rule": "repeated",
                      "type": "WithdrawalPendingReason",
                      "id": 2
                    },
                    "payment_pending_orders": {
                      "type": "int32",
                      "id": 3
                    },
                    "deposit_orders_cancelled": {
                      "type": "int32",
                      "id": 4
                    },
                    "deposit_orders_pending": {
                      "type": "int32",
                      "id": 5
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
