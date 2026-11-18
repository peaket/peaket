// 받는 층(StreamGateway) 시험: 프로세스 안 HTTP 서버에 붙이고 맨 TCP로 핸드셰이크한다(Docker·Valkey 없음. 구독기는 가짜, BAT-052 리뷰 반영 RF-T14~T16).
// 정본: docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '핸드셰이크' ②④와 그 뒤 문장(맺은 뒤 곧 닫는 4403 bad event·4429 too many 연결은 닫기로 정한 때
// 파드 연결 셈에서 빠지고 닫기 인사를 100ms [가정]만 기다린 뒤 끊는다. 회차가 다른 연결도 그 jti의 닫히는 중 연결로 세고, 4개 [가정]이면 그 jti의 새 핸드셰이크는
// ⑤ 뒤 업그레이드 없이 503), ADR-0297 결정 3 '곧 닫는 연결'·결정 7, §12 S-T42 ②⑯, §13. 보안 다시 보기 SEC-R01·R02·R03.
// '닫기 인사에 답하지 않는' 클라이언트는 101 뒤 소켓을 열어 둔 채 아무것도 쓰지 않는 맨 TCP다. 단언 값은 정본에서 적고 구현 상수를 가져오지 않는다.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { parseAdmissionJwks, systemClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { createStreamHub, StreamGateway } from '../src/modules/stream/index.js';
import { FakeSubscriber } from './hub-fixtures.js';

const SPEC = {
  /** 곧 닫는 연결의 닫기 인사 유예(ms, [가정]) */
  closingGraceMs: 100,
  /** 같은 jti의 닫히는 중 연결 상한([가정]). 이만큼 있으면 새 핸드셰이크 503 */
  closingPerToken: 4,
  /** 시험이 닫히는 중 연결이 끊겼다고 보기까지 기다리는 시간(ms, 리뷰 반영 계획 4.1 RF-T15) */
  waitAfterGraceMs: 300,
} as const;

const ORIGIN = 'https://www.peaket.example';
const ISS = 'https://queue.peaket.example';
const SEATS = 'peaket.seats.v1';
const AUTH = 'peaket.auth.';
const JNY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' }) as Record<string, string>;
const KEYS = parseAdmissionJwks(JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: pub.x!, y: pub.y!, kid: 'k1' }] }));
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

function token(o: { eventId?: string; jti?: string; accountId?: string } = {}): string {
  const iat = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', typ: 'admission+jwt', kid: 'k1' });
  const body = b64({ iss: ISS, sub: o.accountId ?? 'acct-1', aud: 'purchase', jti: o.jti ?? randomBytes(8).toString('hex'), sid: 'login-1', event: o.eventId ?? 'ev-1', jny: JNY, iat, exp: iat + 45 * 60 });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

interface Kept {
  socket: Socket;
  data: Buffer[];
  closed: boolean;
  /** 받은 닫힘 프레임(opcode 8)의 코드. 없으면 undefined */
  closeCode(): number | undefined;
}

interface Shake {
  status: number;
  body: string;
  upgrade: string | undefined;
  kept?: Kept;
}

let server: Server | undefined;
let gateway: StreamGateway | undefined;
const sockets: Socket[] = [];
let rejects: number[] = [];

async function startGateway(maxConnections: number): Promise<number> {
  rejects = [];
  const hub = createStreamHub({ clock: systemClock, subscriber: new FakeSubscriber(), sectionCount: () => 4 });
  gateway = new StreamGateway({
    hub,
    clock: systemClock,
    admission: { keys: KEYS, issuer: ISS },
    webOrigin: ORIGIN,
    maxConnections,
    layout: { get: async (eventId: string) => (eventId === 'ev-1' || eventId === 'ev-2' ? { layoutVersion: 1, sectionCount: 4 } : undefined) },
    onRejected: (e) => rejects.push(e.status),
  });
  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', gateway.onUpgrade);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const a = server.address();
  return typeof a === 'object' && a ? a.port : 0;
}

/** 맨 TCP 핸드셰이크. 101이면 소켓을 열어 둔 채(아무것도 쓰지 않음 = 닫기 인사에 답하지 않음) 돌려준다 */
function shake(port: number, path: string, o: { protocols?: string; method?: string; headers?: Record<string, string> } = {}): Promise<Shake> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method: o.method ?? 'GET',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), Origin: ORIGIN, ...(o.protocols !== undefined ? { 'Sec-WebSocket-Protocol': o.protocols } : {}), ...o.headers },
    });
    req.once('upgrade', (res, socket, head: Buffer) => {
      sockets.push(socket);
      const kept: Kept = {
        socket,
        // 101과 같은 조각에 온 바이트(곧 보낸 닫힘 프레임)는 head에 있다
        data: head.length > 0 ? [Buffer.from(head)] : [],
        closed: false,
        closeCode() {
          const b = Buffer.concat(this.data);
          const at = b.indexOf(0x88);
          return at >= 0 && b.length >= at + 4 ? b.readUInt16BE(at + 2) : undefined;
        },
      };
      socket.on('data', (d: Buffer) => kept.data.push(d));
      socket.on('close', () => (kept.closed = true));
      socket.on('error', () => {});
      resolve({ status: res.statusCode ?? 0, body: '', upgrade: res.headers.upgrade, kept });
    });
    req.once('response', (res) => {
      let body = '';
      res.on('data', (d) => (body += String(d)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, upgrade: res.headers.upgrade }));
    });
    req.once('error', reject);
    req.end();
  });
}

