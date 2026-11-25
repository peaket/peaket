// 생성물: docs/api/proto/peaket/control/v1/control.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const controlV1Control: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "control": {
          "nested": {
            "v1": {
              "nested": {
                "ControlReceiver": {
                  "methods": {
                    "ApplyControl": {
                      "requestType": "ApplyControlRequest",
                      "responseType": "ApplyControlResponse"
                    },
                    "PreviewControl": {
                      "requestType": "PreviewControlRequest",
                      "responseType": "PreviewControlResponse"
                    }
                  }
                },
                "ControlKind": {
                  "values": {
                    "CONTROL_KIND_UNSPECIFIED": 0,
                    "CONTROL_KIND_ADMISSION_TARGET": 1,
                    "CONTROL_KIND_ADMISSION_PAUSE": 2,
                    "CONTROL_KIND_SALE_PAUSE": 3,
                    "CONTROL_KIND_ENTRY_DEGRADED": 4,
                    "CONTROL_KIND_LOBBY_BANNER": 5,
                    "CONTROL_KIND_AUTOMATION_STOP": 6,
                    "CONTROL_KIND_SALE_SUSPENSION": 7,
                    "CONTROL_KIND_PG_SWITCH": 8,
                    "CONTROL_KIND_ENTRY_PAUSE_RELEASE": 9
                  }
                },
                "ApplyControlRequest": {
                  "fields": {
                    "command_id": {
                      "type": "string",
                      "id": 1
                    },
                    "scope": {
                      "type": "string",
                      "id": 2
                    },
                    "kind": {
                      "type": "ControlKind",
                      "id": 3
                    },
                    "version": {
                      "type": "int64",
                      "id": 4
                    },
                    "desired_state_json": {
                      "type": "string",
                      "id": 5
                    },
                    "runbook_bundle": {
                      "type": "RunbookBundle",
                      "id": 6
                    }
                  }
                },
                "RunbookBundle": {
                  "fields": {
                    "canonical_bundle": {
                      "type": "bytes",
                      "id": 1
                    },
                    "signatures": {
                      "rule": "repeated",
                      "type": "OperatorSignature",
                      "id": 2
                    }
                  }
                },
                "OperatorSignature": {
                  "fields": {
                    "key_id": {
                      "type": "string",
                      "id": 1
                    },
                    "signature": {
                      "type": "bytes",
                      "id": 2
                    }
                  }
                },
                "ApplyControlResponse": {
                  "fields": {
                    "applied_version": {
                      "type": "int64",
                      "id": 1
                    },
                    "pod_name": {
                      "type": "string",
                      "id": 2
                    },
                    "applied_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 3
                    }
                  }
                },
                "PreviewControlRequest": {
                  "fields": {
                    "scope": {
                      "type": "string",
                      "id": 1
                    },
                    "kind": {
                      "type": "ControlKind",
                      "id": 2
                    },
                    "keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "PreviewCount": {
                  "fields": {
                    "key": {
                      "type": "string",
                      "id": 1
                    },
                    "value": {
                      "type": "double",
                      "id": 2
                    },
                    "source": {
                      "type": "string",
                      "id": 3
                    },
                    "measured_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 4
                    }
                  }
                },
                "PreviewUnavailable": {
                  "fields": {
                    "key": {
                      "type": "string",
                      "id": 1
                    },
                    "reason": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "PreviewControlResponse": {
                  "fields": {
                    "counts": {
                      "rule": "repeated",
                      "type": "PreviewCount",
                      "id": 1
                    },
                    "unavailable": {
                      "rule": "repeated",
                      "type": "PreviewUnavailable",
                      "id": 2
                    },
                    "pod_name": {
                      "type": "string",
                      "id": 3
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
