// F-04-19 연구 내보내기 서비스(동결 로컬, LCH-330).
// 정본: docs/features/forensic-replay.md §6.1·§6.3·§6.4·§6.6·§8(FX-T10·T17·T21), docs/security/asvs/forensic-replay.md.
// 만들기: 지정·검토 결과서·회차 일정·시간창·보존·한도 → 이용 내역 → 감사 → 레코드.
// 받기: 레코드 → 지정·세션·fetch 가드 → 상태 → 이용 내역·감사 → 바이트.
import { randomUUID } from 'node:crypto';
import {
  RESEARCH_COLUMNS,
  RESEARCH_EXPORT_TTL_MS,
  RESEARCH_WINDOW_MS,
  checkResearchWindow,
  denialAlertDue,
  pseudonymizationLogRow,
  recentDenialCount,
  researchAuditRecord,
  researchDesignationProblem,
  researchExportSessionAllowed,
  researchFetchAllowed,
  researchFileProblem,
  researchOutputColumns,
  researchQuotaExceeded,
  type ResearchActor,
  type ResearchExportOutcome,
  type ResearchExportRecord,
  type ResearchFileProblem,
} from '../domain/research-export.js';
import type {
  PseudonymizationLog,
  ResearchAlerts,
  ResearchAuditSink,
  ResearchDesignations,
  ResearchExportBuffer,
  ResearchExportConfig,
  ResearchExportStore,
  ResearchSchedule,
  ResearchSilverSource,
} from '../domain/ports.js';

const DAY = 86_400_000;
const ALERT_WINDOW_MS = 600_000;

export class ResearchProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    title: string,
    readonly retryAfter?: number,
  ) {
    super(title);
  }
}

export interface ResearchExportsDeps {
  store: ResearchExportStore;
  buffer: ResearchExportBuffer;
  silver: ResearchSilverSource;
  audit: ResearchAuditSink;
  log: PseudonymizationLog;
  config: ResearchExportConfig;
  alerts: ResearchAlerts;
  identity: ResearchDesignations;
  schedule: ResearchSchedule;
  now: () => number;
  /** 만료 정리 실패를 로그·지표로 남긴다. 없으면 stderr JSON 줄을 쓴다. */
  onCleanupError?: (e: unknown) => void;
}

export interface ResearchIdempotency {
  key: string;
  requestHash: Uint8Array;
}

interface RequestBody {
  eventId: string;
  fromMs: number;
  toMs: number;
  reason: string;
}

const utcDayStart = (nowMs: number): number => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const latin1 = (bytes: Uint8Array, from: number, to: number): string =>
  Buffer.from(bytes.subarray(from, to)).toString('latin1');

