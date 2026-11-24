// identity.accounts-merged 소비자 처리기(F-07-2 IR-02, docs/data.md §4 경계 9, asyncapi AccountMerged).
// 값은 identity-svc가 지금 JSON으로 낸다(Avro 전환 전, identity의 account-merged-message와 같다).
// 업무 키는 흡수 계정 ID이고, 같은 사건을 다시 받아도 저장소가 흡수 계정 PK로 한 행만 남긴다.
// 모양이 틀린 값은 던지지 않고 bad로 돌려주며, 처리에서 RangeError로 던져 held_event에 보류한다(다른 소비자와 같은 꼴).
import { AccountMerged } from '@peaket/contracts/asyncapi';
import type { ConsumedMessage, KeyedHandler } from '@peaket/platform';
import type { MergedAccountWriter } from '../domain/ports.js';

/** identity 계정 병합 토픽(asyncapi identity.accounts-merged, 키 = mergedAccountId) */
export const ACCOUNTS_MERGED_TOPIC = 'identity.accounts-merged';

/** 사건 하나(확인 시각은 Date로 옮긴다) */
export interface AccountMergedEvent {
  readonly mergeId: string;
  readonly primaryAccountId: string;
  readonly mergedAccountId: string;
  readonly confirmedAt: Date;
}

/** 읽은 값: 반영할 사건이거나, 모양이 틀린 레코드(보류 키·까닭) */
export type AccountMergedRecord = { readonly kind: 'event'; readonly event: AccountMergedEvent } | { readonly kind: 'bad'; readonly key: string; readonly error: string };

/** 까닭에 싣는 문제 수 상한(PaymentResultHandler와 같다) */
const MAX_ISSUES = 5;

function issuesOf(issues: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[]): string {
  const parts = issues.slice(0, MAX_ISSUES).map((i) => `${i.path.map(String).join('.') || '(값)'}: ${i.code}`);
  const more = issues.length > MAX_ISSUES ? ` 외 ${issues.length - MAX_ISSUES}개` : '';
  return `AccountMerged 모양이 틀렸다(${parts.join(', ')}${more})`;
}

export class AccountMergedHandler implements KeyedHandler<AccountMergedRecord> {
  constructor(private readonly merged: MergedAccountWriter) {}

  /** 값 → 레코드. 던지지 않는다. 흡수 계정 ID를 읽을 수 있으면 그 키로 보류한다 */
  decode(m: ConsumedMessage): AccountMergedRecord {
    const fallback = `bad:${m.key ?? ''}`;
    if (m.value === null) return { kind: 'bad', key: fallback, error: 'AccountMerged 값이 없다' };
    let v: unknown;
    try {
      v = JSON.parse(m.value.toString('utf8'));
    } catch {
      return { kind: 'bad', key: fallback, error: 'AccountMerged 값이 JSON이 아니다' };
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { kind: 'bad', key: fallback, error: 'AccountMerged 값이 객체가 아니다' };
    const o = v as Record<string, unknown>;
    const key = typeof o.mergedAccountId === 'string' ? o.mergedAccountId : fallback;
    const parsed = AccountMerged.safeParse(o);
    if (!parsed.success) return { kind: 'bad', key, error: issuesOf(parsed.error.issues) };
    const confirmedAt = new Date(parsed.data.confirmedAt);
    if (Number.isNaN(confirmedAt.getTime())) return { kind: 'bad', key, error: 'AccountMerged 확인 시각이 날짜가 아니다' };
    return {
      kind: 'event',
      event: { mergeId: parsed.data.mergeId, primaryAccountId: parsed.data.primaryAccountId, mergedAccountId: parsed.data.mergedAccountId, confirmedAt },
    };
  }

  /** 업무 키: 흡수 계정 ID(병합 사건은 흡수 계정마다 하나다) */
  keyOf(r: AccountMergedRecord): string {
    return r.kind === 'event' ? r.event.mergedAccountId : r.key;
  }

  /** 같은 병합 사건을 다시 받았을 때 보류 표가 같은 사건으로 알아보게 mergeId를 쓴다 */
  eventKeyOf(r: AccountMergedRecord): string | undefined {
    return r.kind === 'event' ? r.event.mergeId : undefined;
  }

  /** bad면 RangeError(까닭)를 던진다. event면 흡수 계정 PK로 한 행을 쓴다(저장소가 멱등) */
  async handle(r: AccountMergedRecord, _m?: ConsumedMessage): Promise<void> {
    if (r.kind === 'bad') throw new RangeError(r.error);
    await this.merged.record(r.event);
  }
}
