// 생성물: docs/api/proto/peaket/seatmap/v1/seatmap.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const seatmapV1Seatmap: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "seatmap": {
          "nested": {
            "v1": {
              "nested": {
                "SeatmapImportService": {
                  "methods": {
                    "ParseSeatmapImport": {
                      "requestType": "ParseSeatmapImportRequest",
                      "responseType": "ParseSeatmapImportResponse"
                    }
                  }
                },
                "SeatmapFormat": {
                  "values": {
                    "SEATMAP_FORMAT_UNSPECIFIED": 0,
                    "SEATMAP_FORMAT_SVG": 1,
                    "SEATMAP_FORMAT_JSON": 2,
                    "SEATMAP_FORMAT_CSV": 3
                  }
                },
                "ParseSeatmapImportRequest": {
                  "fields": {
                    "file": {
                      "type": "bytes",
                      "id": 1
                    },
                    "format": {
                      "type": "SeatmapFormat",
                      "id": 2
                    }
                  }
                },
                "ParseStatus": {
                  "values": {
                    "PARSE_STATUS_UNSPECIFIED": 0,
                    "PARSE_STATUS_PARSED": 1,
                    "PARSE_STATUS_REJECTED": 2
                  }
                },
                "ParseIssue": {
                  "fields": {
                    "line": {
                      "type": "int32",
                      "id": 1
                    },
                    "field": {
                      "type": "string",
                      "id": 2
                    },
                    "code": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "ParseSeatmapImportResponse": {
                  "fields": {
                    "status": {
                      "type": "ParseStatus",
                      "id": 1
                    },
                    "layout_json": {
                      "type": "bytes",
                      "id": 2
                    },
                    "errors": {
                      "rule": "repeated",
                      "type": "ParseIssue",
                      "id": 3
                    },
                    "ignored": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};
