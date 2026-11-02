// 생성물: docs/api/proto/peaket/core/v1/core.proto의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.
export const coreV1Core: Record<string, unknown> = {
  "nested": {
    "peaket": {
      "nested": {
        "core": {
          "nested": {
            "v1": {
              "nested": {
                "SaleReviewService": {
                  "methods": {
                    "RecordSaleReviewResult": {
                      "requestType": "RecordSaleReviewResultRequest",
                      "responseType": "RecordSaleReviewResultResponse"
                    }
                  }
                },
                "SaleReviewResult": {
                  "values": {
                    "SALE_REVIEW_RESULT_UNSPECIFIED": 0,
                    "SALE_REVIEW_RESULT_APPROVED": 1,
                    "SALE_REVIEW_RESULT_REJECTED": 2,
                    "SALE_REVIEW_RESULT_SUSPENDED": 3,
                    "SALE_REVIEW_RESULT_RESUMED": 4
                  }
                },
                "RecordSaleReviewResultRequest": {
                  "fields": {
                    "production_id": {
                      "type": "string",
                      "id": 1
                    },
                    "result": {
                      "type": "SaleReviewResult",
                      "id": 2
                    },
                    "reason": {
                      "type": "string",
                      "id": 3
                    },
                    "reviewed_by": {
                      "type": "string",
                      "id": 4
                    },
                    "scales": {
                      "rule": "repeated",
                      "type": "EventScale",
                      "id": 5
                    },
                    "place_id": {
                      "type": "string",
                      "id": 6
                    },
                    "artist_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 7
                    },
                    "aliases": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 8
                    }
                  }
                },
                "EventScale": {
                  "fields": {
                    "event_id": {
                      "type": "string",
                      "id": 1
                    },
                    "level": {
                      "type": "ScaleLevel",
                      "id": 2
                    }
                  }
                },
                "ScaleLevel": {
                  "values": {
                    "SCALE_LEVEL_UNSPECIFIED": 0,
                    "SCALE_LEVEL_LARGE": 1,
                    "SCALE_LEVEL_MEDIUM": 2,
                    "SCALE_LEVEL_SMALL": 3
                  }
                },
                "RecordSaleReviewResultResponse": {
                  "fields": {
                    "applied": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "ReviewModerationService": {
                  "methods": {
                    "ApplyModeration": {
                      "requestType": "ApplyModerationRequest",
                      "responseType": "ApplyModerationResponse"
                    },
                    "GetReportedReview": {
                      "requestType": "GetReportedReviewRequest",
                      "responseType": "GetReportedReviewResponse"
                    }
                  }
                },
                "ModerationAction": {
                  "values": {
                    "MODERATION_ACTION_UNSPECIFIED": 0,
                    "MODERATION_ACTION_NO_ACTION": 1,
                    "MODERATION_ACTION_TEMP_BLOCK": 2,
                    "MODERATION_ACTION_BLOCK": 3,
                    "MODERATION_ACTION_RELEASE": 4
                  }
                },
                "ApplyModerationRequest": {
                  "fields": {
                    "review_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 1
                    },
                    "action": {
                      "type": "ModerationAction",
                      "id": 2
                    },
                    "case_id": {
                      "type": "string",
                      "id": 3
                    },
                    "notice_document_id": {
                      "type": "string",
                      "id": 4
                    },
                    "reason": {
                      "type": "string",
                      "id": 5
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 6
                    },
                    "violation": {
                      "type": "string",
                      "id": 7
                    },
                    "ends_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 8
                    }
                  }
                },
                "ApplyModerationResponse": {
                  "fields": {
                    "applied_count": {
                      "type": "int32",
                      "id": 1
                    }
                  }
                },
                "GetReportedReviewRequest": {
                  "fields": {
                    "review_id": {
                      "type": "string",
                      "id": 1
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "ReportCategory": {
                  "values": {
                    "REPORT_CATEGORY_UNSPECIFIED": 0,
                    "REPORT_CATEGORY_SCALPING": 1,
                    "REPORT_CATEGORY_MACRO": 2,
                    "REPORT_CATEGORY_ABUSE": 3,
                    "REPORT_CATEGORY_RIGHTS": 4,
                    "REPORT_CATEGORY_ILLEGAL_FILMING": 5,
                    "REPORT_CATEGORY_SPAM": 6,
                    "REPORT_CATEGORY_OFF_TOPIC": 7,
                    "REPORT_CATEGORY_OTHER": 8
                  }
                },
                "ReportNotifyChannel": {
                  "values": {
                    "REPORT_NOTIFY_CHANNEL_UNSPECIFIED": 0,
                    "REPORT_NOTIFY_CHANNEL_APP": 1,
                    "REPORT_NOTIFY_CHANNEL_EMAIL": 2
                  }
                },
                "ReportCategoryCount": {
                  "fields": {
                    "category": {
                      "type": "ReportCategory",
                      "id": 1
                    },
                    "count": {
                      "type": "int32",
                      "id": 2
                    }
                  }
                },
                "ReviewReport": {
                  "fields": {
                    "category": {
                      "type": "ReportCategory",
                      "id": 1
                    },
                    "detail": {
                      "type": "string",
                      "id": 2
                    },
                    "rights_holder": {
                      "type": "bool",
                      "id": 3
                    },
                    "notify_channel": {
                      "type": "ReportNotifyChannel",
                      "id": 4
                    },
                    "created_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 5
                    }
                  }
                },
                "ReviewPhoto": {
                  "fields": {
                    "image_id": {
                      "type": "string",
                      "id": 1
                    },
                    "thumb_key": {
                      "type": "string",
                      "id": 2
                    },
                    "view_key": {
                      "type": "string",
                      "id": 3
                    },
                    "alt": {
                      "type": "string",
                      "id": 4
                    },
                    "width": {
                      "type": "int32",
                      "id": 5
                    },
                    "height": {
                      "type": "int32",
                      "id": 6
                    }
                  }
                },
                "GetReportedReviewResponse": {
                  "fields": {
                    "review_id": {
                      "type": "string",
                      "id": 1
                    },
                    "rating": {
                      "type": "int32",
                      "id": 2
                    },
                    "body": {
                      "type": "string",
                      "id": 3
                    },
                    "photos": {
                      "rule": "repeated",
                      "type": "ReviewPhoto",
                      "id": 4
                    },
                    "report_total": {
                      "type": "int32",
                      "id": 5
                    },
                    "report_counts": {
                      "rule": "repeated",
                      "type": "ReportCategoryCount",
                      "id": 6
                    },
                    "reports": {
                      "rule": "repeated",
                      "type": "ReviewReport",
                      "id": 7
                    }
                  }
                },
                "AccountMergeCheckService": {
                  "methods": {
                    "CheckAccountMerge": {
                      "requestType": "CheckAccountMergeRequest",
                      "responseType": "CheckAccountMergeResponse"
                    }
                  }
                },
                "CheckAccountMergeRequest": {
                  "fields": {
                    "primary_account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "absorbed_account_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "MergeBlockReason": {
                  "values": {
                    "MERGE_BLOCK_REASON_UNSPECIFIED": 0,
                    "MERGE_BLOCK_REASON_ABSORBED_HAS_REVIEWS": 1,
                    "MERGE_BLOCK_REASON_LIMITED_MERCH_OVER_LIMIT": 2
                  }
                },
                "MergeBlock": {
                  "fields": {
                    "reason": {
                      "type": "MergeBlockReason",
                      "id": 1
                    },
                    "account_id": {
                      "type": "string",
                      "id": 2
                    },
                    "ref_id": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "CheckAccountMergeResponse": {
                  "fields": {
                    "blocks": {
                      "rule": "repeated",
                      "type": "MergeBlock",
                      "id": 1
                    }
                  }
                },
                "SupportCaseService": {
                  "methods": {
                    "GetInquiryRecord": {
                      "requestType": "GetInquiryRecordRequest",
                      "responseType": "GetInquiryRecordResponse"
                    },
                    "AddInquiryReply": {
                      "requestType": "AddInquiryReplyRequest",
                      "responseType": "AddInquiryReplyResponse"
                    },
                    "CloseInquiry": {
                      "requestType": "CloseInquiryRequest",
                      "responseType": "CloseInquiryResponse"
                    }
                  }
                },
                "InquiryStatus": {
                  "values": {
                    "INQUIRY_STATUS_UNSPECIFIED": 0,
                    "INQUIRY_STATUS_RECEIVED": 1,
                    "INQUIRY_STATUS_IN_PROGRESS": 2,
                    "INQUIRY_STATUS_ANSWERED": 3,
                    "INQUIRY_STATUS_CLOSED": 4
                  }
                },
                "InquiryAuthorKind": {
                  "values": {
                    "INQUIRY_AUTHOR_KIND_UNSPECIFIED": 0,
                    "INQUIRY_AUTHOR_KIND_FAN": 1,
                    "INQUIRY_AUTHOR_KIND_AGENT": 2,
                    "INQUIRY_AUTHOR_KIND_SYSTEM": 3
                  }
                },
                "InquiryMessageKind": {
                  "values": {
                    "INQUIRY_MESSAGE_KIND_UNSPECIFIED": 0,
                    "INQUIRY_MESSAGE_KIND_MESSAGE": 1,
                    "INQUIRY_MESSAGE_KIND_PROGRESS": 2,
                    "INQUIRY_MESSAGE_KIND_ANSWER": 3
                  }
                },
                "InquiryMessage": {
                  "fields": {
                    "message_id": {
                      "type": "string",
                      "id": 1
                    },
                    "author_kind": {
                      "type": "InquiryAuthorKind",
                      "id": 2
                    },
                    "kind": {
                      "type": "InquiryMessageKind",
                      "id": 3
                    },
                    "body": {
                      "type": "string",
                      "id": 4
                    },
                    "created_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 5
                    }
                  }
                },
                "GetInquiryRecordRequest": {
                  "fields": {
                    "inquiry_id": {
                      "type": "string",
                      "id": 1
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "GetInquiryRecordResponse": {
                  "fields": {
                    "inquiry_id": {
                      "type": "string",
                      "id": 1
                    },
                    "number": {
                      "type": "string",
                      "id": 2
                    },
                    "account_id": {
                      "type": "string",
                      "id": 3
                    },
                    "category": {
                      "type": "string",
                      "id": 4
                    },
                    "order_ref": {
                      "type": "string",
                      "id": 5
                    },
                    "title": {
                      "type": "string",
                      "id": 6
                    },
                    "status": {
                      "type": "InquiryStatus",
                      "id": 7
                    },
                    "created_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 8
                    },
                    "answered_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 9
                    },
                    "closed_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 10
                    },
                    "messages": {
                      "rule": "repeated",
                      "type": "InquiryMessage",
                      "id": 11
                    }
                  }
                },
                "InquiryReplyKind": {
                  "values": {
                    "INQUIRY_REPLY_KIND_UNSPECIFIED": 0,
                    "INQUIRY_REPLY_KIND_ANSWER": 1,
                    "INQUIRY_REPLY_KIND_PROGRESS": 2
                  }
                },
                "AddInquiryReplyRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "inquiry_id": {
                      "type": "string",
                      "id": 2
                    },
                    "kind": {
                      "type": "InquiryReplyKind",
                      "id": 3
                    },
                    "body": {
                      "type": "string",
                      "id": 4
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "InquiryReplyResult": {
                  "values": {
                    "INQUIRY_REPLY_RESULT_UNSPECIFIED": 0,
                    "INQUIRY_REPLY_RESULT_RECORDED": 1,
                    "INQUIRY_REPLY_RESULT_INQUIRY_CLOSED": 2
                  }
                },
                "AddInquiryReplyResponse": {
                  "fields": {
                    "result": {
                      "type": "InquiryReplyResult",
                      "id": 1
                    },
                    "message": {
                      "type": "InquiryMessage",
                      "id": 2
                    },
                    "status": {
                      "type": "InquiryStatus",
                      "id": 3
                    }
                  }
                },
                "CloseInquiryRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "inquiry_id": {
                      "type": "string",
                      "id": 2
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "CloseInquiryResponse": {
                  "fields": {
                    "status": {
                      "type": "InquiryStatus",
                      "id": 1
                    },
                    "closed_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 2
                    }
                  }
                },
                "CatalogAdminService": {
                  "methods": {
                    "GetHomeLayout": {
                      "requestType": "GetHomeLayoutRequest",
                      "responseType": "GetHomeLayoutResponse"
                    },
                    "CreateBannerUpload": {
                      "requestType": "CreateBannerUploadRequest",
                      "responseType": "CreateBannerUploadResponse"
                    },
                    "CompleteBannerUpload": {
                      "requestType": "CompleteBannerUploadRequest",
                      "responseType": "CompleteBannerUploadResponse"
                    },
                    "PublishHomeLayout": {
                      "requestType": "PublishHomeLayoutRequest",
                      "responseType": "PublishHomeLayoutResponse"
                    },
                    "SearchArtists": {
                      "requestType": "SearchArtistsRequest",
                      "responseType": "SearchArtistsResponse"
                    },
                    "CreateArtist": {
                      "requestType": "CreateArtistRequest",
                      "responseType": "CreateArtistResponse"
                    },
                    "SetArtistAliases": {
                      "requestType": "SetArtistAliasesRequest",
                      "responseType": "SetArtistAliasesResponse"
                    },
                    "SearchPlaces": {
                      "requestType": "SearchPlacesRequest",
                      "responseType": "SearchPlacesResponse"
                    },
                    "CreatePlace": {
                      "requestType": "CreatePlaceRequest",
                      "responseType": "CreatePlaceResponse"
                    },
                    "UpdatePlace": {
                      "requestType": "UpdatePlaceRequest",
                      "responseType": "UpdatePlaceResponse"
                    },
                    "SetPlaceAliases": {
                      "requestType": "SetPlaceAliasesRequest",
                      "responseType": "SetPlaceAliasesResponse"
                    },
                    "SetProductionAliases": {
                      "requestType": "SetProductionAliasesRequest",
                      "responseType": "SetProductionAliasesResponse"
                    }
                  }
                },
                "CatalogWriteResult": {
                  "values": {
                    "CATALOG_WRITE_RESULT_UNSPECIFIED": 0,
                    "CATALOG_WRITE_RESULT_APPLIED": 1,
                    "CATALOG_WRITE_RESULT_VERSION_MISMATCH": 2,
                    "CATALOG_WRITE_RESULT_DUPLICATE": 3,
                    "CATALOG_WRITE_RESULT_INVALID_CONTENT": 4
                  }
                },
                "HomeBanner": {
                  "fields": {
                    "banner_id": {
                      "type": "string",
                      "id": 1
                    },
                    "production_id": {
                      "type": "string",
                      "id": 2
                    },
                    "image_id": {
                      "type": "string",
                      "id": 3
                    },
                    "alt": {
                      "type": "string",
                      "id": 4
                    },
                    "display_from": {
                      "type": "google.protobuf.Timestamp",
                      "id": 5
                    },
                    "display_until": {
                      "type": "google.protobuf.Timestamp",
                      "id": 6
                    }
                  }
                },
                "HomeTheme": {
                  "fields": {
                    "theme_id": {
                      "type": "string",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "production_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    },
                    "display_from": {
                      "type": "google.protobuf.Timestamp",
                      "id": 4
                    },
                    "display_until": {
                      "type": "google.protobuf.Timestamp",
                      "id": 5
                    }
                  }
                },
                "HomeLayout": {
                  "fields": {
                    "version": {
                      "type": "int64",
                      "id": 1
                    },
                    "banners": {
                      "rule": "repeated",
                      "type": "HomeBanner",
                      "id": 2
                    },
                    "themes": {
                      "rule": "repeated",
                      "type": "HomeTheme",
                      "id": 3
                    },
                    "updated_by": {
                      "type": "string",
                      "id": 4
                    },
                    "updated_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 5
                    }
                  }
                },
                "HomeLayoutProblem": {
                  "values": {
                    "HOME_LAYOUT_PROBLEM_UNSPECIFIED": 0,
                    "HOME_LAYOUT_PROBLEM_PRODUCTION_NOT_APPROVED": 1,
                    "HOME_LAYOUT_PROBLEM_INVALID_PERIOD": 2,
                    "HOME_LAYOUT_PROBLEM_IMAGE_NOT_FOUND": 3
                  }
                },
                "HomeLayoutIssue": {
                  "fields": {
                    "problem": {
                      "type": "HomeLayoutProblem",
                      "id": 1
                    },
                    "ref_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "GetHomeLayoutRequest": {
                  "fields": {
                    "acted_by": {
                      "type": "string",
                      "id": 1
                    }
                  }
                },
                "GetHomeLayoutResponse": {
                  "fields": {
                    "layout": {
                      "type": "HomeLayout",
                      "id": 1
                    }
                  }
                },
                "CreateBannerUploadRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "content_type": {
                      "type": "string",
                      "id": 2
                    },
                    "size_bytes": {
                      "type": "int64",
                      "id": 3
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "CreateBannerUploadResponse": {
                  "fields": {
                    "image_id": {
                      "type": "string",
                      "id": 1
                    },
                    "object_key": {
                      "type": "string",
                      "id": 2
                    },
                    "upload_url": {
                      "type": "string",
                      "id": 3
                    },
                    "upload_expires_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 4
                    }
                  }
                },
                "CompleteBannerUploadRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "image_id": {
                      "type": "string",
                      "id": 2
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "BannerUploadResult": {
                  "values": {
                    "BANNER_UPLOAD_RESULT_UNSPECIFIED": 0,
                    "BANNER_UPLOAD_RESULT_ACCEPTED": 1,
                    "BANNER_UPLOAD_RESULT_REJECTED": 2
                  }
                },
                "BannerRejectReason": {
                  "values": {
                    "BANNER_REJECT_REASON_UNSPECIFIED": 0,
                    "BANNER_REJECT_REASON_UNSUPPORTED_TYPE": 1,
                    "BANNER_REJECT_REASON_TOO_LARGE": 2,
                    "BANNER_REJECT_REASON_TOO_SMALL": 3,
                    "BANNER_REJECT_REASON_MALWARE": 4
                  }
                },
                "CompleteBannerUploadResponse": {
                  "fields": {
                    "result": {
                      "type": "BannerUploadResult",
                      "id": 1
                    },
                    "preview_key": {
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
                      "type": "BannerRejectReason",
                      "id": 5
                    }
                  }
                },
                "PublishHomeLayoutRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "expected_version": {
                      "type": "int64",
                      "id": 2
                    },
                    "banners": {
                      "rule": "repeated",
                      "type": "HomeBanner",
                      "id": 3
                    },
                    "themes": {
                      "rule": "repeated",
                      "type": "HomeTheme",
                      "id": 4
                    },
                    "reason": {
                      "type": "string",
                      "id": 5
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "PublishHomeLayoutResponse": {
                  "fields": {
                    "result": {
                      "type": "CatalogWriteResult",
                      "id": 1
                    },
                    "layout": {
                      "type": "HomeLayout",
                      "id": 2
                    },
                    "issues": {
                      "rule": "repeated",
                      "type": "HomeLayoutIssue",
                      "id": 3
                    }
                  }
                },
                "SearchArtistsRequest": {
                  "fields": {
                    "q": {
                      "type": "string",
                      "id": 1
                    },
                    "cursor": {
                      "type": "string",
                      "id": 2
                    },
                    "limit": {
                      "type": "int32",
                      "id": 3
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "ArtistSummary": {
                  "fields": {
                    "artist_id": {
                      "type": "string",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "aliases": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 3
                    }
                  }
                },
                "SearchArtistsResponse": {
                  "fields": {
                    "artists": {
                      "rule": "repeated",
                      "type": "ArtistSummary",
                      "id": 1
                    },
                    "next_cursor": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "CreateArtistRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "reason": {
                      "type": "string",
                      "id": 3
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "CreateArtistResponse": {
                  "fields": {
                    "result": {
                      "type": "CatalogWriteResult",
                      "id": 1
                    },
                    "artist_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "SetArtistAliasesRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "artist_id": {
                      "type": "string",
                      "id": 2
                    },
                    "expected_version": {
                      "type": "int64",
                      "id": 3
                    },
                    "aliases": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "reason": {
                      "type": "string",
                      "id": 5
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "SetArtistAliasesResponse": {
                  "fields": {
                    "result": {
                      "type": "CatalogWriteResult",
                      "id": 1
                    },
                    "version": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "SearchPlacesRequest": {
                  "fields": {
                    "q": {
                      "type": "string",
                      "id": 1
                    },
                    "cursor": {
                      "type": "string",
                      "id": 2
                    },
                    "limit": {
                      "type": "int32",
                      "id": 3
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 4
                    }
                  }
                },
                "PlaceSummary": {
                  "fields": {
                    "place_id": {
                      "type": "string",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "address": {
                      "type": "string",
                      "id": 3
                    },
                    "region": {
                      "type": "string",
                      "id": 4
                    },
                    "status": {
                      "type": "PlaceStatus",
                      "id": 5
                    },
                    "aliases": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "SearchPlacesResponse": {
                  "fields": {
                    "places": {
                      "rule": "repeated",
                      "type": "PlaceSummary",
                      "id": 1
                    },
                    "next_cursor": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "CreatePlaceRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "name": {
                      "type": "string",
                      "id": 2
                    },
                    "address": {
                      "type": "string",
                      "id": 3
                    },
                    "region": {
                      "type": "string",
                      "id": 4
                    },
                    "reason": {
                      "type": "string",
                      "id": 5
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "CreatePlaceResponse": {
                  "fields": {
                    "result": {
                      "type": "CatalogWriteResult",
                      "id": 1
                    },
                    "place_id": {
                      "type": "string",
                      "id": 2
                    }
                  }
                },
                "PlaceStatus": {
                  "values": {
                    "PLACE_STATUS_UNSPECIFIED": 0,
                    "PLACE_STATUS_ACTIVE": 1,
                    "PLACE_STATUS_CLOSED": 2
                  }
                },
                "UpdatePlaceRequest": {
                  "oneofs": {
                    "_name": {
                      "oneof": [
                        "name"
                      ]
                    },
                    "_address": {
                      "oneof": [
                        "address"
                      ]
                    },
                    "_region": {
                      "oneof": [
                        "region"
                      ]
                    },
                    "_keep_old_name_as_alias": {
                      "oneof": [
                        "keep_old_name_as_alias"
                      ]
                    }
                  },
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "place_id": {
                      "type": "string",
                      "id": 2
                    },
                    "expected_version": {
                      "type": "int64",
                      "id": 3
                    },
                    "name": {
                      "type": "string",
                      "id": 4,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "address": {
                      "type": "string",
                      "id": 5,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "region": {
                      "type": "string",
                      "id": 6,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "status": {
                      "type": "PlaceStatus",
                      "id": 7
                    },
                    "keep_old_name_as_alias": {
                      "type": "bool",
                      "id": 8,
                      "options": {
                        "proto3_optional": true
                      }
                    },
                    "reason": {
                      "type": "string",
                      "id": 9
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 10
                    }
                  }
                },
                "UpdatePlaceResponse": {
                  "fields": {
                    "result": {
                      "type": "CatalogWriteResult",
                      "id": 1
                    },
                    "version": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "SetPlaceAliasesRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "place_id": {
                      "type": "string",
                      "id": 2
                    },
                    "expected_version": {
                      "type": "int64",
                      "id": 3
                    },
                    "aliases": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "reason": {
                      "type": "string",
                      "id": 5
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "SetPlaceAliasesResponse": {
                  "fields": {
                    "result": {
                      "type": "CatalogWriteResult",
                      "id": 1
                    },
                    "version": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "SetProductionAliasesRequest": {
                  "fields": {
                    "request_id": {
                      "type": "string",
                      "id": 1
                    },
                    "production_id": {
                      "type": "string",
                      "id": 2
                    },
                    "expected_version": {
                      "type": "int64",
                      "id": 3
                    },
                    "aliases": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "reason": {
                      "type": "string",
                      "id": 5
                    },
                    "acted_by": {
                      "type": "string",
                      "id": 6
                    }
                  }
                },
                "SetProductionAliasesResponse": {
                  "fields": {
                    "result": {
                      "type": "CatalogWriteResult",
                      "id": 1
                    },
                    "version": {
                      "type": "int64",
                      "id": 2
                    }
                  }
                },
                "BookingRestrictionViewService": {
                  "methods": {
                    "SetBookingRestrictionView": {
                      "requestType": "SetBookingRestrictionViewRequest",
                      "responseType": "SetBookingRestrictionViewResponse"
                    }
                  }
                },
                "BookingRestrictionViewState": {
                  "values": {
                    "BOOKING_RESTRICTION_VIEW_STATE_UNSPECIFIED": 0,
                    "BOOKING_RESTRICTION_VIEW_STATE_ACTIVE": 1,
                    "BOOKING_RESTRICTION_VIEW_STATE_LIFTED": 2
                  }
                },
                "SetBookingRestrictionViewRequest": {
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
                      "type": "BookingRestrictionViewState",
                      "id": 3
                    },
                    "reason_code": {
                      "type": "string",
                      "id": 4
                    },
                    "starts_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 5
                    },
                    "ends_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 6
                    },
                    "appeal_due_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 7
                    },
                    "version": {
                      "type": "int64",
                      "id": 8
                    }
                  }
                },
                "SetBookingRestrictionViewResponse": {
                  "fields": {
                    "changed": {
                      "type": "bool",
                      "id": 1
                    }
                  }
                },
                "FraudAppealViewService": {
                  "methods": {
                    "SetFraudAppealView": {
                      "requestType": "SetFraudAppealViewRequest",
                      "responseType": "SetFraudAppealViewResponse"
                    }
                  }
                },
                "FraudAppealViewState": {
                  "values": {
                    "FRAUD_APPEAL_VIEW_STATE_UNSPECIFIED": 0,
                    "FRAUD_APPEAL_VIEW_STATE_OPEN": 1,
                    "FRAUD_APPEAL_VIEW_STATE_SUBMITTED": 2,
                    "FRAUD_APPEAL_VIEW_STATE_ACCEPTED": 3,
                    "FRAUD_APPEAL_VIEW_STATE_REJECTED": 4,
                    "FRAUD_APPEAL_VIEW_STATE_EXPIRED": 5
                  }
                },
                "PriorityPurchaseView": {
                  "fields": {
                    "grant_id": {
                      "type": "string",
                      "id": 1
                    },
                    "seat_label": {
                      "type": "string",
                      "id": 2
                    },
                    "price": {
                      "type": "int64",
                      "id": 3
                    },
                    "expires_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 4
                    },
                    "status": {
                      "type": "string",
                      "id": 5
                    }
                  }
                },
                "SetFraudAppealViewRequest": {
                  "fields": {
                    "account_id": {
                      "type": "string",
                      "id": 1
                    },
                    "case_id": {
                      "type": "string",
                      "id": 2
                    },
                    "event_id": {
                      "type": "string",
                      "id": 3
                    },
                    "reason_categories": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 4
                    },
                    "due_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 5
                    },
                    "locked_ticket_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 6
                    },
                    "state": {
                      "type": "FraudAppealViewState",
                      "id": 7
                    },
                    "priority_purchases": {
                      "rule": "repeated",
                      "type": "PriorityPurchaseView",
                      "id": 8
                    },
                    "version": {
                      "type": "int64",
                      "id": 9
                    },
                    "objection_due_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 10
                    },
                    "objection_state": {
                      "type": "string",
                      "id": 11
                    },
                    "cancelled_ticket_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 12
                    },
                    "restricted_until": {
                      "type": "google.protobuf.Timestamp",
                      "id": 13
                    },
                    "objection_note": {
                      "type": "string",
                      "id": 14
                    },
                    "lock_expires_at": {
                      "type": "google.protobuf.Timestamp",
                      "id": 15
                    },
                    "lock_active": {
                      "type": "bool",
                      "id": 16
                    },
                    "party": {
                      "type": "string",
                      "id": 17
                    },
                    "held_ticket_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 18
                    },
                    "excluded_ticket_ids": {
                      "rule": "repeated",
                      "type": "string",
                      "id": 19
                    }
                  }
                },
                "SetFraudAppealViewResponse": {
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
