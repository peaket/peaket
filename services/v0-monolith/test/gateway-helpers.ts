// v0 입구 시험의 공용 도구(docs/infra.md §3 'v0 배포').
// - ES256 팬 액세스 토큰을 node:crypto로 직접 서명한다(틀린 토큰을 마음대로 만들려고)
// - 자체 서명 인증서(EC P-256)를 openssl 명령으로 만든다
// - 가짜 앱(평문 HTTP, 받은 요청을 적어 두고 시험이 정한 대로 답한다. 업그레이드는 101 뒤 되받아 보낸다)
// - HTTPS·평문 HTTP·생 TLS 요청
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http, { type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { WebSocketServer } from 'ws';
import type { FanPublicJwk } from '../src/gateway/token.js';

/** 시험 토큰의 발급자(tools/local/v0-token.mjs의 V0_TOKEN_ISSUER와 같은 값) */
export const ISSUER = 'https://identity.peaket.local';
/** 입구가 모든 응답에 붙여야 하는 HSTS 값(docs/infra.md §3 'v0 배포' 6). 상수를 가져오지 않고 글자 그대로 견준다 */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';
/** Problem의 Content-Type(문자 집합 매개변수는 붙어도 된다) */
export const PROBLEM_CONTENT_TYPE = /^application\/problem\+json(\s*;\s*charset=utf-8)?$/i;

export const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');
export const b64json = (value: unknown): string => b64url(JSON.stringify(value));

export interface FanKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: FanPublicJwk;
  /** 공개키 칸에 개인키 칸 d를 더한 것(공개키 목록에 섞이면 거절해야 한다) */
  privateJwk: FanPublicJwk & { d: string };
}

/** 새 EC P-256 키 쌍 */
export function makeFanKey(kid: string): FanKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  if (typeof pub.x !== 'string' || typeof pub.y !== 'string' || typeof priv.d !== 'string') throw new Error('EC JWK를 만들지 못했다');
  const publicJwk: FanPublicJwk = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid, alg: 'ES256', use: 'sig' };
  return { kid, privateKey, publicJwk, privateJwk: { ...publicJwk, d: priv.d } };
}

export type DsaEncoding = 'ieee-p1363' | 'der';

/** 글자 그대로의 머리·본문 조각에 ES256 서명을 붙인다(조각을 일부러 망가뜨린 토큰도 서명이 맞게) */
export function signSegments(privateKey: KeyObject, headerSeg: string, payloadSeg: string, dsaEncoding: DsaEncoding = 'ieee-p1363'): string {
  const signature = sign('sha256', Buffer.from(`${headerSeg}.${payloadSeg}`, 'ascii'), { key: privateKey, dsaEncoding });
  return `${headerSeg}.${payloadSeg}.${b64url(signature)}`;
}

/** 머리·본문(객체면 JSON, 문자열이면 그대로)을 base64url로 바꿔 ES256으로 서명한다 */
export function signJwt(privateKey: KeyObject, header: unknown, payload: unknown, dsaEncoding: DsaEncoding = 'ieee-p1363'): string {
  const payloadSeg = typeof payload === 'string' ? b64url(payload) : b64json(payload);
  return signSegments(privateKey, b64json(header), payloadSeg, dsaEncoding);
}

/** 맞는 팬 토큰 머리. 덮어쓸 칸에 undefined를 주면 그 칸이 빠진다(JSON.stringify) */
export function fanHeader(kid: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { alg: 'ES256', typ: 'at+jwt', kid, ...over };
}

/** 맞는 팬 토큰 본문(15분). 덮어쓸 칸에 undefined를 주면 그 칸이 빠진다 */
export function fanClaims(nowSec: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: ISSUER, sub: 'u-1', sid: 's-1', scope: 'ticket:buy', aud: 'fan', iat: nowSec, exp: nowSec + 900, ...over };
}

/** 그 키로 서명한 팬 토큰 */
export function fanToken(key: FanKey, nowSec: number, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  return signJwt(key.privateKey, fanHeader(key.kid, header), fanClaims(nowSec, claims));
}

/** 머리 이름을 소문자로 모은다. 대소문자만 다른 같은 이름이 둘이면 실패다(입구가 머리를 겹쳐 넘기면 안 된다) */
export function lowerKeys(headers: OutgoingHttpHeaders | IncomingHttpHeaders): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower in out) throw new Error(`머리 ${lower}가 대소문자만 달리 둘 있다`);
    out[lower] = value;
  }
  return out;
}

/** 생 머리 목록(rawHeaders: 이름, 값, 이름, 값 …)의 이름을 소문자로, 받은 순서대로 */
export function rawHeaderNames(rawHeaders: readonly string[]): string[] {
  return rawHeaders.filter((_v, i) => i % 2 === 0).map((name) => name.toLowerCase());
}

/** 신원 머리(x-user-로 시작하는 것과 x-session-id)만 골라 낸다 */
export function identityHeadersOf(headers: OutgoingHttpHeaders | IncomingHttpHeaders): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(lowerKeys(headers))) {
    if (name.startsWith('x-user-') || name === 'x-session-id') out[name] = value;
  }
  return out;
}

// ---- 자체 서명 인증서 ----

let cachedCert: { cert: string; key: string } | undefined;

function findOpenssl(): string {
  const candidates = ['openssl'];
  if (process.platform === 'win32') candidates.push('C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // 다음 후보
    }
  }
  throw new Error('openssl 명령을 찾지 못했다. PATH에 openssl을 두고(Windows는 Git for Windows가 함께 설치한 openssl) 다시 돌린다');
}

