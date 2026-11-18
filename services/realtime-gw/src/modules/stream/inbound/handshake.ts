// 받는 층: 좌석 델타 WebSocket `GET /v1/events/{eventId}/seats/stream`의 핸드셰이크(docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '핸드셰이크',
// ADR-0296 결정 2, docs/frontend.md §4.4.1 '연결'·'닫힘 코드', BUILD_ORDER HOT-090).
// 앞이 걸리면 뒤는 보지 않는다: ① 경로·회차 ID 모양 404 ② 내리는 중·파드 연결 상한 503(ADR-0297 결정 3) ③ Origin 403(4.4.2)
// ④ 업그레이드 머리(Sec-WebSocket-Key·Version)·하위 프로토콜 겹침·`peaket.seats.v1` 없음 400(ws에 맡기지 않는다, ADR-0297 결정 7)
// ⑤ `peaket.auth.` 값이 꼭 하나가 아니거나 토큰 확인 실패 401(4.4.3·4.4.4) ⑥ 판 파일 없음·틀림 503.
// 거절 응답은 본문이 없고 이유를 싣지 않는다(16.5.1). 통과하면 `peaket.seats.v1`을 골라 맺는다(토큰 값은 되돌려 보내지 않는다).
// 주소의 회차와 토큰 event가 다르면 맺은 뒤 바로 4403 bad event, 같은 토큰(jti)의 파드 연결이 이미 2개면 4429 too many(허브가 닫는다).
// 클라이언트 Ping은 받지 않는다: autoPong을 끄고 Ping이 오면 4403 bad frame(ADR-0297 결정 2).
// 신원은 확인한 토큰에서만 정한다(x-user-id·x-forwarded-for 같은 머리는 읽지 않는다, 4.1.3).
// 토큰과 하위 프로토콜 값은 로그·지표에 싣지 않는다(14.1.2). 업그레이드 요청은 Fastify 경로를 거치지 않는다(v0 delta-socket.ts와 같은 꼴).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { AdmissionTokenRejected, type AdmissionClaims, type AdmissionKeys, type Clock, verifyAdmissionToken } from '@peaket/platform';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { CLOSE, CLOSE_REASON, type StreamConnection, type StreamHub } from '../application/hub.js';
import { KEY_PART } from '../application/message.js';

/** 서버가 고르는 하위 프로토콜 */
export const SEATS_PROTOCOL = 'peaket.seats.v1';
/** 입장 토큰을 싣는 하위 프로토콜 값의 앞 글자 */
export const AUTH_PROTOCOL_PREFIX = 'peaket.auth.';
const PATH = /^\/v1\/events\/([^/]*)\/seats\/stream$/;
/** Sec-WebSocket-Key: 16바이트의 base64(RFC 6455 §4.1, ws와 같은 꼴) */
const WS_KEY = /^[+/0-9A-Za-z]{22}==$/;
/** 하위 프로토콜 값 하나: RFC 7230 token 글자 */
const TOKEN_CHARS = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** ws가 받는 프레임 크기 상한. 1,024바이트 검사(4403)는 허브가 하므로 그보다 넉넉히 둔다(이것을 넘으면 ws가 1009로 끊는다) */
const WS_MAX_PAYLOAD = 64 * 1024;
/** 닫기 인사를 기다리는 시간(ms). 넘으면 끊는다 */
const CLOSE_GRACE_MS = 1_000;

const STATUS_TEXT: Readonly<Record<number, string>> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' };

export type HandshakeRejectStatus = 400 | 401 | 403 | 404 | 503;

/** 거절 이유 코드(로그 ws_rejected의 reason. 받은 값을 싣지 않는다) */
export type HandshakeRejectReason =
  | 'path'
  | 'shutting_down'
  | 'capacity'
  | 'origin'
  | 'upgrade_headers'
  | 'subprotocol'
  | 'token_count'
  | `token_${AdmissionTokenRejected['reason']}`
  | 'layout';

