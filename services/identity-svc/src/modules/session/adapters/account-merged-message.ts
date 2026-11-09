// 계정 병합 사건의 Outbox 메시지(asyncapi identity.accounts-merged `AccountMerged`, docs/data.md §4의 9번, identity §2.1 '계정 병합의 첫 구현', BUILD_ORDER BOT-042).
// 값은 공용 Avro 인코더(BUILD_ORDER BAS-030) 전까지 JSON이다. 두 저장소(메모리·PostgreSQL)가 함께 쓴다.
import type { OutboxMessage } from '@peaket/platform';

export const ACCOUNTS_MERGED_TOPIC = 'identity.accounts-merged';

export function accountMergedMessage(i: { mergeId: string; primaryAccountId: string; mergedAccountId: string; confirmedAt: number }): OutboxMessage {
  const value = { mergeId: i.mergeId, primaryAccountId: i.primaryAccountId, mergedAccountId: i.mergedAccountId, confirmedAt: new Date(i.confirmedAt).toISOString() };
  // 키 = mergedAccountId(asyncapi)
  return { topic: ACCOUNTS_MERGED_TOPIC, key: i.mergedAccountId, payload: Buffer.from(JSON.stringify(value), 'utf8') };
}
