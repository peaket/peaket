// 토스페이먼츠 지급대행 어댑터(BAT-630 LCH-110, settlement §5.2·§8).
// 실제 키·계약이 없으므로 전송은 TossPayoutTransport 포트 뒤에 둔다. 이 파일은 분할·20건 묶음·멱등키·
// 실패 분류·웹훅 단건 조회 확정만 맡고, JWE 봉인과 HTTP 호출은 운영 전 어댑터가 채운다.
import { createHash } from 'node:crypto';
import type { KycRecord, PayoutBatchRecord, PayoutRecord, TossSellerStatus } from '../domain/settlement.js';
import { SettlementProblem } from '../domain/settlement.js';
import type { PayoutGateway } from '../domain/ports.js';
import {
  classifyTossFailure,
  groupTossPayoutRequests,
  parseTossSettlementWebhook,
  verifyTossPayoutSignature,
} from '../domain/payout-adapters.js';

export interface TossPayoutRequestItem {
  refPayoutId: string;
  amount: number;
  statementId: string;
}

export interface TossPayoutTransport {
  /** 요청 하나(최대 20건). 같은 요청 묶음은 같은 idempotencyKey로 다시 보낸다. */
  requestPayouts(input: {
    batch: PayoutBatchRecord;
    payouts: readonly PayoutRecord[];
    payoutDate: string;
    idempotencyKey: string;
  }): Promise<{ pgPayoutIds: Record<string, string>; failures?: readonly { payoutId: string; code: string }[] }>;
  /** 웹훅 본문을 믿지 않고 단건 조회로 확정한다. */
  getPayout(pgPayoutId: string): Promise<{ pgPayoutId: string; status: 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELED'; errorCode?: string }>;
  cancelPayout(pgPayoutId: string): Promise<{ pgPayoutId: string; status: 'CANCELED' | 'REQUESTED' }>;
}

/** 같은 지급 건 묶음은 같은 멱등키를 쓴다. 재시도·재요청에도 키가 바뀌지 않는다. */
export function tossIdempotencyKey(payouts: readonly PayoutRecord[]): string {
  return `peaket-payout-${createHash('sha256').update(payouts.map((p) => p.refPayoutId).sort().join('|')).digest('hex')}`;
}

export class TossPayoutGateway implements PayoutGateway {
  readonly pg = 'TOSS' as const;
  constructor(private readonly transport: TossPayoutTransport) {}

  async submit(input: { batch: PayoutBatchRecord; payouts: readonly PayoutRecord[] }) {
    const groups = groupTossPayoutRequests(input.payouts);
    const pgPayoutIds: Record<string, string> = {};
    for (const group of groups) {
      const result = await this.transport.requestPayouts({
        batch: input.batch,
        payouts: group,
        payoutDate: input.batch.payoutDate,
        idempotencyKey: tossIdempotencyKey(group),
      });
      Object.assign(pgPayoutIds, result.pgPayoutIds);
      if (result.failures && result.failures.length > 0) {
        const first = result.failures[0]!;
        throw new SettlementProblem(
          `payout-gateway-${classifyTossFailure(first.code).toLowerCase()}`,
          502,
          `토스페이먼츠가 지급 요청을 거절했습니다(${first.code})`,
        );
      }
    }
    return { status: 'SUBMITTED' as const, pgPayoutIds };
  }
}

export interface SettlementWebhookStore {
  findPayoutByPgPayoutId(pgPayoutId: string): Promise<PayoutRecord | undefined>;
  savePayout(record: PayoutRecord): Promise<void>;
  findKycByTossSellerId(tossSellerId: string): Promise<KycRecord | undefined>;
  saveKyc(record: KycRecord): Promise<void>;
  hasReceipt(transmissionId: string): Promise<boolean>;
  recordReceipt(transmissionId: string): Promise<void>;
}

export type SettlementWebhookAnswer = 'ACCEPTED' | 'REJECTED' | 'IGNORED' | 'STORE_FAILED';

export class ReceiveSettlementWebhook {
  constructor(
    private readonly d: {
      secrets: readonly string[];
      transport: Pick<TossPayoutTransport, 'getPayout'>;
      store: SettlementWebhookStore;
      now: () => Date;
    },
  ) {}

  async receive(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<SettlementWebhookAnswer> {
    const header = (name: string): string | undefined => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const transmissionId = header('tosspayments-webhook-transmission-id');
    const transmissionTime = header('tosspayments-webhook-transmission-time');
    if (!transmissionId || !transmissionTime) return 'REJECTED';
    const body = rawBody.toString('utf8');
    const verdict = verifyTossPayoutSignature({
      signature: header('tosspayments-webhook-signature'),
      secrets: this.d.secrets,
      body,
      transmissionTime,
      now: this.d.now(),
    });
    if (verdict !== 'OK') return 'REJECTED';
    if (await this.d.store.hasReceipt(transmissionId)) return 'ACCEPTED';
    const event = parseTossSettlementWebhook(body);
    if (event === null) return 'REJECTED';
    if (event.kind === 'IGNORED') return 'ACCEPTED';
    try {
      if (event.kind === 'PAYOUT') {
        const payout = await this.d.store.findPayoutByPgPayoutId(event.pgPayoutId);
        if (!payout) return 'REJECTED';
        const fact = await this.d.transport.getPayout(event.pgPayoutId);
        const updated: PayoutRecord = {
          ...payout,
          pgPayoutId: fact.pgPayoutId,
          status: fact.status,
          errorCode: fact.errorCode ?? null,
          updatedAt: this.d.now(),
        };
        await this.d.store.savePayout(updated);
      } else {
        const kyc = await this.d.store.findKycByTossSellerId(event.tossSellerId);
        if (!kyc) return 'REJECTED';
        const status = event.status.toUpperCase() as TossSellerStatus;
        const next: KycRecord = {
          ...kyc,
          tossSellerStatus: status,
          status: status === 'APPROVED' ? 'VERIFIED' : status === 'REJECTED' ? 'REJECTED' : 'PENDING',
          businessVerified: status === 'APPROVED' ? true : kyc.businessVerified,
          representativeVerified: status === 'APPROVED' ? true : kyc.representativeVerified,
          verifiedAt: status === 'APPROVED' ? this.d.now() : kyc.verifiedAt,
          updatedAt: this.d.now(),
        };
        await this.d.store.saveKyc(next);
      }
      await this.d.store.recordReceipt(transmissionId);
      return 'ACCEPTED';
    } catch {
      return 'STORE_FAILED';
    }
  }
}
