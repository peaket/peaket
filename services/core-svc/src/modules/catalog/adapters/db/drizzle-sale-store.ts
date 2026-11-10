// Drizzle 판매 정책·회차 고치기·판매 자격 명단 저장소(ADR-0241·ADR-0261 결정 1·2·4·6~9·13, docs/data.md production·event·sale_eligibility_*·§5).
// 파트너 경로(DrizzleSaleStore): core_partner 사용자로 접속하고 트랜잭션마다 테넌트(app.tenant_id)를 건다. 조회에도 테넌트 조건을 넣는다(범위 인자, 행 보안은 2차 방어).
// 쓰기는 공연 행을 FOR NO KEY UPDATE로 잡은 트랜잭션 안에서 한다(등록·이미지·좌석맵과 같은 잠금). 한 트랜잭션의 연결은 질의를 하나씩 차례대로 보낸다.
// 정비 경로(DrizzleSaleMaintenanceStore): relay 프로세스의 정비 역할 연결(core_maintenance, 모든 테넌트)이다. 파기는 명단 행을 FOR UPDATE로 잡고 파기 시각을 다시 본다.
// 큰 명단 문장은 core 역할 문장 시간 상한(5초) 안에 들게 기본 키 차례로 5,000행 [가정]씩 나눈다(앞서 지운 행을 다시 훑지 않는다, 리뷰 C4).
// 값은 빌더나 매개변수로만 넘긴다(ASVS v5.0.0-1.2.4). 구성원 계정 ID는 기록에 넣지 않는다.
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Database, DbTransaction } from '@peaket/platform';
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import { and, asc, count, eq, gt, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { EventStatus, SaleReview } from '../../domain/production.js';
import type { PendingEvent } from '../../domain/registration.js';
import { destroyTime, listEventIds, MEMBER_CHUNK } from '../../domain/sale-eligibility.js';
import type { EventEditable, ListWrite, MaintenanceList, PendingDrop, SaleEventRow, SaleMaintenanceStore, SaleOwnerView, SaleState, SaleStore, SaleTx, StoredList } from '../../domain/sale-ports.js';
import { layoutVenueId } from '../../domain/seatmap-layout.js';
import { PARTNER_DATABASE } from './drizzle-catalog-repository.js';
import { pendingOf } from './layout-rows.js';
import { event, priceTier, production, saleEligibilityDrop, saleEligibilityList, saleEligibilityMember, saleEligibilityUpload, venue } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Tx = DbTransaction | Database['db'];
type ProductionRow = typeof production.$inferSelect;
const nextSeq = sql<number>`nextval('sale_eligibility_copy_seq')`;

/** 변경분 JSON(날짜는 ISO 문자열) */
type StoredChange = Partial<Record<keyof EventEditable, string | number | boolean | null>>;
type Revision = { addedEvents?: Record<string, unknown>[]; eventChanges?: Record<string, StoredChange>; salePolicy?: SalePolicyRule[]; [k: string]: unknown };

const DATE_FIELDS = new Set<keyof EventEditable>(['openAt', 'startsAt', 'endsAt', 'entryOpensAt']);

const toStoredChange = (c: Partial<EventEditable>): StoredChange =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : (v as string | number | boolean | null)]));
const fromStoredChange = (c: StoredChange): Partial<EventEditable> =>
  Object.fromEntries(Object.entries(c).map(([k, v]) => [k, DATE_FIELDS.has(k as keyof EventEditable) && typeof v === 'string' ? new Date(v) : v])) as Partial<EventEditable>;

const fromStoredAdded = (e: Record<string, unknown>): PendingEvent =>
  ({
    ...e,
    openAt: new Date(e.openAt as string),
    startsAt: new Date(e.startsAt as string),
    endsAt: new Date(e.endsAt as string),
    ...(typeof e.entryOpensAt === 'string' ? { entryOpensAt: new Date(e.entryOpensAt) } : {}),
    addedAt: new Date(e.addedAt as string),
  }) as PendingEvent;

