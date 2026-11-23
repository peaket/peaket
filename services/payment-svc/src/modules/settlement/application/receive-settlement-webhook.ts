// 토스페이먼츠 지급대행 웹훅(payout.changed·seller.changed) 받기(F-07-6 LCH-110, settlement §8 웹훅 행, ADR-0369 결정 5·14).
// - 서명 원문 `{본문}:{전송 시각}`을 두 결제 상점의 지금·옛 보안 키(hex 글)로 HMAC-SHA256 상수 시간 비교한다. 하나만 맞아도 받는다.
//   틀리면 REJECTED(400)와 보안 로그 settlement_webhook_signature_invalid(전송 ID·시각만)·지표다.
// - 서명은 맞고 5분 넘게 늦으면 보안 로그 settlement_webhook_late를 남기고 본문의 ID만 쓴다. 어느 쪽이든 본문의 상태를 믿지 않고 단건 조회 결과로만 확정한다.
// - 중복은 본문 eventId로 막는다(전송 ID는 보낼 때마다 새로 나온다). 단건 조회·반영이 실패하면 STORE_FAILED(503)이고 eventId를 기록하지 않아 결제사가 다시 보낸다.
// - 모르는 지급·셀러 ID는 조회 없이 ACCEPTED(받기만 해 결제사 재전송을 막는다 [가정]). 설정이 없으면 정산 사건은 REJECTED와 설정 없음 로그다.
import type { Settlements } from './settlements.js';
import type { SettlementApprovalLog, SettlementSignals, SettlementStore, TossPayoutTransport } from '../domain/ports.js';
import { parseTossSettlementWebhook, verifyTossPayoutSignature, type TossPayoutConfig } from '../domain/payout-adapters.js';
import type { PgStore } from '../domain/settlement.js';

export type SettlementWebhookAnswer = 'ACCEPTED' | 'REJECTED' | 'IGNORED' | 'STORE_FAILED';

/** /v1/webhooks/toss의 정산 사건 수신기 모양(PaymentModule settlementWebhook) */
export interface SettlementWebhookReceiver {
  receive(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<SettlementWebhookAnswer>;
}

export interface ReceiveSettlementWebhookDeps {
  config: TossPayoutConfig | undefined;
  transport: TossPayoutTransport | undefined;
  settlements: Settlements;
  store: SettlementStore;
  now: () => Date;
  log: SettlementApprovalLog;
  signals?: SettlementSignals;
}

export class ReceiveSettlementWebhook implements SettlementWebhookReceiver {
  constructor(private readonly d: ReceiveSettlementWebhookDeps) {}

  async receive(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<SettlementWebhookAnswer> {
    const { config, transport } = this.d;
    if (!config || !transport) {
      this.d.log.webhookUnconfigured?.({ at: this.d.now() });
      return 'REJECTED';
    }
    const header = (name: string): string | undefined => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const transmissionId = header('tosspayments-webhook-transmission-id');
    const transmissionTime = header('tosspayments-webhook-transmission-time');
    if (!transmissionId || !transmissionTime) return 'REJECTED';
    const body = rawBody.toString('utf8');
    const secrets = (['STANDARD', 'ESCROW'] as const).flatMap((s) => (config.stores[s]?.securityKeys ?? []).map((k) => k.toString('hex')));
    const now = this.d.now();
    const verdict = verifyTossPayoutSignature({ signature: header('tosspayments-webhook-signature'), secrets, body, transmissionTime, now });
    if (verdict === 'SIGNATURE_MISMATCH') {
      this.d.log.webhookSignatureInvalid?.({ transmissionId, at: now });
      this.d.signals?.webhookSignatureInvalid();
      return 'REJECTED';
    }
    if (verdict === 'STALE') this.d.log.webhookLate?.({ transmissionId, sentAt: transmissionTime, at: now });
    const event = parseTossSettlementWebhook(body);
    if (event === null) return 'REJECTED';
    if (event.kind === 'IGNORED') return 'IGNORED';
    // eventId가 없는 본문은 전송 ID를 열쇠로 쓴다(공개 문서에는 늘 있다 [가정])
    const eventId = event.eventId ?? `transmission:${transmissionId}`;
    try {
      if (await this.d.store.hasWebhookEvent(eventId)) return 'ACCEPTED';
      if (event.kind === 'PAYOUT') {
        const payout = await this.d.store.findPayoutByPgPayoutId(event.pgPayoutId);
        if (payout) {
          const batch = await this.d.store.findPayoutBatch(payout.batchId);
          const pgStore: PgStore = batch?.pgStore ?? 'STANDARD';
          const fact = await transport.getPayout(pgStore, event.pgPayoutId);
          await this.d.settlements.applyPayoutFact({ pgPayoutId: fact.pgPayoutId, status: fact.status, ...(fact.errorCode ? { errorCode: fact.errorCode } : {}), observedAt: now });
        }
      } else {
        const seller = await this.d.store.findTossSellerById(event.tossSellerId);
        if (seller) {
          const fact = await transport.getSeller(seller.pgStore, event.tossSellerId);
          await this.d.settlements.applyTossSellerFact({ pgStore: seller.pgStore, tossSellerId: fact.tossSellerId, status: fact.status, checkedAt: now });
        }
      }
      await this.d.store.recordWebhookEvent({ eventId, transmissionId, receivedAt: now });
      return 'ACCEPTED';
    } catch {
      return 'STORE_FAILED';
    }
  }
}

/** 토스 지급대행 설정이 없을 때의 수신기: 정산 사건을 받지 않고(400) 설정 없음 로그를 남긴다(결제 웹훅 경로로 넘기지 않는다) */
export class UnconfiguredSettlementWebhook implements SettlementWebhookReceiver {
  constructor(private readonly d: { log: SettlementApprovalLog; now: () => Date }) {}

  async receive(): Promise<SettlementWebhookAnswer> {
    this.d.log.webhookUnconfigured?.({ at: this.d.now() });
    return 'REJECTED';
  }
}
