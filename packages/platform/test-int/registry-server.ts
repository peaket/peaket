// 통합 시험용 Schema Registry 자리(BAT-220 계획 §11 4): Confluent REST `GET /schemas/ids/{id}`의 응답 모양만 내는 실제 HTTP(S) 서버.
// 응답은 단위 시험과 같은 registryReply(test/schema-registry-fake.ts)로 만든다. 닫기·되살리기로 레지스트리 정지를 흉내 낸다(같은 포트로 다시 연다).
// TLS 시험은 시험이 만든 자체 서명 인증서(openssl)를 쓴다. 실제 레지스트리와의 짝 맞춤은 구간 5의 G-30(docs/observability.md)이다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryReply, type RegistryState } from '../test/schema-registry-fake.js';

export interface RegistryServer {
  url: string;
  port: number;
  /** 듣기를 멈추고 열린 연결을 끊는다(연결 거부가 된다) */
  close(): Promise<void>;
  /** 같은 포트로 다시 연다 */
  reopen(): Promise<void>;
}

/** 127.0.0.1용 자체 서명 인증서(시험이 만든 것, 어느 CA도 믿지 않는다) */
function selfSigned(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-registry-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', 'k.pem', '-out', 'c.pem'], { cwd: dir, stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function startRegistryServer(state: RegistryState, o: { tls?: boolean; delayMs?: number } = {}): Promise<RegistryServer> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const answer = () => {
      const r = registryReply(state, new URL(req.url ?? '/', 'http://x').pathname, req.headers.authorization ?? null);
      res.writeHead(r.status, r.headers).end(r.body);
    };
    if (o.delayMs) setTimeout(answer, o.delayMs);
    else answer();
  };
  const make = (): Server => (o.tls ? createHttpsServer(selfSigned(), handler) : createHttpServer(handler));
  let server = make();
  const sockets = new Set<Socket>();
  const track = (s: Server) => s.on('connection', (c: Socket) => (sockets.add(c), c.on('close', () => sockets.delete(c))));
  track(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `${o.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    async close() {
      if (!server.listening) return;
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
    async reopen() {
      server = make();
      track(server);
      await new Promise<void>((r, j) => server.once('error', j).listen(port, '127.0.0.1', () => r()));
    },
  };
}
