// 굿즈·부가 상품 반품 요청(POST /v1/shop/orders/{orderId}/returns, ADR-0315, POL-016 §1.4, planning/03 §2.13 I7~I10, P-T62).
// 접수만 한다: 결제사를 부르지 않고 계좌도 받지 않으며 merch_refund 행을 만들지 않는다. 항목을 RETURN_REQUESTED로 바꾸고 바뀐 주문을 200으로 돌려준다.
// 판매자 전이(I11~I15)의 순수 함수는 sellerReturnTransition에 두되 HTTP는 열지 않는다(BAT-610 잔여, 7.2.1).
// 같은 키 다시 오기는 결과 참조 `return:{주문 ID}`가 경로 주문일 때만 세션 계정으로 그 주문을 읽어 답한다(아니면 404, ADR-0337 결정 6).
import type { Clock, IdempotencyRequest } from '@peaket/platform';
import { merchReturnNotAllowed, orderNotFound, resolveReturnItems, type ReturnReason } from '../domain/merch-order.js';
import type { ShopOrderStore } from '../domain/merch-ports.js';
import type { MerchOrdersRead } from './merch-orders-read.js';
import { replayMismatch, type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

export type ShopOrderDetailView = Awaited<ReturnType<MerchOrdersRead['get']>>;

export interface MerchReturnDeps {
  store: ShopOrderStore;
  read: MerchOrdersRead;
  clock: Clock;
  signals?: ShopSignals;
  logger?: ShopLogger;
}

export type ReturnBody = { itemIds: string[]; reason: ReturnReason; returnTrackingNo?: string | undefined };

export class MerchReturn {
  readonly #log: ShopLogger;

  constructor(private readonly d: MerchReturnDeps) {
    this.#log = d.logger ?? silentShopLogger;
  }

  /** @throws ShopProblem 400 invalid-body · 404 not-found · 409 merch-return-not-allowed·escrow-partial-not-allowed */
  async run(accountId: string, orderId: string, body: ReturnBody, once: IdempotencyRequest): Promise<ShopOrderDetailView> {
    const replay = await this.d.store.replayOf(once);
    if (replay !== undefined) return this.#replay(accountId, orderId, replay, once.operation);
    const detail = await this.d.store.findOrder(orderId.toLowerCase());
    if (!detail || detail.order.accountId !== accountId) throw orderNotFound();
    const nowMs = this.d.clock.now();
    const entryOpensAtMs = await this.#entryOf(detail);
    // WALLET인데 연결 회차 입장 시각을 읽지 못하면 단순 변심 반품을 받지 않는다(RV-04). 이상·다름은 입장 뒤에도 받는다
    if (detail.order.fulfillment === 'WALLET' && entryOpensAtMs === undefined && body.reason === 'CHANGE_OF_MIND') throw merchReturnNotAllowed();
    // 자격을 먼저 보고, 저장소가 트랜잭션 안에서 다시 본다(같은 항목에 반품 요청 둘이 겹치면 하나만 이긴다)
    resolveReturnItems(detail, body.itemIds, body.reason, entryOpensAtMs, nowMs);
    const saved = await this.d.store.applyReturn(once, {
      orderId: detail.order.orderId,
      accountId,
      itemIds: body.itemIds,
      reason: body.reason,
      ...(body.returnTrackingNo === undefined ? {} : { returnTrackingNo: body.returnTrackingNo }),
      nowMs,
      ...(entryOpensAtMs === undefined ? {} : { entryOpensAtMs }),
    });
    if (saved.kind === 'replay') return this.#replay(accountId, orderId, saved.resultRef, once.operation);
    this.d.signals?.ret('requested');
    return this.d.read.get(accountId, detail.order.orderId);
  }

  /** 참조가 경로 주문의 반품이 아니면(모양이 틀림·다른 주문) 남의 주문과 같은 404다. 읽기는 세션 계정으로 하므로 남의 주문도 같은 404다 */
  async #replay(accountId: string, orderId: string, ref: string, operation: string): Promise<ShopOrderDetailView> {
    const path = orderId.toLowerCase();
    if (!ref.startsWith('return:') || ref.slice('return:'.length) !== path) throw replayMismatch(this.#log, operation, path);
    return this.d.read.get(accountId, path);
  }

  async #entryOf(detail: { order: { eventId: string | null }; items: { fulfillment: string }[] }): Promise<number | undefined> {
    if (detail.order.eventId === null || !detail.items.some((i) => i.fulfillment === 'WALLET')) return undefined;
    const at = await this.d.store.eventEntryOpensAt(detail.order.eventId);
    return at?.getTime();
  }
}
