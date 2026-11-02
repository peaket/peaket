// 생성물: docs/api/proto/peaket/purchase/v1/refund.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const purchaseV1Refund: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "purchase": {
          "nested": {
            "v1": {
              "nested": {
                "EventRefundService": {
                  "methods": {
                    "PreviewEventRefund": {
                      "requestType": "PreviewEventRefundRequest",
                      "responseType": "PreviewEventRefundResponse"
                    },
                    "StartEventRefund": {
                      "requestType": "StartEventRefundRequest",
                      "responseType": "StartEventRefundResponse"
                    },
                    "GetEventRefundJob": {
                      "requestType": "GetEventRefundJobRequest",
                      "responseType": "GetEventRefundJobResponse"
                    },
                    "PauseEventRefundJob": {
                      "requestType": "PauseEventRefundJobRequest",
                      "responseType": "PauseEventRefundJobResponse"
                    },
                    "ResumeEventRefundJob": {
                      "requestType": "ResumeEventRefundJobRequest",
                      "responseType": "ResumeEventRefundJobResponse"
                    }
                  }
                },
                "CancellationRuling": {
                  "values": {
                    "CANCELLATION_RULING_UNSPECIFIED": 0,
                    "CANCELLATION_RULING_ORGANIZER": 1,
                    "CANCELLATION_RULING_FORCE_MAJEURE": 2,
                    "CANCELLATION_RULING_CONTENT_CHANGE": 3
                  }
                },
                "PreviewEventRefundRequest": {
                  "fields": {
                    "event_id": {
                      "type": "string",
                      "id": 1
                    },
                    "cancellation_request_id": {
                      "type": "string",
                      "id": 2
                    },
                    "ruling": {
                      "type": "CancellationRuling",
                      "id": 3
                    }
                  }
                },
                "PgRefundEstimate": {
                  "fields": {
                    "pg": {
                      "type": "peaket.common.v1.PgProvider",
                      "id": 1
                    },
                    "orders": {
                      "type": "int32",
                      "id": 2
                    },
                    "estimated_seconds": {
                      "type": "int32",
                      "id": 3
                    }
                  }
                },
                "PreviewEventRefundResponse": {
                  "fields": {
                    "target_orders": {
                      "type": "int32",
                      "id": 1
                    },
                    "refund_total": {
                      "type": "peaket.common.v1.Money",
                      "id": 2
                    },
                    "compensation_targets": {
                      "type": "int32",
                      "id": 3
                    },
                    "compensation_total": {
                      "type": "peaket.common.v1.Money",
                      "id": 4
                    },
                    "per_pg": {
                      "rule": "repeated",
                      "type": "PgRefundEstimate",
                      "id": 5
                    }
                  }
                },
                "StartEventRefundRequest": {
                  "fields": {
                    "event_id": {
                      "type": "string",
                      "id": 1
                    },
                    "cancellation_request_id": {
                      "type": "string",
                      "id": 2
                    },
                    "ruling": {
                      "type": "CancellationRuling",
                      "id": 3
                    },
                    "ruled_by": {
                      "type": "string",
                      "id": 4
                    },
                    "confirmed_by": {
                      "type": "string",
                      "id": 5
                    },
                    "confirmed_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 6
                    }
                  }
                },
                "StartEventRefundResponse": {
                  "fields": {
                    "job_id": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "GetEventRefundJobRequest": {
                  "fields": {
                    "job_id": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "RefundJobState": {
                  "values": {
                    "REFUND_JOB_STATE_UNSPECIFIED": 0,
                    "REFUND_JOB_STATE_RUNNING": 1,
                    "REFUND_JOB_STATE_PAUSED": 2,
                    "REFUND_JOB_STATE_COMPLETED": 3
                  }
                },
                "RefundPauseReason": {
                  "values": {
                    "REFUND_PAUSE_REASON_UNSPECIFIED": 0,
                    "REFUND_PAUSE_REASON_AUTO_FAILURE_RATE": 1,
                    "REFUND_PAUSE_REASON_AUTO_CONSECUTIVE_FAILURES": 2,
                    "REFUND_PAUSE_REASON_AUTO_CIRCUIT_OPEN": 3,
                    "REFUND_PAUSE_REASON_AUTO_REJECT_RATE": 4,
                    "REFUND_PAUSE_REASON_MANUAL": 5
                  }
                },
                "PgRefundPart": {
                  "fields": {
                    "pg": {
                      "type": "peaket.common.v1.PgProvider",
                      "id": 1
                    },
                    "state": {
                      "type": "RefundJobState",
                      "id": 2
                    },
                    "pause_reason": {
                      "type": "RefundPauseReason",
                      "id": 3
                    },
                    "done_orders": {
                      "type": "int32",
                      "id": 4
                    },
                    "failed_orders": {
                      "type": "int32",
                      "id": 5
                    },
                    "unknown_orders": {
                      "type": "int32",
                      "id": 6
                    }
                  }
                },
                "GetEventRefundJobResponse": {
                  "fields": {
                    "state": {
                      "type": "RefundJobState",
                      "id": 1
                    },
                    "total_orders": {
                      "type": "int32",
                      "id": 2
                    },
                    "done_orders": {
                      "type": "int32",
                      "id": 3
                    },
                    "failed_orders": {
                      "type": "int32",
                      "id": 4
                    },
                    "per_pg": {
                      "rule": "repeated",
                      "type": "PgRefundPart",
                      "id": 5
                    }
                  }
                },
                "PauseEventRefundJobRequest": {
                  "fields": {
                    "job_id": {
                      "type": "string",
                      "id": 1
                    },
                    "pg": {
                      "type": "peaket.common.v1.PgProvider",
                      "id": 2
                    },
                    "paused_by": {
                      "type": "string",
                      "id": 3
                    },
                    "reason": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "PauseEventRefundJobResponse": {
                  "fields": {
                    "state": {
                      "type": "RefundJobState",
                      "id": 1
                    }
                  }
                },
                "ResumeEventRefundJobRequest": {
                  "fields": {
                    "job_id": {
                      "type": "string",
                      "id": 1
                    },
                    "resumed_by": {
                      "type": "string",
                      "id": 2
                    },
                    "reason": {
                      "type": "string",
                      "id": 3
                    },
                    "pg": {
                      "type": "peaket.common.v1.PgProvider",
                      "id": 4
                    }
                  }
                },
                "ResumeEventRefundJobResponse": {
                  "fields": {
                    "state": {
                      "type": "RefundJobState",
                      "id": 1
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
