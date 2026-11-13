// 메모리 판매 정책·회차 고치기·판매 자격 명단 저장소(시험·로컬). 메모리 카탈로그의 지도를 함께 쓴다.
// 공연마다 한 줄로 세워 잠금을 흉내 내고, 쓰기는 fn이 끝난 뒤에만 반영한다(던지면 버린다, DB 트랜잭션과 같게 답한다). 운영은 Drizzle 저장소다.
import type { EventEditable, ListWrite, SaleEventRow, SaleOwnerView, SaleState, SaleStore, SaleTx } from '../domain/sale-ports.js';
import { applyApproval, type SaleApprovalInput } from '../domain/sale-approval.js';
import type { MemoryCatalogRepository } from './memory-catalog-repository.js';

export class MemorySaleStore implements SaleStore {
  readonly #locks = new Map<string, Promise<unknown>>();
  /** 규모 올리기·판매 승인의 오픈 간격 검사를 한 줄로 세운다(프로세스 밖 잠금의 대역) */
  #scaleLock: Promise<unknown> = Promise.resolve();

  constructor(private readonly repo: MemoryCatalogRepository) {}

  async promoterOf(productionId: string): Promise<string | undefined> {
    return this.repo.productions.get(productionId)?.promoterId;
  }

  async owner(productionId: string, tenantId: string): Promise<SaleOwnerView | undefined> {
    const p = this.repo.productions.get(productionId);
    return p && p.promoterId === tenantId ? { approvedBefore: p.saleApprovedAt !== null, suspended: p.saleReview === 'SUSPENDED' } : undefined;
  }

  async read(productionId: string, tenantId: string): Promise<SaleState | undefined> {
    return (await this.owner(productionId, tenantId)) ? this.#state(productionId) : undefined;
  }

  async eventProduction(eventId: string, tenantId: string): Promise<string | undefined> {
    const e = this.repo.events.get(eventId);
    return e && this.repo.productions.get(e.productionId)?.promoterId === tenantId ? e.productionId : undefined;
  }

  async eventOwner(eventId: string): Promise<{ productionId: string; tenantId: string } | undefined> {
    const e = this.repo.events.get(eventId);
    const p = e && this.repo.productions.get(e.productionId);
    return p ? { productionId: p.id, tenantId: p.promoterId } : undefined;
  }

