// 생성물: docs/api/avro/peaket/audit/DataAccessed.avsc(scripts/avro-schemas.mjs). 손으로 고치지 않는다.
export const auditDataAccessed: Readonly<Record<string, unknown>> = {
  "type": "record",
  "name": "DataAccessed",
  "namespace": "peaket.audit",
  "doc": "관리 계정의 개인정보 접근 기록. 토픽 audit.data-accessed, 키 actorAccountId. core-svc export 모듈이 파트너 예매자 명단 보기·내려받기와 같은 트랜잭션의 Outbox로 내고 ops-svc가 admin_data_access와 감사 체인에 쓴다(소유자 결정 2026-11-16 OPEN[43], ADR-0278, 추천 적용 2026-11-16, W8-audit2b).",
  "fields": [
    {
      "name": "eventKey",
      "doc": "중복 제거 키이자 ops admin_data_access.id. 명단 보기는 새 UUIDv7, 내려받기는 그 내보내기 ID(core attendee_export.id)",
      "type": {
        "type": "string",
        "logicalType": "uuid"
      }
    },
    {
      "name": "sourceService",
      "doc": "기록을 낸 서비스 이름(지금은 core-svc)",
      "type": "string"
    },
    {
      "name": "actorAccountId",
      "doc": "접근한 관리 계정(파트너 계정 포함). 표시 이름은 싣지 않는다",
      "type": {
        "type": "string",
        "logicalType": "uuid"
      }
    },
    {
      "name": "actorRole",
      "doc": "그때의 역할(예 partner_admin)",
      "type": "string"
    },
    {
      "name": "action",
      "doc": "LIST는 명단 보기 한 페이지, DOWNLOAD는 명단 내려받기 한 번",
      "type": {
        "type": "enum",
        "name": "DataAccessedAction",
        "default": "UNRECOGNIZED",
        "symbols": [
          "UNRECOGNIZED",
          "LIST",
          "DOWNLOAD"
        ]
      }
    },
    {
      "name": "targetKind",
      "doc": "접근한 개인정보의 종류. ATTENDEE_LIST는 파트너 예매자 명단",
      "type": {
        "type": "enum",
        "name": "DataAccessedTargetKind",
        "default": "UNRECOGNIZED",
        "symbols": [
          "UNRECOGNIZED",
          "ATTENDEE_LIST"
        ]
      }
    },
    {
      "name": "promoterId",
      "doc": "명단의 파트너",
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
          "targetKind": [
            "ATTENDEE_LIST"
          ]
        }
      ]
    },
    {
      "name": "eventId",
      "doc": "명단의 회차(명단 재현 조건 ①)",
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
          "targetKind": [
            "ATTENDEE_LIST"
          ]
        }
      ]
    },
    {
      "name": "pageLimit",
      "doc": "명단 보기 요청의 limit(명단 재현 조건 ②)",
      "type": [
        "null",
        "int"
      ],
      "default": null,
      "x-present-when": [
        {
          "action": [
            "LIST"
          ]
        }
      ]
    },
    {
      "name": "cursor",
      "doc": "명단 보기 요청이 받은 cursor 원문. 받은 커서가 있을 때만 싣는다(명단 재현 조건 ②)",
      "type": [
        "null",
        "string"
      ],
      "default": null
    },
    {
      "name": "reason",
      "doc": "내려받기 사유(먼저 적어야 내려받는다)",
      "type": [
        "null",
        "string"
      ],
      "default": null,
      "x-present-when": [
        {
          "action": [
            "DOWNLOAD"
          ]
        }
      ]
    },
    {
      "name": "format",
      "doc": "내려받은 파일 형식",
      "type": [
        "null",
        {
          "type": "enum",
          "name": "DataAccessedFormat",
          "default": "UNRECOGNIZED",
          "symbols": [
            "UNRECOGNIZED",
            "CSV",
            "XLSX",
            "PDF"
          ]
        }
      ],
      "default": null,
      "x-present-when": [
        {
          "action": [
            "DOWNLOAD"
          ]
        }
      ]
    },
    {
      "name": "targetCount",
      "doc": "보기는 그 페이지에 보인 행 수, 내려받기는 파일의 행 수",
      "type": "int"
    },
    {
      "name": "sourceIp",
      "doc": "접속지 정보: 요청의 클라이언트 IP 원문(IPv4 또는 IPv6, docs/features/settlement.md §9 '접속지'). 받는 쪽이 IP 모양인지 다시 본다",
      "type": "string"
    },
    {
      "name": "occurredAt",
      "doc": "접근한 시각(명단 재현 조건 ③)",
      "type": {
        "type": "long",
        "logicalType": "timestamp-millis"
      }
    }
  ]
};
