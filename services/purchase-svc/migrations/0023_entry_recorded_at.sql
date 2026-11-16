-- 마감 뒤 환급 전 입장 기록 대조(BUILD_ORDER GAT-090, P-T19 ①, docs/features/transfer-refund.md §3.1 '입장 기록 대조와 환급 집기', docs/data.md order_cancellation).
-- entry_recorded_at: 입장 시작 뒤 취소(REQUESTED)의 표에 들어감·통과 스캔이 나온 가장 이른 시각. 쓸 때 refund_due_at을 비워 실행기가 더 집지 않는다.
-- 대조된 행은 refund_due_at이 비어 지금 색인·조회에서 빠지므로 색인은 더하지 않는다. 기존 행은 NULL이다.
ALTER TABLE "order_cancellation" ADD COLUMN "entry_recorded_at" timestamp with time zone;
