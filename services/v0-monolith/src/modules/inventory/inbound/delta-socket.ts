// 받는 층: 변경분 WebSocket GET /v0/events/{eventId}/seat-deltas(v0에만 있다)(docs/features/seat-hold.md §14 동작 6).
// 업그레이드 요청은 Fastify 경로를 거치지 않으므로 여기서 신원 머리·Origin·입장을 직접 본다(플랫폼 인증 가드와 같은 머리 이름·판정).
// 받은 변경분 JSON을 그 회차의 모든 연결에 그대로 보낸다(구역 구독·묶어 보내기 없음, K4의 v0).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type BeforeApplicationShutdown, Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { WebSocket, WebSocketServer } from 'ws';
import { InventoryService } from '../application/inventory-service.js';
import { EVENT_ID_PATTERN } from '../domain/inventory.js';
import { DELTA_FEED, type DeltaFeed } from '../domain/ports.js';

export const ALLOWED_ORIGINS = Symbol.for('peaket.v0.inventory.allowedOrigins');

const PATH = /^\/v0\/events\/([^/?#]+)\/seat-deltas$/;
/** 신원 머리 한 값의 길이 상한(플랫폼 인증 가드와 같다) */
const MAX_HEADER = 1024;
/** 연결 하나의 보내기 버퍼 상한. 넘으면 읽지 않는 연결로 보고 끊는다 [가정] */
const MAX_BUFFERED = 1024 * 1024;
/** 닫기 인사를 기다리는 시간. 넘으면 끊는다 */
const CLOSE_GRACE_MS = 1_000;

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= MAX_HEADER ? v : undefined);

function reject(socket: Duplex, status: 400 | 401 | 403 | 404 | 503, reason: string): void {
  // 쓰기를 마치면 소켓을 없앤다(end만으로는 상대가 닫을 때까지 읽기 쪽이 남는다. ws의 abortHandshake와 같다, 새 맥락 리뷰)
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

@Injectable()
export class DeltaSocket implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly byEvent = new Map<string, Set<WebSocket>>();
  private unsubscribe: (() => void) | undefined;
  private unsubscribeGap: (() => void) | undefined;
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void this.upgrade(req, socket, head);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly inventory: InventoryService,
    @Inject(DELTA_FEED) private readonly feed: DeltaFeed,
    @Inject(ALLOWED_ORIGINS) private readonly allowedOrigins: readonly string[],
    @Inject(PLATFORM_LOGGER) private readonly logger: PlatformLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.adapterHost.httpAdapter.getHttpServer().on('upgrade', this.onUpgrade);
    this.unsubscribe = this.feed.subscribe((delta, raw) => {
      for (const ws of this.byEvent.get(delta.eventId) ?? []) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (ws.bufferedAmount > MAX_BUFFERED) ws.terminate();
        else ws.send(raw);
      }
    });
    // 받기 연결이 끊긴 동안의 변경분은 잃는다. 열린 연결을 닫아 브라우저가 다시 연결하며 좌석 목록을 다시 받게 한다(§14 동작 6)
    this.unsubscribeGap = this.feed.onGap(() => this.closeAll(1012, 'delta feed restarted'));
  }

  /** HTTP 서버가 닫히기 전에 연결을 닫는다(서버 닫기는 업그레이드된 소켓이 끊기기를 기다리므로 뒤에 닫으면 서로 기다린다, 새 맥락 리뷰) */
  beforeApplicationShutdown(): void {
    this.adapterHost.httpAdapter.getHttpServer().off('upgrade', this.onUpgrade);
    this.unsubscribe?.();
    this.unsubscribeGap?.();
    this.closeAll(1001, 'server shutting down');
    this.wss.close();
  }

  /** 지금 열린 연결 수(그 회차) */
  connections(eventId: string): number {
    return this.byEvent.get(eventId)?.size ?? 0;
  }

  private closeAll(code: number, reason: string): void {
    for (const set of this.byEvent.values()) {
      for (const ws of set) {
        ws.close(code, reason);
        setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
      }
    }
    this.byEvent.clear();
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => {});
    const path = (req.url ?? '').split('?')[0]!;
    const m = PATH.exec(path);
    if (!m) return reject(socket, 404, 'Not Found');
    let eventId: string;
    try {
      eventId = decodeURIComponent(m[1]!);
    } catch {
      return reject(socket, 400, 'Bad Request'); // 깨진 퍼센트 인코딩(시험 작성 에이전트가 찾음)
    }
    if (!EVENT_ID_PATTERN.test(eventId)) return reject(socket, 400, 'Bad Request');
    const h = req.headers;
    const accountId = one(h['x-user-id']);
    const sessionId = one(h['x-session-id']);
    // 플랫폼 인증 가드와 같이: 신원이 없거나 대상이 팬이 아니면 401, 스코프·pid가 없으면 403
    if (!accountId || !sessionId || one(h['x-user-aud']) !== 'fan') return reject(socket, 401, 'Unauthorized');
    const scopes = (one(h['x-user-scope']) ?? '').split(/\s+/);
    const pid = one(h['x-user-pid']);
    if (!scopes.includes('ticket:buy') || !pid) return reject(socket, 403, 'Forbidden');
    const origin = one(h.origin);
    if (!origin || !this.allowedOrigins.includes(origin)) return reject(socket, 403, 'Forbidden');
    // 변경분을 받지 못하는 동안은 받지 않는다(브라우저가 3초 뒤 다시 연결하며 좌석 목록을 다시 받는다, 2차 리뷰)
    if (!this.feed.isListening()) return reject(socket, 503, 'Service Unavailable');
    try {
      await this.inventory.requireAdmitted(eventId, pid);
    } catch (err) {
      const status = (err as { status?: number }).status;
      return reject(socket, status === 403 ? 403 : 503, status === 403 ? 'Forbidden' : 'Service Unavailable');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      let set = this.byEvent.get(eventId);
      if (!set) this.byEvent.set(eventId, (set = new Set()));
      set.add(ws);
      ws.on('error', () => {});
      ws.on('close', () => {
        set.delete(ws);
        if (set.size === 0 && this.byEvent.get(eventId) === set) this.byEvent.delete(eventId);
      });
      // 받는 쪽은 보내기만 한다. 브라우저가 보낸 메시지는 읽지 않는다(maxPayload 1KiB 넘으면 끊긴다)
      this.logger.debug({ eventId }, 'v0 변경분 연결');
    });
  }
}
