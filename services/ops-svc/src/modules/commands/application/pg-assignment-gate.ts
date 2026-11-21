// 명령 12 결제사 지정의 온세일 윈도우·하위 결제사 판정과 명령 12·6 결제 갈래 dry-run 넣는 값(ADR-0349 결정 2·3·4·6, BAT-360 B14~B16).
// 미리보기·접수(CreateCommand.prepare)와 실행 직전(ExecuteCommand.run)이 같은 함수를 부른다. 차례는 온세일 윈도우 → 하위 결제사 판정이다.
// - 판매 설정을 읽지 못하면(5초 [가정] 초과·실패) 503 onsale-window-unavailable, 창 안이면 422 command-out-of-range(detail onsaleWindow)
// - payment-svc 판정이 실패·2초 [가정] 초과면 503 pg-check-unavailable, 걸리면 422 pg-fallback-same-provider(detail은 하위 결제사 이름과 까닭뿐)
// - 원천을 잇지 않은 조립도 닫힌 쪽(503)이다. 접수에서 막히면 명령 행·사건·감사·멱등 기록을 남기지 않는다
// 명령 6 결제 갈래의 dry-run은 판정을 쓰지 않고(전송은 OPS-310) 회차마다 지금 지정·결제사 승인 상한만 읽는다. 읽지 못한 값은 unavailable이고 막지 않는다.
import { ProblemError } from '@peaket/platform';
import { pgAssignParamsOf, pgFallbackParamsOf, type PgAssignParams, type PgFallbackParams } from '../domain/command-params.js';
import { PG_TPS_KEYS, type DryRunCount, type DryRunCountResult, type DryRunUnavailable } from '../domain/dry-run.js';
import { inOnsaleWindow, ONSALE_WINDOW_READ_TIMEOUT_MS } from '../domain/onsale-window.js';
import type { OnsaleStartSource, PgAssignmentCheck, PgAssignmentVerdict, PgName } from '../domain/ports.js';

/** payment-svc 판정 데드라인 2초 [가정](ADR-0349 결정 3) */
export const PG_CHECK_TIMEOUT_MS = 2_000;
/** 503의 Retry-After(초) */
const RETRY_AFTER_SECONDS = 5;
const PG_CHECK_SOURCE = 'payment-svc:CheckEventPgAssignment';

// 제목은 openapi x-peaket-problem-types 목록 그대로다(PRF192)
export const onsaleWindowUnavailable = (): ProblemError =>
  new ProblemError({ type: 'onsale-window-unavailable', status: 503, title: '온세일 윈도우를 지금 확인할 수 없습니다', retryAfterSeconds: RETRY_AFTER_SECONDS });
export const pgCheckUnavailable = (): ProblemError =>
  new ProblemError({ type: 'pg-check-unavailable', status: 503, title: '결제사 지정을 지금 확인할 수 없습니다', retryAfterSeconds: RETRY_AFTER_SECONDS });
const inOnsaleWindowProblem = (): ProblemError => new ProblemError({ type: 'command-out-of-range', status: 422, title: '안전 허용 범위 밖의 명령입니다', detail: 'onsaleWindow' });
const sameProvider = (v: NonNullable<PgAssignmentVerdict['conflict']>): ProblemError =>
  new ProblemError({ type: 'pg-fallback-same-provider', status: 422, title: '대체 결제사가 기본 결제사와 같은 하위 결제사를 거칩니다', detail: `${v.subProvider}:${v.reason}` });

class DeadlineExceeded extends Error {
  constructor() {
    super('deadline-exceeded');
    this.name = 'DeadlineExceeded';
  }
}