export const rulesOf = (v: unknown): SalePolicyRule[] => (Array.isArray(v) ? (v as SalePolicyRule[]) : []);
const revisionOf = (p: Pick<ProductionRow, 'pendingRevision'>): Revision => (p.pendingRevision ?? {}) as Revision;

const listRow = (l: typeof saleEligibilityList.$inferSelect): StoredList => ({
  id: l.id,
  key: l.key,
  name: l.name,
  memberCount: l.memberCount,
  version: l.version,
  copySeq: Number(l.copySeq),
  copiedSeq: l.copiedSeq === null ? null : Number(l.copiedSeq),
  uploadedAt: l.uploadedAt,
  lockedAt: l.lockedAt,
  destroyDueAt: l.destroyDueAt,
});

const eventRow = (e: typeof event.$inferSelect): SaleEventRow => ({
  eventId: e.id,
  status: e.status as EventStatus,
  version: e.version,
  openAt: e.openAt,
  lobbyMinutes: e.lobbyMinutes,
  entryOpensAt: e.entryOpensAt,
  startsAt: e.startsAt,
  endsAt: e.endsAt,
  lobbyShuffle: e.lobbyShuffle,
  openBatch: e.openBatch,
  seatAssignment: e.seatAssignment as 'PICK' | 'AUTO',
  perPersonLimit: e.perPersonLimit,
});

/**
 * 그 명단의 구성원을 기본 키(list_id, account_id) 차례로 chunk행씩 지운다(core 역할 문장 시간 상한 5초 안, 리뷰 C4). 묶음마다 기본 키 색인으로 그 묶음의 끝 계정을 찾고
 * (앞 묶음의 끝 뒤부터 chunk번째) 그 범위만 지우므로 앞서 지운 행(아직 정리되지 않은 죽은 행)을 다시 훑지 않는다.
 * promoterId를 주면 테넌트 조건도 넣는다(파트너 경로). signal이 끊기면 던진다(트랜잭션을 되돌린다)
 */
async function deleteMembers(tx: Tx, listId: string, chunk: number, promoterId?: string, signal?: AbortSignal): Promise<number> {
  const tenant = promoterId === undefined ? sql`` : sql` and promoter_id = ${promoterId}::uuid`;
  let after: string | undefined;
  let total = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('정비를 멈췄다');
    const from = after === undefined ? sql`` : sql` and account_id > ${after}::uuid`;
    const edge = await tx.execute(sql`select account_id from sale_eligibility_member where list_id = ${listId}::uuid${tenant}${from} order by account_id offset ${chunk - 1} limit 1`);
    const last = (edge.rows as { account_id: string }[])[0]?.account_id;
    const upTo = last === undefined ? sql`` : sql` and account_id <= ${last}::uuid`;
    const r = await tx.execute(sql`delete from sale_eligibility_member where list_id = ${listId}::uuid${tenant}${from}${upTo}`);
    total += r.rowCount ?? 0;
    if (last === undefined) return total;
    after = last;
  }
}

/** 잠근(또는 읽기 전용 트랜잭션의) 공연에서 판매 상태를 읽는다 */
async function readState(tx: Tx, p: ProductionRow, tenantId: string): Promise<SaleState> {
  const events = await tx
    .select()
    .from(event)
    .where(and(eq(event.productionId, p.id), eq(event.promoterId, tenantId)))
    .orderBy(asc(event.startsAt), asc(event.id));
  const vid = layoutVenueId(p.id);
  const [v] = await tx.select({ pendingLayout: venue.pendingLayout }).from(venue).where(and(eq(venue.id, vid), eq(venue.promoterId, tenantId)));
  const pending = pendingOf(v);
  const grades = pending
    ? pending.doc.priceTiers.map((t) => t.tierId)
    : (await tx.select({ tierId: priceTier.tierId }).from(priceTier).where(and(eq(priceTier.venueId, vid), eq(priceTier.promoterId, tenantId))).orderBy(asc(priceTier.displayOrder))).map((t) => t.tierId);
  const lists = await tx
    .select()
    .from(saleEligibilityList)
    .where(and(eq(saleEligibilityList.productionId, p.id), eq(saleEligibilityList.promoterId, tenantId)))
    .orderBy(asc(saleEligibilityList.key));
  const rev = revisionOf(p);
  return {
    production: {
      id: p.id,
      promoterId: p.promoterId,
      saleReview: p.saleReview as SaleReview,
      saleApprovedAt: p.saleApprovedAt,
      rules: rulesOf(p.salePolicy),
      pendingRules: Array.isArray(rev.salePolicy) ? rev.salePolicy : undefined,
      salePolicyVersion: p.salePolicyVersion,
    },
    events: events.map(eventRow),
    eventChanges: Object.fromEntries(Object.entries(rev.eventChanges ?? {}).map(([id, c]) => [id, fromStoredChange(c)])),
    addedEvents: (rev.addedEvents ?? []).map(fromStoredAdded),
    grades,
    lists: lists.map(listRow),
  };
}

