// 스캔 기록 즉시 업로드(offline-gate §6.5 '업로드 첫 구현', 계획 §3).
// - 큐에 처음 쓴 때부터 5초 뒤, 500건이 되면 바로, online·화면 복귀·[지금 동기화]는 바로 보낸다.
// - 한 번에 500건. acceptedIds만 지우고 나머지는 5초 × 3^(시도 수 − 1), 최대 5분 뒤로 미룬다.
// - 400은 최대 간격, 401은 WWW-Authenticate error로 가른다. 403 device-revoked·device-unregistered면 멈춘다.
// - 시계·타이머는 주입한다(고정 대기 없음).
import type { ScanQueue, ScanQueueRecord } from '../storage/scan-queue.ts';

export interface UploadPort {
  upload(batch: unknown[], o: { withToken: boolean }): Promise<{ acceptedIds: string[]; resyncRequired: boolean }>;
}

export interface UploadState {
  pending: number;
  failed: boolean;
  lastUploadAtMs?: number;
  stopped?: 'device-revoked' | 'device-unregistered';
}

export interface UploadTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

/** 5초 × 3^(시도 수 − 1), 최대 5분 */
export function retryDelayMs(attempts: number): number {
  if (attempts <= 1) return 5_000;
  return Math.min(300_000, 5_000 * 3 ** (attempts - 1));
}

/** WWW-Authenticate(DPoP 머리)의 error 값 둘만 고른다 */
export function authErrorOf(wwwAuthenticate: string | null): 'invalid_token' | 'invalid_dpop_proof' | undefined {
  if (!wwwAuthenticate) return undefined;
  const m = /\berror="([^"]*)"/.exec(wwwAuthenticate);
  if (!m) return undefined;
  return m[1] === 'invalid_token' || m[1] === 'invalid_dpop_proof' ? m[1] : undefined;
}

const BATCH = 500;
const DEBOUNCE_MS = 5_000;

interface ErrorLike {
  status?: number;
  authError?: string;
}

export interface ScanUploaderDeps extends UploadTimers {
  queue: ScanQueue;
  port: UploadPort;
  hasToken(): Promise<boolean>;
  clearToken(): Promise<void>;
  now(): number;
  onState(s: UploadState): void;
  onResync(): void;
  onSignedOut(): void;
}

export class ScanUploader {
  readonly #d: ScanUploaderDeps;
  #timer: unknown;
  #timerAtMs: number | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  #stopped: 'device-revoked' | 'device-unregistered' | undefined;
  #lastUploadAtMs: number | undefined;
  #nextRetryAtMs: number | undefined;
  #signedOut = false;
  #resyncCalled = false;

  constructor(d: ScanUploaderDeps) {
    this.#d = d;
  }