const logCleanupError = (e: unknown): void => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${JSON.stringify({ level: 'error', service: 'ops-svc', kind: 'research_export_cleanup_error', message })}\n`);
};

export class ResearchExports {
  /** 만들기 멱등 기록(같은 계정·작업·키). DB 판은 뒤 통합에서 idempotency_record로 바꾼다. */
  readonly #idem = new Map<string, { hash: string; exportId: string }>();
  /** 같은 계정의 만들기를 한 번에 하나씩 처리한다(한도 확인과 put 사이의 경합을 닫는다). */
  readonly #tails = new Map<string, Promise<void>>();

  constructor(private readonly d: ResearchExportsDeps) {}

  async request(actor: ResearchActor, body: RequestBody, idem?: ResearchIdempotency): Promise<ResearchExportRecord> {
    return this.#serialize(actor.accountId, () => this.#doRequest(actor, body, idem));
  }

  async #doRequest(actor: ResearchActor, body: RequestBody, idem?: ResearchIdempotency): Promise<ResearchExportRecord> {
    const now = this.d.now();
    const idemKey = idem ? `${actor.accountId}\u0000${idem.key}` : null;
    if (idemKey && idem) {
      const seen = this.#idem.get(idemKey);
      const hash = Buffer.from(idem.requestHash).toString('hex');
      if (seen) {
        if (seen.hash !== hash) throw new ResearchProblem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
        let replay: ResearchExportRecord | null;
        try {
          replay = await this.d.store.get(seen.exportId);
        } catch {
          throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
        }
        if (replay) return replay;
      }
    }
    const designations = await this.#designations(actor);
    const designation = researchDesignationProblem(designations);
    if (designation) await this.#deny(actor, body, null, now, designation, 403);

    if (actor.role !== 'commander') await this.#deny(actor, body, null, now, 'pseudonym-handler-required', 403);
    if (!this.d.config.approvedReviewVersions.includes(this.d.config.allowlistVersion)) {
      await this.#deny(actor, body, null, now, 'pseudonymization-review-pending', 403);
    }

    let schedule: { opensAtMs: number; saleEndsAtMs: number } | undefined;
    try {
      schedule = await this.d.schedule.get(body.eventId);
    } catch {
      throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
    }
    if (!schedule) await this.#deny(actor, body, null, now, 'about:blank', 422);
    const windowProblem = checkResearchWindow({ fromMs: body.fromMs, toMs: body.toMs, saleEndsAtMs: schedule!.saleEndsAtMs, nowMs: now });
    if (windowProblem) await this.#deny(actor, body, null, now, 'about:blank', 422);

    const dayStart = utcDayStart(now);
    const dayEnd = dayStart + DAY;
    let createdToday: number;
    try {
      createdToday = await this.d.store.countCreatedBetween({ accountId: actor.accountId, fromMs: dayStart, toMs: dayEnd });
    } catch {
      throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
    }
    if (researchQuotaExceeded(createdToday)) {
      const retryAfter = Math.max(1, Math.ceil((dayEnd - now) / 1000));
      await this.#deny(actor, body, null, now, 'about:blank', 429, retryAfter);
    }

    const record: ResearchExportRecord = {
      exportId: randomUUID(),
      eventId: body.eventId,
      createdBy: actor.accountId,
      createdBySessionId: actor.sessionId,
      createdByRole: actor.role,
      fromMs: body.fromMs,
      toMs: body.toMs,
      reason: body.reason,
      allowlistVersion: this.d.config.allowlistVersion,
      keyVersion: this.d.config.keyVersion,
      status: 'PENDING',
      createdAtMs: now,
      readyAtMs: null,
      expiresAtMs: now + RESEARCH_EXPORT_TTL_MS,
      rowCount: 0,
      columns: researchOutputColumns(),
      failureType: null,
      saleEndsAtMs: schedule!.saleEndsAtMs,
    };

    // 이용 내역 → 감사 → 레코드. 앞 단계가 실패하면 레코드를 남기지 않는다(§8.14).
    try {
      await this.d.log.append(
        pseudonymizationLogRow({ record, saleEndsAtMs: record.saleEndsAtMs, outcome: 'REQUESTED', rowCount: 0, nowMs: now }),
      );
    } catch {
      throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
    }
    try {
      await this.d.audit.append(researchAuditRecord({ record, outcome: 'REQUESTED', actorRole: actor.role, nowMs: now }));
    } catch {
      throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
    }
    try {
      await this.d.store.put(record);
    } catch {
      throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
    }
    if (idemKey && idem) this.#idem.set(idemKey, { hash: Buffer.from(idem.requestHash).toString('hex'), exportId: record.exportId });
    return record;
  }

  async buildDue(nowMs: number): Promise<number> {
    const pending = await this.d.store.listPending(nowMs, 10);
    let done = 0;
    for (const record of pending) {
      let failure: ResearchFileProblem | 'SILVER_ERROR' | null = null;
      try {
        const out = await this.d.silver.build({ eventId: record.eventId, fromMs: record.fromMs, toMs: record.toMs });
        const problems = researchFileProblem({
          byteLength: out.bytes.byteLength,
          head: latin1(out.bytes, 0, Math.min(6, out.bytes.byteLength)),
          tail: latin1(out.bytes, Math.max(0, out.bytes.byteLength - 6), out.bytes.byteLength),
          columns: out.columns,
          rowCount: out.rowCount,
        });
        if (problems) {
          failure = problems;
        } else {
          // 성공 빌드도 이용 내역을 먼저 남기고 레코드를 READY로 바꾼다. 기록이 실패하면 PENDING으로 두고 다음 tick이 다시 한다.
          const ready: ResearchExportRecord = {
            ...record,
            status: 'READY',
            readyAtMs: nowMs,
            rowCount: out.rowCount,
            columns: [...RESEARCH_COLUMNS],
            failureType: null,
          };
          try {
            await this.d.buffer.put(record.exportId, out.bytes, record.expiresAtMs);
            await this.d.log.append(
              pseudonymizationLogRow({ record: ready, saleEndsAtMs: ready.saleEndsAtMs, outcome: 'READY', rowCount: ready.rowCount, nowMs }),
            );
            await this.d.store.update(ready);
            done += 1;
          } catch {
            // 버퍼·이용 내역·저장 중 하나가 실패하면 레코드는 PENDING 그대로다. 다음 tick이 다시 만든다.
          }
          continue;
        }
      } catch {
        failure = 'SILVER_ERROR';
      }

      // 실패도 감사·이용 내역을 먼저 남기고 레코드를 FAILED로 바꾼다. 기록이 실패하면 PENDING으로 두고 다시 시도한다.
      const failed: ResearchExportRecord = { ...record, status: 'FAILED', failureType: failure };
      try {
        await this.d.log.append(
          pseudonymizationLogRow({ record: failed, saleEndsAtMs: failed.saleEndsAtMs, outcome: 'FAILED', problemType: failure, rowCount: 0, nowMs }),
        );
        await this.d.audit.append(
          researchAuditRecord({ record: failed, outcome: 'FAILED', problemType: failure, actorRole: failed.createdByRole, nowMs }),
        );
        await this.d.store.update(failed);
        done += 1;
      } catch {
        // 기록을 남기지 못했으므로 FAILED로 닫지 않는다. PENDING으로 남겨 다음 tick이 다시 한다.
      }
    }
    // 만료 레코드 정리(IR0419-01). 실패는 숨기지 않고 남기며 다음 tick이 다시 한다.
    try {
      await this.d.store.deleteExpired?.(nowMs);
    } catch (e) {
      (this.d.onCleanupError ?? logCleanupError)(e);
    }
    return done;
  }

  async receive(
    actor: ResearchActor,
    exportId: string,
    fetch: { mode?: string; site?: string },
  ): Promise<{ record: ResearchExportRecord; bytes: Uint8Array }> {
    const now = this.d.now();
    let record: ResearchExportRecord | null;
    try {
      record = await this.d.store.get(exportId);
    } catch {
      throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
    }
    if (!record) throw new ResearchProblem('not-found', 404, '찾을 수 없습니다');

    const designations = await this.#designations(actor);
    if (researchDesignationProblem(designations)) {
      await this.#deny(actor, record, record, now, 'pseudonym-handler-required', 403);
    }
    if (!researchExportSessionAllowed(record, actor)) {
      await this.#deny(actor, record, record, now, 'pseudonym-handler-required', 403);
    }
    if (!researchFetchAllowed(fetch)) {
      await this.#deny(actor, record, record, now, 'pseudonym-handler-required', 403);
    }

    if (now >= record.expiresAtMs) throw new ResearchProblem('not-found', 404, '찾을 수 없습니다');
    if (record.status === 'PENDING') {
      const retryAfter = Math.max(1, Math.ceil((record.expiresAtMs - now) / 1000));
      throw new ResearchProblem('research-export-not-ready', 409, '연구용 내보내기를 아직 만드는 중입니다', retryAfter);
    }
    if (record.status === 'FAILED') throw new ResearchProblem('not-found', 404, '찾을 수 없습니다');
    let bytes: Uint8Array | null;
    try {
      bytes = await this.d.buffer.get(record.exportId, now);
    } catch {
      throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
    }
    if (!bytes) throw new ResearchProblem('not-found', 404, '찾을 수 없습니다');

    try {
      await this.d.log.append(
        pseudonymizationLogRow({ record, saleEndsAtMs: record.saleEndsAtMs, outcome: 'RECEIVED', rowCount: record.rowCount, nowMs: now }),
      );
      await this.d.audit.append(researchAuditRecord({ record, outcome: 'RECEIVED', actorRole: actor.role, nowMs: now }));
    } catch {
      throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
    }
    return { record, bytes };
  }

  async #serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.#tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  async #designations(actor: ResearchActor): Promise<readonly string[]> {
    try {
      return await this.d.identity.designations(actor.accountId);
    } catch {
      throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
    }
  }

  /**
   * 거절을 저장소에 남기고 이용 내역·감사·경보를 쓴 뒤 Problem을 던진다.
   * record가 없으면(만들기 전 거절) 그 요청만의 임시 레코드를 만든다. 그 레코드는 저장하지 않는다.
   */
  async #deny(
    actor: ResearchActor,
    body: { eventId: string; fromMs: number; toMs: number; reason: string },
    existing: ResearchExportRecord | null,
    nowMs: number,
    problemType: string,
    status: number,
    retryAfter?: number,
  ): Promise<never> {
    const record: ResearchExportRecord = existing ?? {
      exportId: randomUUID(),
      eventId: body.eventId,
      createdBy: actor.accountId,
      createdBySessionId: actor.sessionId,
      createdByRole: actor.role,
      fromMs: body.fromMs,
      toMs: body.toMs,
      reason: body.reason,
      allowlistVersion: this.d.config.allowlistVersion,
      keyVersion: this.d.config.keyVersion,
      status: 'FAILED',
      createdAtMs: nowMs,
      readyAtMs: null,
      expiresAtMs: nowMs,
      rowCount: 0,
      columns: researchOutputColumns(),
      failureType: null,
      saleEndsAtMs: nowMs,
    };
    try {
      await this.d.store.recordDenial({ accountId: actor.accountId, atMs: nowMs, problemType });
      const denied = await this.d.store.countDeniedSince({ accountId: actor.accountId, sinceMs: nowMs - ALERT_WINDOW_MS });
      if (denialAlertDue(denied)) {
        await this.d.alerts.raise({ kind: 'RESEARCH_EXPORT_DENIALS', accountId: actor.accountId, count: denied, atMs: nowMs, severity: 'SEV3' });
      }
      await this.d.log.append(
        pseudonymizationLogRow({ record, saleEndsAtMs: record.saleEndsAtMs, outcome: 'DENIED', problemType, rowCount: 0, nowMs }),
      );
      await this.d.audit.append(
        researchAuditRecord({ record, outcome: 'DENIED', problemType, actorRole: actor.role, nowMs }),
      );
    } catch {
      throw new ResearchProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다');
    }
    throw new ResearchProblem(problemType, status, status === 429 ? '요청이 너무 많습니다' : '요청을 처리할 수 없습니다', retryAfter);
  }
}

export const RESEARCH_EXPORT_SWEEP_MS = 5_000;

export interface ResearchExportSweep {
  tick(): Promise<void>;
  stop(): void;
}

/** PENDING 연구 내보내기를 주기적으로 buildDue에 넘긴다. main.ts가 서비스를 만든 뒤 켠다. */
export function startResearchExportSweep(d: {
  buildDue: (nowMs: number) => Promise<number>;
  now: () => number;
  intervalMs?: number;
  onError?: (e: unknown) => void;
}): ResearchExportSweep {
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await d.buildDue(d.now());
    } catch (e) {
      d.onError?.(e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, d.intervalMs ?? RESEARCH_EXPORT_SWEEP_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
