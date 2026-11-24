// identity.accounts-withdrawn 사건 처리기: 탈퇴한 계정의 찜을 지운다(F-05-8 GAT-260, HOT-171이 넘긴 것).
// 플랫폼 키 단위 소비자(KeyedHandler)에 꽂는 면이다. 업무 키는 계정 ID, 중복 제거 키는 eventKey다.
// core는 eventKey·accountId만 읽고 withdrawnAt은 쓰지 않는다(값 해독은 review 처리기와 같은 세 칸).
import { AccountWithdrawn } from '@peaket/contracts/asyncapi';
import type { ConsumedMessage, KeyedHandler } from '@peaket/platform';
import type { WishLifecycle } from '../application/wish-lifecycle.js';

export const CATALOG_ACCOUNTS_WITHDRAWN_TOPIC = 'identity.accounts-withdrawn';

export interface CatalogWithdrawnEvent {
  eventKey: string;
  accountId: string;
}

const CatalogWithdrawn = AccountWithdrawn.pick({ eventKey: true, accountId: true });

/** 값에서 core가 읽는 두 칸만 꺼낸다. 맞지 않으면 undefined(오류 글에 값을 싣지 않는다) */
export function readCatalogWithdrawn(value: unknown): CatalogWithdrawnEvent | undefined {
  const parsed = CatalogWithdrawn.safeParse(value);
  if (!parsed.success) return undefined;
  return { eventKey: parsed.data.eventKey, accountId: parsed.data.accountId.toLowerCase() };
}

export class CatalogAccountWithdrawnHandler implements KeyedHandler<CatalogWithdrawnEvent> {
  constructor(
    private readonly wishes: Pick<WishLifecycle, 'purgeWithdrawn'>,
    private readonly o: { logger?: { info(o: object, msg?: string): void } } = {},
  ) {}

  decode(m: ConsumedMessage): CatalogWithdrawnEvent {
    if (m.value === null) throw new Error('탈퇴 사건의 값이 없다');
    let raw: unknown;
    try {
      raw = JSON.parse(m.value.toString('utf8')) as unknown;
    } catch {
      throw new Error('탈퇴 사건의 값을 해독하지 못했다');
    }
    const e = readCatalogWithdrawn(raw);
    if (!e) throw new Error('탈퇴 사건이 계약 모양(eventKey·accountId)이 아니다');
    return e;
  }

  keyOf(e: CatalogWithdrawnEvent): string {
    return e.accountId;
  }

  eventKeyOf(e: CatalogWithdrawnEvent): string {
    return e.eventKey;
  }

  async handle(e: CatalogWithdrawnEvent): Promise<void> {
    const purged = await this.wishes.purgeWithdrawn(e.accountId);
    this.o.logger?.info({ kind: 'wishes-purged', eventKey: e.eventKey, purged }, '탈퇴 계정의 찜을 지웠다');
  }
}