  /** 큐에 쓴 뒤 부른다. 500건이면 바로, 아니면 5초 타이머를 건다 */
  async queued(): Promise<void> {
    if (this.#stopped) return;
    const pending = await this.#d.queue.count();
    if (pending >= BATCH) {
      this.#trigger();
      return;
    }
    this.#schedule(this.#d.now() + DEBOUNCE_MS);
  }

  /** 지금 큐에 있는 기록을 500건씩 차례로 보낸다. 한 묶음이 실패하면 멈춘다 */
  flushNow(): Promise<{ sent: number; accepted: number; deferred: number; tokenCleared: boolean }> {
    this.#clearTimer();
    if (this.#stopped) return Promise.resolve({ sent: 0, accepted: 0, deferred: 0, tokenCleared: false });
    const run = this.#chain.then(() => this.#runOnce(true));
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  stop(): void {
    this.#stopped = 'device-revoked';
    this.#clearTimer();
  }

  #trigger(): void {
    this.#clearTimer();
    const run = this.#chain.then(() => this.#runOnce(false));
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    void run.catch(() => undefined);
  }

  #schedule(atMs: number): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined && this.#timerAtMs !== undefined && this.#timerAtMs <= atMs) return;
    this.#clearTimer();
    this.#timerAtMs = atMs;
    const delay = Math.max(0, atMs - this.#d.now());
    this.#timer = this.#d.setTimer(() => {
      this.#timer = undefined;
      this.#timerAtMs = undefined;
      this.#trigger();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#d.clearTimer(this.#timer);
    this.#timer = undefined;
    this.#timerAtMs = undefined;
  }

  async #runOnce(all: boolean): Promise<{ sent: number; accepted: number; deferred: number; tokenCleared: boolean }> {
    let sent = 0;
    let accepted = 0;
    let tokenCleared = false;
    let failed = false;
    let firstNextMs: number | undefined;
    if (!this.#stopped) {
      for (;;) {
        const batch = await this.#d.queue.due(all ? Number.MAX_SAFE_INTEGER : this.#d.now(), BATCH);
        if (batch.length === 0) break;
        sent += batch.length;
        const outcome = await this.#sendBatch(batch);
        accepted += outcome.accepted;
        if (outcome.tokenCleared) tokenCleared = true;
        if (outcome.ok) {
          this.#lastUploadAtMs = this.#d.now();
        } else {
          failed = true;
          const at = outcome.nextAtMs ?? this.#d.now();
          if (firstNextMs === undefined || at < firstNextMs) firstNextMs = at;
        }
        if (!outcome.complete) break;
      }
    }
    this.#nextRetryAtMs = sent === 0 ? this.#nextRetryAtMs : failed ? firstNextMs : undefined;
    const pending = await this.#d.queue.count();
    const state: UploadState = {
      pending,
      failed: pending > 0 && (failed || this.#nextRetryAtMs !== undefined),
      ...(this.#lastUploadAtMs !== undefined ? { lastUploadAtMs: this.#lastUploadAtMs } : {}),
      ...(this.#stopped ? { stopped: this.#stopped } : {}),
    };
    this.#d.onState(state);
    if (this.#stopped) {
      this.#clearTimer();
    } else if (pending > 0) {
      this.#schedule(this.#nextRetryAtMs ?? this.#d.now() + DEBOUNCE_MS);
    } else {
      this.#clearTimer();
    }
    return { sent, accepted, deferred: sent - accepted, tokenCleared };
  }

  /** 한 묶음. 401은 한 번만 다시 보낸다. complete가 거짓이면 다음 묶음으로 가지 않는다 */
  async #sendBatch(batch: ScanQueueRecord[]): Promise<{ ok: boolean; accepted: number; complete: boolean; tokenCleared: boolean; nextAtMs?: number }> {
    let tokenCleared = false;
    let withToken = await this.#d.hasToken();
    let reply: { acceptedIds: string[]; resyncRequired: boolean } | undefined;
    let failure: unknown;
    let retried = false;
    // 서버가 받는 것은 큐 행이 아니라 그 안의 ScanEvent 본문(JSON)이다
    const bodies = batch.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    for (;;) {
      try {
        reply = await this.#d.port.upload(bodies, { withToken });
        break;
      } catch (e) {
        failure = e;
        if (retried) break;
        const status = (e as ErrorLike).status;
        const auth = (e as ErrorLike).authError;
        if (status === 401 && auth === 'invalid_token' && withToken) {
          await this.#d.clearToken();
          tokenCleared = true;
          if (!this.#signedOut) {
            this.#signedOut = true;
            this.#d.onSignedOut();
          }
          withToken = false;
          retried = true;
          continue;
        }
        if (status === 401 && auth === 'invalid_dpop_proof' && withToken) {
          retried = true;
          continue;
        }
        break;
      }
    }
    if (!reply) {
      const status = (failure as ErrorLike | undefined)?.status;
      if (status === 403) {
        const type = (failure as { type?: string } | undefined)?.type;
        if (type === 'device-revoked' || type === 'device-unregistered') {
          this.#stopped = type;
          return { ok: false, accepted: 0, complete: false, tokenCleared };
        }
      }
      const delay = status === 400 ? 300_000 : this.#delayFor(batch);
      const nextAtMs = this.#d.now() + delay;
      await this.#failAll(batch, nextAtMs);
      return { ok: false, accepted: 0, complete: false, tokenCleared, nextAtMs };
    }
    const taken = new Set(reply.acceptedIds);
    for (const row of batch) if (taken.has(row.id)) await this.#d.queue.ack(row.id);
    const left = batch.filter((r) => !taken.has(r.id));
    if (left.length > 0) {
      const nextAtMs = this.#d.now() + retryDelayMs(Math.min(...left.map((r) => r.attempts)) + 1);
      for (const row of left) await this.#d.queue.fail(row.id, nextAtMs);
      return { ok: false, accepted: taken.size, complete: left.length === 0, tokenCleared, nextAtMs };
    }
    if (reply.resyncRequired && !this.#resyncCalled) {
      this.#resyncCalled = true;
      this.#d.onResync();
    }
    return { ok: true, accepted: taken.size, complete: true, tokenCleared };
  }

  #delayFor(batch: ScanQueueRecord[]): number {
    const attempts = Math.min(...batch.map((r) => r.attempts)) + 1;
    return retryDelayMs(attempts);
  }

  async #failAll(batch: ScanQueueRecord[], nextAtMs: number): Promise<void> {
    for (const row of batch) await this.#d.queue.fail(row.id, nextAtMs);
  }
}

/**
 * 로그아웃: 온라인이면 큐가 빌 때까지 flushNow를 되풀이하고(최대 timeoutMs, 기본 10초) 토큰을 지운다.
 * 오프라인이면 보내지 않고 바로 토큰을 지운다. 남은 기록은 기기 인증으로 올라간다.
 */
export async function logoutAfterFlush(
  d: Partial<UploadTimers> & { uploader: { flushNow(): Promise<unknown> }; online: boolean; queue: { count(): Promise<number> }; clearToken(): Promise<void>; now(): number; timeoutMs?: number },
): Promise<{ remaining: number }> {
  if (!d.online) {
    await d.clearToken();
    return { remaining: await d.queue.count() };
  }
  const timeoutMs = d.timeoutMs ?? 10_000;
  const setTimer: UploadTimers['setTimer'] = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer: UploadTimers['clearTimer'] = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown;
  const timeout = new Promise<void>((resolve) => {
    handle = setTimer(resolve, timeoutMs);
  });
  const work = (async () => {
    for (let i = 0; i < 100; i++) {
      await d.uploader.flushNow();
      if ((await d.queue.count()) === 0) return;
    }
  })();
  await Promise.race([work, timeout]);
  clearTimer(handle);
  await d.clearToken();
  return { remaining: await d.queue.count() };
}