export interface StreamGatewayDeps {
  hub: StreamHub;
  clock: Clock;
  admission: { keys: AdmissionKeys; issuer: string };
  /** 허용 출처 하나(글자 그대로 비교) */
  webOrigin: string;
  /** 파드 연결 상한(PEAKET_REALTIME_MAX_CONNECTIONS). 닿으면 핸드셰이크 503 */
  maxConnections: number;
  /** 회차의 판(처음이면 파일을 읽는다). 없거나 틀리면 undefined */
  layout: { get(eventId: string): Promise<unknown | undefined> };
  onRejected?(e: { status: HandshakeRejectStatus; reason: HandshakeRejectReason }): void;
  onOpened?(): void;
  /** 연결이 닫혔다. code는 서버가 보낸 닫힘 코드(없으면 받은 코드) */
  onClosed?(e: { eventId: string; accountId: string; code: number; connectedMs: number }): void;
}

function reject(socket: Duplex, status: HandshakeRejectStatus): void {
  // 쓰기를 마치면 소켓을 없앤다(end만으로는 상대가 닫을 때까지 읽기 쪽이 남는다. ws의 abortHandshake와 같다)
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Sec-WebSocket-Protocol 값 목록(쉼표로 나눈 값, 앞뒤 빈칸 뺌). 머리가 없으면 빈 목록, 빈 값·token 밖 글자·겹친 값이 있으면 undefined */
function protocolsOf(req: IncomingMessage): string[] | undefined {
  const raw = req.headers['sec-websocket-protocol'];
  if (raw === undefined) return [];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  const list = joined.split(',').map((s) => s.trim());
  if (list.some((p) => !TOKEN_CHARS.test(p))) return undefined;
  if (new Set(list).size !== list.length) return undefined;
  return list;
}

/** ws가 스스로 거절하던 업그레이드 머리를 우리 차례에서 본다(ADR-0297 결정 7). 맞으면 참 */
function upgradeHeadersOk(req: IncomingMessage): boolean {
  if (req.method !== 'GET') return false;
  const upgrade = req.headers.upgrade;
  if (typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') return false;
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !WS_KEY.test(key.trim())) return false;
  return req.headers['sec-websocket-version'] === '13';
}

export class StreamGateway {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, clientTracking: false, perMessageDeflate: false, autoPong: false, handleProtocols: () => SEATS_PROTOCOL });
  /** 맺은 소켓 모두(회차 다름으로 곧 닫는 것도) */
  readonly #sockets = new Set<WebSocket>();
  #stopping = false;
  #stopped: Promise<void> | undefined;

  constructor(private readonly d: StreamGatewayDeps) {}

  /** HTTP 서버의 upgrade 처리기 */
  readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => {});
    void this.#upgrade(req, socket, head).catch(() => {
      if (!socket.destroyed) socket.destroy();
    });
  };

  /** 지금 맺은 연결 수 */
  get connections(): number {
    return this.#sockets.size;
  }

  /** 새 핸드셰이크를 받지 않고 모든 연결을 1012로 닫는다. 닫기 인사를 1초까지 기다리고 남은 소켓은 끊는다 */
  shutdown(): Promise<void> {
    this.#stopping = true;
    return (this.#stopped ??= (async () => {
      await this.d.hub.shutdown();
      for (const ws of this.#sockets) ws.close(CLOSE.SERVER_RESTART, CLOSE_REASON.serverRestart);
      const deadline = Date.now() + CLOSE_GRACE_MS + 200;
      while (this.#sockets.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      for (const ws of this.#sockets) ws.terminate();
      this.#wss.close();
    })());
  }

  #reject(socket: Duplex, status: HandshakeRejectStatus, reason: HandshakeRejectReason): void {
    this.d.onRejected?.({ status, reason });
    reject(socket, status);
  }

  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // ① 경로와 회차 ID 모양(퍼센트 인코딩은 풀지 않는다: 키 조각 모양에 % 가 없다)
    const path = (req.url ?? '').split('?')[0]!;
    const m = PATH.exec(path);
    const eventId = m?.[1];
    if (eventId === undefined || !KEY_PART.test(eventId)) return this.#reject(socket, 404, 'path');
    // ② 내리는 중·파드 연결 상한
    if (this.#stopping) return this.#reject(socket, 503, 'shutting_down');
    if (this.#sockets.size >= this.d.maxConnections) return this.#reject(socket, 503, 'capacity');
    // ③ 출처
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin !== this.d.webOrigin) return this.#reject(socket, 403, 'origin');
    // ④ 업그레이드 머리와 하위 프로토콜(겹침·token 밖 글자·peaket.seats.v1 없음)
    if (!upgradeHeadersOk(req)) return this.#reject(socket, 400, 'upgrade_headers');
    const protocols = protocolsOf(req);
    if (!protocols || !protocols.includes(SEATS_PROTOCOL)) return this.#reject(socket, 400, 'subprotocol');
    // ⑤ 입장 토큰(꼭 하나)
    const auth = protocols.filter((p) => p.startsWith(AUTH_PROTOCOL_PREFIX));
    if (auth.length !== 1) return this.#reject(socket, 401, 'token_count');
    let claims: AdmissionClaims;
    try {
      claims = verifyAdmissionToken(auth[0]!.slice(AUTH_PROTOCOL_PREFIX.length), { keys: this.d.admission.keys, issuer: this.d.admission.issuer, nowMs: this.d.clock.now() });
    } catch (err) {
      return this.#reject(socket, 401, err instanceof AdmissionTokenRejected ? `token_${err.reason}` : 'token_format');
    }
    // ⑥ 판 파일
    const layout = await this.d.layout.get(eventId);
    if (layout === undefined) return this.#reject(socket, 503, 'layout');
    if (this.#stopping) return this.#reject(socket, 503, 'shutting_down');
    if (this.#sockets.size >= this.d.maxConnections) return this.#reject(socket, 503, 'capacity');
    if (socket.destroyed) return;
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#connected(ws, eventId, claims));
  }

  #connected(ws: WebSocket, eventId: string, claims: AdmissionClaims): void {
    if (this.#stopping) {
      ws.close(CLOSE.SERVER_RESTART, CLOSE_REASON.serverRestart);
      return;
    }
    this.#sockets.add(ws);
    this.d.onOpened?.();
    const startedMs = this.d.clock.monotonicMs();
    let sentCode: number | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const conn: StreamConnection = {
      send: (frame) => ws.send(frame, { binary: true }),
      close: (code, reason) => {
        if (sentCode !== undefined) return;
        sentCode = code;
        ws.close(code, reason);
        graceTimer = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
        graceTimer.unref();
      },
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
    };
    ws.on('error', () => {});
    // 브라우저는 Ping을 보내지 않는다(살아 있음은 앱 하트비트). Ping이 오면 받지 않는 프레임으로 닫는다(autoPong 끔, ADR-0297 결정 2)
    ws.on('ping', () => {
      conn.close(CLOSE.FORBIDDEN, CLOSE_REASON.badFrame);
      this.d.hub.gone(conn);
    });
    ws.on('close', (code: number) => {
      if (graceTimer) clearTimeout(graceTimer);
      this.#sockets.delete(ws);
      this.d.hub.gone(conn);
      this.d.onClosed?.({ eventId, accountId: claims.accountId, code: sentCode ?? code, connectedMs: Math.max(0, Math.round(this.d.clock.monotonicMs() - startedMs)) });
    });
    // 주소의 회차와 토큰 event가 다르면 맺은 뒤 바로 4403(docs/frontend.md §4.4.1 구독 상한 표 첫 줄)
    if (claims.eventId !== eventId) {
      conn.close(CLOSE.FORBIDDEN, CLOSE_REASON.badEvent);
      return;
    }
    ws.on('message', (data: RawData, isBinary: boolean) => {
      this.d.hub.receive(conn, toBytes(data), isBinary);
    });
    this.d.hub.open(conn, { eventId, accountId: claims.accountId, expiresAtMs: claims.expiresAtMs, tokenId: claims.jti });
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
