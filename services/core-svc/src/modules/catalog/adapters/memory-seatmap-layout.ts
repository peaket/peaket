// 메모리 배치본 저장소(시험·로컬, ADR-0260). 운영은 Drizzle 저장소다. 메모리 카탈로그의 공연·회차·변경분을 함께 쓰고, 공연마다 한 줄로 세워 잠금을 흉내 낸다.
// 쓰기는 fn이 끝난 뒤에만 반영한다(던지면 버린다, DB 트랜잭션과 같게).
import { type LayoutDoc, type LayoutRound, layoutVenueId } from '../domain/seatmap-layout.js';
import type { LayoutState, LayoutTx, SeatmapLayoutStore } from '../domain/seatmap-ports.js';
import type { MemoryCatalogRepository, MemoryLayout } from './memory-catalog-repository.js';

const copy = <T>(v: T): T => structuredClone(v);

export class MemorySeatmapLayoutStore implements SeatmapLayoutStore {
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(private readonly repo: MemoryCatalogRepository) {}

  async owns(productionId: string, tenantId: string): Promise<boolean> {
    return this.repo.productions.get(productionId)?.promoterId === tenantId;
  }

  async ownerView(productionId: string, tenantId: string): Promise<{ approvedBefore: boolean } | undefined> {
    const p = this.repo.productions.get(productionId);
    return p && p.promoterId === tenantId ? { approvedBefore: p.saleApprovedAt !== null } : undefined;
  }

  async current(productionId: string, tenantId: string): Promise<{ version: number; doc: LayoutDoc } | undefined | 'not-found'> {
    if (!(await this.owns(productionId, tenantId))) return 'not-found';
    const l = this.repo.layouts.get(productionId);
    const cur = l?.pending ?? l?.rows ?? undefined;
    return cur ? copy({ version: cur.version, doc: cur.doc }) : undefined;
  }

  async lockFacts(productionId: string, tenantId: string): Promise<{ saleApprovedAt: Date | null; rounds: LayoutRound[] } | undefined> {
    const p = this.repo.productions.get(productionId);
    if (!p || p.promoterId !== tenantId) return undefined;
    return {
      saleApprovedAt: p.saleApprovedAt,
      rounds: [
        ...[...this.repo.events.values()].filter((e) => e.productionId === productionId).map((e) => ({ eventId: e.id, openAt: e.openAt, cancelled: e.status === 'CANCELLED' })),
        ...(this.repo.pending.get(productionId) ?? []).map((e) => ({ eventId: e.eventId, openAt: e.openAt, cancelled: false })),
      ],
    };
  }

  async templateDraft(templateVenueId: string): Promise<LayoutDoc | undefined> {
    const t = this.repo.templates.get(templateVenueId);
    return t?.published ? { ...copy(t.doc), priceTiers: [], templateVenueId } : undefined;
  }

  withLockedProduction<T>(productionId: string, tenantId: string, fn: (tx: LayoutTx) => Promise<T>): Promise<T | 'not-found'> {
    const prev = this.#locks.get(productionId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const p = this.repo.productions.get(productionId);
      if (!p || p.promoterId !== tenantId) return 'not-found' as const;
      const writes: (() => void)[] = [];
      const layout = (): MemoryLayout | undefined => this.repo.layouts.get(productionId);
      let reserved: MemoryLayout | undefined;
      const tx: LayoutTx = {
        state: async (): Promise<LayoutState> => {
          const l = layout();
          return {
            production: { id: p.id, promoterId: p.promoterId, saleReview: p.saleReview, saleApprovedAt: p.saleApprovedAt },
            venue: l ? { id: l.venueId, layoutVersion: l.rows?.version ?? 0, versionSeq: l.versionSeq, publishedVersion: l.publishedVersion, pending: copy(l.pending), templateVenueId: l.templateVenueId } : null,
            rounds: [
              ...[...this.repo.events.values()].filter((e) => e.productionId === productionId).map((e) => ({ eventId: e.id, openAt: e.openAt, cancelled: e.status === 'CANCELLED', pending: false })),
              ...(this.repo.pending.get(productionId) ?? []).map((e) => ({ eventId: e.eventId, openAt: e.openAt, cancelled: false, pending: true })),
            ],
          };
        },
        rowLayout: async () => copy(layout()?.rows?.doc),
        rowSeatIds: async () => new Set((layout()?.rows?.doc.sections ?? []).flatMap((s) => s.seats.map((x) => x.seatId))),
        // 판 잡기는 이 트랜잭션이 끝날 때 반영한다(던지면 판도 버린다, DB와 같다)
        reserveVersion: async () => {
          const l = layout();
          reserved = l ? { ...l, versionSeq: l.versionSeq + 1 } : { venueId: layoutVenueId(productionId), versionSeq: 1, rows: null, publishedVersion: null, pending: null, templateVenueId: null };
          const r = reserved;
          writes.push(() => this.repo.layouts.set(productionId, { ...(layout() ?? r), versionSeq: r.versionSeq }));
          return r.versionSeq;
        },
        saveRows: async (doc, version, published) => {
          writes.push(() => {
            const l = layout()!;
            this.repo.layouts.set(productionId, { ...l, rows: { version, doc: copy(doc) }, publishedVersion: published ? version : null, pending: null, templateVenueId: doc.templateVenueId ?? null });
          });
        },
        savePending: async (doc, version, saleReview, staged) => {
          writes.push(() => {
            const l = layout()!;
            this.repo.layouts.set(productionId, { ...l, pending: { version, doc: copy(doc), staged } });
            this.repo.productions.set(productionId, { ...this.repo.productions.get(productionId)!, saleReview });
          });
        },
        linkRounds: async () => {
          writes.push(() => {
            const venueId = layout()!.venueId;
            for (const e of this.repo.events.values()) if (e.productionId === productionId) this.repo.events.set(e.id, { ...e, venueId });
            const added = this.repo.pending.get(productionId);
            if (added) this.repo.pending.set(productionId, added.map((e) => ({ ...e, venueId })));
          });
        },
        templateOk: async (id) => this.repo.templates.get(id)?.published === true,
      };
      const value = await fn(tx);
      for (const w of writes) w();
      return value;
    });
    this.#locks.set(productionId, run.catch(() => undefined));
    return run;
  }
}
