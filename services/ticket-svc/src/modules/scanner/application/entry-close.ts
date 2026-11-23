// 입장 기록 마감 배경 작업(offline-gate §7.3 'GAT-180 마감 규칙', BUILD_ORDER GAT-180, O-T29).
// 1분 [가정]마다 마감 행이 없고 ticket.event_starts_at이 지난 회차를 (시작, 회차 ID) 차례로 50개 [가정]까지 본다.
// 끝 시각(ends_at)을 core-svc 판매 설정에서 읽지 못하면 그 회차는 건너뛰고(모르는 채 마감하지 않는다) 지표·로그만 남긴다.
// 마감 행을 쓴 뒤 core-svc 내부 입구에 알리고, TIMEOUT이면 미보고 스캐너 CS 건을 ops-svc에 보낸다. 못 보내면 다음 판단마다 다시 보낸다.
// 돌아가며 보기: 앞 판단이 상한(50)을 꽉 채웠으면 그 마지막 회차 다음부터, 덜 채웠으면(끝에 닿았으면) 다음 판단은 처음부터다.
import type { Clock } from '@peaket/platform';
import { scannerUnreportedEventKey, type EntryCloseReason } from '../domain/entry-close.js';
import type { EntryCloseCoreSink, EntryCloseStore, ScannerCaseSink, ScannerEventPolicyProvider } from '../domain/ports.js';

/** 판단 주기 1분 [가정](offline-gate §7.3 '판단') */
export const ENTRY_CLOSE_EVERY_MS = 60_000;
/** 한 판단이 보는 회차 수 50개 [가정](offline-gate §7.3 '판단') */
export const ENTRY_CLOSE_CANDIDATE_LIMIT = 50;
/** 한 판단이 다시 보내는 core 알림·CS 건 수 [가정]. 밀려도 다음 판단이 이어서 보낸다 */
export const ENTRY_CLOSE_RETRY_LIMIT = 100;

/** pino 꼴 로거(시험은 기록기 대역을 넘긴다) */
export interface EntryCloseLogger {
  info?(o: object, msg: string): void;
  warn?(o: object, msg: string): void;
}

/** offline-gate §7.4 지표. 이름표에는 회차·기기 ID를 싣지 않는다(이름표는 reason·kind뿐) */
export interface EntryCloseMetrics {
  closed(reason: EntryCloseReason): void;
  coreSyncFailure(): void;
  /** TIMEOUT 마감에서 만든 미보고 건 수 */
  unreported(count: number): void;
  caseSendFailure(kind: 'SCANNER_UNREPORTED'): void;
  /** 판단에서 건너뛴 회차 수(reason=ends_unknown) */
  skipped(reason: 'ends_unknown'): void;
}

export interface EntryCloseTickDeps {
  store: EntryCloseStore;
  policy: ScannerEventPolicyProvider;
  core: EntryCloseCoreSink;
  /** ops-svc CS 처리함. 없으면(주소 없음) 건 행을 보내지 않고 남긴다 */
  cases?: ScannerCaseSink;
  clock: Clock;
  log?: EntryCloseLogger;
  metrics?: EntryCloseMetrics;
}

export interface EntryCloseTickResult {
  closed: number;
  coreSynced: number;
  casesOpened: number;
}

export class EntryCloseTick {
  /** 앞 판단이 본 마지막 회차(상한을 꽉 채웠을 때만). 새 파드는 처음부터 본다 */
  #afterEventId: string | undefined;

  constructor(private readonly d: EntryCloseTickDeps) {}

