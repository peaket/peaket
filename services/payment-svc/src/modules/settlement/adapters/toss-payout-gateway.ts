// 토스페이먼츠 지급대행 지급 어댑터(BAT-630 LCH-110, F-07-6 ADR-0369 결정 7, settlement §5.2).
// 지급 건을 지급일별로, 정산서 ID·순번 차례로 요청당 20건씩 나눠 보내고, 묶음마다 멱등키(정렬한 refPayoutId + 지급일)를 정한다.
// 던지지 않고 묶음별 결과(ACCEPTED·REJECTED·NO_RESPONSE·PROCESSING)를 돌려준다. 결과를 저장·정산서로 잇는 일은 응용 층(Settlements)이 한다.
// 웹훅 수신기는 응용 층(application/receive-settlement-webhook.ts)으로 옮겼다.
import { createHash } from 'node:crypto';
import type { PayoutBatchRecord, PayoutRecord } from '../domain/settlement.js';
import type { PayoutGateway, PayoutSubmitResult, TossPayoutTransport, TossSendResult } from '../domain/ports.js';
import { groupTossPayoutRequests } from '../domain/payout-adapters.js';

/** 같은 지급 건 묶음·같은 지급일은 같은 멱등키다(차례 무관). 새 순번이나 바뀐 지급일은 새 키다(J-T34 ②, ADR-0369 결정 7) */
export function tossIdempotencyKey(payouts: readonly PayoutRecord[], payoutDate: string): string {
  const material = `${payouts
    .map((p) => p.refPayoutId)
    .sort()
    .join('|')}|${payoutDate}`;
  return `peaket-payout-${createHash('sha256').update(material).digest('hex')}`;
}

const byStatementSeq = (a: PayoutRecord, b: PayoutRecord): number => a.statementId.localeCompare(b.statementId) || a.seq - b.seq;

export class TossPayoutGateway implements PayoutGateway {
  readonly pg = 'TOSS' as const;
  constructor(private readonly transport: TossPayoutTransport) {}

  async submit(input: { batch: PayoutBatchRecord; payouts: readonly PayoutRecord[]; tossSellerIds?: Readonly<Record<string, string>> }): Promise<PayoutSubmitResult & { groups: NonNullable<PayoutSubmitResult['groups']> }> {
    const byDate = new Map<string, PayoutRecord[]>();
    for (const p of [...input.payouts].sort(byStatementSeq)) {
      const date = p.payoutDate ?? input.batch.payoutDate;
      byDate.set(date, [...(byDate.get(date) ?? []), p]);
    }
    const groups: { idempotencyKey: string; refPayoutIds: string[]; result: TossSendResult }[] = [];
    for (const [payoutDate, rows] of [...byDate].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const group of groupTossPayoutRequests(rows)) {
        const idempotencyKey = tossIdempotencyKey(group, payoutDate);
        const missing = group.find((p) => !input.tossSellerIds?.[p.payoutId]);
        const result: TossSendResult = missing
          ? { kind: 'REJECTED', code: 'SELLER_NOT_REGISTERED', refPayoutId: missing.refPayoutId }
          : await this.transport.requestPayouts(input.batch.pgStore, {
              payoutDate,
              idempotencyKey,
              items: group.map((p) => ({ refPayoutId: p.refPayoutId, amount: p.amount, tossSellerId: input.tossSellerIds![p.payoutId]! })),
            });
        groups.push({ idempotencyKey, refPayoutIds: group.map((p) => p.refPayoutId), result });
      }
    }
    return { status: groups.every((g) => g.result.kind === 'ACCEPTED') ? 'SUBMITTED' : 'PENDING', groups };
  }
}