@Injectable()
export class DrizzleSaleStore implements SaleStore {
  constructor(@Inject(PARTNER_DATABASE) private readonly db: Database) {}

  async owner(productionId: string, tenantId: string): Promise<SaleOwnerView | undefined> {
    if (!UUID.test(productionId)) return undefined;
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select({ approvedAt: production.saleApprovedAt, review: production.saleReview }).from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId)));
      return p ? { approvedBefore: p.approvedAt !== null, suspended: p.review === 'SUSPENDED' } : undefined;
    }, { tenantId });
  }

  async read(productionId: string, tenantId: string): Promise<SaleState | undefined> {
    if (!UUID.test(productionId)) return undefined;
    return this.db.transaction(
      async (tx) => {
        const [p] = await tx.select().from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId)));
        return p ? readState(tx, p, tenantId) : undefined;
      },
      { tenantId, isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async eventProduction(eventId: string, tenantId: string): Promise<string | undefined> {
    if (!UUID.test(eventId)) return undefined;
    return this.db.transaction(async (tx) => (await tx.select({ p: event.productionId }).from(event).where(and(eq(event.id, eventId), eq(event.promoterId, tenantId))))[0]?.p, { tenantId });
  }

  async withLockedProduction<T>(productionId: string, tenantId: string, fn: (tx: SaleTx) => Promise<T>): Promise<T | 'not-found'> {
    if (!UUID.test(productionId)) return 'not-found';
    return this.db.transaction(async (tx) => {
      const [p] = await tx.select().from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId))).for('no key update');
      if (!p) return 'not-found' as const;
      return fn(this.#tx(tx, p, tenantId));
    }, { tenantId });
  }

  async markCopied(listId: string, tenantId: string, copySeq: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(saleEligibilityList)
        .set({ copiedSeq: copySeq })
        .where(and(eq(saleEligibilityList.id, listId), eq(saleEligibilityList.promoterId, tenantId), gte(saleEligibilityList.copySeq, copySeq), or(isNull(saleEligibilityList.copiedSeq), lt(saleEligibilityList.copiedSeq, copySeq))));
    }, { tenantId });
  }

  async takeUploadSlot(productionId: string, tenantId: string, now: Date, limit: number, windowMs: number): Promise<{ ok: true } | { ok: false; retryAfterMs: number } | 'not-found'> {
    if (!UUID.test(productionId)) return 'not-found';
    return this.db.transaction(async (tx) => {
      // 같은 공연의 올리기를 공연 행 잠금으로 줄 세워 센다(동시에 온 둘이 함께 한도를 넘지 않게)
      const [p] = await tx.select({ id: production.id }).from(production).where(and(eq(production.id, productionId), eq(production.promoterId, tenantId))).for('no key update');
      if (!p) return 'not-found' as const;
      const since = new Date(now.getTime() - windowMs);
      const recent = await tx
        .select({ at: saleEligibilityUpload.at })
        .from(saleEligibilityUpload)
        .where(and(eq(saleEligibilityUpload.productionId, productionId), eq(saleEligibilityUpload.promoterId, tenantId), gt(saleEligibilityUpload.at, since)))
        .orderBy(asc(saleEligibilityUpload.at))
        .limit(limit);
      if (recent.length >= limit) return { ok: false as const, retryAfterMs: recent[0]!.at.getTime() + windowMs - now.getTime() };
      await tx.insert(saleEligibilityUpload).values({ id: randomUUID(), productionId, promoterId: tenantId, at: now });
      return { ok: true as const };
    }, { tenantId });
  }

  async dropDone(productionId: string, tenantId: string, listKey: string, copySeq: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(saleEligibilityDrop)
        .where(and(eq(saleEligibilityDrop.productionId, productionId), eq(saleEligibilityDrop.promoterId, tenantId), eq(saleEligibilityDrop.listKey, listKey), eq(saleEligibilityDrop.copySeq, copySeq)));
    }, { tenantId });
  }

  #tx(tx: DbTransaction, p: ProductionRow, tenantId: string): SaleTx {
    const mineProduction = and(eq(production.id, p.id), eq(production.promoterId, tenantId));
    const mineList = (id: string) => and(eq(saleEligibilityList.id, id), eq(saleEligibilityList.promoterId, tenantId));
    const revision = async () => revisionOf((await tx.select({ pendingRevision: production.pendingRevision }).from(production).where(mineProduction))[0] ?? { pendingRevision: null });
    return {
      state: () => readState(tx, p, tenantId),
      // 다른 파트너의 회차는 행 보안으로 볼 수 없어 오픈 시각 한 칸만 주는 함수로 읽는다(ADR-0241 결정 5)
      otherOpenTimes: async (from, to, exclude) => {
        const r = await tx.execute(sql`select open_at from public_open_times(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz, ${exclude}::uuid)`);
        return (r.rows as Array<{ open_at: Date | string }>).map((x) => new Date(x.open_at));
      },
      saveRules: async (rules, version, where, saleReview) => {
        if (where === 'rows') {
          await tx.update(production).set({ salePolicy: rules, salePolicyVersion: version }).where(mineProduction);
          return;
        }
        const rev = await revision();
        await tx.update(production).set({ pendingRevision: { ...rev, salePolicy: rules }, salePolicyVersion: version, saleReview }).where(mineProduction);
      },
      updateEvent: async (eventId, patch, version) => {
        await tx
          .update(event)
          .set({ ...patch, version })
          .where(and(eq(event.id, eventId), eq(event.productionId, p.id), eq(event.promoterId, tenantId)));
      },
      savePendingEventChange: async (eventId, changes, version, saleReview) => {
        await tx
          .update(event)
          .set({ version })
          .where(and(eq(event.id, eventId), eq(event.productionId, p.id), eq(event.promoterId, tenantId)));
        const rev = await revision();
        const all = rev.eventChanges ?? {};
        await tx
          .update(production)
          .set({ pendingRevision: { ...rev, eventChanges: { ...all, [eventId]: { ...all[eventId], ...toStoredChange(changes) } } }, saleReview })
          .where(mineProduction);
      },
      setListTimes: async (listId, lockedAt, destroyDueAt) => {
        await tx.update(saleEligibilityList).set({ lockedAt, destroyDueAt }).where(mineList(listId));
      },
      touchCopies: async () => {
        await tx.update(saleEligibilityList).set({ copySeq: nextSeq }).where(and(eq(saleEligibilityList.productionId, p.id), eq(saleEligibilityList.promoterId, tenantId)));
      },
      putList: async (row: ListWrite, accountIds) => {
        const values = {
          name: row.name,
          memberCount: row.memberCount,
          fileSha256: Buffer.from(row.fileSha256),
          version: row.version,
          uploadedAt: row.uploadedAt,
          uploadedBy: row.uploadedBy,
          lockedAt: row.lockedAt,
          destroyDueAt: row.destroyDueAt,
          copySeq: nextSeq,
        };
        let [saved] = await tx.update(saleEligibilityList).set(values).where(mineList(row.id)).returning({ seq: saleEligibilityList.copySeq });
        if (!saved) [saved] = await tx.insert(saleEligibilityList).values({ id: row.id, productionId: p.id, promoterId: tenantId, key: row.key, ...values }).returning({ seq: saleEligibilityList.copySeq });
        await deleteMembers(tx, row.id, MEMBER_CHUNK, tenantId);
        // 5,000행 [가정]씩 넣는다. 계정 ID 묶음을 배열 매개변수 하나로 넘긴다(행마다 매개변수 셋을 만드는 빌더는 50만 행에서 이벤트 루프를 수십 초 막았다)
        for (let i = 0; i < accountIds.length; i += MEMBER_CHUNK) {
          const ids = `{${accountIds.slice(i, i + MEMBER_CHUNK).join(',')}}`;
          await tx.execute(sql`insert into sale_eligibility_member (list_id, promoter_id, account_id) select ${row.id}::uuid, ${tenantId}::uuid, unnest(${ids}::uuid[])`);
        }
        return Number(saved!.seq);
      },
      deleteList: async (listId, listKey, now) => {
        await deleteMembers(tx, listId, MEMBER_CHUNK, tenantId);
        await tx.delete(saleEligibilityList).where(mineList(listId));
        const [d] = await tx.insert(saleEligibilityDrop).values({ productionId: p.id, promoterId: tenantId, listKey, copySeq: nextSeq, createdAt: now }).returning({ seq: saleEligibilityDrop.copySeq });
        return Number(d!.seq);
      },
    };
  }
}

