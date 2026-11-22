// 시험용 메모리 sale_control 저장소. Drizzle 구현과 같은 조건부 쓰기 규칙을 지킨다(판매 중지와 명령 3의 판은 따로, ADR-0365 결정 6).
import type { SaleControlStore } from '../domain/ports.js';
import type { PlatformSalePause, SaleControl, SaleControlSnapshot, SalePauseApplied, SalePauseWrite, SaleSuspensionApplied, SaleSuspensionWrite } from '../domain/sale-control.js';

export class MemorySaleControlStore implements SaleControlStore {
  readonly rows = new Map<string, SaleControl>();
  /** 전체 범위(PLATFORM) 행 */
  platform: PlatformSalePause | undefined;
  /** 참이면 snapshot이 던진다(원본을 읽지 못하는 파드, 시험용) */
  failSnapshot = false;

  async find(eventId: string): Promise<SaleControl | undefined> {
    return this.rows.get(eventId);
  }

  async apply(write: SaleSuspensionWrite): Promise<SaleSuspensionApplied> {
    const current = this.rows.get(write.eventId);
    if (current && current.commandId === write.commandId && current.suspended === write.suspended) return { control: current, changed: false };
    if (current && write.version !== undefined && write.version <= current.revision) return { control: current, changed: false };
    const control: SaleControl = {
      ...(current ?? {}),
      eventId: write.eventId,
      paused: current?.paused ?? false,
      suspended: write.suspended,
      revision: Math.max((current?.revision ?? 0) + 1, write.version ?? 0),
      commandId: write.commandId,
      ...(write.suspensionRef !== undefined ? { suspensionRef: write.suspensionRef } : current?.suspensionRef !== undefined ? { suspensionRef: current.suspensionRef } : {}),
      reason: write.reason,
      updatedAtMs: write.nowMs,
    };
    this.rows.set(write.eventId, control);
    return { control, changed: true };
  }

  async applyPause(write: SalePauseWrite): Promise<SalePauseApplied> {
    const cur: PlatformSalePause | SaleControl | undefined = write.scope.kind === 'EVENT' ? this.rows.get(write.scope.eventId) : this.platform;
    const curRev = cur?.pausedRevision ?? 0;
    if (cur && write.version <= curRev) {
      return { paused: cur.paused, appliedVersion: curRev, ...(cur.pausedCommandId !== undefined ? { commandId: cur.pausedCommandId } : {}), ...(cur.pausedChangedAtMs !== undefined ? { changedAtMs: cur.pausedChangedAtMs } : {}), changed: false };
    }
    const changedAtMs = cur && cur.paused === write.paused && cur.pausedChangedAtMs !== undefined ? cur.pausedChangedAtMs : write.nowMs;
    const pause = { paused: write.paused, pausedRevision: write.version, pausedCommandId: write.commandId, pausedChangedAtMs: changedAtMs };
    if (write.scope.kind === 'EVENT') {
      const row = this.rows.get(write.scope.eventId);
      this.rows.set(write.scope.eventId, { ...(row ?? { eventId: write.scope.eventId, suspended: false, revision: 1 }), ...pause, updatedAtMs: write.nowMs });
    } else {
      this.platform = pause;
    }
    return { paused: write.paused, appliedVersion: write.version, commandId: write.commandId, changedAtMs, changed: true };
  }

  async snapshot(): Promise<SaleControlSnapshot> {
    if (this.failSnapshot) throw new Error('sale_control을 읽지 못했다(시험)');
    return { events: [...this.rows.values()], ...(this.platform ? { platform: this.platform } : {}) };
  }
}
