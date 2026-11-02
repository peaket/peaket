-- 불변식 검사기가 읽는 표 이름·칸·형(services/invariant-checker/src/tables.ts)대로 둔 읽기 전용 뷰(docs/features/payment.md §13 '불변식 검사').
-- 검사기는 원본 DB 주소에 options=-c search_path=v0_check를 붙여 읽는다. drizzle-kit generate --custom으로 만든 손 마이그레이션이다.
-- v0의 회차·좌석·계정 ID는 UUID가 아니므로 md5(값)::uuid로 바꾼다(같은 값은 같은 UUID). 좌석은 '회차:좌석'이다.
CREATE SCHEMA IF NOT EXISTS v0_check;
--> statement-breakpoint
CREATE VIEW v0_check.purchase_order AS
  SELECT o.order_id AS id, md5(o.account_id)::uuid AS account_id, md5(o.event_id)::uuid AS event_id, o.status, o.amount::bigint AS amount, o.created_at
  FROM public.v0_order o;
--> statement-breakpoint
CREATE VIEW v0_check.order_event AS
  SELECT e.order_id, e.seq, e.to_status, e.occurred_at FROM public.v0_order_event e;
--> statement-breakpoint
-- 티켓 ID는 주문 좌석 칸이 비어 있으면(발권 뒤 주문 확정이 실패) 그 주문·좌석의 티켓에서 가져온다(P5 거짓 위반을 막는다)
CREATE VIEW v0_check.order_item AS
  SELECT i.order_id, i.line_no, md5(o.event_id || ':' || i.seat_id)::uuid AS seat_id, coalesce(i.ticket_id, t.ticket_id) AS ticket_id
  FROM public.v0_order_item i JOIN public.v0_order o ON o.order_id = i.order_id
  LEFT JOIN public.v0_ticket t ON t.order_id = i.order_id AND t.seat_id = i.seat_id;
--> statement-breakpoint
-- 주문 좌석에서 만든 판매: APPROVED·CONFIRMED는 SOLD, PAYING은 그 좌석이 그 주문으로 팔렸을 때만 PENDING(판매로 바꾸기 전에 멈춘
-- PAYING은 좌석이 팔리지 않았으므로 RETURNED), FAILED는 RETURNED. CREATED(아직 홀드)는 넣지 않는다
CREATE VIEW v0_check.seat_sale AS
  SELECT md5(o.event_id)::uuid AS event_id, md5(o.event_id || ':' || i.seat_id)::uuid AS seat_id, o.order_id,
         CASE WHEN o.status IN ('APPROVED', 'CONFIRMED') THEN 'SOLD'
              WHEN o.status = 'PAYING' AND s.status = 'SOLD' AND s.order_id = o.order_id THEN 'PENDING'
              ELSE 'RETURNED' END AS status
  FROM public.v0_order_item i JOIN public.v0_order o ON o.order_id = i.order_id
  LEFT JOIN public.v0_seat s ON s.event_id = o.event_id AND s.seat_id = i.seat_id
  WHERE o.status <> 'CREATED';
--> statement-breakpoint
CREATE VIEW v0_check.purchase_quota AS
  SELECT md5(q.account_id)::uuid AS account_id, md5(q.event_id)::uuid AS event_id, q.sold AS used, e.per_person_limit AS limit_count
  FROM public.v0_quota q JOIN public.v0_seat_event e ON e.event_id = q.event_id;
--> statement-breakpoint
CREATE VIEW v0_check.event_sale AS
  SELECT md5(s.event_id)::uuid AS event_id, count(*)::int AS sellable_seats FROM public.v0_seat s GROUP BY s.event_id;
--> statement-breakpoint
-- v0에는 발권 재시도 큐·취소·환불이 없다(빈 뷰)
CREATE VIEW v0_check.ticket_issue_job AS
  SELECT NULL::uuid AS order_id, NULL::uuid AS event_id, NULL::timestamptz AS issue_due_at, NULL::timestamptz AS created_at WHERE false;
--> statement-breakpoint
CREATE VIEW v0_check.order_cancellation AS
  SELECT NULL::uuid AS id, NULL::uuid AS order_id, NULL::uuid AS ticket_id, NULL::text AS status WHERE false;
--> statement-breakpoint
CREATE VIEW v0_check.payment_cancel AS
  SELECT NULL::uuid AS id, NULL::uuid AS payment_id, NULL::bigint AS amount, NULL::text AS status, NULL::timestamptz AS canceled_at WHERE false;
--> statement-breakpoint
CREATE VIEW v0_check.payment AS
  SELECT p.payment_id AS id, p.order_id, md5(p.event_id)::uuid AS event_id, p.pg, p.amount::bigint AS amount, p.status, p.approved_at
  FROM public.v0_payment p;
--> statement-breakpoint
CREATE VIEW v0_check.ticket AS
  SELECT t.ticket_id AS id, md5(t.event_id)::uuid AS event_id, md5(t.event_id || ':' || t.seat_id)::uuid AS seat_id, t.status
  FROM public.v0_ticket t;
