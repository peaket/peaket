// 명령 6 해제 받기(제어 gRPC CONTROL_KIND_ENTRY_PAUSE_RELEASE, F-02-2 OPS-310, ADR-0366 결정 9, ADR-0250, ADR-0105 결정 7).
// - 파드마다 결제사별로 받은 가장 큰 판을 메모리에 둔다. 같거나 작은 판은 아무것도 하지 않고 그 판을 답한다(다시 보내기 멱등)
// - 새 판이면 ReleaseEntryPause를 actor = 요청자 관리 계정 ID, notAfterMs = 판(밀리초로 읽음)으로 부른다. 정지 행의 since가 판보다 늦으면
//   (명령을 낸 뒤 새로 걸린 정지) 열지 않는다. 그래서 파드가 다시 떠 메모리를 잃고 같은 판을 다시 받아도 새 정지를 열지 않는다
// - 처리 뒤 이 파드의 정지 캐시를 바로 비우고(다음 1초 캐시를 기다리지 않는다), 새 정지가 아니었으면 이 파드의 그 결제사 서킷을 한 번 닫는다
//   (조회 길이 막혀 서킷이 스스로 닫히지 못해도 바로 통과한다, C-T44 ②). 다시 멈추는 자동 조건은 그대로다
// - 사유는 넘기지 않는다(감사 기록은 ops-svc 명령 기록, ADR-0250 결정 5). 쓰임새가 받는 사유 칸에는 고정 글을 넣는다(표·로그에 남지 않는다)
// 저장소 오류는 던진다(받는 층이 UNAVAILABLE, ops-svc가 같은 판으로 다시 보낸다). 겨루기(CONFLICT)도 다시 보내기로 넘긴다.
import type { PgName } from '../domain/payment-gateway.js';
import type { EntryReleaseDesired } from '../domain/pg-switch-control.js';
import type { ReleaseEntryPause, ReleaseEntryPauseResult } from './release-entry-pause.js';

/** 쓰임새의 사유 칸에 넣는 고정 글(운영자 사유가 아니다. ReleaseEntryPause는 이 글을 쓰지도 로그에 남기지도 않는다) */
export const ENTRY_RELEASE_CONTROL_REASON = 'ops-command';

/** 겨루기가 이어져 열지 못함(받는 층이 UNAVAILABLE) */
export class EntryReleaseConflict extends Error {
  constructor() {
    super('entry-release-conflict');
    this.name = 'EntryReleaseConflict';
  }
}

export interface ApplyEntryPauseReleaseDeps {
  readonly release: Pick<ReleaseEntryPause, 'execute'>;
  /** 이 파드의 정지 캐시(CachedEntryPauseReader) */
  readonly pauses: { invalidate(): void };
  /** 이 파드의 그 결제사 서킷을 닫는다(PgCallGuards.of(pg)?.closeCircuit()). 던져도 답을 막지 않는다 */
  readonly closeCircuit: (pg: PgName) => void;
}

export interface ApplyEntryPauseReleaseResult {
  readonly appliedVersion: number;
  /** 새 판이 아니라 아무것도 하지 않았다 */
  readonly replayed: boolean;
  /** 새 판일 때 쓰임새의 결과 */
  readonly outcome?: ReleaseEntryPauseResult['kind'];
}

export class ApplyEntryPauseRelease {
  readonly #applied = new Map<PgName, number>();

  constructor(private readonly deps: ApplyEntryPauseReleaseDeps) {}

  /** 이 파드가 그 결제사에 받은 가장 큰 판(없으면 0) */
  appliedVersion(pg: PgName): number {
    return this.#applied.get(pg) ?? 0;
  }

  /**
   * @throws PaymentInputError actor가 길이·제어 문자 검사에 걸림(쓰기 0)
   * @throws EntryReleaseConflict 겨루기가 이어짐 · 저장소 오류
   */
  async run(input: { readonly desired: EntryReleaseDesired; readonly version: number }): Promise<ApplyEntryPauseReleaseResult> {
    const { pg, actor } = input.desired;
    const seen = this.appliedVersion(pg);
    if (input.version <= seen) return { appliedVersion: seen, replayed: true };
    const r = await this.deps.release.execute({ pg, actor, reason: ENTRY_RELEASE_CONTROL_REASON, notAfterMs: input.version });
    if (r.kind === 'CONFLICT') throw new EntryReleaseConflict();
    this.deps.pauses.invalidate();
    if (r.kind !== 'PAUSED_AFTER') {
      try {
        this.deps.closeCircuit(pg);
      } catch {
        // 삼킨다(서킷은 자기 시험 호출로도 닫히고, 정지 캐시가 읽은 해제로 감시기도 닫는다)
      }
    }
    this.#applied.set(pg, input.version);
    return { appliedVersion: input.version, replayed: false, outcome: r.kind };
  }
}
