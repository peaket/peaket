// 명령 6 해제의 쓰임새(docs/features/payment.md §2 '정지 판정자의 첫 구현', ADR-0105 결정 7, ADR-0250, BUILD_ORDER PRF-202).
// 부르는 쪽은 제어 gRPC 받는 쪽 ApplyEntryPauseRelease다(명령 6 해제, F-02-2 OPS-310, ADR-0366 결정 9). 사유 글은 쓰지도 로그에 남기지도 않는다.
// notAfterMs를 주면 정지 행의 since가 그보다 늦은 정지(명령을 낸 뒤 새로 걸린 정지)는 열지 않고 PAUSED_AFTER다(ADR-0366 결정 9, ADR-0250 결정 3 보완).
import type { Clock } from '@peaket/platform';
import { ENTRY_PAUSE_RELEASE_RETRIES, parseReleaseEntryPause } from '../domain/entry-pause-judge.js';
import type { EntryPauseJudgeLog, EntryPauseJudgeSignals, EntryPauseStore } from '../domain/ports.js';

export interface ReleaseEntryPauseDeps {
  store: EntryPauseStore;
  clock: Clock;
  log: Pick<EntryPauseJudgeLog, 'transition' | 'released'>;
  signals: Pick<EntryPauseJudgeSignals, 'writeConflict'>;
}

/** ALREADY_OPEN 쓸 것이 없었다, RELEASED 열었다, PAUSED_AFTER notAfterMs보다 늦게 걸린 정지라 열지 않았다, CONFLICT 2회 [가정] 더 해도 겨루어 졌다 */
export type ReleaseEntryPauseResult = { readonly kind: 'ALREADY_OPEN' } | { readonly kind: 'RELEASED' } | { readonly kind: 'PAUSED_AFTER' } | { readonly kind: 'CONFLICT' };

const ALREADY_OPEN: ReleaseEntryPauseResult = Object.freeze({ kind: 'ALREADY_OPEN' });
const RELEASED: ReleaseEntryPauseResult = Object.freeze({ kind: 'RELEASED' });
const CONFLICT: ReleaseEntryPauseResult = Object.freeze({ kind: 'CONFLICT' });
const PAUSED_AFTER: ReleaseEntryPauseResult = Object.freeze({ kind: 'PAUSED_AFTER' });

export class ReleaseEntryPause {
  constructor(readonly deps: ReleaseEntryPauseDeps) {}

  /**
   * @throws PaymentInputError 입력이 틀림(저장소를 읽지 않는다)
   * @throws 저장소 오류(부르는 쪽이 같은 명령으로 다시 보낸다)
   */
  async execute(input: { readonly pg: string; readonly actor: string; readonly reason: string; readonly notAfterMs?: number }): Promise<ReleaseEntryPauseResult> {
    const { pg, actor } = parseReleaseEntryPause(input);
    const { store, clock, log, signals } = this.deps;
    for (let attempt = 0; attempt <= ENTRY_PAUSE_RELEASE_RETRIES; attempt += 1) {
      const row = await store.readRecord(pg);
      if (row === undefined || row.stage === 'OPEN') return ALREADY_OPEN;
      if (input.notAfterMs !== undefined && row.sinceMs > input.notAfterMs) return PAUSED_AFTER;
      const written = await store.write(row, { pg, stage: 'OPEN', reason: row.reason, actor, sinceMs: row.sinceMs, reopenedAtMs: clock.now() });
      if (written) {
        log.released({ pg, actor });
        log.transition({ pg, from: row.stage, to: 'OPEN', reason: row.reason, actor });
        return RELEASED;
      }
      signals.writeConflict(pg);
    }
    return CONFLICT;
  }
}
