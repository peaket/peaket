// 생성물: docs/api/proto/peaket/image/v1/image.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const imageV1Image: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "image": {
          "nested": {
            "v1": {
              "nested": {
                "ImageService": {
                  "methods": {
                    "ProcessImage": {
                      "requestType": "ProcessImageRequest",
                      "responseType": "ProcessImageResponse"
                    }
                  }
                },
                "ImageKind": {
                  "values": {
                    "IMAGE_KIND_UNSPECIFIED": 0,
                    "IMAGE_KIND_PRODUCTION": 1,
                    "IMAGE_KIND_HOME_BANNER": 2,
                    "IMAGE_KIND_REVIEW_PHOTO": 3
                  }
                },
                "ProcessImageRequest": {
                  "fields": {
                    "source_key": {
                      "type": "string",
                      "id": 1
                    },
                    "kind": {
                      "type": "ImageKind",
                      "id": 2
                    }
                  }
                },
                "ImageStatus": {
                  "values": {
                    "IMAGE_STATUS_UNSPECIFIED": 0,
                    "IMAGE_STATUS_ACCEPTED": 1,
                    "IMAGE_STATUS_REJECTED": 2,
                    "IMAGE_STATUS_SCAN_PENDING": 3
                  }
                },
                "ImageRejectReason": {
                  "values": {
                    "IMAGE_REJECT_REASON_UNSPECIFIED": 0,
                    "IMAGE_REJECT_REASON_UNSUPPORTED_TYPE": 1,
                    "IMAGE_REJECT_REASON_TOO_LARGE": 2,
                    "IMAGE_REJECT_REASON_TOO_SMALL": 3,
                    "IMAGE_REJECT_REASON_MALWARE": 4
                  }
                },
                "ProcessImageResponse": {
                  "fields": {
                    "status": {
                      "type": "ImageStatus",
                      "id": 1
                    },
                    "derivative_keys": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 2
                    },
                    "width": {
                      "type": "int32",
                      "id": 3
                    },
                    "height": {
                      "type": "int32",
                      "id": 4
                    },
                    "reject_reason": {
                      "type": "ImageRejectReason",
                      "id": 5
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
