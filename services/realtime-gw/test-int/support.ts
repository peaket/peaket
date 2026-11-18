// realtime-gw 통합 시험 도구(BUILD_ORDER HOT-090, BAT-052): 입장 토큰 서명, 판 파일 폴더, 서비스 띄우기(start), WebSocket 클라이언트,
// 손으로 하는 핸드셰이크(상태 코드·본문을 그대로 본다), 관리 포트 지표 읽기, 로그 모으기.
// 정본 값: 하위 프로토콜 peaket.seats.v1·peaket.auth.{토큰}, 허용 출처 https://www.peaket.example(docs/frontend.md §4.4.1),
// 토큰 규칙(seat-hold §2 '구매 세션 열기와 확인의 첫 구현'), 판 파일 {eventId}.json의 layout.layoutVersion·layout.sections(seat-hold §7 '판 파일').
import { generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { decodeFrame, type Frame } from '../../../packages/seatmap/src/wire.js'; // 화면과 같은 해독기(core-svc 시험과 같이 소스를 바로 가져온다)
import { WebSocket } from 'ws';
import { start, type StartedService } from '../src/start.js';

export const ORIGIN = 'https://www.peaket.example';
export const ISS = 'https://queue.peaket.example';
export const SEATS = 'peaket.seats.v1';
export const AUTH = 'peaket.auth.';
const JNY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

export interface TestKey {
  kid: string;
  priv: KeyObject;
  jwk: Record<string, string>;
}

export function newKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kid, priv: privateKey, jwk: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, kid } };
}

export const K1 = newKey('k1');
/** JWKS에 없는 키(서명 틀림을 만든다) */
export const K_OTHER = newKey('k1');
export const JWKS = JSON.stringify({ keys: [K1.jwk] });

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

/** 입장 토큰. claims로 칸을 바꾸고(undefined면 뺀다) header로 머리를 바꾼다 */
export function admissionToken(o: { eventId?: string; accountId?: string; claims?: Record<string, unknown>; header?: Record<string, unknown>; signWith?: KeyObject; nowMs?: number } = {}): string {
  const iat = Math.floor((o.nowMs ?? Date.now()) / 1000);
  const body = { iss: ISS, sub: o.accountId ?? 'acct-1', aud: 'purchase', jti: randomBytes(8).toString('hex'), sid: 'login-1', event: o.eventId ?? 'ev-1', jny: JNY, iat, exp: iat + 45 * 60, ...o.claims };
  const head = b64({ alg: 'ES256', typ: 'admission+jwt', kid: K1.kid, ...o.header });
  const payload = b64(body);
  const sig = sign('sha256', Buffer.from(`${head}.${payload}`), { key: o.signWith ?? K1.priv, dsaEncoding: 'ieee-p1363' });
  return `${head}.${payload}.${sig.toString('base64url')}`;
}

/** 회차별 판 파일 폴더. sections는 회차 → 구역 수 */
export function layoutDir(sections: Record<string, number>): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'rtgw-layout-'));
  for (const [eventId, n] of Object.entries(sections)) {
    writeFileSync(join(dir, `${eventId}.json`), JSON.stringify({ layout: { layoutVersion: 3, sections: Array.from({ length: n }, (_, i) => ({ id: `S${i}` })) } }));
  }
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 로그 가명 키(32바이트 base64) */
export const PSEUDONYM_KEY = randomBytes(32);

export function serviceEnv(o: { redisUrl: string; seatMapDir: string; extra?: Record<string, string> }): Record<string, string> {
  return {
    PEAKET_ENV: 'local',
    PORT: '0',
    PEAKET_MANAGEMENT_PORT: '0',
    PEAKET_LOG_LEVEL: 'info',
    PEAKET_LOG_PSEUDONYM_KEY: PSEUDONYM_KEY.toString('base64'),
    PEAKET_SEAT_REDIS_URL: o.redisUrl,
    PEAKET_ADMISSION_JWKS: JWKS,
    PEAKET_ADMISSION_ISSUER: ISS,
    PEAKET_SEATMAP_DIR: o.seatMapDir,
    ...o.extra,
  };
}

export interface Running extends StartedService {
  /** 받은 로그 줄(글 그대로) */
  logLines(): string[];
  metrics(): Promise<string>;
  url(path: string): string;
}

export async function startService(env: Record<string, string>): Promise<Running> {
  let text = '';
  const logDestination = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  const s = await start({ env, logDestination });
  return {
    ...s,
    logLines: () => text.split('\n').filter((l) => l.length > 0),
    metrics: async () => (await fetch(`http://127.0.0.1:${s.ports.management}/metrics`)).text(),
    url: (path) => `ws://127.0.0.1:${s.ports.app}${path}`,
  };
}

export const streamPath = (eventId: string): string => `/v1/events/${eventId}/seats/stream`;

