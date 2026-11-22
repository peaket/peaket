// SSE 연결 하나(관제 늘 여는 흐름·위젯 흐름이 함께 쓴다, ADR-0100 결정 2, ADR-0360 결정 4·5).
// - 첫 덩이에 retry: 10000(커서가 있으면 id 줄), 15초 [가정]마다 주석 줄 ': hb'
// - 액세스 토큰 만료 시각에 닫고(token-expired), 5초 [가정]마다 종료 세션 목록을 봐 닫는다(session-ended)
// - 읽지 않아 쌓인 양이 상한(1MiB [가정])을 넘으면 닫는다(backpressure). 브라우저가 끊으면 client
// 닫힌 까닭은 정규 로그 한 줄로 남긴다(event ops-live-closed, reason).
import { TERMINATED_SESSION_TTL_MS, type PlatformLogger, type Principal } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  OPS_LIVE_HEARTBEAT_MS,
  OPS_LIVE_PENDING_LIMIT_BYTES,
  OPS_LIVE_SESSION_CHECK_MS,
  SSE_HEARTBEAT,
  TOKEN_EXP_HEADER,
  formatSse,
  sseOpening,
  type LiveCloseReason,
  type OpsLiveEvent,
} from '../domain/live.js';

/** 토큰 만료 머리가 없을 때 연 시각부터 닫을 때까지: 액세스 토큰 수명(platform TERMINATED_SESSION_TTL_MS, identity §3, ADR-0360 결정 4) */
export const OPS_LIVE_ACCESS_TOKEN_TTL_MS = TERMINATED_SESSION_TTL_MS;

/**
 * 토큰 만료로 닫을 시각. 게이트웨이가 넣은 만료(epoch 초)와 연 시각 + 액세스 토큰 수명 가운데 이른 쪽이다(머리로 늘릴 수 없다)
 * @param header x-user-token-exp 값
 * @param openedAtMs 연 시각
 */
export function tokenDeadlineOf(header: string | undefined, openedAtMs: number): number {
  const cap = openedAtMs + OPS_LIVE_ACCESS_TOKEN_TTL_MS;
  if (header === undefined || !/^\d{1,12}$/.test(header.trim())) return cap;
  return Math.min(cap, Number(header.trim()) * 1000);
}

/** 종료 세션 목록(platform AuthState.terminated)의 읽기 면 */
export interface TerminatedSessionsView {
  has(sessionId: string): boolean;
}

export interface SseConnectionOptions {
  readonly stream: 'ops-live' | 'ops-event-live';
  readonly me: Principal | undefined;
  readonly nowMs: number;
  readonly terminated?: TerminatedSessionsView;
  readonly logger?: PlatformLogger;
  readonly heartbeatMs?: number;
  readonly sessionCheckMs?: number;
  readonly pendingLimitBytes?: number;
}

export class SseConnection {
  #closed = false;
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #onClose: (() => void)[] = [];
  closedReason: LiveCloseReason | undefined;

  constructor(
    private readonly request: FastifyRequest,
    private readonly reply: FastifyReply,
    private readonly o: SseConnectionOptions,
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  /** 응답 머리와 첫 덩이를 쓰고 타이머를 켠다 */
  open(cursor?: number): void {
    this.reply.hijack();
    this.reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.writeRaw(sseOpening(cursor));
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.#timers.push(t);
    };
    every(this.o.heartbeatMs ?? OPS_LIVE_HEARTBEAT_MS, () => this.writeRaw(SSE_HEARTBEAT));
    const header = this.request.headers[TOKEN_EXP_HEADER];
    const deadline = tokenDeadlineOf(typeof header === 'string' ? header : undefined, this.o.nowMs);
    const expiry = setTimeout(() => this.close('token-expired'), Math.max(0, deadline - this.o.nowMs));
    expiry.unref?.();
    this.#timers.push(expiry);
    const sessionId = this.o.me?.sessionId;
    if (this.o.terminated && sessionId) {
      const terminated = this.o.terminated;
      every(this.o.sessionCheckMs ?? OPS_LIVE_SESSION_CHECK_MS, () => {
        if (terminated.has(sessionId)) this.close('session-ended');
      });
    }
    this.request.raw.on('close', () => this.close('client'));
    this.request.raw.on('error', () => this.close('client'));
  }

  /** 닫힐 때 부를 것(구독 끊기 등) */
  onClose(fn: () => void): void {
    if (this.#closed) fn();
    else this.#onClose.push(fn);
  }

  send(e: OpsLiveEvent): void {
    this.writeRaw(formatSse(e));
  }

  private writeRaw(chunk: string): void {
    if (this.#closed) return;
    const raw = this.reply.raw;
    raw.write(chunk);
    // 쌓인 양: 아직 소켓으로 내보내지 못한 바이트(writableLength). 넘으면 닫아 브라우저가 다시 붙게 한다
    const pending = typeof raw.writableLength === 'number' ? raw.writableLength : 0;
    if (pending > (this.o.pendingLimitBytes ?? OPS_LIVE_PENDING_LIMIT_BYTES)) this.close('backpressure');
  }

  close(reason: LiveCloseReason): void {
    if (this.#closed) return;
    this.#closed = true;
    this.closedReason = reason;
    for (const t of this.#timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    for (const fn of this.#onClose.splice(0)) {
      try {
        fn();
      } catch {
        // 끊기 실패는 무시한다(연결은 이미 닫는다)
      }
    }
    this.o.logger?.info({ event: 'ops-live-closed', stream: this.o.stream, reason }, '관제 SSE 흐름을 닫았다');
    if (reason === 'backpressure') this.reply.raw.destroy();
    else this.reply.raw.end();
  }
}