const PATH = '/v1/events/ev-1/seats/stream';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await sleep(10);
  }
  return ok();
};

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.race([gateway?.shutdown(), sleep(3_000)]);
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  gateway = undefined;
});

describe('S-T42 ⑯ 곧 닫는 연결은 파드 상한을 차지하지 않는다(SEC-R01, ADR-0297 결정 3)', () => {
  test('S-T42 ⑯ 파드 상한 3에서 회차가 다른 토큰(ev-2)으로 ev-1에 셋 붙어 닫기 인사에 답하지 않아도(4403 bad event) 곧바로 다른 토큰의 핸드셰이크는 101이다 [ASVS v5.0.0-2.4.1]', async () => {
    const port = await startGateway(3);
    const evil = token({ eventId: 'ev-2' });
    const started = Date.now();
    const kept: Kept[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${evil}` });
      expect(r.status, `bad event ${i + 1}`).toBe(101);
      kept.push(r.kept!);
    }
    expect(await until(() => kept.every((k) => k.closeCode() === 4403), 1_000)).toBe(true);
    const other = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${token()}` });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(other.status).toBe(101);
    expect(rejects).toEqual([]);
  });

  test('S-T42 ⑯ 파드 상한 3에서 같은 jti로 넷 붙으면(셋째·넷째 4429 too many, 답하지 않음) 열린 연결은 둘뿐이라 다른 토큰의 핸드셰이크는 101이다 [ASVS v5.0.0-2.4.1]', async () => {
    const port = await startGateway(3);
    const same = token({ jti: 'jti-same-1' });
    const got: Shake[] = [];
    for (let i = 0; i < 4; i++) got.push(await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${same}` }));
    expect(got.map((g) => g.status)).toEqual([101, 101, 101, 101]);
    expect(await until(() => got[2]!.kept!.closeCode() === 4429 && got[3]!.kept!.closeCode() === 4429, 1_000)).toBe(true);
    expect([got[0]!.kept!.closeCode(), got[1]!.kept!.closeCode()]).toEqual([undefined, undefined]);
    const other = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${token({ accountId: 'acct-2' })}` });
    expect(other.status).toBe(101);
    // 열린 연결이 셋(둘 + 방금 것)이라 그다음은 상한이다
    const over = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${token({ accountId: 'acct-3' })}` });
    expect([over.status, over.body, over.upgrade]).toEqual([503, '', undefined]);
  });

  test('S-T42 ⑯ 곧 닫는 연결(4403·4429)은 닫기 인사를 100ms만 기다리고 끊는다(시험은 300ms까지 본다). 열린 연결은 끊지 않는다', async () => {
    const port = await startGateway(100);
    const bad = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${token({ eventId: 'ev-2' })}` });
    const same = token({ jti: 'jti-same-2' });
    const open1 = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${same}` });
    const open2 = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${same}` });
    const tooMany = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${same}` });
    expect([bad.status, open1.status, open2.status, tooMany.status]).toEqual([101, 101, 101, 101]);
    await sleep(SPEC.waitAfterGraceMs);
    expect([bad.kept!.closed, tooMany.kept!.closed]).toEqual([true, true]);
    expect([open1.kept!.closed, open2.kept!.closed]).toEqual([false, false]);
    expect(SPEC.closingGraceMs).toBeLessThan(SPEC.waitAfterGraceMs);
  });
});

describe('S-T42 ⑯ 같은 토큰의 닫히는 중 연결 상한(SEC-R02, ADR-0297 결정 3)', () => {
  test('S-T42 ⑯ 같은 jti로 회차가 다른 연결을 답하지 않는 채 넷 만들면(101 뒤 4403 bad event) 다섯째 핸드셰이크는 회차가 맞든 다르든 업그레이드 없이 503·빈 본문이고, 그 연결들이 끊긴 뒤(300ms) 맞는 회차는 101이다 [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-16.5.1]', async () => {
    const port = await startGateway(100);
    const wrong = token({ jti: 'jti-r02', eventId: 'ev-2' });
    const right = token({ jti: 'jti-r02', eventId: 'ev-1' });
    const kept: Kept[] = [];
    for (let i = 0; i < SPEC.closingPerToken; i++) {
      const r = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${wrong}` });
      expect(r.status, `${i + 1}번째`).toBe(101);
      kept.push(r.kept!);
    }
    expect(await until(() => kept.every((k) => k.closeCode() === 4403), 1_000)).toBe(true);
    // 바로 다섯째: 회차가 다른 것도 맞는 것도(ev-2 경로로 맞는 회차 포함) 503
    const fifthWrong = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${wrong}` });
    const fifthRight = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${right}` });
    const fifthOtherPath = await shake(port, '/v1/events/ev-2/seats/stream', { protocols: `${SEATS}, ${AUTH}${wrong}` });
    for (const [name, r] of [['회차 다름', fifthWrong], ['회차 맞음', fifthRight], ['ev-2 경로', fifthOtherPath]] as const) {
      expect([r.status, r.body, r.upgrade], name).toEqual([503, '', undefined]);
    }
    expect(rejects.filter((s) => s === 503)).toHaveLength(3);
    // 다른 토큰은 막히지 않는다
    expect((await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${token()}` })).status).toBe(101);
    await sleep(SPEC.waitAfterGraceMs);
    expect(kept.every((k) => k.closed)).toBe(true);
    const later = await shake(port, PATH, { protocols: `${SEATS}, ${AUTH}${right}` });
    expect(later.status).toBe(101);
  });
});

describe('S-T42 ② ws에 맡기지 않는 업그레이드 요청 검사(SEC-R03, ADR-0297 결정 7)', () => {
  test('S-T42 ② POST(업그레이드 머리는 맞음)·Upgrade h2c·빈 하위 프로토콜 값(peaket.seats.v1,,peaket.auth.…)은 모두 400·빈 본문·업그레이드 없음이고 400으로 하나씩 센다 [ASVS v5.0.0-16.5.1]', async () => {
    const port = await startGateway(100);
    const t = token();
    const cases: Array<[string, Parameters<typeof shake>[2]]> = [
      ['POST', { method: 'POST', protocols: `${SEATS}, ${AUTH}${t}` }],
      ['Upgrade h2c', { protocols: `${SEATS}, ${AUTH}${t}`, headers: { Upgrade: 'h2c' } }],
      ['빈 하위 프로토콜 값', { protocols: `${SEATS},,${AUTH}${t}` }],
    ];
    for (const [name, o] of cases) {
      const r = await shake(port, PATH, o);
      expect([r.status, r.body, r.upgrade], name).toEqual([400, '', undefined]);
    }
    expect(rejects).toEqual([400, 400, 400]);
  });
});