/** 한도 안에 끝나지 않으면 던진다(원천이 자기 한도를 지키지 않아도 접수가 오래 묶이지 않게) */
async function within<T>(ms: number, f: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([f(), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new DeadlineExceeded()), ms)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface PgAssignmentGateDeps {
  /** core-svc 판매 설정의 판매 시작. 없으면 명령 12가 503 onsale-window-unavailable이다 */
  readonly onsale?: OnsaleStartSource;
  /** payment-svc 하위 결제사 판정. 없으면 명령 12가 503 pg-check-unavailable이다 */
  readonly pgCheck?: PgAssignmentCheck;
  /** 시험이 한도를 줄인다. 없으면 5초·2초 */
  readonly onsaleTimeoutMs?: number;
  readonly pgCheckTimeoutMs?: number;
}

export class PgAssignmentGate {
  constructor(private readonly deps: PgAssignmentGateDeps = {}) {}

  /** 판매 설정을 읽는다. 404(판매 승인 전)는 undefined */
  async #saleStart(eventId: string): Promise<number | undefined> {
    const onsale = this.deps.onsale;
    if (!onsale) throw onsaleWindowUnavailable();
    try {
      return await within(this.deps.onsaleTimeoutMs ?? ONSALE_WINDOW_READ_TIMEOUT_MS, () => onsale.saleStartMs(eventId));
    } catch {
      throw onsaleWindowUnavailable();
    }
  }

  /** 하위 결제사 판정. 실패·시간 초과는 503 */
  async #verdict(q: { eventId: string; primaryPg: PgName; fallbackPg?: PgName }): Promise<PgAssignmentVerdict> {
    const check = this.deps.pgCheck;
    if (!check) throw pgCheckUnavailable();
    try {
      return await within(this.deps.pgCheckTimeoutMs ?? PG_CHECK_TIMEOUT_MS, () => check.check(q));
    } catch {
      throw pgCheckUnavailable();
    }
  }

  /**
   * 명령 12 확인(접수 전·실행 직전). 통과하면 판정(지금 지정·승인 상한 포함)을 돌려준다.
   * @throws ProblemError 503 onsale-window-unavailable, 422 command-out-of-range(onsaleWindow), 503 pg-check-unavailable, 422 pg-fallback-same-provider
   */
  async checkPgAssign(params: PgAssignParams, nowMs: number): Promise<PgAssignmentVerdict> {
    const saleStart = await this.#saleStart(params.eventId);
    if (inOnsaleWindow(saleStart, nowMs)) throw inOnsaleWindowProblem();
    const verdict = await this.#verdict({ eventId: params.eventId, primaryPg: params.primaryPg, ...(params.fallbackPg !== undefined ? { fallbackPg: params.fallbackPg } : {}) });
    if (!verdict.allowed) throw sameProvider(verdict.conflict ?? { subProvider: 'UNKNOWN', reason: 'UNKNOWN' });
    return verdict;
  }

  /** 검사를 지난 명령 12 params(저장된 값)를 다시 읽어 확인한다(실행 직전) */
  async checkStoredPgAssign(params: Record<string, unknown>, nowMs: number): Promise<PgAssignmentVerdict> {
    return this.checkPgAssign(pgAssignParamsOf(params), nowMs);
  }

  /** 명령 12 dry-run 넣는 값: 지금 지정 기본 결제사와 새 기본 결제사의 승인 상한(초당). 없으면 unavailable */
  pgAssignInputs(params: PgAssignParams, verdict: PgAssignmentVerdict, nowMs: number): DryRunCountResult {
    const counted: DryRunCount[] = [];
    const unavailable: DryRunUnavailable[] = [];
    const at = new Date(nowMs).toISOString();
    const put = (key: string, pg: PgName | undefined, missing: string) => {
      const v = pg === undefined ? undefined : verdict.approvalLimits[pg];
      if (v === undefined || !Number.isFinite(v)) unavailable.push({ key, source: PG_CHECK_SOURCE, reason: pg === undefined ? missing : `approval-limit-missing:${pg}` });
      else counted.push({ key, value: v, source: PG_CHECK_SOURCE, measuredAt: at });
    };
    put(PG_TPS_KEYS.current, verdict.current?.primaryPg, 'current-assignment-missing');
    put(PG_TPS_KEYS.next, params.primaryPg, 'primary-missing');
    return { counted, unavailable };
  }

  /**
   * 명령 6 결제 갈래 dry-run 넣는 값(ADR-0349 결정 6): 회차마다 지금 기본 결제사·전환할 결제사(toPg, 없으면 그 회차의 대체)의 승인 상한.
   * 판정 RPC로 지금 지정과 승인 상한만 읽고 허용 여부는 쓰지 않는다(물을 기본 결제사 칸은 toPg, 없으면 TOSS). 실패는 그 회차 값만 unavailable이다
   */
  async pgFallbackInputs(params: Record<string, unknown>, nowMs: number): Promise<DryRunCountResult> {
    let p: PgFallbackParams;
    try {
      p = pgFallbackParamsOf(params);
    } catch {
      return { counted: [], unavailable: [] };
    }
    if (p.scope !== 'EVENT') return { counted: [], unavailable: [] };
    const at = new Date(nowMs).toISOString();
    const rows = await Promise.all(
      p.eventIds.map(async (eventId): Promise<DryRunCountResult> => {
        const currentKey = `${PG_TPS_KEYS.current}:${eventId}`;
        const nextKey = `${PG_TPS_KEYS.next}:${eventId}`;
        let verdict: PgAssignmentVerdict;
        try {
          verdict = await this.#verdict({ eventId, primaryPg: p.toPg ?? 'TOSS' });
        } catch {
          return { counted: [], unavailable: [currentKey, nextKey].map((key) => ({ key, source: PG_CHECK_SOURCE, reason: 'pg-check-unavailable' })) };
        }
        const counted: DryRunCount[] = [];
        const unavailable: DryRunUnavailable[] = [];
        const put = (key: string, pg: PgName | undefined, missing: string) => {
          const v = pg === undefined ? undefined : verdict.approvalLimits[pg];
          if (v === undefined || !Number.isFinite(v)) unavailable.push({ key, source: PG_CHECK_SOURCE, reason: pg === undefined ? missing : `approval-limit-missing:${pg}` });
          else counted.push({ key, value: v, source: PG_CHECK_SOURCE, measuredAt: at });
        };
        put(currentKey, verdict.current?.primaryPg, 'current-assignment-missing');
        put(nextKey, p.toPg ?? verdict.current?.fallbackPg, 'fallback-missing');
        return { counted, unavailable };
      }),
    );
    return { counted: rows.flatMap((r) => r.counted), unavailable: rows.flatMap((r) => r.unavailable) };
  }
}