/** EC P-256 자체 서명 인증서(127.0.0.1·localhost, 하루). 한 프로세스에서 한 번만 만든다 */
export function selfSignedCert(): { cert: string; key: string } {
  if (cachedCert) return cachedCert;
  const openssl = findOpenssl();
  const dir = mkdtempSync(join(tmpdir(), 'peaket-v0-gw-'));
  try {
    const keyFile = join(dir, 'key.pem');
    const certFile = join(dir, 'cert.pem');
    execFileSync(
      openssl,
      [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
        '-subj', '/CN=t', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', keyFile, '-out', certFile,
      ],
      { stdio: 'pipe' },
    );
    cachedCert = { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') };
    return cachedCert;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 가짜 앱 ----

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
  upgrade: boolean;
}

export type UpstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

export const defaultUpstreamReply: UpstreamHandler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('ok');
};

/** 앱 대역. 받은 요청을 requests에 적고 handler대로 답한다. 업그레이드는 WebSocket으로 받아 'hello'를 보내고 받은 글을 'echo:'를 붙여 되보낸다 */
export class FakeUpstream {
  readonly requests: RecordedRequest[] = [];
  /**
   * 앱이 머리를 받은 요청의 경로(본문을 다 받기 전에 적는다, 업그레이드 포함).
   * requests는 본문이 끝나야 적으므로, 입구가 앱에 요청을 열었다가 끊은 경우는 여기서만 보인다
   */
  readonly started: string[] = [];
  handler: UpstreamHandler = defaultUpstreamReply;
  readonly #server: http.Server;
  readonly #wss = new WebSocketServer({ noServer: true });

  private constructor() {
    this.#server = http.createServer((req, res) => {
      this.started.push(req.url ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, rawHeaders: req.rawHeaders, body, upgrade: false });
        this.handler(req, res, body);
      });
    });
    this.#server.on('upgrade', (req: http.IncomingMessage, socket, head: Buffer) => {
      this.started.push(req.url ?? '');
      this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, rawHeaders: req.rawHeaders, body: '', upgrade: true });
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send('hello');
        ws.on('message', (data) => ws.send(`echo:${String(data)}`));
      });
    });
  }

  static async start(): Promise<FakeUpstream> {
    const up = new FakeUpstream();
    await new Promise<void>((resolve) => up.#server.listen(0, '127.0.0.1', resolve));
    return up;
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  get url(): URL {
    return new URL(`http://127.0.0.1:${this.port}`);
  }

  /** 그 경로(쿼리 포함)로 받은 요청. 없으면 undefined */
  find(url: string): RecordedRequest | undefined {
    return this.requests.find((r) => r.url === url);
  }

  /** 그 경로(쿼리 포함)의 요청 머리라도 받았는가(본문을 다 받지 못했어도) */
  touched(url: string): boolean {
    return this.started.includes(url);
  }

  async close(): Promise<void> {
    for (const client of this.#wss.clients) client.terminate();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/** 열었다 닫은 포트(앱에 닿지 못하는 주소) */
export async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ---- 요청 ----

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface CallOptions {
  method?: string;
  path: string;
  headers?: OutgoingHttpHeaders;
  body?: string;
}

function collect(req: http.ClientRequest, body: string | undefined): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** 입구 HTTPS 포트로 요청 하나(시험 인증서를 믿는다, 연결을 다시 쓰지 않는다) */
export function httpsCall(port: number, ca: string, options: CallOptions): Promise<Reply> {
  const req = https.request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers, ca, agent: false });
  return collect(req, options.body);
}

/** 평문 HTTP 요청 하나(관리 포트, 또는 HTTPS 포트에 평문을 보내 보는 시험) */
export function httpCall(port: number, options: CallOptions): Promise<Reply> {
  const req = http.request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers, agent: false });
  return collect(req, options.body);
}

/** 생 TLS 연결로 글을 보내고 응답 하나(머리 + Content-Length 본문)나 연결이 끝날 때까지 받은 글 */
export function tlsExchange(port: number, ca: string, text: string, timeoutMs = 5000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(received.toString('utf8'));
    };
    const socket = tls.connect({ host: '127.0.0.1', port, ca }, () => socket.write(text));
    const timer = setTimeout(() => finish(new Error(`응답이 ${timeoutMs}ms 안에 끝나지 않았다: ${JSON.stringify(received.toString('utf8'))}`)), timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const all = received.toString('latin1');
      const end = all.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = /\r\ncontent-length:\s*(\d+)/i.exec(all.slice(0, end));
      if (length && received.length >= end + 4 + Number(length[1])) finish();
    });
    socket.on('end', () => finish());
    socket.on('close', () => finish());
    socket.on('error', (err) => (received.length > 0 ? finish() : finish(err)));
  });
}

/** 생 HTTP/1.1 응답 글을 상태·머리(소문자)·본문으로 나눈다 */
export function parseRawResponse(raw: string): Reply {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) throw new Error(`HTTP 응답이 아니다: ${JSON.stringify(raw)}`);
  const [statusLine = '', ...lines] = raw.slice(0, end).split('\r\n');
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
  if (!status) throw new Error(`상태 줄이 아니다: ${JSON.stringify(statusLine)}`);
  const headers: IncomingHttpHeaders = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(status[1]), headers, body: raw.slice(end + 4) };
}

/** 시간 안에 끝나지 않으면 실패하는 기다림 */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}이(가) ${ms}ms 안에 끝나지 않았다`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
