// 우선 구매 권리 상태 대조(ADR-0385, GAT-135 A13·A14). purchase DB 원본과 queue-svc q:prio 사본을 30초 [가정]마다 맞춘다.
// ① 기한 지난 OFFERED(진행 중 주문 없음)를 EXPIRED로 바꾸고 ② 만료 전 OFFERED·USED·WITHDRAWN을 SetPriorityGrant로 다시 보낸다.
// 한 항목의 실패는 던지지 않고 지표·로그로 남긴 뒤 다음 틱에 다시 한다. 사본 보내기 실패가 주문·결제 경로를 막지 않는다.
import {
  InvalidPriorityGrantState,
  type PriorityGrantCursor,
  type PriorityGrantExpireResult,
  type PriorityGrantStore,
  type PriorityGrantSyncResult,
  type PriorityGrantSyncSignals,
  type QueuePriorityGrants,
} from '../domain/ports.js';

export type { PriorityGrantExpireResult, PriorityGrantSyncResult, PriorityGrantSyncSignals } from '../domain/ports.js';

export interface PriorityGrantSyncLogger {
  warn(o: Record<string, unknown>, msg: string): void;
  error(o: Record<string, unknown>, msg: string): void;
}

export interface PriorityGrantSyncDeps {
  readonly grants: Pick<PriorityGrantStore, 'expireDue' | 'listSyncable'>;
  readonly copies: QueuePriorityGrants;
  readonly clock: { now(): number };
  readonly logger?: PriorityGrantSyncLogger;
  readonly signals?: PriorityGrantSyncSignals;
}

/** 한 틱에 처리하는 행 수 [가정]. 부정 예매 권리는 드물어 작다 */
export const PRIORITY_GRANT_SYNC_LIMIT = 100;
/** 대조 주기 [가정]. 만료 반복(1초)과 달리 급하지 않다 */
export const PRIORITY_GRANT_SYNC_INTERVAL_MS = 30_000;

const codeOf = (e: unknown): string =>
  typeof e === 'object' && e !== null
    ? String((e as { code?: unknown; name?: unknown }).code ?? (e as { name?: unknown }).name ?? 'unknown')
    : 'unknown';

export class PriorityGrantSync {
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  /** 이어 읽기 위치(`(updated_at, id)` 키셋). 페이지가 끝나면 처음으로 되돌린다(ADR-0385) */
  #cursor: PriorityGrantCursor | undefined;

  constructor(private readonly deps: PriorityGrantSyncDeps) {}

  /** 한 틱. 던지지 않는다(반복이 멈추지 않게). 시험은 직접 부른다 */
  async runOnce(): Promise<void> {
    const now = this.deps.clock.now();
    try {
      await this.deps.grants.expireDue(now, PRIORITY_GRANT_SYNC_LIMIT);
      this.deps.signals?.expire('ok');
    } catch (err) {
      this.deps.signals?.expire('failed');
      this.#log('warn', { step: 'expire', code: codeOf(err) }, '우선 구매 권리 만료 대조 실패(다음 틱에 다시 한다)');
    }

    let rows;
    try {
      rows = await this.deps.grants.listSyncable(now, PRIORITY_GRANT_SYNC_LIMIT, this.#cursor);
    } catch (err) {
      this.#log('warn', { step: 'list', code: codeOf(err) }, '우선 구매 권리 대조 목록 읽기 실패(다음 틱에 다시 한다)');
      return;
    }

    let failed = false;
    for (const g of rows) {
      try {
        await this.deps.copies.set({
          accountId: g.accountId,
          eventId: g.eventId,
          grantId: g.grantId,
          state: g.status,
          expiresAtMs: g.expiresAtMs,
          version: g.version,
        });
        this.#cursor = { updatedAtMs: g.updatedAtMs, grantId: g.grantId };
        this.deps.signals?.sync('ok');
      } catch (err) {
        const invalid = err instanceof InvalidPriorityGrantState;
        this.deps.signals?.sync(invalid ? 'invalid' : 'failed');
        // 로그에는 권리 ID·회차 ID만 둔다(계정 ID·좌석·가격은 싣지 않는다, POL-023)
        this.#log(
          invalid ? 'error' : 'warn',
          { step: 'copy', grantId: g.grantId, eventId: g.eventId, code: codeOf(err) },
          invalid ? '우선 구매 권리 사본이 계약과 다르다' : '우선 구매 권리 사본 보내기 실패(다음 틱에 다시 한다)',
        );
        if (invalid) {
          // 계약·데이터 결함 행은 다시 보내지 않고 커서를 넘긴다(IR-04)
          this.#cursor = { updatedAtMs: g.updatedAtMs, grantId: g.grantId };
          continue;
        }
        // 일시 실패 행은 커서를 그 앞에 두어 다음 틱에 그 행부터 다시 보낸다
        failed = true;
        break;
      }
    }
    // 마지막 페이지를 다 보냈으면 처음으로 되돌린다. 실패가 있으면 커서를 그 앞에 두어 다음 틱에 이어 간다
    if (!failed && rows.length < PRIORITY_GRANT_SYNC_LIMIT) this.#cursor = undefined;
  }

  /** 반복을 켠다. 켜자마자 한 번 돌려 재시작 직후에도 사본을 맞춘다 */
  start(): void {
    if (this.#timer) return;
    void this.#tick();
    this.#timer = setInterval(() => void this.#tick(), PRIORITY_GRANT_SYNC_INTERVAL_MS);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#running;
  }

  async #tick(): Promise<void> {
    if (this.#running) return;
    this.#running = this.runOnce().finally(() => {
      this.#running = undefined;
    });
    await this.#running;
  }

  #log(level: 'warn' | 'error', o: Record<string, unknown>, msg: string): void {
    if (level === 'error') this.deps.logger?.error(o, msg);
    else this.deps.logger?.warn(o, msg);
  }
}
