// shop 메모리 저장소(단위 시험·개발). Drizzle과 같은 포트를 쓴다.
import type { ProductListPage, ProductStore } from '../domain/ports.js';
import type { ProductFilter, ProductRecord } from '../domain/product.js';

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

export class MemoryProductStore implements ProductStore {
  readonly rows = new Map<string, ProductRecord>();

  async list(promoterId: string, filter: ProductFilter): Promise<ProductListPage> {
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    let rows = [...this.rows.values()]
      .filter((p) => p.promoterId === promoterId)
      .filter((p) => filter.ticketLinked === undefined || p.ticketLinked === filter.ticketLinked)
      .filter((p) => !filter.q || p.name.toLowerCase().includes(filter.q.toLowerCase()))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.productId.localeCompare(a.productId));
    if (cursor) rows = rows.filter((p) => p.updatedAt.getTime() < cursor.at || (p.updatedAt.getTime() === cursor.at && p.productId < cursor.id));
    const page = rows.slice(0, filter.limit + 1);
    const items = page.slice(0, filter.limit);
    return { items, nextCursor: page.length > filter.limit ? encodeCursor(items[items.length - 1]!) : null };
  }

  async find(promoterId: string, productId: string): Promise<ProductRecord | undefined> {
    const p = this.rows.get(productId);
    return p?.promoterId === promoterId ? p : undefined;
  }

  async insert(record: ProductRecord): Promise<void> {
    if (this.rows.has(record.productId)) throw new Error('duplicate product');
    this.rows.set(record.productId, { ...record, attributes: { ...record.attributes }, fulfillments: [...record.fulfillments] });
  }

  async save(promoterId: string, record: ProductRecord, expectedVersion: number): Promise<ProductRecord | 'conflict'> {
    const current = await this.find(promoterId, record.productId);
    if (!current) throw new Error('not-found');
    if (current.version !== expectedVersion) return 'conflict';
    const next = { ...record, promoterId, version: current.version + 1, attributes: { ...record.attributes }, fulfillments: [...record.fulfillments] };
    this.rows.set(record.productId, next);
    return next;
  }
}

/** 시험·개발용 회차→공연 이름. 운영은 DrizzleProductEventDirectory가 core DB를 읽는다. */
export class MemoryProductEventDirectory {
  readonly rows = new Map<string, { productionId: string; title: string }>();
  async productionOf(eventId: string) {
    return this.rows.get(eventId);
  }
}

/** 시험·개발용 고정 수수료율. 운영은 계약 표를 읽는 어댑터로 바꾼다. */
export class FixedCommissionRate {
  constructor(private readonly bp = 1000) {}
  async rateBp(): Promise<number> {
    return this.bp;
  }
}
