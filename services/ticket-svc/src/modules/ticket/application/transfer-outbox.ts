// 양도 사건 Outbox 메시지(계획 docs/review/plans/F-05-11.md §4, docs/streaming.md §5).
// 규칙은 domain/transfer-events.ts에 있다(어댑터가 application을 가져오지 않는 architecture §3.1).
export { TRANSFER_EVENT_TOPIC, TransferOutbox, type TransferEventCodec, type TransferOutboxMessage } from '../domain/transfer-events.js';
