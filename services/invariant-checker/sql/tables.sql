-- 검사 연결의 임시 표(pg_temp). 연결이 끝나면 사라져 검사 DB에 아무것도 남기지 않는다(openspec 변경 add-invariant-checker-and-pg-simulator 결정 1).
-- 원본 표의 칸은 src/tables.ts의 고정 목록과 같아야 한다. 형은 docs/data.md의 정본 형이다(금액은 bigint로 넓혀 받는다).
CREATE TEMP TABLE inv_params (as_of timestamptz NOT NULL, enqueue_within interval NOT NULL, issue_deadline interval NOT NULL);

CREATE TEMP TABLE purchase_order (id uuid, account_id uuid, event_id uuid, status text, amount bigint, created_at timestamptz);
CREATE TEMP TABLE order_event (order_id uuid, seq int, to_status text, occurred_at timestamptz);
CREATE TEMP TABLE order_item (order_id uuid, line_no int, seat_id uuid, ticket_id uuid);
CREATE TEMP TABLE order_cancellation (id uuid, order_id uuid, ticket_id uuid, status text);
CREATE TEMP TABLE seat_sale (event_id uuid, seat_id uuid, order_id uuid, status text);
CREATE TEMP TABLE purchase_quota (account_id uuid, event_id uuid, used int, limit_count int);
CREATE TEMP TABLE event_sale (event_id uuid, sellable_seats int);
CREATE TEMP TABLE ticket_issue_job (order_id uuid, event_id uuid, issue_due_at timestamptz, created_at timestamptz);

CREATE TEMP TABLE payment (id uuid, order_id uuid, event_id uuid, pg text, amount bigint, status text, approved_at timestamptz);
CREATE TEMP TABLE payment_cancel (id uuid, payment_id uuid, amount bigint, status text, canceled_at timestamptz);
CREATE TEMP TABLE settlement_statement (id uuid, kind text, event_id uuid, pg text, gross_amount bigint, refund_amount bigint, payout_amount bigint, revision int, excluded_payments jsonb, status text);
CREATE TEMP TABLE statement_source (statement_id uuid, source_id uuid, kind text, payment_id uuid, amount bigint);
CREATE TEMP TABLE payout (id uuid, statement_id uuid, amount bigint, status text);
CREATE TEMP TABLE partner_receivable (id uuid, amount bigint, remaining bigint);
CREATE TEMP TABLE receivable_movement (id uuid, receivable_id uuid, kind text, amount bigint);
CREATE TEMP TABLE reconciliation_run (id uuid, pg text, recon_date date, status text);

CREATE TEMP TABLE ticket (id uuid, event_id uuid, seat_id uuid, status text);

CREATE TEMP TABLE rec_queue_entry (event_id uuid, account_ref text, request_id text, result text, seq bigint, generation bigint, started_at timestamptz, ended_at timestamptz);
CREATE TEMP TABLE rec_queue_admit (event_id uuid, account_ref text, request_id text, result text, seq bigint, generation bigint, started_at timestamptz, ended_at timestamptz);
CREATE TEMP TABLE rec_queue_serving (event_id uuid, serving bigint, observed_at timestamptz);
CREATE TEMP TABLE rec_pg_charge (pg text, payment_ref text, order_ref text, amount bigint, status text, approved_at timestamptz, canceled_amount bigint);
