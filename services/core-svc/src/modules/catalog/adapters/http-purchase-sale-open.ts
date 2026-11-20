// core-svc → purchase-svc 내부 판매 열기 클라이언트(BAT-616 LCH-080, ADR-0327, guidelines §8.1).
// POST /internal/v1/events/{eventId}/sale-open은 같은 회차를 다시 불러도 행·판·비트맵을 새로 만들지 않는다(멱등). 서비스 사이 토큰을 붙이고 시간 상한은 3초 [가정]이다.
// 409 sale-not-publishable(좌석맵 판 없음·취소·종료)은 'no-layout'으로 답하고, 그 밖의 실패는 던져 승인 쪽이 로그·지표만 남기게 한다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { SaleOpen, SaleOpenInput, SaleOpenResult } from '../domain/sale-open-port.js';

export const SALE_OPEN_TIMEOUT_MS = 3_000;

export class HttpPurchaseSaleOpen implements SaleOpen {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(i: SaleOpenInput): Promise<SaleOpenResult> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/events/{eventId}/sale-open',
      params: { eventId: i.eventId },
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({ openAtMs: i.openAtMs, startsAtMs: i.startsAtMs }),
      timeoutCapMs: SALE_OPEN_TIMEOUT_MS,
    });
    if (res.status === 409) return 'no-layout';
    if (res.status < 200 || res.status > 299) throw new Error(`purchase-svc 판매 열기 ${res.status}`);
    const text = await res.text().catch(() => '');
    const body = text ? (JSON.parse(text) as { opened?: unknown }) : {};
    return body.opened === true ? 'opened' : 'exists';
  }
}

/** 주소가 없을 때: 열지 않고 'unwired'만 돌려준다. 승인은 막지 않고 사본도 쓰지 않는다(닫힘, 정비 일이 다시 시도한다) */
export class UnwiredSaleOpen implements SaleOpen {
  async open(): Promise<SaleOpenResult> {
    return 'unwired';
  }
}

/** 시험·로컬: 부른 값을 모으고 정한 결과를 돌려준다(기본 opened). 운영 조립에는 쓰지 않는다 */
export class MemorySaleOpen implements SaleOpen {
  readonly calls: SaleOpenInput[] = [];
  /** 차례로 쓸 결과. 다 쓰면 마지막 값을 되풀이한다(기본 opened) */
  readonly results: SaleOpenResult[];

  constructor(results: SaleOpenResult | SaleOpenResult[] = 'opened') {
    this.results = Array.isArray(results) ? [...results] : [results];
  }

  async open(i: SaleOpenInput): Promise<SaleOpenResult> {
    this.calls.push(i);
    return this.results.length > 1 ? (this.results.shift() as SaleOpenResult) : (this.results[0] ?? 'opened');
  }
}
