// 생성물: Avro 계약(docs/api/avro)의 레코드 전체 이름 → .avsc JSON. 서비스가 빌드된 계약 판으로 쓴다(ADR-0357 결정 2). 손으로 고치지 않는다.
import { auditDataAccessed } from './peaket-audit-DataAccessed.js';
import { controlSessionTerminated } from './peaket-control-SessionTerminated.js';
import { controlSettingChanged } from './peaket-control-SettingChanged.js';
import { identityAccountMerged } from './peaket-identity-AccountMerged.js';
import { identityAccountWithdrawn } from './peaket-identity-AccountWithdrawn.js';
import { identityLoginMethodChanged } from './peaket-identity-LoginMethodChanged.js';
import { supportCaseRequested } from './peaket-support-CaseRequested.js';
import { telemetryBehaviorSignal } from './peaket-telemetry-BehaviorSignal.js';
import { telemetryHoldAttempt } from './peaket-telemetry-HoldAttempt.js';
import { telemetryPipelinePulse } from './peaket-telemetry-PipelinePulse.js';
import { telemetryQueueAggregate } from './peaket-telemetry-QueueAggregate.js';
import { telemetryQueueEntryRecord } from './peaket-telemetry-QueueEntryRecord.js';
import { telemetryTrustCandidate } from './peaket-telemetry-TrustCandidate.js';
import { telemetryTrustVerdict } from './peaket-telemetry-TrustVerdict.js';
import { tradeEventSaleChanged } from './peaket-trade-EventSaleChanged.js';
import { tradeOrderEvent } from './peaket-trade-OrderEvent.js';
import { tradePaymentEvent } from './peaket-trade-PaymentEvent.js';
import { tradePurchaseSessionEnded } from './peaket-trade-PurchaseSessionEnded.js';
import { tradePurchaseSessionStarted } from './peaket-trade-PurchaseSessionStarted.js';
import { tradeSeatEvent } from './peaket-trade-SeatEvent.js';
import { tradeSettlementEvent } from './peaket-trade-SettlementEvent.js';
import { tradeTicketEvent } from './peaket-trade-TicketEvent.js';

/** .avsc JSON 하나(값은 파일 그대로) */
export type AvroSchema = Readonly<Record<string, unknown>>;

/** 레코드 전체 이름(예: peaket.trade.OrderEvent) → 계약 판 스키마 */
export const avroSchemas: Readonly<Record<string, AvroSchema>> = Object.freeze({
  "peaket.audit.DataAccessed": auditDataAccessed,
  "peaket.control.SessionTerminated": controlSessionTerminated,
  "peaket.control.SettingChanged": controlSettingChanged,
  "peaket.identity.AccountMerged": identityAccountMerged,
  "peaket.identity.AccountWithdrawn": identityAccountWithdrawn,
  "peaket.identity.LoginMethodChanged": identityLoginMethodChanged,
  "peaket.support.CaseRequested": supportCaseRequested,
  "peaket.telemetry.BehaviorSignal": telemetryBehaviorSignal,
  "peaket.telemetry.HoldAttempt": telemetryHoldAttempt,
  "peaket.telemetry.PipelinePulse": telemetryPipelinePulse,
  "peaket.telemetry.QueueAggregate": telemetryQueueAggregate,
  "peaket.telemetry.QueueEntryRecord": telemetryQueueEntryRecord,
  "peaket.telemetry.TrustCandidate": telemetryTrustCandidate,
  "peaket.telemetry.TrustVerdict": telemetryTrustVerdict,
  "peaket.trade.EventSaleChanged": tradeEventSaleChanged,
  "peaket.trade.OrderEvent": tradeOrderEvent,
  "peaket.trade.PaymentEvent": tradePaymentEvent,
  "peaket.trade.PurchaseSessionEnded": tradePurchaseSessionEnded,
  "peaket.trade.PurchaseSessionStarted": tradePurchaseSessionStarted,
  "peaket.trade.SeatEvent": tradeSeatEvent,
  "peaket.trade.SettlementEvent": tradeSettlementEvent,
  "peaket.trade.TicketEvent": tradeTicketEvent,
});

/** 레지스트리 주제 이름(TopicRecordNameStrategy, docs/api/avro/README.md §3): <토픽>-<네임스페이스.레코드> */
export function avroSubject(topic: string, fullName: string): string {
  return `${topic}-${fullName}`;
}
