// 생성물: docs/api/proto/peaket/queue/v1/queue.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const queueV1Queue: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "queue": {
          "nested": {
            "v1": {
              "nested": {
                "QueueService": {
                  "methods": {
                    "IsolateWaiting": {
                      "requestType": "IsolateWaitingRequest",
                      "responseType": "IsolateWaitingResponse"
                    }
                  }
                },
                "ReassessPattern": {
                  "values": {
                    "REASSESS_PATTERN_UNSPECIFIED": 0,
                    "REASSESS_PATTERN_DEVICE_SHARE": 1,
                    "REASSESS_PATTERN_BEHAVIOR_REPLAY": 2
                  }
                },
                "IsolateWaitingRequest": {
                  "fields": {
                    "event_id": {
                      "type": "string",
                      "id": 1
                    },
                    "pid": {
                      "type": "string",
                      "id": 2
                    },
                    "event_key": {
                      "type": "string",
                      "id": 3
                    },
                    "pattern": {
                      "type": "ReassessPattern",
                      "id": 4
                    }
                  }
                },
                "IsolateResult": {
                  "values": {
                    "ISOLATE_RESULT_UNSPECIFIED": 0,
                    "ISOLATE_RESULT_ISOLATED": 1,
                    "ISOLATE_RESULT_NOT_WAITING": 2,
                    "ISOLATE_RESULT_ALREADY_ISOLATED": 3,
                    "ISOLATE_RESULT_CAP_REACHED": 4
                  }
                },
                "IsolateWaitingResponse": {
                  "fields": {
                    "result": {
                      "type": "IsolateResult",
                      "id": 1
                    }
                  }
                },
                "VerificationAppealService": {
                  "methods": {
                    "GetVerificationAppeal": {
                      "requestType": "GetVerificationAppealRequest",
                      "responseType": "GetVerificationAppealResponse"
                    },
                    "ResolveVerificationAppeal": {
                      "requestType": "ResolveVerificationAppealRequest",
                      "responseType": "ResolveVerificationAppealResponse"
                    }
                  }
                },
                "GetVerificationAppealRequest": {
                  "fields": {
                    "appeal_id": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "GetVerificationAppealResponse": {
                  "fields": {
                    "appeal_id": {
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
                    "pid": {
                      "type": "string",
                      "id": 4
                    },
                    "text": {
                      "type": "string",
                      "id": 5
                    },
                    "reason_category": {
                      "type": "string",
                      "id": 6
                    },
                    "received_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 7
                    },
                    "entry_state": {
                      "type": "AppealEntryState",
                      "id": 8
                    }
                  }
                },
                "AppealEntryState": {
                  "values": {
                    "APPEAL_ENTRY_STATE_UNSPECIFIED": 0,
                    "APPEAL_ENTRY_STATE_VERIFYING": 1,
                    "APPEAL_ENTRY_STATE_PASSED": 2,
                    "APPEAL_ENTRY_STATE_ENDED": 3
                  }
                },
                "AppealOutcome": {
                  "values": {
                    "APPEAL_OUTCOME_UNSPECIFIED": 0,
                    "APPEAL_OUTCOME_ACCEPTED": 1,
                    "APPEAL_OUTCOME_REJECTED": 2
                  }
                },
                "ResolveVerificationAppealRequest": {
                  "fields": {
                    "appeal_id": {
                      "type": "string",
                      "id": 1
                    },
                    "case_id": {
                      "type": "string",
                      "id": 2
                    },
                    "case_version": {
                      "type": "int64",
                      "id": 3
                    },
                    "outcome": {
                      "type": "AppealOutcome",
                      "id": 4
                    }
                  }
                },
                "ResolveAppealResult": {
                  "values": {
                    "RESOLVE_APPEAL_RESULT_UNSPECIFIED": 0,
                    "RESOLVE_APPEAL_RESULT_APPLIED": 1,
                    "RESOLVE_APPEAL_RESULT_UNCHANGED": 2,
                    "RESOLVE_APPEAL_RESULT_NOT_ISOLATED": 3
                  }
                },
                "ResolveVerificationAppealResponse": {
                  "fields": {
                    "result": {
                      "type": "ResolveAppealResult",
                      "id": 1
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
                "PriorityGrantService": {
                  "methods": {
                    "SetPriorityGrant": {
                      "requestType": "SetPriorityGrantRequest",
                      "responseType": "SetPriorityGrantResponse"
                    }
                  }
                },
                "PriorityGrantState": {
                  "values": {
                    "PRIORITY_GRANT_STATE_UNSPECIFIED": 0,
                    "PRIORITY_GRANT_STATE_OFFERED": 1,
                    "PRIORITY_GRANT_STATE_WITHDRAWN": 2
                  }
                },
                "SetPriorityGrantRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "event_id": {
                      "type": "string",
                      "id": 2
                    },
                    "grant_id": {
                      "type": "string",
                      "id": 3
                    },
                    "state": {
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
                "SetPriorityGrantResponse": {
                  "fields": {
                    "changed": {
                      "type": "bool",
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
