// 회차 판매 상태 표 저장소(EventSaleStore, docs/features/seat-hold.md §4 '판정의 첫 구현', docs/data.md §2 event_sale·§5.1, ADR-0122, BUILD_ORDER PRF-144).
// seat_sale만 보는 활성 행 수·평균은 여기서 읽는다(주문 표를 읽는 결제 중 셈은 booking 모듈의 DrizzleSalePaying이다).
// 사건 값은 JSON 대역(jsonTradeEventCodec, Avro는 BAS-030)이고 키는 회차 ID, 토픽은 trade.seats다. Outbox 행은 그 트랜잭션의 마지막 문장으로 넣는다(ADR-0116 결정 3).
// 구현에서 정한 것: 쓰기 트랜잭션은 READ COMMITTED·문장 시간 한도 5초 [가정]이다(요청 밖의 다른 반복과 같다).
import { type Clock, type Database, type DatabaseOptions, writeOutbox } from '@peaket/platform';
import { sql, type SQL } from 'drizzle-orm';
import type { EventSaleChange, EventSaleCreate, EventSaleRepublish, EventSaleStore, TradeEventCodec } from '../../domain/ports.js';
import { avgTicketsOf, type EventSaleRow, SALE_STATEMENT_TIMEOUT_MS, saleChangedPayload, type SaleStatus } from '../../domain/sale-state.js';
import { SEAT_TOPIC } from '../../domain/seat-event.js';
import { jsonTradeEventCodec } from '../trade-events.js';

/** 판정이 동시에 쓰는 DB 연결 2개 [가정](docs/features/seat-hold.md §4 '판정의 첫 구현') */
const SALE_STATE_POOL_MAX = 2;

/**
 * 판정 반복(API 파드)의 purchase DB 풀 설정(main.ts가 createDatabase에 넘기고 종료 때 닫는다).
 * 핫패스 풀과 따로인 일반 풀(연결을 기다린다)·연결 2개 [가정]·이름 purchase-svc-sale-state다(orderExpiryDatabaseOptions와 같은 꼴)
 */
export function saleStateDatabaseOptions(url: string): DatabaseOptions {
  return { url, profile: 'general', max: SALE_STATE_POOL_MAX, applicationName: 'purchase-svc-sale-state' };
}

export interface DrizzleEventSaleOptions {
  database: Database;
  /** Outbox 행의 ID 시계 */
  clock: Clock;
  /** 사건 인코더. 기본은 JSON 대역 jsonTradeEventCodec이다(BAS-030 전까지) */
  codec?: TradeEventCodec;
}

const TX = { isolationLevel: 'read committed', statementTimeoutMs: SALE_STATEMENT_TIMEOUT_MS } as const;

const COLUMNS = sql.raw('event_id, status, previous_status, version, sellable_seats, available, held, paying, sold_out_tiers, open_at, first_sold_out_at, reopen_count, changed_at, counted_at');

type EventSaleDbRow = {
  event_id: string;
  status: string;
  previous_status: string | null;
  version: string | number;
  sellable_seats: number;
  available: number;
  held: number;
  paying: number;
  sold_out_tiers: string[];
  open_at: Date | string | null;
  first_sold_out_at: Date | string | null;
  reopen_count: number;
  changed_at: Date | string;
  counted_at: Date | string;
};

const msOf = (v: Date | string): number => new Date(v).getTime();

function rowOf(r: EventSaleDbRow): EventSaleRow {
  return {
    eventId: r.event_id,
    status: r.status as SaleStatus,
    ...(r.previous_status !== null ? { previousStatus: r.previous_status as SaleStatus } : {}),
    version: Number(r.version),
    sellableSeats: r.sellable_seats,
    available: r.available,
    held: r.held,
    paying: r.paying,
    soldOutTiers: r.sold_out_tiers,
    ...(r.open_at !== null ? { openAtMs: msOf(r.open_at) } : {}),
    ...(r.first_sold_out_at !== null ? { firstSoldOutAtMs: msOf(r.first_sold_out_at) } : {}),
    reopenCount: r.reopen_count,
    changedAtMs: msOf(r.changed_at),
    countedAtMs: msOf(r.counted_at),
  };
}

/** text[] 값(drizzle sql은 배열 인자를 목록으로 펼치므로 array[…]로 만든다) */
const textArray = (values: readonly string[]): SQL =>
  sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/** EventSaleStore의 purchase DB 구현(계약은 domain/ports.ts) */
