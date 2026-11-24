// identity.accounts-merged 사건 처리기: 흡수 계정의 찜을 대표 계정으로 옮긴다(F-05-8 GAT-260, docs/data.md §4 경계 9, ADR-0148).
// 플랫폼 키 단위 소비자(KeyedHandler)에 꽂는 면이다. 업무 키는 흡수 계정 ID, 중복 제거 키는 mergeId다.
// 사건·원장 기록이 아니라 지금의 소유 값만 고치는 갈래라 wish.account_id를 바꾼다(대표 계정에 같은 찜이 있으면 하나만).
import { AccountMerged } from '@peaket/contracts/asyncapi';
import type { ConsumedMessage, KeyedHandler } from '@peaket/platform';
import type { WishLifecycle } from '../application/wish-lifecycle.js';

export const CATALOG_ACCOUNTS_MERGED_TOPIC = 'identity.accounts-merged';

export interface CatalogMergedEvent {
  mergeId: string;
  primaryAccountId: string;
  mergedAccountId: string;
}

const CatalogMerged = AccountMerged.pick({ mergeId: true, primaryAccountId: true, mergedAccountId: true });

/** 값에서 core가 읽는 세 칸만 꺼낸다. 맞지 않으면 undefined(오류 글에 값을 싣지 않는다) */
export function readCatalogMerged(value: unknown): CatalogMergedEvent | undefined {
  const parsed = CatalogMerged.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    mergeId: parsed.data.mergeId,
    primaryAccountId: parsed.data.primaryAccountId.toLowerCase(),
    mergedAccountId: parsed.data.mergedAccountId.toLowerCase(),
  };
}

export class CatalogAccountMergedHandler implements KeyedHandler<CatalogMergedEvent> {
  constructor(
    private readonly wishes: Pick<WishLifecycle, 'moveMerged'>,
    private readonly o: { logger?: { info(o: object, msg?: string): void; warn?(o: object, msg?: string): void } } = {},
  ) {}

  decode(m: ConsumedMessage): CatalogMergedEvent {
    if (m.value === null) throw new Error('병합 사건의 값이 없다');
    let raw: unknown;
    try {
      raw = JSON.parse(m.value.toString('utf8')) as unknown;
    } catch {
      throw new Error('병합 사건의 값을 해독하지 못했다');
    }
    const e = readCatalogMerged(raw);
    if (!e) throw new Error('병합 사건이 계약 모양(mergeId·primaryAccountId·mergedAccountId)이 아니다');
    return e;
  }

  keyOf(e: CatalogMergedEvent): string {
    return e.mergedAccountId;
  }

  eventKeyOf(e: CatalogMergedEvent): string {
    return e.mergeId;
  }

  async handle(e: CatalogMergedEvent): Promise<void> {
    const moved = await this.wishes.moveMerged(e.primaryAccountId, e.mergedAccountId);
    // 두 번 받으면 옮길 행이 없어 moved 0이다. 그것도 정상(멱등)
    this.o.logger?.info({ kind: 'wishes-merged', mergeId: e.mergeId, moved }, '흡수 계정의 찜을 대표 계정으로 옮겼다');
  }
}
