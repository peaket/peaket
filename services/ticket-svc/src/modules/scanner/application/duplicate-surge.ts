// 중복 입장 급증 경보(GAT-360, offline-gate §7.2): 같은 회차의 DUPLICATE 이상 표시가 10분에 10건 [가정]을 넘으면
// ops-svc의 기존 internal ops-alert 경로로 SEV3를 남기고, 10분 창이 기준 아래로 내려가면 푼다.
// 새 경보 원천을 만들지 않고 이미 쌓이는 gate_flag(DUPLICATE)를 다시 센다.
import type { Clock } from '@peaket/platform';
import { inEntryWindow } from './scanner-freshness.js';
import type { DuplicateSurgeSink, ScannerEventPolicyProvider, ScannerGateStore, ScannerShiftStore } from '../domain/ports.js';

/** 경보 창 10분 [가정](d5 §7.2 '중복 입장 이상 표시가 10분에 12건') */
export const DUPLICATE_SURGE_WINDOW_MS = 10 * 60_000;
/** 기준 10건 [가정](d5 §7.2·offline-gate §7.2) */
export const DUPLICATE_SURGE_THRESHOLD = 10;

export function duplicateSurgeKind(eventId: string): string {
  return `duplicate-surge:${eventId}`;
}

export interface DuplicateSurgeDeps {
  gate: Pick<ScannerGateStore, 'countDuplicateFlags'>;
  shifts: Pick<ScannerShiftStore, 'eventsWithPlacements'>;
  policy?: ScannerEventPolicyProvider;
  sink: DuplicateSurgeSink;
  clock: Clock;
  log?: { warn(o: object, msg?: string): void; info?(o: object, msg?: string): void };
}

export interface DuplicateSurgeReport {
  checkedEvents: number;
  opened: number;
  resolved: number;
  failed: number;
}

export class DuplicateSurge {
  readonly #open = new Set<string>();

  constructor(private readonly d: DuplicateSurgeDeps) {}

  async run(): Promise<DuplicateSurgeReport> {
    const now = this.d.clock.now();
    const report: DuplicateSurgeReport = { checkedEvents: 0, opened: 0, resolved: 0, failed: 0 };
    let events: string[];
    try {
      events = await this.d.shifts.eventsWithPlacements();
    } catch {
      return { ...report, failed: 1 };
    }
    for (const eventId of events) {
      report.checkedEvents += 1;
      let policy;
      try {
        policy = await this.d.policy?.get(eventId);
      } catch {
        policy = undefined;
      }
      // 입장 창 밖이면 세지 않고, 열려 있던 경보는 푼다
      const openWindow = inEntryWindow(policy, now);
      let count = 0;
      if (openWindow) {
        try {
          count = await this.d.gate.countDuplicateFlags({ eventId, sinceMs: now - DUPLICATE_SURGE_WINDOW_MS });
        } catch {
          report.failed += 1;
          continue;
        }
      }
      const key = eventId;
      if (count >= DUPLICATE_SURGE_THRESHOLD) {
        if (this.#open.has(key)) continue;
        try {
          await this.d.sink.open({
            eventKey: eventId,
            kind: duplicateSurgeKind(eventId),
            severity: 'SEV3',
            source: 'ticket-svc',
            reason: `중복 입장 이상 표시가 10분에 ${count}건입니다`,
            detail: { kind: 'DUPLICATE_SURGE', count, windowMs: DUPLICATE_SURGE_WINDOW_MS, threshold: DUPLICATE_SURGE_THRESHOLD, eventId },
            atMs: now,
          });
          this.#open.add(key);
          report.opened += 1;
          this.d.log?.warn?.({ eventId, count, kind: 'duplicate-surge', severity: 'SEV3' }, '중복 입장 급증 경보(SEV3)');
        } catch (err) {
          report.failed += 1;
          this.d.log?.warn?.({ eventId, err: err instanceof Error ? err.message : String(err) }, '중복 입장 급증 경보를 남기지 못했다(다음에 다시 한다)');
        }
        continue;
      }
      if (this.#open.has(key)) {
        try {
          await this.d.sink.resolve({ eventKey: eventId, kind: duplicateSurgeKind(eventId), reason: '중복 입장 이상 표시가 10분 기준 아래로 내려갔다', atMs: now });
          this.#open.delete(key);
          report.resolved += 1;
          this.d.log?.info?.({ eventId, count, kind: 'duplicate-surge' }, '중복 입장 급증 경보를 풀었다');
        } catch (err) {
          report.failed += 1;
          this.d.log?.warn?.({ eventId, err: err instanceof Error ? err.message : String(err) }, '중복 입장 급증 경보 해제에 실패했다(다음에 다시 한다)');
        }
      }
    }
    return report;
  }

  openAlerts(): number {
    return this.#open.size;
  }
}
