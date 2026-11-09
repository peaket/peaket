// 생성물: docs/api/proto/peaket/payment/v1/payment.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const paymentV1Payment: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "payment": {
          "nested": {
            "v1": {
              "nested": {
                "PaymentService": {
                  "methods": {
                    "PrepareCheckout": {
                      "requestType": "PrepareCheckoutRequest",
                      "responseType": "PrepareCheckoutResponse"
                    },
                    "ConfirmPayment": {
                      "requestType": "ConfirmPaymentRequest",
                      "responseType": "ConfirmPaymentResponse"
                    },
                    "BatchGetPayments": {
                      "requestType": "BatchGetPaymentsRequest",
                      "responseType": "BatchGetPaymentsResponse"
                    },
                    "GetPayment": {
                      "requestType": "GetPaymentRequest",
                      "responseType": "GetPaymentResponse"
                    },
                    "CancelPayment": {
                      "requestType": "CancelPaymentRequest",
                      "responseType": "CancelPaymentResponse"
                    },
                    "RegisterPayoutSeller": {
                      "requestType": "RegisterPayoutSellerRequest",
                      "responseType": "RegisterPayoutSellerResponse"
                    },
                    "ApprovePayoutBatch": {
                      "requestType": "ApprovePayoutBatchRequest",
                      "responseType": "ApprovePayoutBatchResponse"
                    },
                    "GetNewPaymentPause": {
                      "requestType": "GetNewPaymentPauseRequest",
                      "responseType": "GetNewPaymentPauseResponse"
                    }
                  }
                },
                "OrderKind": {
                  "values": {
                    "ORDER_KIND_UNSPECIFIED": 0,
                    "ORDER_KIND_TICKET": 1,
                    "ORDER_KIND_MERCH": 2
                  }
                },
                "PrepareCheckoutRequest": {
                  "oneofs": {
                    "_virtual_account_allowed": {
                      "oneof": [
                        "virtual_account_allowed"
                      ]
                    }
                  },
                  "fields": {
                    "order_kind": {
                      "type": "OrderKind",
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
                    "amount": {
                      "type": "peaket.common.v1.Money",
                      "id": 4
                    },
                    "pay_method": {
                      "type": "string",
                      "id": 5
                    },
                    "order_name": {
                      "type": "string",
                      "id": 6
                    },
                    "buyer": {
                      "type": "BuyerContact",
                      "id": 7
                    },
                    "attempt_id": {
                      "type": "string",
                      "id": 8
                    },
                    "customer_key": {
                      "type": "string",
                      "id": 9
                    },
                    "virtual_account_allowed": {
                      "type": "bool",
                      "id": 10,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "entry_opens_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 11
                    },
                    "pinned_pg": {
                      "type": "peaket.common.v1.PgProvider",
                      "id": 12
                    }
                  }
                },
                "BuyerContact": {
                  "fields": {
                    "email": {
                      "type": "string",
                      "id": 1
                    },
                    "phone": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "PrepareCheckoutResponse": {
                  "oneofs": {
                    "checkout": {
                      "oneof": [
                        "toss",
                        "portone",
                        "simulator"
                      ]
                    }
                  },
                  "fields": {
                    "pg": {
                      "type": "peaket.common.v1.PgProvider",
                      "id": 1
                    },
                    "switched": {
                      "type": "bool",
                      "id": 2
                    },
                    "toss": {
                      "type": "TossCheckout",
                      "id": 3
                    },
                    "portone": {
                      "type": "PortoneCheckout",
                      "id": 4
                    },
                    "simulator": {
                      "type": "TossCheckout",
                      "id": 5
                    },
                    "allowed_pay_methods": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    },
                    "deposit_due_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 7
                    }
                  }
                },
                "TossCheckout": {
                  "fields": {
                    "client_key": {
                      "type": "string",
                      "id": 1
                    },
                    "customer_key": {
                      "type": "string",
                      "id": 2
                    },
                    "order_id": {
                      "type": "string",
                      "id": 3
                    },
                    "order_name": {
                      "type": "string",
                      "id": 4
                    },
                    "amount": {
                      "type": "peaket.common.v1.Money",
                      "id": 5
                    },
                    "success_url": {
                      "type": "string",
                      "id": 6
                    },
                    "fail_url": {
                      "type": "string",
                      "id": 7
                    }
                  }
                },
                "PortoneCheckout": {
                  "fields": {
                    "store_id": {
                      "type": "string",
                      "id": 1
                    },
                    "channel_key": {
                      "type": "string",
                      "id": 2
                    },
                    "payment_id": {
                      "type": "string",
                      "id": 3
                    },
                    "order_name": {
                      "type": "string",
                      "id": 4
                    },
                    "total_amount": {
                      "type": "peaket.common.v1.Money",
                      "id": 5
                    },
                    "currency": {
                      "type": "string",
                      "id": 6
                    },
                    "redirect_url": {
                      "type": "string",
                      "id": 7
                    },
                    "customer": {
                      "type": "BuyerContact",
                      "id": 8
                    },
                    "custom_data": {
                      "type": "PortoneCustomData",
                      "id": 9
                    }
                  }
                },
                "PortoneCustomData": {
                  "fields": {
                    "order_id": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "ConfirmPaymentRequest": {
                  "oneofs": {
                    "payment_ref": {
                      "oneof": [
                        "toss",
                        "portone"
                      ]
                    },
                    "_virtual_account_allowed": {
                      "oneof": [
                        "virtual_account_allowed"
                      ]
                    }
                  },
                  "fields": {
                    "order_id": {
                      "type": "string",
                      "id": 1
                    },
                    "attempt_id": {
                      "type": "string",
                      "id": 2
                    },
                    "pg": {
                      "type": "peaket.common.v1.PgProvider",
                      "id": 3
                    },
                    "toss": {
                      "type": "TossPaymentRef",
                      "id": 4
                    },
                    "portone": {
                      "type": "PortonePaymentRef",
                      "id": 5
                    },
                    "amount": {
                      "type": "peaket.common.v1.Money",
                      "id": 6
                    },
                    "event_id": {
                      "type": "string",
                      "id": 7
                    },
                    "authenticated_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 8
                    },
                    "attempt_no": {
                      "type": "int32",
                      "id": 9
                    },
                    "entry_opens_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 10
                    },
                    "virtual_account_allowed": {
                      "type": "bool",
                      "id": 11,
                      "options": {
                        "proto3_optional": true
                      }
                    }
                  }
                },
                "TossPaymentRef": {
                  "fields": {
                    "payment_key": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "PortonePaymentRef": {
                  "fields": {
                    "payment_id": {
                      "type": "string",
                      "id": 1
                    },
                    "tx_id": {
                      "type": "string",
                      "id": 2
                    },
                    "payment_token": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ConfirmResult": {
                  "values": {
                    "CONFIRM_RESULT_UNSPECIFIED": 0,
                    "CONFIRM_RESULT_APPROVED": 1,
                    "CONFIRM_RESULT_ALREADY_APPROVED": 2,
                    "CONFIRM_RESULT_IN_PROGRESS": 3,
                    "CONFIRM_RESULT_DECLINED": 4,
                    "CONFIRM_RESULT_WAITING_FOR_DEPOSIT": 5,
                    "CONFIRM_RESULT_UNKNOWN": 6
                  }
                },
                "FailureCategory": {
                  "values": {
                    "FAILURE_CATEGORY_UNSPECIFIED": 0,
                    "FAILURE_CATEGORY_CARD_DECLINED": 1,
                    "FAILURE_CATEGORY_USER_ABORTED": 2,
                    "FAILURE_CATEGORY_VALIDATION": 3,
                    "FAILURE_CATEGORY_EXPIRED": 4,
                    "FAILURE_CATEGORY_PG_ERROR": 5,
                    "FAILURE_CATEGORY_THROTTLED": 6,
                    "FAILURE_CATEGORY_DEPOSIT_CANCELED": 7
                  }
                },
                "ConfirmPaymentResponse": {
                  "fields": {
                    "result": {
                      "type": "ConfirmResult",
                      "id": 1
                    },
                    "payment_id": {
                      "type": "string",
                      "id": 2
                    },
                    "approved_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 3
                    },
                    "failure_category": {
                      "type": "FailureCategory",
                      "id": 4
                    }
                  }
                },
                "GetPaymentRequest": {
                  "oneofs": {
                    "key": {
                      "oneof": [
                        "payment_id",
                        "order_id"
                      ]
                    }
                  },
                  "fields": {
                    "payment_id": {
                      "type": "string",
                      "id": 1
                    },
                    "order_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "PaymentStatus": {
                  "values": {
                    "PAYMENT_STATUS_UNSPECIFIED": 0,
                    "PAYMENT_STATUS_ACCEPTED": 1,
                    "PAYMENT_STATUS_AWAITING_DEPOSIT": 2,
                    "PAYMENT_STATUS_APPROVED": 3,
                    "PAYMENT_STATUS_UNKNOWN": 4,
                    "PAYMENT_STATUS_FAILED": 5,
                    "PAYMENT_STATUS_PARTIAL_CANCELED": 6,
                    "PAYMENT_STATUS_CANCELED": 7
                  }
                },
                "GetPaymentResponse": {
                  "fields": {
                    "payment_id": {
                      "type": "string",
                      "id": 1
                    },
                    "order_id": {
                      "type": "string",
                      "id": 2
                    },
                    "pg": {
                      "type": "peaket.common.v1.PgProvider",
                      "id": 3
                    },
                    "status": {
                      "type": "PaymentStatus",
                      "id": 4
                    },
                    "amount": {
                      "type": "peaket.common.v1.Money",
                      "id": 5
                    },
                    "cancelled_amount": {
                      "type": "peaket.common.v1.Money",
                      "id": 6
                    },
                    "approved_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 7
                    },
                    "virtual_account": {
                      "type": "VirtualAccountInfo",
                      "id": 8
                    }
                  }
                },
                "VirtualAccountInfo": {
                  "fields": {
                    "bank": {
                      "type": "string",
                      "id": 1
                    },
                    "account_number": {
                      "type": "string",
                      "id": 2
                    },
                    "due_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 3
                    }
                  }
                },
                "BatchGetPaymentsRequest": {
                  "fields": {
                    "order_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "BatchGetPaymentsResponse": {
                  "fields": {
                    "payments": {
                      "rule": "repeated",
                      "type": "OrderPaymentState",
                      "id": 1
                    }
                  }
                },
                "OrderPaymentState": {
                  "fields": {
                    "order_id": {
                      "type": "string",
                      "id": 1
                    },
                    "payment_id": {
                      "type": "string",
                      "id": 2
                    },
                    "pg": {
                      "type": "peaket.common.v1.PgProvider",
                      "id": 3
                    },
                    "status": {
                      "type": "PaymentStatus",
                      "id": 4
                    },
                    "amount": {
                      "type": "peaket.common.v1.Money",
                      "id": 5
                    },
                    "approved_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 6
                    },
                    "failure_category": {
                      "type": "FailureCategory",
                      "id": 7
                    },
                    "event_key": {
                      "type": "string",
                      "id": 8
                    },
                    "event_seq": {
                      "type": "int64",
                      "id": 9
                    },
                    "deposit_due_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 10
                    }
                  }
                },
                "CancelPaymentRequest": {
                  "fields": {
                    "payment_id": {
                      "type": "string",
                      "id": 1
                    },
                    "cancellation_id": {
                      "type": "string",
                      "id": 2
                    },
                    "amount": {
                      "type": "peaket.common.v1.Money",
                      "id": 3
                    },
                    "reason": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "CancelResult": {
                  "values": {
                    "CANCEL_RESULT_UNSPECIFIED": 0,
                    "CANCEL_RESULT_CANCELLED": 1,
                    "CANCEL_RESULT_CANCEL_PENDING": 2,
                    "CANCEL_RESULT_REJECTED": 3,
                    "CANCEL_RESULT_UNKNOWN": 4
                  }
                },
                "CancelPaymentResponse": {
                  "fields": {
                    "result": {
                      "type": "CancelResult",
                      "id": 1
                    },
                    "cancelled_amount": {
                      "type": "peaket.common.v1.Money",
                      "id": 2
                    },
                    "remaining_cancellable": {
                      "type": "peaket.common.v1.Money",
                      "id": 3
                    }
                  }
                },
                "BusinessType": {
                  "values": {
                    "BUSINESS_TYPE_UNSPECIFIED": 0,
                    "BUSINESS_TYPE_INDIVIDUAL": 1,
                    "BUSINESS_TYPE_CORPORATION": 2
                  }
                },
                "RegisterPayoutSellerRequest": {
                  "fields": {
                    "partner_id": {
                      "type": "string",
                      "id": 1
                    },
                    "seller_name": {
                      "type": "string",
                      "id": 2
                    },
                    "representative_name": {
                      "type": "string",
                      "id": 3
                    },
                    "business_type": {
                      "type": "BusinessType",
                      "id": 4
                    },
                    "bank_code": {
                      "type": "string",
                      "id": 5
                    },
                    "account_number": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "RegisterResult": {
                  "values": {
                    "REGISTER_RESULT_UNSPECIFIED": 0,
                    "REGISTER_RESULT_REGISTERED": 1,
                    "REGISTER_RESULT_HOLDER_MISMATCH": 2,
                    "REGISTER_RESULT_PG_ERROR": 3
                  }
                },
                "SellerStatus": {
                  "values": {
                    "SELLER_STATUS_UNSPECIFIED": 0,
                    "SELLER_STATUS_APPROVAL_REQUIRED": 1,
                    "SELLER_STATUS_PARTIALLY_APPROVED": 2,
                    "SELLER_STATUS_KYC_REQUIRED": 3,
                    "SELLER_STATUS_APPROVED": 4
                  }
                },
                "RegisterPayoutSellerResponse": {
                  "fields": {
                    "result": {
                      "type": "RegisterResult",
                      "id": 1
                    },
                    "bank_code": {
                      "type": "string",
                      "id": 2
                    },
                    "account_last4": {
                      "type": "string",
                      "id": 3
                    },
                    "toss_seller_id": {
                      "type": "string",
                      "id": 4
                    },
                    "portone_partner_id": {
                      "type": "string",
                      "id": 5
                    },
                    "seller_status": {
                      "type": "SellerStatus",
                      "id": 6
                    }
                  }
                },
                "ApprovePayoutBatchRequest": {
                  "fields": {
                    "batch_id": {
                      "type": "string",
                      "id": 1
                    },
                    "confirmed_by": {
                      "type": "string",
                      "id": 2
                    },
                    "approved_by": {
                      "type": "string",
                      "id": 3
                    },
                    "approved_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 4
                    }
                  }
                },
                "ApprovePayoutBatchResponse": {
                  "fields": {
                    "accepted": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "GetNewPaymentPauseRequest": {
                  "fields": {
                    "event_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "GetNewPaymentPauseResponse": {
                  "fields": {
                    "pauses": {
                      "rule": "repeated",
                      "type": "EventPaymentPause",
                      "id": 1
                    }
                  }
                },
                "EventPaymentPause": {
                  "fields": {
                    "event_id": {
                      "type": "string",
                      "id": 1
                    },
                    "paused_since": {
                      "type": "google.protobuf.Timestamp",
                      "id": 2
                    }
                  }
                }
              }
            }
          }
        },
        "common": {
          "nested": {
            "v1": {
              "nested": {
                "Money": {
                  "fields": {
                    "krw": {
                      "type": "int64",
                      "id": 1
                    }
                  }
                },
                "PgProvider": {
                  "values": {
                    "PG_PROVIDER_UNSPECIFIED": 0,
                    "PG_PROVIDER_TOSS": 1,
                    "PG_PROVIDER_PORTONE": 2,
                    "PG_PROVIDER_SIMULATOR": 3
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
