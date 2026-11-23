// 시험·로컬용 입장 기록 마감 알림 저장소. 운영은 DrizzleEntryClosedStore다.
// event.entry_closed_at 대역과 판매 설정 사본(eventClosedAtMs)을 함께 기억한다. 사본 행이 없으면 칸만 쓴다.
import type { MemoryCatalogRepository } from './memory-catalog-repository.js';
import { ENTRY_ROLE_END_AFTER_ENDS_MS, type EntryClosedResult, type EntryClosedStore, type SaleConfigStore } from '../domain/sale-config-ports.js';

export class MemoryEntryClosedStore implements EntryClosedStore {
  readonly entryClosedAt = new Map<string, number>();

  constructor(
    private readonly repo: MemoryCatalogRepository,
    private readonly configs: SaleConfigStore,
  ) {}

  async markEntryClosed(eventId: string, closedAtMs: number): Promise<EntryClosedResult> {
    if (!this.repo.events.has(eventId)) return { status: 'not-found' };
    const existing = this.entryClosedAt.get(eventId);
    if (existing !== undefined) return { status: 'unchanged', entryClosedAtMs: existing };
    const config = await this.configs.get(eventId);
    const endsAtMs = config?.endsAtMs ?? this.repo.details.get(eventId)?.event?.endsAt?.getTime();
    if (endsAtMs === undefined || closedAtMs < endsAtMs + ENTRY_ROLE_END_AFTER_ENDS_MS) return { status: 'too-early' };
    this.entryClosedAt.set(eventId, closedAtMs);
    if (config) await this.configs.put([{ ...config, entryClosedAtMs: closedAtMs }], []);
    return { status: 'stored', entryClosedAtMs: closedAtMs };
  }
}
