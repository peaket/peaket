// 시험·로컬용 입장 기록 마감 저장소(운영은 DrizzleEntryCloseStore). 같은 계약(entry-close-store-contract)을 둘 다에 돌린다.
// 회차 잠금·업로드 겹침의 실제 DB 동작은 운영 어댑터 몫이고, 여기서는 판단(decideEntryClose)과 한 번만 마감을 지킨다.
import { decideEntryClose, scannerUnreportedEventKey, type EntryCloseReason } from '../domain/entry-close.js';
import type { EntryCloseStore, ScannerShiftStore } from '../domain/ports.js';

interface MemoryReport {
  pendingUploads: number;
  reportedAtMs: number;
}

const keyOf = (eventId: string, deviceId: string): string => `${eventId}/${deviceId}`;

export interface MemoryEntryCloseStoreOptions {
  /** 배치 확인과 '로그인했던 기기'(근무 준비 보고)를 같은 저장소 뒤에서 읽는다 */
  shifts: ScannerShiftStore;
}

export class MemoryEntryCloseStore implements EntryCloseStore {
  /** 후보 고르기에 쓰는 ticket.event_starts_at 대역(시험이 seedEventStart로 심는다) */
  readonly starts = new Map<string, number>();
  readonly reports = new Map<string, MemoryReport>();
  readonly closes = new Map<string, { closedAtMs: number; reason: EntryCloseReason; coreSyncedAtMs?: number }>();
  readonly cases = new Map<string, { eventKey: string; createdAtMs: number; openedAtMs?: number }>();
  /** 회차별로 마감을 한 줄로 세운다(운영의 회차 잠금 대역) */
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(private readonly o: MemoryEntryCloseStoreOptions) {}

  /** 시험: 그 회차의 티켓 하나를 발권 때 받은 회차 시작과 함께 심는다 */
  seedEventStart(eventId: string, startsAtMs: number): void {
    this.starts.set(eventId, startsAtMs);
  }

  async putQueueReport(i: { eventId: string; deviceId: string; pendingUploads: number; nowMs: number }): Promise<'stored' | 'no_placement'> {
    if (!(await this.o.shifts.placementOf(i.eventId, i.deviceId))) return 'no_placement';
    this.reports.set(keyOf(i.eventId, i.deviceId), { pendingUploads: i.pendingUploads, reportedAtMs: i.nowMs });
    return 'stored';
  }

  async candidates(i: { nowMs: number; limit: number; afterEventId?: string }): Promise<string[]> {
    const all = [...this.starts.entries()]
      .filter(([eventId, startsAtMs]) => startsAtMs <= i.nowMs && !this.closes.has(eventId))
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    let rows = all;
    if (i.afterEventId !== undefined) {
      const afterStart = this.starts.get(i.afterEventId);
      // 기억한 회차의 티켓 행이 없으면(보존 기한 삭제) 처음부터 본다
      if (afterStart !== undefined) rows = all.filter(([eventId, startsAtMs]) => startsAtMs > afterStart || (startsAtMs === afterStart && eventId > i.afterEventId!));
    }
    return rows.slice(0, i.limit).map(([eventId]) => eventId);
  }

  close(i: { eventId: string; nowMs: number; endsAtMs: number; clockNow: () => number }): Promise<{ closed: boolean; reason?: EntryCloseReason; closedAtMs?: number; unreported: number }> {
    const prev = this.#chains.get(i.eventId) ?? Promise.resolve();
    const next = prev.then(
      () => this.#close(i),
      () => this.#close(i),
    );
    this.#chains.set(
      i.eventId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async #close(i: { eventId: string; nowMs: number; endsAtMs: number; clockNow: () => number }): Promise<{ closed: boolean; reason?: EntryCloseReason; closedAtMs?: number; unreported: number }> {
    if (this.closes.has(i.eventId)) return { closed: false, unreported: 0 };
    const devices = (await this.o.shifts.readinessDevices?.(i.eventId)) ?? [];
    const decision = decideEntryClose({
      nowMs: i.nowMs,
      endsAtMs: i.endsAtMs,
      devices: devices.map((deviceId) => {
        const report = this.reports.get(keyOf(i.eventId, deviceId));
        return { deviceId, ...(report ? { report } : {}) };
      }),
    });
    if (!decision.close) return { closed: false, unreported: 0 };
    const closedAtMs = i.clockNow();
    this.closes.set(i.eventId, { closedAtMs, reason: decision.reason });
    for (const deviceId of decision.unreportedDeviceIds) {
      this.cases.set(keyOf(i.eventId, deviceId), { eventKey: scannerUnreportedEventKey(i.eventId, deviceId), createdAtMs: closedAtMs });
    }
    return { closed: true, reason: decision.reason, closedAtMs, unreported: decision.unreportedDeviceIds.length };
  }

  async closedAt(eventId: string): Promise<number | undefined> {
    return this.closes.get(eventId)?.closedAtMs;
  }

  async pendingCoreSync(limit: number): Promise<{ eventId: string; closedAtMs: number }[]> {
    return [...this.closes.entries()]
      .filter(([, c]) => c.coreSyncedAtMs === undefined)
      .sort((a, b) => a[1].closedAtMs - b[1].closedAtMs || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([eventId, c]) => ({ eventId, closedAtMs: c.closedAtMs }));
  }

  async markCoreSynced(eventId: string, nowMs: number): Promise<void> {
    const c = this.closes.get(eventId);
    if (c) this.closes.set(eventId, { ...c, coreSyncedAtMs: nowMs });
  }

  async pendingCases(limit: number): Promise<{ eventId: string; deviceId: string; eventKey: string; createdAtMs: number }[]> {
    return [...this.cases.entries()]
      .filter(([, c]) => c.openedAtMs === undefined)
      .sort((a, b) => a[1].createdAtMs - b[1].createdAtMs || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([key, c]) => {
        const slash = key.indexOf('/');
        return { eventId: key.slice(0, slash), deviceId: key.slice(slash + 1), eventKey: c.eventKey, createdAtMs: c.createdAtMs };
      });
  }

  async markCaseOpened(eventId: string, deviceId: string, nowMs: number): Promise<void> {
    const key = keyOf(eventId, deviceId);
    const c = this.cases.get(key);
    if (c) this.cases.set(key, { ...c, openedAtMs: nowMs });
  }
}