/** 지표 글에서 값 하나(이름과 꼬리표가 글자 그대로 같은 줄). 없으면 undefined */
export function metricValue(text: string, series: string): number | undefined {
  for (const line of text.split('\n')) {
    if (line.startsWith(`${series} `)) return Number(line.slice(series.length + 1));
  }
  return undefined;
}

export interface Handshake {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** 손으로 하는 업그레이드 요청. 101이면 소켓을 닫고 돌려준다(keep이 참이면 소켓을 둔다) */
export function handshake(port: number, path: string, h: { origin?: string; protocols?: string[]; headers?: Record<string, string> }, keep?: (socket: import('node:net').Socket) => void): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      ...h.headers,
    };
    if (h.origin !== undefined) headers.Origin = h.origin;
    if (h.protocols !== undefined) headers['Sec-WebSocket-Protocol'] = h.protocols.join(', ');
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers });
    req.once('upgrade', (res, socket) => {
      if (keep) keep(socket);
      else socket.destroy();
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' });
    });
    req.once('response', (res) => {
      let body = '';
      res.on('data', (d) => (body += String(d)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.once('error', reject);
    req.end();
  });
}

export interface Client {
  ws: WebSocket;
  /** 받은 프레임 바이트(받은 차례) */
  raw: Buffer[];
  frames(): Frame[];
  opened: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
  /** pred에 맞는 프레임이 from번째 뒤로 올 때까지 기다린다 */
  next<T extends Frame>(pred: (f: Frame) => f is T, timeoutMs?: number, from?: number): Promise<T>;
  send(bytes: Uint8Array | string): void;
}

export function connect(url: string, o: { token?: string; origin?: string; headers?: Record<string, string> } = {}): Client {
  const ws = new WebSocket(url, [SEATS, AUTH + (o.token ?? admissionToken())], { headers: { Origin: o.origin ?? ORIGIN, ...o.headers } });
  const raw: Buffer[] = [];
  const waiters = new Set<() => void>();
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) raw.push(Buffer.from(data));
    for (const w of [...waiters]) w();
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => reject(new Error(`핸드셰이크 ${res.statusCode}`)));
    ws.once('error', reject);
  });
  opened.catch(() => {});
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  const frames = (): Frame[] => raw.map((b) => decodeFrame(b));
  return {
    ws,
    raw,
    frames,
    opened,
    closed,
    send: (bytes) => ws.send(bytes),
    next<T extends Frame>(pred: (f: Frame) => f is T, timeoutMs = 3_000, from = 0): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const look = (): boolean => {
          const hit = frames().slice(from).find(pred);
          if (hit) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(hit);
            return true;
          }
          return false;
        };
        const check = (): void => void look();
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`${timeoutMs}ms 안에 프레임이 오지 않았다(받은 것 ${JSON.stringify(frames().map((f) => f.type))})`));
        }, timeoutMs);
        waiters.add(check);
        look();
      });
    },
  };
}

export type DeltaFrame = Extract<Frame, { type: 'delta' }>;
export const isDelta = (f: Frame): f is DeltaFrame => f.type === 'delta';
export const isHeartbeat = (f: Frame): f is Extract<Frame, { type: 'heartbeat' }> => f.type === 'heartbeat';
export const isBatchInterval = (f: Frame): f is Extract<Frame, { type: 'batchInterval' }> => f.type === 'batchInterval';
export const entriesOf = (f: DeltaFrame) => f.sections.map((s) => ({ sectionIndex: s.sectionIndex, sectionVersion: s.sectionVersion, offsets: [...s.offsets], states: [...s.states] }));

/** SubscribeSections 바이트(docs/frontend.md §4.4.1 type 16, 리틀 엔디언). 상한을 넘는 목록도 만든다 */
export function subscribeBytes(sections: readonly number[]): Uint8Array {
  const u8 = new Uint8Array(4 + 2 * sections.length);
  const v = new DataView(u8.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, 16);
  v.setUint16(2, sections.length, true);
  sections.forEach((s, i) => v.setUint16(4 + 2 * i, s, true));
  return u8;
}

export function timeSyncBytes(clientTimeMs: number): Uint8Array {
  const u8 = new Uint8Array(10);
  const v = new DataView(u8.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, 18);
  v.setBigUint64(2, BigInt(clientTimeMs), true);
  return u8;
}

export const channelOf = (eventId: string, section: number): string => `s:{event:${eventId}}:sec:${section}`;
export const deltaText = (m: { epoch: number; section: number; version: number; changedAtMs: number; seats: Array<[number, number]> }): string =>
  ['1', m.epoch, m.section, m.version, m.changedAtMs, ...m.seats.map(([o, s]) => `${o}:${s}`)].join(' ');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ok가 참이 될 때까지 기다린다 */
export async function until(ok: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000, everyMs = 50): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await ok()) return;
    if (Date.now() > end) throw new Error(`${what}이(가) ${timeoutMs}ms 안에 되지 않았다`);
    await sleep(everyMs);
  }
}