  async run(): Promise<EntryCloseTickResult> {
    const nowMs = this.d.clock.now();
    const candidates = await this.d.store.candidates({
      nowMs,
      limit: ENTRY_CLOSE_CANDIDATE_LIMIT,
      ...(this.#afterEventId !== undefined ? { afterEventId: this.#afterEventId } : {}),
    });
    let closed = 0;
    for (const eventId of candidates) {
      let policy: Awaited<ReturnType<ScannerEventPolicyProvider['get']>>;
      try {
        policy = await this.d.policy.get(eventId);
      } catch {
        policy = undefined;
      }
      const endsAtMs = policy?.endsAtMs;
      if (endsAtMs === undefined) {
        this.d.metrics?.skipped('ends_unknown');
        this.d.log?.warn?.({ kind: 'entry-close.ends-unknown', eventId }, 'entry-close.ends-unknown');
        continue;
      }
      try {
        const r = await this.d.store.close({ eventId, nowMs, endsAtMs, clockNow: () => this.d.clock.now() });
        if (!r.closed || r.reason === undefined) continue;
        closed++;
        this.d.metrics?.closed(r.reason);
        if (r.reason === 'TIMEOUT' && r.unreported > 0) this.d.metrics?.unreported(r.unreported);
        this.d.log?.info?.({ kind: 'entry-close.closed', eventId, reason: r.reason, unreported: r.unreported }, 'entry-close.closed');
      } catch (err) {
        this.d.log?.warn?.({ kind: 'entry-close.failed', eventId, err: err instanceof Error ? err.name : 'unknown' }, 'entry-close.failed');
      }
    }
    // 상한을 꽉 채웠으면 마지막 회차 다음부터, 덜 채웠으면(끝에 닿았으면) 다음 판단은 처음부터
    this.#afterEventId = candidates.length === ENTRY_CLOSE_CANDIDATE_LIMIT ? candidates.at(-1) : undefined;

    const coreSynced = await this.#syncCore();
    const casesOpened = await this.#openCases();
    return { closed, coreSynced, casesOpened };
  }

  async #syncCore(): Promise<number> {
    let synced = 0;
    for (const p of await this.d.store.pendingCoreSync(ENTRY_CLOSE_RETRY_LIMIT)) {
      let ok = false;
      let storedAtMs: number | undefined;
      let status: number | undefined;
      try {
        const r = await this.d.core.notify(p.eventId, p.closedAtMs);
        if (r.ok) {
          ok = true;
          storedAtMs = r.storedAtMs;
        } else {
          status = r.status;
        }
      } catch {
        // 연결 끊김·시간 초과. 다음 판단이 다시 보낸다
      }
      if (!ok) {
        this.d.metrics?.coreSyncFailure();
        this.d.log?.warn?.({ kind: 'entry-close.core-sync-failed', eventId: p.eventId, ...(status !== undefined ? { status } : {}) }, 'entry-close.core-sync-failed');
        continue;
      }
      await this.d.store.markCoreSynced(p.eventId, this.d.clock.now());
      synced++;
      if (storedAtMs !== undefined && storedAtMs !== p.closedAtMs) {
        this.d.log?.warn?.({ kind: 'entry-close.core-mismatch', eventId: p.eventId, storedAtMs, closedAtMs: p.closedAtMs }, 'entry-close.core-mismatch');
      }
    }
    return synced;
  }

  async #openCases(): Promise<number> {
    if (!this.d.cases) return 0;
    let opened = 0;
    for (const c of await this.d.store.pendingCases(ENTRY_CLOSE_RETRY_LIMIT)) {
      const at = new Date(c.createdAtMs).toISOString();
      let ok = false;
      try {
        ok = await this.d.cases.open({
          eventKey: c.eventKey,
          kind: 'SCANNER_UNREPORTED',
          sourceId: `${c.eventId}/${c.deviceId}`,
          category: 'UNREPORTED_AT_CLOSE',
          createdAt: at,
          dueBaseAt: at,
        });
      } catch {
        ok = false;
      }
      if (!ok) {
        this.d.metrics?.caseSendFailure('SCANNER_UNREPORTED');
        this.d.log?.warn?.({ kind: 'scanner-unreported.case-failed', eventId: c.eventId, deviceId: c.deviceId }, 'scanner-unreported.case-failed');
        continue;
      }
      await this.d.store.markCaseOpened(c.eventId, c.deviceId, this.d.clock.now());
      opened++;
    }
    return opened;
  }
}

/** 시험·조립이 eventKey를 따로 계산하지 않게 내보낸다(정본과 같은 함수) */
export { scannerUnreportedEventKey };
