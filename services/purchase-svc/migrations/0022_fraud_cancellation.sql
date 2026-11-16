-- 부정 예매 운영자 취소의 요청·표별 결과(BUILD_ORDER GAT-080, fraud_cancellation.proto, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부', docs/data.md).
-- fraud_cancellation_request: 승인 ID가 멱등키, 같은 승인 ID에 다른 지문이면 ALREADY_EXISTS, 요청자와 승인자는 다르다.
-- fraud_cancellation_ticket: (승인, 표)마다 결과 하나. ACCEPTED만 취소 ID(order_cancellation.id)를, FAILED만 까닭을 가진다.
CREATE TABLE "fraud_cancellation_request" (
	"approval_id" uuid PRIMARY KEY NOT NULL,
	"fraud_case_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"targets_hash" text NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fraud_cancellation_request_actors_check" CHECK ("fraud_cancellation_request"."requested_by" <> "fraud_cancellation_request"."approved_by")
);
--> statement-breakpoint
CREATE TABLE "fraud_cancellation_ticket" (
	"approval_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"expected_holder_account_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"cancellation_id" uuid,
	"refund_amount" integer,
	"withdrawn_transfer_offer_id" text,
	"failure_code" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fraud_cancellation_ticket_approval_id_ticket_id_pk" PRIMARY KEY("approval_id","ticket_id"),
	CONSTRAINT "fraud_cancellation_ticket_outcome_check" CHECK ("fraud_cancellation_ticket"."outcome" in ('ACCEPTED', 'SKIPPED_ALREADY_ENDED', 'SKIPPED_ENTRY_STARTED', 'SKIPPED_HOLDER_CHANGED', 'FAILED')),
	CONSTRAINT "fraud_cancellation_ticket_failure_code_check" CHECK ("fraud_cancellation_ticket"."failure_code" in ('TICKET_UNAVAILABLE', 'SEAT_RETURN_FAILED', 'CANCELLATION_CONFLICT', 'ORDER_STATE', 'INTERNAL')),
	CONSTRAINT "fraud_cancellation_ticket_refund_amount_check" CHECK ("fraud_cancellation_ticket"."refund_amount" >= 0),
	CONSTRAINT "fraud_cancellation_ticket_accepted_check" CHECK (("fraud_cancellation_ticket"."outcome" = 'ACCEPTED') = ("fraud_cancellation_ticket"."cancellation_id" is not null)),
	CONSTRAINT "fraud_cancellation_ticket_failed_check" CHECK (("fraud_cancellation_ticket"."outcome" = 'FAILED') = ("fraud_cancellation_ticket"."failure_code" is not null))
);
--> statement-breakpoint
ALTER TABLE "fraud_cancellation_ticket" ADD CONSTRAINT "fraud_cancellation_ticket_approval_id_fraud_cancellation_request_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."fraud_cancellation_request"("approval_id") ON DELETE no action ON UPDATE no action;