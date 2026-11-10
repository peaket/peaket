// 생성물: docs/api/proto/peaket/trust/v1/trust.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const trustV1Trust: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "trust": {
          "nested": {
            "v1": {
              "nested": {
                "TrustService": {
                  "methods": {
                    "ScoreRisk": {
                      "requestType": "ScoreRiskRequest",
                      "responseType": "ScoreRiskResponse"
                    }
                  }
                },
                "ScoreContext": {
                  "values": {
                    "SCORE_CONTEXT_UNSPECIFIED": 0,
                    "SCORE_CONTEXT_LOBBY_ENTRY": 1,
                    "SCORE_CONTEXT_PREVERIFY": 2,
                    "SCORE_CONTEXT_LOGIN": 3,
                    "SCORE_CONTEXT_VERIFICATION": 4
                  }
                },
                "LobbyShuffle": {
                  "values": {
                    "LOBBY_SHUFFLE_UNSPECIFIED": 0,
                    "LOBBY_SHUFFLE_ON": 1,
                    "LOBBY_SHUFFLE_OFF": 2
                  }
                },
                "ScoreRiskRequest": {
                  "fields": {
                    "context": {
                      "type": "ScoreContext",
                      "id": 1
                    },
                    "event_id": {
                      "type": "string",
                      "id": 2
                    },
                    "pid": {
                      "type": "string",
                      "id": 3
                    },
                    "account_id": {
                      "type": "string",
                      "id": 4
                    },
                    "human_check_token": {
                      "type": "string",
                      "id": 5
                    },
                    "device_id": {
                      "type": "string",
                      "id": 6
                    },
                    "behavior": {
                      "type": "BehaviorSummary",
                      "id": 7
                    },
                    "client": {
                      "type": "ClientSignals",
                      "id": 8
                    },
                    "first_visit_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 9
                    },
                    "session_created_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 10
                    },
                    "lobby_shuffle": {
                      "type": "LobbyShuffle",
                      "id": 11
                    },
                    "journey_id": {
                      "type": "string",
                      "id": 12
                    }
                  }
                },
                "BehaviorSummary": {
                  "fields": {
                    "v": {
                      "type": "int32",
                      "id": 1
                    },
                    "window_ms": {
                      "type": "int32",
                      "id": 2
                    },
                    "pointer_moves": {
                      "type": "int32",
                      "id": 3
                    },
                    "pointer_entropy": {
                      "type": "double",
                      "id": 4
                    },
                    "input_interval_mean_ms": {
                      "type": "double",
                      "id": 5
                    },
                    "input_interval_std_ms": {
                      "type": "double",
                      "id": 6
                    },
                    "scroll_events": {
                      "type": "int32",
                      "id": 7
                    },
                    "scroll_distance_px": {
                      "type": "int32",
                      "id": 8
                    }
                  }
                },
                "ClientSignals": {
                  "fields": {
                    "ip": {
                      "type": "string",
                      "id": 1
                    },
                    "user_agent": {
                      "type": "string",
                      "id": 2
                    },
                    "client_hints": {
                      "keyType": "string",
                      "type": "string",
                      "id": 3
                    },
                    "asn": {
                      "type": "int64",
                      "id": 4
                    }
                  }
                },
                "Verdict": {
                  "values": {
                    "VERDICT_UNSPECIFIED": 0,
                    "VERDICT_ALLOW": 1,
                    "VERDICT_CHALLENGE": 2,
                    "VERDICT_BLOCK": 3
                  }
                },
                "ReasonCategory": {
                  "values": {
                    "REASON_CATEGORY_UNSPECIFIED": 0,
                    "REASON_CATEGORY_RAPID_REQUESTS": 1,
                    "REASON_CATEGORY_DEVICE_HISTORY": 2,
                    "REASON_CATEGORY_NETWORK": 3,
                    "REASON_CATEGORY_INTERACTION": 4,
                    "REASON_CATEGORY_HUMAN_CHECK": 5,
                    "REASON_CATEGORY_SHARED_PATTERN": 6
                  }
                },
                "ScoreRiskResponse": {
                  "fields": {
                    "verdict": {
                      "type": "Verdict",
                      "id": 1
                    },
                    "reason_category": {
                      "type": "string",
                      "id": 2,
                      "options": {
                        "deprecated": true
                      }
                    },
                    "degraded": {
                      "type": "bool",
                      "id": 3
                    },
                    "reason": {
                      "type": "ReasonCategory",
                      "id": 4
                    }
                  }
                },
                "TrustLabelService": {
                  "methods": {
                    "ApplyLabel": {
                      "requestType": "ApplyLabelRequest",
                      "responseType": "ApplyLabelResponse"
                    }
                  }
                },
                "LabelSource": {
                  "values": {
                    "LABEL_SOURCE_UNSPECIFIED": 0,
                    "LABEL_SOURCE_SAMPLE_REVIEW": 1,
                    "LABEL_SOURCE_FRAUD_CONFIRMED": 2,
                    "LABEL_SOURCE_APPEAL_ACCEPTED": 3,
                    "LABEL_SOURCE_FRAUD_ACTIONED": 4,
                    "LABEL_SOURCE_FRAUD_APPEAL_ACCEPTED": 5
                  }
                },
                "Label": {
                  "values": {
                    "LABEL_UNSPECIFIED": 0,
                    "LABEL_BOT": 1,
                    "LABEL_HUMAN": 2
                  }
                },
                "ApplyLabelRequest": {
                  "fields": {
                    "source_ref": {
                      "type": "string",
                      "id": 1
                    },
                    "source_version": {
                      "type": "int64",
                      "id": 2
                    },
                    "source": {
                      "type": "LabelSource",
                      "id": 3
                    },
                    "label": {
                      "type": "Label",
                      "id": 4
                    },
                    "event_id": {
                      "type": "string",
                      "id": 5
                    },
                    "pid": {
                      "type": "string",
                      "id": 6
                    },
                    "queue_entry_id": {
                      "type": "string",
                      "id": 7
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 8
                    },
                    "device_ref": {
                      "type": "string",
                      "id": 9
                    },
                    "review_batch": {
                      "type": "ReviewBatch",
                      "id": 10
                    },
                    "applied_verdict": {
                      "type": "Verdict",
                      "id": 11
                    },
                    "verdict_event_key": {
                      "type": "string",
                      "id": 12
                    }
                  }
                },
                "ReviewBatch": {
                  "values": {
                    "REVIEW_BATCH_UNSPECIFIED": 0,
                    "REVIEW_BATCH_PASSED": 1,
                    "REVIEW_BATCH_SHADOW_CHALLENGED": 2
                  }
                },
                "BlockListChange": {
                  "values": {
                    "BLOCK_LIST_CHANGE_UNSPECIFIED": 0,
                    "BLOCK_LIST_CHANGE_NONE": 1,
                    "BLOCK_LIST_CHANGE_ADDED": 2,
                    "BLOCK_LIST_CHANGE_REMOVED": 3,
                    "BLOCK_LIST_CHANGE_DEVICE_NOT_FOUND": 4
                  }
                },
                "ApplyLabelResponse": {
                  "fields": {
                    "changed": {
                      "type": "bool",
                      "id": 1
                    },
                    "block_list": {
                      "type": "BlockListChange",
                      "id": 2
                    }
                  }
                },
                "TrustEvidenceService": {
                  "methods": {
                    "GetVerdictEvidence": {
                      "requestType": "GetVerdictEvidenceRequest",
                      "responseType": "GetVerdictEvidenceResponse"
                    }
                  }
                },
                "GetVerdictEvidenceRequest": {
                  "fields": {
                    "event_id": {
                      "type": "string",
                      "id": 1
                    },
                    "pid": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "HardSignal": {
                  "values": {
                    "HARD_SIGNAL_UNSPECIFIED": 0,
                    "HARD_SIGNAL_NONE": 1,
                    "HARD_SIGNAL_BLOCK_LIST": 2,
                    "HARD_SIGNAL_HONEYPOT": 3
                  }
                },
                "EvidenceSource": {
                  "values": {
                    "EVIDENCE_SOURCE_UNSPECIFIED": 0,
                    "EVIDENCE_SOURCE_REALTIME": 1,
                    "EVIDENCE_SOURCE_REASSESS": 2
                  }
                },
                "GetVerdictEvidenceResponse": {
                  "fields": {
                    "found": {
                      "type": "bool",
                      "id": 1
                    },
                    "reason": {
                      "type": "ReasonCategory",
                      "id": 2
                    },
                    "hard_signal": {
                      "type": "HardSignal",
                      "id": 3
                    },
                    "source": {
                      "type": "EvidenceSource",
                      "id": 4
                    },
                    "decided_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 5
                    },
                    "profile_version": {
                      "type": "int64",
                      "id": 6
                    },
                    "device_challenges_sent": {
                      "type": "int32",
                      "id": 7
                    },
                    "device_challenges_passed": {
                      "type": "int32",
                      "id": 8
                    },
                    "device_challenges_failed": {
                      "type": "int32",
                      "id": 9
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