export class DrizzleEventSale implements EventSaleStore {
  readonly #codec: TradeEventCodec;

  constructor(private readonly o: DrizzleEventSaleOptions) {
    this.#codec = o.codec ?? jsonTradeEventCodec;
  }

  async read(eventId: string): Promise<EventSaleRow | undefined> {
    const r = await this.o.database.db.execute(sql`select ${COLUMNS} from event_sale where event_id = ${eventId}::uuid`);
    const row = r.rows[0] as EventSaleDbRow | undefined;
    return row && rowOf(row);
  }

  async activeSaleCount(eventId: string): Promise<number> {
    const r = await this.o.database.db.execute(sql`select count(*)::int as n from seat_sale where event_id = ${eventId}::uuid and status in ('PENDING', 'SOLD')`);
    return (r.rows[0] as { n: number }).n;
  }

  async avgTicketsPerOrder(eventId: string): Promise<number | undefined> {
    const r = await this.o.database.db.execute(sql`select count(*)::int as seats, count(distinct order_id)::int as orders from seat_sale where event_id = ${eventId}::uuid and status = 'SOLD'`);
    const { seats, orders } = r.rows[0] as { seats: number; orders: number };
    return avgTicketsOf(seats, orders);
  }

  async create(input: EventSaleCreate): Promise<EventSaleRow | undefined> {
    const at = new Date(input.nowMs);
    return this.#writeAndPublish(
      sql`insert into event_sale (event_id, status, version, sellable_seats, available, held, paying, changed_at, counted_at)
          values (${input.eventId}::uuid, 'ON_SALE', 1, ${input.sellableSeats}::int, ${input.available}::int, ${input.held}::int, ${input.paying}::int, ${at}::timestamptz, ${at}::timestamptz)
          on conflict (event_id) do nothing
          returning ${COLUMNS}`,
      input.avgTicketsPerOrder,
    );
  }

  async applyChange(input: EventSaleChange): Promise<EventSaleRow | undefined> {
    const at = new Date(input.nowMs);
    const firstSoldOutAt = input.status === 'SOLD_OUT' ? sql`coalesce(first_sold_out_at, ${at}::timestamptz)` : sql`first_sold_out_at`;
    return this.#writeAndPublish(
      sql`update event_sale
          set status = ${input.status}, previous_status = ${input.previousStatus ?? null}::text, version = version + 1,
              available = ${input.available}::int, held = ${input.held}::int, paying = ${input.paying}::int,
              sold_out_tiers = ${textArray(input.soldOutTiers)}, first_sold_out_at = ${firstSoldOutAt}, reopen_count = ${input.reopenCount}::int,
              changed_at = ${at}::timestamptz, counted_at = ${at}::timestamptz
          where event_id = ${input.eventId}::uuid and version = ${input.expectedVersion}::bigint
          returning ${COLUMNS}`,
      input.avgTicketsPerOrder,
    );
  }

  async republish(input: EventSaleRepublish): Promise<EventSaleRow | undefined> {
    return this.#writeAndPublish(
      sql`update event_sale
          set available = ${input.available}::int, held = ${input.held}::int, paying = ${input.paying}::int, counted_at = ${new Date(input.nowMs)}::timestamptz
          where event_id = ${input.eventId}::uuid and version = ${input.expectedVersion}::bigint
          returning ${COLUMNS}`,
      input.avgTicketsPerOrder,
    );
  }

  /** 행을 쓰는 문장 하나와 그 행의 사건(마지막 문장)을 한 트랜잭션에 쓴다. 문장이 행을 돌려주지 않으면 Outbox도 쓰지 않고 undefined */
  #writeAndPublish(write: SQL, avgTicketsPerOrder: number | undefined): Promise<EventSaleRow | undefined> {
    return this.o.database.transaction(async (tx) => {
      const r = await tx.execute(write);
      const written = r.rows[0] as EventSaleDbRow | undefined;
      if (!written) return undefined;
      const row = rowOf(written);
      await writeOutbox(tx, this.o.clock, [{ topic: SEAT_TOPIC, key: row.eventId, payload: this.#codec.encode(SEAT_TOPIC, saleChangedPayload(row, avgTicketsPerOrder)) }]);
      return row;
    }, TX);
  }
}
