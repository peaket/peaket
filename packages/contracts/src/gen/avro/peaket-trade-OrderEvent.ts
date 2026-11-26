// 생성물: docs/api/avro/peaket/trade/OrderEvent.avsc(scripts/avro-schemas.mjs). 손으로 고치지 않는다.
export const tradeOrderEvent: Readonly<Record<string, unknown>> = {
  "type": "record",
  "name": "OrderEvent",
  "namespace": "peaket.trade",
  "doc": "주문 사건(생성·접수·확정·실패·환불 등). 토픽 trade.orders, 키 eventId(회차). purchase-svc Outbox에서 나간다.",
  "fields": [
    {
      "name": "eventId",
      "doc": "회차 ID",
      "type": "string"
    },
    {
      "name": "orderId",
      "type": "string"
    },
    {
      "name": "accountId",
      "type": "string"
    },
    {
      "name": "type",
      "doc": "EVENT_CANCELLATION_CONFIRMED·COMPENSATION_PAID는 회차 취소 확정과 배상 지급(ADR-0046). AWAITING_DEPOSIT은 가상계좌 발급(입금 대기), DEPOSIT_REVERSED는 입금 오류로 결제사가 입금을 되돌려 확정된 주문이 입금 대기로 돌아감(docs/planning/03 §2.4, 추천 적용 2026-10-14, ADR-0062). EXPIRED는 결제를 접수하지 않고 끝난 주문(ADR-0107), ISSUE_DELAYED는 승인 뒤 발권이 60초 [가정] 넘게 끝나지 않아 다시 발권하는 중인 주문(ADR-0106). 두 기호는 2026-10-28에 끝에 더했고 소비자를 먼저 배포한다",
      "type": {
        "type": "enum",
        "name": "OrderEventType",
        "default": "UNRECOGNIZED",
        "symbols": [
          "UNRECOGNIZED",
          "CREATED",
          "ACCEPTED",
          "RESERVED",
          "AWAITING_DEPOSIT",
          "APPROVED",
          "CONFIRMED",
          "DEPOSIT_REVERSED",
          "FAILED",
          "COMPENSATED",
          "PARTIALLY_REFUNDED",
          "REFUNDED",
          "EVENT_CANCELLATION_CONFIRMED",
          "COMPENSATION_PAID",
          "EXPIRED",
          "ISSUE_DELAYED",
          "EVENT_POSTPONED",
          "REFUND_FAILED",
          "REFUND_ACCOUNT_REQUESTED",
          "COMPENSATION_ACCOUNT_REQUESTED"
        ]
      }
    },
    {
      "name": "amount",
      "doc": "주문 금액(원). 서버가 계산한 purchase_order.amount이고 사건 종류와 상관없이 같은 값이다. 환급액은 이 칸이 아니다(ADR-0150)",
      "type": "long"
    },
    {
      "name": "refundAmount",
      "doc": "그 환급에서 돌려준 금액(원). 고객 취소로 끝난 주문은 그 전이를 일으킨 취소의 환급액, 회차 취소·연기는 그 표의 환급액이다. REFUNDED와 계좌 입력 요청 두 사건에만 싣는다(2026-11-15 R-583, F-07-15)",
      "type": [
        "null",
        "long"
      ],
      "default": null,
      "x-present-when": [
        {
          "type": [
            "REFUNDED",
            "REFUND_ACCOUNT_REQUESTED",
            "COMPENSATION_ACCOUNT_REQUESTED"
          ]
        }
      ]
    },
    {
      "name": "fanNoticeReason",
      "doc": "팬 통지 문안에 쓸 사유 요약. 판정자가 쓴 글이거나 실패 사유 코드다. EVENT_CANCELLATION_CONFIRMED·EVENT_POSTPONED·REFUND_FAILED에만 싣는다(2026-11-15 R-583, avsc는 2026-11-23 F-04-2)",
      "type": [
        "null",
        "string"
      ],
      "default": null,
      "x-present-when": [
        {
          "type": [
            "EVENT_CANCELLATION_CONFIRMED",
            "EVENT_POSTPONED",
            "REFUND_FAILED"
          ]
        }
      ]
    },
    {
      "name": "cancellationId",
      "doc": "환불 계좌 입력을 요청한 취소 ID. REFUND_ACCOUNT_REQUESTED에만 싣는다(F-07-15, notify §9)",
      "type": [
        "null",
        "string"
      ],
      "default": null,
      "x-present-when": [
        {
          "type": [
            "REFUND_ACCOUNT_REQUESTED"
          ]
        }
      ]
    },
    {
      "name": "compensationId",
      "doc": "배상 계좌 입력을 요청한 배상 ID. COMPENSATION_ACCOUNT_REQUESTED에만 싣는다(F-07-15, notify §9)",
      "type": [
        "null",
        "string"
      ],
      "default": null,
      "x-present-when": [
        {
          "type": [
            "COMPENSATION_ACCOUNT_REQUESTED"
          ]
        }
      ]
    },
    {
      "name": "postponedTo",
      "doc": "연기된 회차의 새 시작 시각. EVENT_POSTPONED에만 싣는다(2026-11-15 R-583, avsc는 2026-11-23 F-04-2)",
      "type": [
        "null",
        {
          "type": "long",
          "logicalType": "timestamp-millis"
        }
      ],
      "default": null,
      "x-present-when": [
        {
          "type": [
            "EVENT_POSTPONED"
          ]
        }
      ]
    },
    {
      "name": "refundWindowClosesAt",
      "doc": "연기 회차의 환급 신청 창 닫힘. EVENT_POSTPONED에만 싣는다(2026-11-15 R-583, avsc는 2026-11-23 F-04-2)",
      "type": [
        "null",
        {
          "type": "long",
          "logicalType": "timestamp-millis"
        }
      ],
      "default": null,
      "x-present-when": [
        {
          "type": [
            "EVENT_POSTPONED"
          ]
        }
      ]
    },
    {
      "name": "seatIds",
      "type": {
        "type": "array",
        "items": "string"
      }
    },
    {
      "name": "purchaseSessionId",
      "doc": "구매 세션 ID(분석 연결 키, ADR-0052). CREATED에만 싣는다. 주문 표에 저장하지 않는 값이라 뒤의 사건은 주문 ID로 잇는다(ADR-0150)",
      "type": [
        "null",
        "string"
      ],
      "default": null,
      "x-present-when": [
        {
          "type": [
            "CREATED"
          ]
        }
      ]
    },
    {
      "name": "journeyId",
      "doc": "구매 세션의 여정 ID(조사용 추적 ID, UUIDv7). CREATED에만 싣고 뒤의 사건은 주문 ID로 잇는다. 분석 적재는 버린다(ADR-0171, 추천 적용 2026-10-31)",
      "type": [
        "null",
        {
          "type": "string",
          "logicalType": "uuid"
        }
      ],
      "default": null,
      "x-present-when": [
        {
          "type": [
            "CREATED"
          ]
        }
      ]
    },
    {
      "name": "contactRef",
      "doc": "예매자 휴대폰 번호(E.164)의 조사용 가명 invRef(contact, 번호)(키 판 접두어 포함, docs/security/secrets-and-keys.md). CREATED에만, 계산하지 못하면 비우고 refMissing이 true다. 분석 적재는 버린다(ADR-0171 결정 4, 추천 적용 2026-10-31)",
      "type": [
        "null",
        "string"
      ],
      "default": null,
      "x-present-when": [
        {
          "type": [
            "CREATED"
          ],
          "refMissing": [
            false
          ]
        }
      ]
    },
    {
      "name": "refMissing",
      "doc": "조사용 가명 칸을 계산하지 못해 비웠으면 true(조사용 가명 라벨 키를 KMS에서 받지 못함·한도 초과). 업무 처리는 막지 않았고, 조사 적재는 이 값을 나중에 채우지 않는다. 생산자는 inv_ref_missing_total로 센다(docs/security/secrets-and-keys.md 'inv-ref-key', 추천 적용 2026-10-31, ADR-0171)",
      "type": "boolean",
      "default": false
    },
    {
      "name": "items",
      "doc": "좌석별 등급·구역·가격(ADR-0052)",
      "type": {
        "type": "array",
        "items": {
          "type": "record",
          "name": "OrderEventItem",
          "fields": [
            {
              "name": "seatId",
              "type": "string"
            },
            {
              "name": "tierId",
              "type": "string"
            },
            {
              "name": "sectionId",
              "type": "string"
            },
            {
              "name": "price",
              "type": "long"
            }
          ]
        }
      }
    },
    {
      "name": "seatAssignment",
      "type": {
        "type": "enum",
        "name": "OrderEventSeatAssignment",
        "default": "UNRECOGNIZED",
        "symbols": [
          "UNRECOGNIZED",
          "PICK",
          "AUTO"
        ]
      }
    },
    {
      "name": "firstInStage",
      "type": "boolean",
      "default": false,
      "doc": "이 주문이 이 단계(ACCEPTED·APPROVED·CONFIRMED)에 처음 들어올 때 true. 입금 되돌림 뒤 다시 확정되면 false. 관제 실시간 표가 퍼널을 주문마다 한 번 센다(ADR-0099)"
    },
    {
      "name": "occurredAt",
      "type": {
        "type": "long",
        "logicalType": "timestamp-millis"
      }
    },
    {
      "name": "eventKey",
      "doc": "중복 제거 키(ADR-0052). 같은 사건을 다시 보내면 같은 값",
      "type": {
        "type": "string",
        "logicalType": "uuid"
      }
    }
  ]
};
