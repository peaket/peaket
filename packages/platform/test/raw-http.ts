// 실제 소켓으로 HTTP/1.1 요청을 손으로 보내는 시험 도우미(W9-fix3 F4·F5, 시험 담당 w9f3-test 2026-11-17).
// inject는 소켓이 없어 '본문을 다 읽기 전에 답하고 연결을 닫는지'와 '서버가 읽은 바이트 수'를 볼 수 없어 따로 둔다.
// 서버 쪽 소켓은 원격 포트(= 손님 쪽 지역 포트)로 짝짓고, 그 소켓이 닫힐 때의 bytesRead를 적는다.
import type { Server } from 'node:http';
import { connect, type Socket } from 'node:net';

export interface RawResponse {
  status: number;
  /** 머리 이름은 소문자 */
  headers: Record<string, string>;
  body: string;
}

interface ServerSide {
  socket: Socket;
  closed: boolean;
  /** 닫힐 때의 bytesRead(닫히기 전에는 지금 값) */
  bytesRead(): number;
  whenClosed: Promise<void>;
}

/** 서버의 연결을 원격 포트로 찾는다. 서버마다 한 번 건다 */
export function trackConnections(server: Server): { of(localPort: number, waitMs?: number): Promise<ServerSide> } {
  const byPort = new Map<number, ServerSide>();
  server.on('connection', (socket: Socket) => {
    let closedAt: number | undefined;
    const side: ServerSide = {
      socket,
      closed: false,
      bytesRead: () => closedAt ?? socket.bytesRead,
      whenClosed: new Promise<void>((resolve) =>
        socket.once('close', () => {
          closedAt = socket.bytesRead;
          side.closed = true;
          resolve();
        }),
      ),
    };
    if (socket.remotePort !== undefined) byPort.set(socket.remotePort, side);
  });
  return {
    async of(localPort, waitMs = 1_000) {
      const until = Date.now() + waitMs;
      for (;;) {
        const s = byPort.get(localPort);
        if (s) return s;
        if (Date.now() > until) throw new Error(`서버 쪽 연결(원격 포트 ${localPort})을 찾지 못했다(시험 준비)`);
        await sleep(5);
      }
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 손님 쪽 연결 하나. 받은 바이트를 모아 응답을 차례로 읽는다 */
export class RawClient {
  private buffer = Buffer.alloc(0);
  private readonly parsed: RawResponse[] = [];
  private waiters: Array<() => void> = [];
  /** 서버가 끝을 보냈거나(FIN) 연결이 끊겼다 */
  ended = false;
  /** 쓰기·읽기 오류(EPIPE·ECONNRESET 등). 서버가 닫은 뒤 보내면 생긴다 */
  error: Error | undefined;

  private constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
      this.wake();
    });
    const stop = () => {
      this.ended = true;
      this.wake();
    };
    socket.on('end', stop);
    socket.on('close', stop);
    socket.on('error', (err) => {
      this.error = err;
      stop();
    });
  }

  static async open(port: number): Promise<RawClient> {
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    return new RawClient(socket);
  }

  get localPort(): number {
    return this.socket.localPort!;
  }

  /** 끊긴 뒤에는 쓰지 않는다(오류를 삼킨다) */
  write(data: string | Buffer): void {
    if (this.ended || this.socket.destroyed) return;
    this.socket.write(data, () => undefined);
  }

  /** 요청 줄과 머리만 보낸다(본문은 따로) */
  head(method: string, path: string, headers: Record<string, string | number>): void {
    const lines = [`${method} ${path} HTTP/1.1`, 'Host: 127.0.0.1', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''];
    this.write(lines.join('\r\n'));
  }

  /** 응답 하나(n번째, 0부터)를 기다린다. 시간 안에 오지 않으면 undefined */
  async response(index = 0, waitMs = 2_000): Promise<RawResponse | undefined> {
    const until = Date.now() + waitMs;
    while (this.parsed.length <= index) {
      if (this.ended || Date.now() > until) return this.parsed[index];
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, Math.max(1, until - Date.now()));
      });
    }
    return this.parsed[index];
  }

  destroy(): void {
    this.socket.destroy();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private parse(): void {
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const [statusLine, ...lines] = this.buffer.subarray(0, end).toString('latin1').split('\r\n');
      const headers: Record<string, string> = {};
      for (const l of lines) {
        const i = l.indexOf(':');
        if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      const length = Number(headers['content-length'] ?? 0);
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(end + 4 + length);
      this.parsed.push({ status: Number(statusLine!.split(' ')[1]), headers, body });
    }
  }
}

/**
 * 본문을 조금씩 보낸다(chunkBytes를 intervalMs마다, 모두 totalBytes). 연결이 끊기면 멈춘다.
 * chunked면 전송 덩어리 꼴(크기 16진수 줄 + 데이터 + CRLF)로 싼다. 보낸 바이트 수(본문 몫)를 돌려준다
 */
export async function trickle(c: RawClient, o: { totalBytes: number; chunkBytes: number; intervalMs: number; chunked?: boolean }): Promise<number> {
  const chunk = Buffer.alloc(o.chunkBytes, 0x61);
  let sent = 0;
  while (sent < o.totalBytes && !c.ended) {
    const n = Math.min(o.chunkBytes, o.totalBytes - sent);
    const data = n === chunk.length ? chunk : chunk.subarray(0, n);
    c.write(o.chunked ? Buffer.concat([Buffer.from(`${n.toString(16)}\r\n`), data, Buffer.from('\r\n')]) : data);
    sent += n;
    await sleep(o.intervalMs);
  }
  return sent;
}

/** 서버 쪽 연결이 시간 안에 닫혔는지 */
export async function closedWithin(side: ServerSide, ms: number): Promise<boolean> {
  if (side.closed) return true;
  return Promise.race([side.whenClosed.then(() => true), sleep(ms).then(() => side.closed)]);
}