const maintenanceList = { id: saleEligibilityList.id, productionId: saleEligibilityList.productionId, key: saleEligibilityList.key, copySeq: saleEligibilityList.copySeq, destroyDueAt: saleEligibilityList.destroyDueAt };
const asMaintenance = (r: { id: string; productionId: string; key: string; copySeq: number; destroyDueAt: Date }): MaintenanceList => ({ ...r, copySeq: Number(r.copySeq) });

/** 정비 일의 저장소(relay 프로세스의 정비 역할 연결 core_maintenance, 모든 테넌트) */
export class DrizzleSaleMaintenanceStore implements SaleMaintenanceStore {
  constructor(private readonly db: Database) {}

  async dueForPurge(now: Date, limit: number): Promise<MaintenanceList[]> {
    const rows = await this.db.db.select(maintenanceList).from(saleEligibilityList).where(lte(saleEligibilityList.destroyDueAt, now)).orderBy(asc(saleEligibilityList.destroyDueAt), asc(saleEligibilityList.id)).limit(limit);
    return rows.map(asMaintenance);
  }

  async purge(list: MaintenanceList, now: Date, chunk: number, signal?: AbortSignal): Promise<{ eventIds: string[]; copySeq: number } | undefined> {
    return this.db.transaction(async (tx) => {
      // 명단 행을 잡고 파기 시각을 다시 본다. 올리기·회차 더하기·고치기는 이 행을 고치므로 그 사이 늦춰졌으면 지우지 않는다(data.md §5)
      const [l] = await tx.select({ id: saleEligibilityList.id, promoterId: saleEligibilityList.promoterId, destroyDueAt: saleEligibilityList.destroyDueAt }).from(saleEligibilityList).where(eq(saleEligibilityList.id, list.id)).for('update');
      if (!l || l.destroyDueAt.getTime() > now.getTime()) return undefined;
      await deleteMembers(tx, list.id, chunk, undefined, signal);
      await tx.delete(saleEligibilityList).where(eq(saleEligibilityList.id, list.id));
      const [d] = await tx.insert(saleEligibilityDrop).values({ productionId: list.productionId, promoterId: l.promoterId, listKey: list.key, copySeq: nextSeq, createdAt: now }).returning({ seq: saleEligibilityDrop.copySeq });
      return { eventIds: await this.#allEvents(tx, list.productionId), copySeq: Number(d!.seq) };
    });
  }

  async pendingCopies(now: Date, limit: number): Promise<MaintenanceList[]> {
    const rows = await this.db.db.select(maintenanceList).from(saleEligibilityList).where(this.#pending(now)).orderBy(asc(saleEligibilityList.copySeq), asc(saleEligibilityList.id)).limit(limit);
    return rows.map(asMaintenance);
  }

  async countPendingCopies(now: Date): Promise<number> {
    const [r] = await this.db.db.select({ n: count() }).from(saleEligibilityList).where(this.#pending(now));
    return Number(r?.n ?? 0);
  }

  #pending(now: Date) {
    return and(gt(saleEligibilityList.destroyDueAt, now), or(isNull(saleEligibilityList.copiedSeq), lt(saleEligibilityList.copiedSeq, saleEligibilityList.copySeq)));
  }

  async copyData(list: MaintenanceList): Promise<{ eventIds: string[]; accountIds: string[]; expiresAt: Date } | undefined> {
    // 한 스냅숏에서 명단 판·구성원·규칙·회차를 읽는다. 회차·수명은 넘기는 지금의 규칙·회차로 계산한다(올리기 때 고정하지 않는다, 리뷰 H1)
    return this.db.transaction(
      async (tx) => {
        const [l] = await tx.select({ copySeq: saleEligibilityList.copySeq, destroyDueAt: saleEligibilityList.destroyDueAt }).from(saleEligibilityList).where(eq(saleEligibilityList.id, list.id));
        if (!l || Number(l.copySeq) !== list.copySeq) return undefined;
        const [p] = await tx.select({ salePolicy: production.salePolicy }).from(production).where(eq(production.id, list.productionId));
        const events = await this.#events(tx, list.productionId);
        const members = await tx.select({ a: saleEligibilityMember.accountId }).from(saleEligibilityMember).where(eq(saleEligibilityMember.listId, list.id));
        return { eventIds: listEventIds(rulesOf(p?.salePolicy), list.key, events), accountIds: members.map((m) => m.a), expiresAt: events.length > 0 ? destroyTime(events) : l.destroyDueAt };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async markCopied(listId: string, copySeq: number): Promise<void> {
    await this.db.db
      .update(saleEligibilityList)
      .set({ copiedSeq: copySeq })
      .where(and(eq(saleEligibilityList.id, listId), gte(saleEligibilityList.copySeq, copySeq), or(isNull(saleEligibilityList.copiedSeq), lt(saleEligibilityList.copiedSeq, copySeq))));
  }

  async pendingDrops(limit: number): Promise<PendingDrop[]> {
    const rows = await this.db.db
      .select({ productionId: saleEligibilityDrop.productionId, listKey: saleEligibilityDrop.listKey, copySeq: saleEligibilityDrop.copySeq })
      .from(saleEligibilityDrop)
      .orderBy(asc(saleEligibilityDrop.createdAt), asc(saleEligibilityDrop.copySeq))
      .limit(limit);
    return rows.map((r) => ({ ...r, copySeq: Number(r.copySeq) }));
  }

  async countPendingDrops(): Promise<number> {
    const [r] = await this.db.db.select({ n: count() }).from(saleEligibilityDrop);
    return Number(r?.n ?? 0);
  }

  dropEventIds(productionId: string): Promise<string[]> {
    return this.#allEvents(this.db.db, productionId);
  }

  async dropDone(d: PendingDrop): Promise<void> {
    await this.db.db.delete(saleEligibilityDrop).where(and(eq(saleEligibilityDrop.productionId, d.productionId), eq(saleEligibilityDrop.listKey, d.listKey), eq(saleEligibilityDrop.copySeq, d.copySeq)));
  }

  async deleteUploadsBefore(cutoff: Date): Promise<number> {
    const gone = await this.db.db.delete(saleEligibilityUpload).where(lt(saleEligibilityUpload.at, cutoff)).returning({ id: saleEligibilityUpload.id });
    return gone.length;
  }

  #events(tx: Tx, productionId: string) {
    return tx
      .select({ eventId: event.id, startsAt: event.startsAt, openAt: event.openAt, status: event.status })
      .from(event)
      .where(eq(event.productionId, productionId))
      .orderBy(asc(event.startsAt), asc(event.id))
      .then((rows) => rows.map((e) => ({ ...e, status: e.status as EventStatus })));
  }

  /** 사본 지우기는 그 공연의 회차 모두(취소된 회차 포함)에 넉넉히 넘긴다 */
  async #allEvents(tx: Tx, productionId: string): Promise<string[]> {
    return (await this.#events(tx, productionId)).map((e) => e.eventId);
  }
}
