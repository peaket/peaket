// shop 상품 유스케이스(BUILD_ORDER BAT-610 서버 잔여, FR-024, ADR-0101).
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import {
  productEtag,
  ProductProblem,
  statusOf,
  toView,
  validateInput,
  validatePatch,
  type ProductFilter,
  type ProductInput,
  type ProductPatch,
  type ProductRecord,
  type ProductStatus,
  type ProductView,
} from '../domain/product.js';
import type { CommissionRateSource, ProductEventDirectory, ProductStore } from '../domain/ports.js';

export interface ShopDeps {
  readonly store: ProductStore;
  readonly directory: ProductEventDirectory;
  readonly commission: CommissionRateSource;
  readonly clock: Clock;
}

export interface ProductPage {
  items: ProductView[];
  nextCursor: string | null;
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const preconditionRequired = () => new ProblemError({ type: 'precondition-required', status: 428, title: 'If-Match가 필요합니다' });
const preconditionFailed = () => new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 고쳤습니다' });
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProductProblem) throw new ProblemError({ type: e.type, status: e.status, title: e.title });
    throw e;
  }
};

function parseIfMatch(value: string | undefined): number {
  if (value === undefined) throw preconditionRequired();
  const m = /^"(\d+)"$/.exec(value.trim());
  if (!m) throw preconditionFailed();
  return Number(m[1]);
}

const dateOrNull = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);

export class Products {
  constructor(private readonly d: ShopDeps) {}

  async list(promoterId: string, filter: ProductFilter): Promise<ProductPage> {
    const page = await this.d.store.list(promoterId, filter);
    const now = new Date(this.d.clock.now());
    const items: ProductView[] = [];
    for (const p of page.items) {
      const view = await this.#view(p, now);
      if (filter.status && filter.status.length > 0 && !filter.status.includes(view.status)) continue;
      if (filter.linkedProductionId && view.linkedProductionId !== filter.linkedProductionId) continue;
      items.push(view);
    }
    return { items, nextCursor: page.nextCursor };
  }

  async get(promoterId: string, productId: string): Promise<ProductView> {
    const p = await this.d.store.find(promoterId, productId);
    if (!p) throw notFound();
    return this.#view(p, new Date(this.d.clock.now()));
  }

  async create(promoterId: string, input: ProductInput): Promise<ProductView> {
    return guard(async () => {
      validateInput(input);
      const now = new Date(this.d.clock.now());
      const published = input.status === 'PUBLISHED';
      const record: ProductRecord = {
        productId: uuidv7(this.d.clock),
        promoterId,
        type: input.type,
        name: input.name,
        status: input.status,
        price: input.price,
        shippingFee: input.shippingFee ?? null,
        returnShippingFee: input.returnShippingFee ?? null,
        returnAddress: input.returnAddress ?? null,
        limitedQty: input.limitedQty ?? null,
        stock: input.limitedQty ?? null,
        transferable: input.transferable ?? false,
        ticketLinked: input.ticketLinked,
        linkedEventId: input.linkedEventId ?? null,
        fulfillments: input.fulfillments,
        saleStartsAt: dateOrNull(input.saleStartsAt),
        saleEndsAt: dateOrNull(input.saleEndsAt),
        commissionRateBp: published ? await this.d.commission.rateBp(promoterId) : null,
        attributes: input.attributes ?? {},
        version: 1,
        publishedAt: published ? now : null,
        updatedAt: now,
      };
      await this.d.store.insert(record);
      return this.#view(record, now);
    });
  }

  async update(promoterId: string, productId: string, patch: ProductPatch, ifMatch: string | undefined): Promise<ProductView> {
    return guard(async () => {
      const expected = parseIfMatch(ifMatch);
      const current = await this.d.store.find(promoterId, productId);
      if (!current) throw notFound();
      if (current.version !== expected) throw preconditionFailed();
      const now = new Date(this.d.clock.now());
      const merged: ProductRecord = {
        ...current,
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.price !== undefined ? { price: patch.price } : {}),
        ...(patch.shippingFee !== undefined ? { shippingFee: patch.shippingFee } : {}),
        ...(patch.returnShippingFee !== undefined ? { returnShippingFee: patch.returnShippingFee } : {}),
        ...(patch.returnAddress !== undefined ? { returnAddress: patch.returnAddress } : {}),
        ...(patch.ticketLinked !== undefined ? { ticketLinked: patch.ticketLinked } : {}),
        ...(patch.linkedEventId !== undefined ? { linkedEventId: patch.linkedEventId } : {}),
        ...(patch.limitedQty !== undefined ? { limitedQty: patch.limitedQty, stock: patch.limitedQty } : {}),
        ...(patch.fulfillments !== undefined ? { fulfillments: patch.fulfillments } : {}),
        ...(patch.transferable !== undefined ? { transferable: patch.transferable } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.saleStartsAt !== undefined ? { saleStartsAt: dateOrNull(patch.saleStartsAt) } : {}),
        ...(patch.saleEndsAt !== undefined ? { saleEndsAt: dateOrNull(patch.saleEndsAt) } : {}),
        ...(patch.attributes !== undefined ? { attributes: patch.attributes } : {}),
        updatedAt: now,
      };
      validatePatch(merged);
      if (merged.status === 'PUBLISHED' && merged.commissionRateBp === null) merged.commissionRateBp = await this.d.commission.rateBp(promoterId);
      if (merged.status === 'PUBLISHED' && merged.publishedAt === null) merged.publishedAt = now;
      const saved = await this.d.store.save(promoterId, merged, expected);
      if (saved === 'conflict') throw preconditionFailed();
      return this.#view(saved, now);
    });
  }

  async #view(p: ProductRecord, now: Date): Promise<ProductView> {
    const linked = p.ticketLinked && p.linkedEventId ? await this.d.directory.productionOf(p.linkedEventId) : undefined;
    return toView(p, now, linked);
  }
}

export const statusLabel = (s: ProductStatus): string => s;
export { productEtag, statusOf };
