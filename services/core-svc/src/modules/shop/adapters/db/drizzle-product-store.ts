// shop Drizzle 저장소(docs/data.md product·product_stock). 파트너 경로는 core_partner 역할(RLS)로 읽고 쓴다.
// RLS는 트랜잭션의 app.tenant_id로 거르므로 모든 질의를 테넌트 트랜잭션 안에서 한다(ADR-0241, authz-matrix §5.3).
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { ProductListPage, ProductStore } from '../../domain/ports.js';
import type { Fulfillment, ProductFilter, ProductRecord } from '../../domain/product.js';
import { product, productStock } from './schema.js';

interface Row {
  product: typeof product.$inferSelect;
  stock: { stock: number } | null;
}

const encodeCursor = (p: ProductRecord): string => Buffer.from(`${p.updatedAt.getTime()}:${p.productId}`).toString('base64url');
const decodeCursor = (cursor: string): { at: number; id: string } | undefined => {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const n = Number(at);
    return Number.isSafeInteger(n) && id ? { at: n, id } : undefined;
  } catch {
    return undefined;
  }
};

const toRecord = (row: Row): ProductRecord => ({
  productId: row.product.id,
  promoterId: row.product.promoterId,
  type: row.product.type,
  name: row.product.name,
  status: row.product.status as ProductRecord['status'],
  price: row.product.price,
  shippingFee: row.product.shippingFee,
  returnShippingFee: row.product.returnShippingFee,
  returnAddress: row.product.returnAddress,
  limitedQty: row.product.limitedQty,
  stock: row.product.limitedQty === null ? null : (row.stock?.stock ?? 0),
  transferable: row.product.transferable,
  ticketLinked: row.product.ticketLinked,
  linkedEventId: row.product.linkedEventId,
  fulfillments: row.product.fulfillments as Fulfillment[],
  saleStartsAt: row.product.saleStartsAt,
  saleEndsAt: row.product.saleEndsAt,
  commissionRateBp: row.product.commissionRateBp,
  attributes: row.product.attributes ?? {},
  version: row.product.version,
  publishedAt: row.product.publishedAt,
  updatedAt: row.product.updatedAt,
});

export class DrizzleProductStore implements ProductStore {
  constructor(private readonly db: Database) {}

  async list(promoterId: string, filter: ProductFilter): Promise<ProductListPage> {
    return this.db.transaction(
      async (tx) => {
        const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
        const conditions = [eq(product.promoterId, promoterId)];
        if (filter.ticketLinked !== undefined) conditions.push(eq(product.ticketLinked, filter.ticketLinked));
        if (filter.q) conditions.push(sql`${product.name} ilike ${`%${filter.q}%`}`);
        if (cursor) conditions.push(or(lt(product.updatedAt, new Date(cursor.at)), and(eq(product.updatedAt, new Date(cursor.at)), lt(product.id, cursor.id)))!);
        const rows = await tx
          .select({ product, stock: { stock: productStock.stock } })
          .from(product)
          .leftJoin(productStock, eq(productStock.productId, product.id))
          .where(and(...conditions))
          .orderBy(desc(product.updatedAt), desc(product.id))
          .limit(filter.limit + 1);
        const items = rows.slice(0, filter.limit).map((r) => toRecord(r as Row));
        return { items, nextCursor: rows.length > filter.limit ? encodeCursor(items[items.length - 1]!) : null };
      },
      { tenantId: promoterId, accessMode: 'read only' },
    );
  }

  async find(promoterId: string, productId: string): Promise<ProductRecord | undefined> {
    return this.db.transaction(
      async (tx) => {
        const rows = await tx
          .select({ product, stock: { stock: productStock.stock } })
          .from(product)
          .leftJoin(productStock, eq(productStock.productId, product.id))
          .where(and(eq(product.id, productId), eq(product.promoterId, promoterId)))
          .limit(1);
        return rows[0] ? toRecord(rows[0] as Row) : undefined;
      },
      { tenantId: promoterId, accessMode: 'read only' },
    );
  }

  async insert(record: ProductRecord): Promise<void> {
    await this.db.transaction(
      async (tx) => {
        await tx.insert(product).values({
          id: record.productId,
          promoterId: record.promoterId,
          type: record.type,
          name: record.name,
          status: record.status,
          price: record.price,
          shippingFee: record.shippingFee,
          returnShippingFee: record.returnShippingFee,
          returnAddress: record.returnAddress,
          limitedQty: record.limitedQty,
          transferable: record.transferable,
          ticketLinked: record.ticketLinked,
          linkedEventId: record.linkedEventId,
          fulfillments: record.fulfillments,
          saleStartsAt: record.saleStartsAt,
          saleEndsAt: record.saleEndsAt,
          commissionRateBp: record.commissionRateBp,
          attributes: record.attributes,
          version: record.version,
          publishedAt: record.publishedAt,
          updatedAt: record.updatedAt,
        });
        if (record.limitedQty !== null) await tx.insert(productStock).values({ productId: record.productId, stock: record.stock ?? record.limitedQty, updatedAt: record.updatedAt });
      },
      { tenantId: record.promoterId },
    );
  }

  async save(promoterId: string, record: ProductRecord, expectedVersion: number): Promise<ProductRecord | 'conflict'> {
    return this.db.transaction(
      async (tx) => {
        const updated = await tx
          .update(product)
          .set({
            type: record.type,
            name: record.name,
            status: record.status,
            price: record.price,
            shippingFee: record.shippingFee,
            returnShippingFee: record.returnShippingFee,
            returnAddress: record.returnAddress,
            limitedQty: record.limitedQty,
            transferable: record.transferable,
            ticketLinked: record.ticketLinked,
            linkedEventId: record.linkedEventId,
            fulfillments: record.fulfillments,
            saleStartsAt: record.saleStartsAt,
            saleEndsAt: record.saleEndsAt,
            commissionRateBp: record.commissionRateBp,
            attributes: record.attributes,
            publishedAt: record.publishedAt,
            updatedAt: record.updatedAt,
            version: sql`${product.version} + 1`,
          })
          .where(and(eq(product.id, record.productId), eq(product.promoterId, promoterId), eq(product.version, expectedVersion)))
          .returning({ version: product.version });
        if (updated.length === 0) return 'conflict';
        if (record.limitedQty === null) await tx.delete(productStock).where(eq(productStock.productId, record.productId));
        else
          await tx
            .insert(productStock)
            .values({ productId: record.productId, stock: record.stock ?? record.limitedQty, updatedAt: record.updatedAt })
            .onConflictDoUpdate({ target: productStock.productId, set: { stock: record.stock ?? record.limitedQty, updatedAt: record.updatedAt } });
        return { ...record, version: updated[0]!.version };
      },
      { tenantId: promoterId },
    );
  }
}

/** 회차→공연 이름. core_app 읽기 역할로 event·production을 읽는다. */
export class DrizzleProductEventDirectory {
  constructor(private readonly db: Database) {}
  async productionOf(eventId: string): Promise<{ productionId: string; title: string } | undefined> {
    const r = await this.db.pool.query<{ production_id: string; title: string }>('select e.production_id, p.title from event e join production p on p.id = e.production_id where e.id = $1', [eventId]);
    const row = r.rows[0];
    return row ? { productionId: row.production_id, title: row.title } : undefined;
  }
}
