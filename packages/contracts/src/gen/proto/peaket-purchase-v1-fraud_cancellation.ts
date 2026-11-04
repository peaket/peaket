// 생성물: docs/api/proto/peaket/purchase/v1/fraud_cancellation.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const purchaseV1Fraudcancellation: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "purchase": {
          "nested": {
            "v1": {
              "nested": {
                "FraudCancellationService": {
                  "methods": {
                    "CancelFraudTickets": {
                      "requestType": "CancelFraudTicketsRequest",
                      "responseType": "CancelFraudTicketsResponse"
                    },
                    "GetFraudCancellation": {
                      "requestType": "GetFraudCancellationRequest",
                      "responseType": "GetFraudCancellationResponse"
                    }
                  }
                },
                "FraudCancelTarget": {
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
                "CancelFraudTicketsRequest": {
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
                      "type": "FraudCancelTarget",
                      "id": 4
                    },
                    "requested_by": {
                      "type": "string",
                      "id": 5
                    },
                    "approved_by": {
                      "type": "string",
                      "id": 6
                    },
                    "approved_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 7
                    }
                  }
                },
                "FraudCancellationOutcome": {
                  "values": {
                    "FRAUD_CANCELLATION_OUTCOME_UNSPECIFIED": 0,
                    "FRAUD_CANCELLATION_OUTCOME_ACCEPTED": 1,
                    "FRAUD_CANCELLATION_OUTCOME_SKIPPED_ALREADY_ENDED": 2,
                    "FRAUD_CANCELLATION_OUTCOME_SKIPPED_ENTRY_STARTED": 3,
                    "FRAUD_CANCELLATION_OUTCOME_SKIPPED_HOLDER_CHANGED": 4,
                    "FRAUD_CANCELLATION_OUTCOME_FAILED": 5
                  }
                },
                "FraudTicketResult": {
                  "fields": {
                    "ticket_id": {
                      "type": "string",
                      "id": 1
                    },
                    "outcome": {
                      "type": "FraudCancellationOutcome",
                      "id": 2
                    },
                    "cancellation_id": {
                      "type": "string",
                      "id": 3
                    },
                    "refund_amount": {
                      "type": "peaket.common.v1.Money",
                      "id": 4
                    },
                    "withdrawn_transfer_offer_id": {
                      "type": "string",
                      "id": 5
                    },
                    "failure_code": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "CancelFraudTicketsResponse": {
                  "fields": {
                    "results": {
                      "rule": "repeated",
                      "type": "FraudTicketResult",
                      "id": 1
                    }
                  }
                },
                "GetFraudCancellationRequest": {
                  "fields": {
                    "approval_id": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "FraudRefundState": {
                  "values": {
                    "FRAUD_REFUND_STATE_UNSPECIFIED": 0,
                    "FRAUD_REFUND_STATE_PENDING": 1,
                    "FRAUD_REFUND_STATE_REFUNDED": 2,
                    "FRAUD_REFUND_STATE_NEEDS_CS": 3
                  }
                },
                "FraudRefundProgress": {
                  "fields": {
                    "ticket_id": {
                      "type": "string",
                      "id": 1
                    },
                    "cancellation_id": {
                      "type": "string",
                      "id": 2
                    },
                    "state": {
                      "type": "FraudRefundState",
                      "id": 3
                    },
                    "refunded_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 4
                    }
                  }
                },
                "GetFraudCancellationResponse": {
                  "fields": {
                    "results": {
                      "rule": "repeated",
                      "type": "FraudTicketResult",
                      "id": 1
                    },
                    "refunds": {
                      "rule": "repeated",
                      "type": "FraudRefundProgress",
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