  withLockedProduction<T>(productionId: string, tenantId: string, fn: (tx: SaleTx) => Promise<T>): Promise<T | 'not-found'> {
    const prev = this.#locks.get(productionId) ?? Promise.resolve();
    const run = prev.then(async () => {
      if (!(await this.owner(productionId, tenantId))) return 'not-found' as const;
      const writes: (() => void)[] = [];
      const tx: SaleTx = {
        state: async () => this.#state(productionId),
        otherOpenTimes: async (from, to, exclude) =>
          [...this.repo.events.values()]
            .filter((e) => {
              const p = this.repo.productions.get(e.productionId);
              return e.productionId !== exclude && p !== undefined && p.saleApprovedAt !== null && p.saleReview !== 'SUSPENDED' && e.status !== 'CANCELLED' && e.openAt >= from && e.openAt <= to;
            })
            .map((e) => e.openAt),
        saveRules: async (rules, version, where, saleReview) =>
          void writes.push(() => {
            const cur = this.repo.salePolicies.get(productionId) ?? { rules: [], version: 1 };
            this.repo.salePolicies.set(productionId, where === 'rows' ? { ...cur, rules, version } : { ...cur, pending: rules, version });
            const p = this.repo.productions.get(productionId)!;
            this.repo.productions.set(productionId, { ...p, saleReview });
          }),
        updateEvent: async (eventId, patch, version) =>
          void writes.push(() => {
            this.#apply(eventId, patch);
            this.repo.eventVersions.set(eventId, version);
          }),
        savePendingEventChange: async (eventId, changes, version, saleReview) =>
          void writes.push(() => {
            this.repo.eventVersions.set(eventId, version);
            const all = this.repo.eventChanges.get(productionId) ?? {};
            this.repo.eventChanges.set(productionId, { ...all, [eventId]: { ...all[eventId], ...changes } });
            const p = this.repo.productions.get(productionId)!;
            this.repo.productions.set(productionId, { ...p, saleReview });
          }),
        setListTimes: async (listId, lockedAt, destroyDueAt) =>
          void writes.push(() => {
            const l = this.repo.saleLists.get(listId);
            if (l) Object.assign(l, { lockedAt, destroyDueAt });
          }),
        touchCopies: async () =>
          void writes.push(() => {
            for (const l of this.repo.saleLists.values()) if (l.productionId === productionId) l.copySeq = this.repo.nextCopySeq();
          }),
        putList: async (row: ListWrite, accountIds) => {
          // 판은 넣을 때 정해진다(되돌려도 번호를 다시 쓰지 않는다, DB 순번과 같다)
          const copySeq = this.repo.nextCopySeq();
          writes.push(() => {
            const prev = this.repo.saleLists.get(row.id);
            this.repo.saleLists.set(row.id, {
              ...row,
              copySeq,
              copiedSeq: prev?.copiedSeq ?? null,
              productionId,
              promoterId: tenantId,
              fileSha256: new Uint8Array(row.fileSha256),
              members: new Set(accountIds),
            });
          });
          return copySeq;
        },
        deleteList: async (listId, listKey, now) => {
          const copySeq = this.repo.nextCopySeq();
          writes.push(() => {
            this.repo.saleLists.delete(listId);
            this.repo.saleDrops.push({ productionId, promoterId: tenantId, listKey, copySeq, createdAt: now });
          });
          return copySeq;
        },
        approve: async (input: SaleApprovalInput) => {
          const before = this.#state(productionId);
          const after = applyApproval(before, input);
          writes.push(() => {
            for (const e of after.events) if (e.scale !== undefined) this.repo.eventScales.set(e.eventId, e.scale);
            const p = this.repo.productions.get(productionId)!;
            this.repo.productions.set(productionId, {
              ...p,
              saleReview: 'APPROVED',
              saleApprovedAt: input.now,
              ...(input.placeId !== undefined ? { placeId: input.placeId } : {}),
            });
            const policy = this.repo.salePolicies.get(productionId);
            if (policy) this.repo.salePolicies.set(productionId, { rules: policy.pending ?? policy.rules, version: policy.version });
            for (const e of after.events) {
              if (!this.repo.events.has(e.eventId)) {
                this.repo.events.set(e.eventId, { id: e.eventId, productionId, venueId: null, openAt: e.openAt, startsAt: e.startsAt, status: 'SCHEDULED' });
              }
              this.#apply(e.eventId, {
                openAt: e.openAt,
                startsAt: e.startsAt,
                endsAt: e.endsAt,
                entryOpensAt: e.entryOpensAt,
                lobbyMinutes: e.lobbyMinutes,
                lobbyShuffle: e.lobbyShuffle,
                openBatch: e.openBatch,
                seatAssignment: e.seatAssignment,
                perPersonLimit: e.perPersonLimit,
              });
              this.repo.eventVersions.set(e.eventId, e.version);
            }
            this.repo.eventChanges.delete(productionId);
            this.repo.pending.delete(productionId);
          });
          return after;
        },
        reject: async (_reason, _now) => {
          writes.push(() => {
            const p = this.repo.productions.get(productionId)!;
            this.repo.productions.set(productionId, { ...p, saleReview: 'REJECTED' });
          });
        },
        setEventScale: async (eventId, scale, version) => {
          writes.push(() => {
            this.repo.eventScales.set(eventId, scale);
            this.repo.eventVersions.set(eventId, version);
          });
        },
        largeOpenTimes: async (from, to, exclude) =>
          [...this.repo.events.values()]
            .filter((e) => e.productionId !== exclude && e.status !== 'CANCELLED' && this.repo.eventScales.get(e.id) === 'LARGE' && this.repo.productions.get(e.productionId)?.saleReview === 'APPROVED')
            .map((e) => e.openAt)
            .filter((t) => t.getTime() >= from.getTime() && t.getTime() <= to.getTime()),
      };
      const value = await fn(tx);
      for (const w of writes) w();
      return value;
    });
    this.#locks.set(productionId, run.catch(() => undefined));
    return run;
  }

  async withScaleChangeLock<T>(_tenantId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#scaleLock;
    let release!: () => void;
    this.#scaleLock = new Promise<void>((resolve) => (release = resolve));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async markCopied(listId: string, tenantId: string, copySeq: number): Promise<void> {
    const l = this.repo.saleLists.get(listId);
    if (l && l.promoterId === tenantId && copySeq <= l.copySeq && (l.copiedSeq === null || l.copiedSeq < copySeq)) l.copiedSeq = copySeq;
  }

  takeUploadSlot(productionId: string, tenantId: string, now: Date, limit: number, windowMs: number): Promise<{ ok: true } | { ok: false; retryAfterMs: number } | 'not-found'> {
    // 공연마다 한 줄로 세운다(DB의 공연 행 잠금과 같다)
    const prev = this.#locks.get(productionId) ?? Promise.resolve();
    const run = prev.then(async () => {
      if (!(await this.owner(productionId, tenantId))) return 'not-found' as const;
      const recent = (this.repo.saleUploads.get(productionId) ?? []).filter((t) => t.getTime() > now.getTime() - windowMs).sort((a, b) => a.getTime() - b.getTime());
      if (recent.length >= limit) return { ok: false as const, retryAfterMs: recent[0]!.getTime() + windowMs - now.getTime() };
      this.repo.saleUploads.set(productionId, [...recent, now]);
      return { ok: true as const };
    });
    this.#locks.set(productionId, run.catch(() => undefined));
    return run;
  }

  async dropDone(productionId: string, tenantId: string, listKey: string, copySeq: number): Promise<void> {
    const i = this.repo.saleDrops.findIndex((d) => d.productionId === productionId && d.promoterId === tenantId && d.listKey === listKey && d.copySeq === copySeq);
    if (i >= 0) this.repo.saleDrops.splice(i, 1);
  }

  #row(eventId: string): SaleEventRow {
    const e = this.repo.events.get(eventId)!;
    const draft = this.repo.eventDrafts.get(eventId);
    const d = this.repo.details.get(eventId)?.event;
    return {
      eventId,
      status: e.status,
      version: this.repo.eventVersions.get(eventId) ?? 1,
      openAt: e.openAt,
      startsAt: e.startsAt,
      lobbyMinutes: d?.lobbyMinutes ?? draft?.lobbyMinutes ?? 10,
      entryOpensAt: d?.entryOpensAt ?? draft?.entryOpensAt ?? null,
      endsAt: d?.endsAt ?? draft?.endsAt ?? new Date(e.startsAt.getTime() + 2 * 3_600_000),
      lobbyShuffle: d?.lobbyShuffle ?? draft?.lobbyShuffle ?? true,
      openBatch: d?.openBatch ?? draft?.openBatch ?? true,
      seatAssignment: d?.seatAssignment ?? draft?.seatAssignment ?? 'PICK',
      perPersonLimit: d?.perPersonLimit ?? draft?.perPersonLimit ?? 4,
      ...(this.repo.eventScales.get(eventId) !== undefined ? { scale: this.repo.eventScales.get(eventId) } : {}),
    };
  }

  /** event 행 고치기를 메모리 카탈로그의 회차·상세 칸에 반영한다 */
  #apply(eventId: string, patch: Partial<EventEditable>): void {
    const e = this.repo.events.get(eventId)!;
    this.repo.events.set(eventId, { ...e, ...(patch.openAt ? { openAt: patch.openAt } : {}), ...(patch.startsAt ? { startsAt: patch.startsAt } : {}) });
    const { openAt: _o, startsAt: _s, ...rest } = patch;
    const d = this.repo.details.get(eventId) ?? {};
    this.repo.details.set(eventId, { ...d, event: { ...d.event, ...rest } });
    const draft = this.repo.eventDrafts.get(eventId);
    if (draft) this.repo.eventDrafts.set(eventId, { ...draft, ...patch, entryOpensAt: (patch.entryOpensAt === null ? undefined : (patch.entryOpensAt ?? draft.entryOpensAt)) as Date | undefined });
  }

  #state(productionId: string): SaleState {
    const p = this.repo.productions.get(productionId)!;
    const policy = this.repo.salePolicies.get(productionId);
    const layout = this.repo.layouts.get(productionId);
    const doc = layout?.pending?.doc ?? layout?.rows?.doc;
    return {
      production: { id: p.id, promoterId: p.promoterId, saleReview: p.saleReview, saleApprovedAt: p.saleApprovedAt, rules: policy?.rules ?? [], pendingRules: policy?.pending, salePolicyVersion: policy?.version ?? 1 },
      events: [...this.repo.events.values()]
        .filter((e) => e.productionId === productionId)
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.id < b.id ? -1 : 1))
        .map((e) => this.#row(e.id)),
      eventChanges: structuredClone(this.repo.eventChanges.get(productionId) ?? {}),
      addedEvents: this.repo.pending.get(productionId) ?? [],
      grades: doc?.priceTiers.map((t) => t.tierId) ?? [],
      lists: [...this.repo.saleLists.values()]
        .filter((l) => l.productionId === productionId)
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .map(({ id, key, name, memberCount, version, copySeq, copiedSeq, uploadedAt, lockedAt, destroyDueAt }) => ({ id, key, name, memberCount, version, copySeq, copiedSeq, uploadedAt, lockedAt, destroyDueAt })),
    };
  }
}
