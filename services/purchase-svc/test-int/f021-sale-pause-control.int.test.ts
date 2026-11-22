// F-02-1(OPS-300) purchase-svc 받는 쪽: 명령 3 판매 일시정지(CONTROL_KIND_SALE_PAUSE)를 원본 purchase DB sale_control과 사본 s:{event:E}:ctl에 쓰고,
// 새로 뜬·늘린 파드가 그 상태로 시작하며, 사본을 지워도 다시 서고, 원본을 읽지 못한 파드는 준비 상태가 되지 않는다(C-T50).
// 시험 조립이 아니라 시작 함수(src/start.ts)를 파드처럼 여럿 띄운다(F-02-1 계획 13절 '시작 파일 조립은 따로 띄워 본다'). 실제 PostgreSQL 18·Valkey 8.1.
// Kafka 브로커는 주지 않는다(ci: 제어 토픽 소비가 꺼진 채 뜬다). 그래도 sale_control 읽기는 준비 상태를 막아야 한다(정본 C-T50 '제어 상태를 읽지 못한 파드는 준비 상태가 되지 않는다').
// 정본: docs/features/control-tower.md §14 C-T50, ADR-0365 결정 1(판 검사)·2(꼴)·6(칸 이름: sale_control paused_revision·paused_command_id·paused_changed_at,
// 사본 paused·pausedRev·pausedCmd, 전체는 s:ctl:events 회차마다 allPaused·allRev·allCmd, 판매 중지 revision·rev와 서로 막지 않음)·7(시작 읽기·2초 다시 맞춤)·
// 8(정지 동안 유휴로 끝내지 않음, 풀린 뒤 유휴 시한 < 풀린 시각 + 5분이면 그 값, 최대 체류는 그대로), docs/data.md s:session:{jti}·s:{event:E}:sessions·s:{event:E}:stream.
// 홀드 423은 실제 HTTP 응답이다(계획 13절 '423이 실제 HTTP 응답으로 나옴'). 결제 시도·결제 접수의 423은 주문이 있어야 해 이 파일에서 보지 않는다(계획 10.1의 빈칸).
import { createPublicKey, diffieHellman, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHotRedis, type HotRedis, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput, purchaseRequestKey } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { RedisSeatStore } from '../src/modules/inventory/index.js';
import { start, type StartedService } from '../src/start.js';
import { claimsOf, newKey, signAdmission } from '../test/admission-fixtures.js';
import { clientKeyOf } from '../test/session-fixtures.js';
import { type ApplyRequest, type ControlClient, controlClient, freePort, status } from '../../queue-svc/test-int/control-client.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const DAY = 86_400_000;
const IDLE_MS = 5 * 60_000;
const ADMISSION = newKey('it-f021-adm');
const ecdh = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { jwk: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'it-f021-ecdh' }, pub: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y! }, format: 'jwk' }) };
})();

interface Pod {
  readonly name: string;
  readonly svc: StartedService;
  readonly control: ControlClient;
  readonly app: string;
  readonly management: string;
}

let pgc: PostgresContainer;
let admin: pg.Client;
let brokenUrl: string;
let valkey: ValkeyContainer;
let redis: HotRedis;
let seatDir: string;
const pods: Pod[] = [];

/** 이 파일이 쓰는 회차(좌석맵 판·판매 열기를 미리 한다) */
const E = { paused: randomUUID(), other: randomUUID(), susp: randomUUID(), idle: randomUUID(), idleCtrl: randomUUID() };

const layoutFile = () => ({
  perAccountLimit: 4,
  saleEndsAt: new Date(Date.now() + DAY).toISOString(),
  layout: {
    layoutVersion: 1,
    canvas: { width: 1000, height: 800 },
    sections: [
      {
        sectionId: 'SEC-A',
        name: 'A구역',
        shape: { type: 'polygon', points: [] },
        tierId: 'R',
        seatIndexRange: { from: 0, to: 3 },
        seats: ['A01', 'A02', 'A03', 'A04'].map((seatId, index) => ({ seatId, row: 'A', number: index + 1, x: 10 * (index + 1), y: 20, index })),
      },
    ],
  },
});

async function startPod(name: string, databaseUrl: string): Promise<Pod> {
  const appPort = await freePort();
  const managementPort = await freePort();
  const controlPort = await freePort();
  const svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_POD: name,
      PEAKET_SEAT_REDIS_URL: valkey.url,
      PEAKET_DATABASE_URL: databaseUrl,
      PEAKET_ORDER_CONSENT_VERSION: 'f021-v1',
      PEAKET_ADMISSION_JWKS: JSON.stringify({ keys: [{ ...ADMISSION.publicJwk, alg: 'ES256', use: 'sig' }] }),
      PEAKET_ADMISSION_ISSUER: 'https://queue.peaket.example',
      PEAKET_PURCHASE_ECDH_KEY: JSON.stringify(ecdh.jwk),
      PEAKET_SEATMAP_DIR: seatDir,
      PEAKET_PAYMENT_GRPC_ADDR: '127.0.0.1:1',
      PEAKET_TICKET_GRPC_ADDR: '127.0.0.1:1',
      PEAKET_PURCHASE_CONTROL_GRPC_PORT: String(controlPort),
      PEAKET_CONTROL_GRPC_HOST: '127.0.0.1',
      PORT: String(appPort),
      PEAKET_MANAGEMENT_PORT: String(managementPort),
      PEAKET_GRPC_PORT: String(await freePort()),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'fatal',
    },
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const pod = { name, svc, control: controlClient(`127.0.0.1:${controlPort}`), app: `http://127.0.0.1:${appPort}`, management: `http://127.0.0.1:${managementPort}` };
  pods.push(pod);
  return pod;
}

beforeAll(async () => {
  [pgc, valkey] = await Promise.all([startPostgres(), startValkey()]);
  await migratePurchase(pgc.url);
  admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  // C-T50 ③용 두 번째 DB: 마이그레이션은 같고 sale_control만 읽지 못하게 이름을 바꿔 둔다(시험 안에서 되돌린다)
  await admin.query('create database peaket_f021_broken');
  brokenUrl = pgc.url.replace(/\/peaket$/, '/peaket_f021_broken');
  await migratePurchase(brokenUrl);
  redis = await createHotRedis({ url: valkey.url });
  seatDir = await mkdtemp(join(tmpdir(), 'peaket-f021-'));
  const seats = new RedisSeatStore(redis);
  for (const e of Object.values(E)) {
    await writeFile(join(seatDir, `${e}.json`), JSON.stringify(layoutFile()));
    await seats.openSale({ eventId: e, seatCount: 4, keepUntilMs: Date.now() + 3 * DAY });
  }
  // 처음 두 파드(C-T50 '둘에서 늘린다'의 둘)
  await startPod('purchase-f021-a', pgc.url);
  await startPod('purchase-f021-b', pgc.url);
}, 240_000);

afterAll(async () => {
  for (const p of pods) {
    p.control.close();
    await p.svc.close().catch(() => undefined);
  }
  await redis?.close();
  await admin?.end().catch(() => undefined);
  valkey?.stop();
  pgc?.stop();
  if (seatDir) await rm(seatDir, { recursive: true, force: true });
});

const ctl = (e: string) => `s:{event:${e}}:ctl`;
async function hash(key: string): Promise<Record<string, string>> {
  const raw = (await redis.command(['HGETALL', key], { key })) as unknown;
  if (Array.isArray(raw)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < raw.length; i += 2) o[String(raw[i])] = String(raw[i + 1]);
    return o;
  }
  return Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}
const del = (key: string) => redis.command(['DEL', key], { key });
const exists = async (key: string) => Number(await redis.command(['EXISTS', key], { key }));
const ready = async (p: Pod) => (await fetch(`${p.management}/ready`)).status;

interface Row {
  paused: boolean;
  paused_revision: string | null;
  paused_command_id: string | null;
  paused_changed_at: Date | null;
  suspended: boolean;
  revision: string;
  command_id: string | null;
}
const rowOf = async (eventId: string | 'PLATFORM'): Promise<Row | undefined> =>
  (
    await admin.query<Row>(
      eventId === 'PLATFORM'
        ? "select paused, paused_revision::text, paused_command_id::text, paused_changed_at, suspended, revision::text, command_id::text from sale_control where scope = 'PLATFORM'"
        : "select paused, paused_revision::text, paused_command_id::text, paused_changed_at, suspended, revision::text, command_id::text from sale_control where scope = 'EVENT' and event_id = $1",
      eventId === 'PLATFORM' ? [] : [eventId],
    )
  ).rows[0];

const pauseReq = (scope: string, version: number | string, paused: boolean, commandId = randomUUID()): ApplyRequest => ({ commandId, scope, kind: 'CONTROL_KIND_SALE_PAUSE', version, desiredStateJson: JSON.stringify({ paused }) });
/** 준비된 모든 파드에 같은 명령을 보낸다(ADR-0365 결정 4의 퍼뜨리기와 같다). 파드마다의 ack를 돌려준다 */
const toAll = (r: ApplyRequest) => Promise.all(pods.map((p) => p.control.apply(r)));

let accountSeq = 0;
/** 입장 토큰과 본문 clientEphemeralPublicKey로 구매 세션을 여는 첫 홀드(start-admission-jwks.int.test.ts와 같은 흐름) */
async function firstHold(pod: Pod, eventId: string, seatId: string): Promise<{ status: number; type?: string; jti: string }> {
  const n = ++accountSeq;
  const account = `0190f3a1-7c2e-7a00-8000-${String(n).padStart(12, '0')}`;
  const login = `it-f021-login-${n}`;
  const jti = randomUUID();
  const token = signAdmission(ADMISSION, claimsOf({ nowMs: Date.now(), jti, accountId: account, loginSessionId: login, eventId }));
  const client = clientKeyOf();
  const mac = Buffer.from(purchaseRequestKey(diffieHellman({ privateKey: client.privateKey, publicKey: ecdh.pub }), jti));
  const url = `/v1/events/${eventId}/holds`;
  const body = JSON.stringify({ seatIds: [seatId], clientEphemeralPublicKey: client.text });
  const r = await fetch(`${pod.app}${url}`, {
    method: 'POST',
    body,
    headers: {
      'x-user-id': account,
      'x-session-id': login,
      'x-user-aud': 'fan',
      'x-user-scope': 'ticket:buy',
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'x-admission-token': token,
      'x-purchase-seq': '1',
      'x-purchase-mac': purchaseMac(mac, purchaseMacInput('POST', url, 1, Buffer.from(body, 'utf8'))),
    },
  });
  const json = (await r.json().catch(() => ({}))) as { type?: string };
  return { status: r.status, ...(json.type !== undefined ? { type: json.type } : {}), jti };
}

describe('C-T50 킬스위치 중 확장·재시작 (purchase-svc 시작 파일)', () => {
  test('C-T50 ① 명령 3이 ACKED인 회차에서 늘린 파드의 홀드는 423 sale-paused이고 다른 회차는 판다. 원본·사본에 판·명령 칸이 서고 두 파드 모두 그 판 이상을 ack한다', async () => {
    const cmd = randomUUID();
    const version = Date.now();
    const acks = await toAll(pauseReq(E.paused, version, true, cmd));
    expect(acks.map((a) => ({ pod: a.podName, v: a.appliedVersion }))).toEqual([
      { pod: 'purchase-f021-a', v: version },
      { pod: 'purchase-f021-b', v: version },
    ]);
    const row = await rowOf(E.paused);
    expect(row).toMatchObject({ paused: true, paused_revision: String(version), paused_command_id: cmd });
    expect(row?.paused_changed_at).toBeInstanceOf(Date);
    expect(await hash(ctl(E.paused))).toMatchObject({ paused: '1', pausedRev: String(version), pausedCmd: cmd });

    // 파드를 늘린다(셋째). 새 파드는 sale_control을 읽어야 준비가 된다
    const fresh = await startPod('purchase-f021-c', pgc.url);
    await expect.poll(() => ready(fresh), { timeout: 15_000, interval: 200 }).toBe(200);
    const paused = await firstHold(fresh, E.paused, 'A01');
    expect({ status: paused.status, type: paused.type }).toEqual({ status: 423, type: `${PROBLEM_TYPE_BASE}sale-paused` });
    const other = await firstHold(fresh, E.other, 'A01');
    expect(other.status, '다른 회차는 그대로 판다').toBe(201);
    // 새 파드도 같은 판을 다시 받으면 아무것도 바꾸지 않고 그 판을 답한다(멱등)
    expect((await fresh.control.apply(pauseReq(E.paused, version, true, cmd))).appliedVersion).toBe(version);
  }, 60_000);

  test('C-T50 ② 사본 s:{event:E}:ctl을 지우면 2초 [가정] + 다시 맞춤 한 번 안에 원본대로 다시 써진다', async () => {
    const before = await hash(ctl(E.paused));
    expect(before.paused, '① 시험의 정지가 걸려 있어야 한다').toBe('1');
    await del(ctl(E.paused));
    expect(await exists(ctl(E.paused))).toBe(0);
    await expect.poll(() => hash(ctl(E.paused)), { timeout: 4_500, interval: 100 }).toMatchObject({ paused: '1', pausedRev: before.pausedRev, pausedCmd: before.pausedCmd });
  });

  test('C-T50 ③ sale_control을 읽지 못한 파드는 준비 상태가 되지 않고, 읽을 수 있게 되면 준비가 된다', async () => {
    const brokenAdmin = new pg.Client({ connectionString: brokenUrl });
    await brokenAdmin.connect();
    await brokenAdmin.query('alter table sale_control rename to sale_control_hidden');
    const broken = await startPod('purchase-f021-broken', brokenUrl);
    try {
      // 시작 읽기 재시도(1초 [가정])·다시 맞춤(2초 [가정])보다 긴 3초 동안 늘 503이어야 한다
      const seen: number[] = [];
      const until = Date.now() + 3_000;
      while (Date.now() < until) {
        seen.push(await ready(broken));
        await sleep(250);
      }
      expect(seen.length).toBeGreaterThanOrEqual(5);
      expect(new Set(seen), '원본을 읽지 못했는데 준비 상태가 됐다').toEqual(new Set([503]));
      await brokenAdmin.query('alter table sale_control_hidden rename to sale_control');
      await expect.poll(() => ready(broken), { timeout: 10_000, interval: 200 }).toBe(200);
    } finally {
      // 다른 DB를 보는 파드라 뒤 시험(정리 반복·다시 맞춤)에 끼지 않게 닫는다
      pods.splice(pods.indexOf(broken), 1);
      broken.control.close();
      await broken.svc.close().catch(() => undefined);
      await brokenAdmin.end().catch(() => undefined);
    }
  }, 60_000);
});

describe('F021-SUSP 판매 중지와 판매 일시정지의 판 칸 (B13·M10)', () => {
  test('F021-SUSP ① 명령 3 판은 판매 중지 칸(revision·rev·cmd)에 쓰지 않고, 둘은 서로의 판으로 막히지 않는다', async () => {
    const e = E.susp;
    const suspCmd = randomUUID();
    await toAll({ commandId: suspCmd, scope: e, kind: 'CONTROL_KIND_SALE_SUSPENSION', version: 50_000, desiredStateJson: '{"suspended":true}' });
    const pauseCmd = randomUUID();
    const acks = await toAll(pauseReq(e, 10, true, pauseCmd));
    expect(acks.every((a) => a.appliedVersion === 10), '판매 중지 판(50,000)보다 작은 명령 3 판(10)이 막혔다').toBe(true);
    expect(await rowOf(e)).toMatchObject({ paused: true, paused_revision: '10', paused_command_id: pauseCmd, suspended: true, revision: '50000', command_id: suspCmd });
    expect(await hash(ctl(e))).toMatchObject({ paused: '1', pausedRev: '10', pausedCmd: pauseCmd, suspended: '1', rev: '50000', cmd: suspCmd });
    // 판매 재개는 판매 중지 칸만 내리고 명령 3은 그대로다
    const resumeCmd = randomUUID();
    await toAll({ commandId: resumeCmd, scope: e, kind: 'CONTROL_KIND_SALE_SUSPENSION', version: 50_001, desiredStateJson: '{"suspended":false}' });
    expect(await rowOf(e)).toMatchObject({ paused: true, paused_revision: '10', suspended: false, revision: '50001' });
    expect(await hash(ctl(e))).toMatchObject({ paused: '1', pausedRev: '10', suspended: '0', rev: '50001' });
  });

  test('F021-SUSP ② 전체 범위 명령 3은 PLATFORM 행과 s:ctl:events의 모든 회차 사본(allPaused·allRev·allCmd)에 쓰고, 지운 사본도 다시 서며, 홀드는 423이다', async () => {
    const cmd = randomUUID();
    const version = Date.now();
    await toAll(pauseReq('PLATFORM', version, true, cmd));
    expect(await rowOf('PLATFORM')).toMatchObject({ paused: true, paused_revision: String(version), paused_command_id: cmd });
    for (const e of [E.other, E.paused]) expect(await hash(ctl(e)), e).toMatchObject({ allPaused: '1', allRev: String(version), allCmd: cmd });
    await del(ctl(E.other));
    await expect.poll(() => hash(ctl(E.other)), { timeout: 4_500, interval: 100 }).toMatchObject({ allPaused: '1', allRev: String(version) });
    const held = await firstHold(pods[0]!, E.other, 'A02');
    expect({ status: held.status, type: held.type }).toEqual({ status: 423, type: `${PROBLEM_TYPE_BASE}sale-paused` });
    const lift = Date.now() + 1;
    await toAll(pauseReq('PLATFORM', lift, false));
    expect(await hash(ctl(E.other))).toMatchObject({ allPaused: '0', allRev: String(lift) });
    expect((await firstHold(pods[0]!, E.other, 'A03')).status, '전체 정지를 풀면 다시 판다').toBe(201);
  });
});

describe('ASVS v5.0.0-1.4.2·15.3.5·2.1.1 purchase-svc 판·꼴 검사', () => {
  const pod = () => pods[0]!;
  test('ASVS v5.0.0-1.4.2 ③ 판 0·음수·2^53·2^53+1은 INVALID_ARGUMENT이고 행·사본을 쓰지 않는다', async () => {
    const e = randomUUID();
    for (const version of [0, -1, '9007199254740992', '9007199254740993']) {
      await expect(pod().control.apply(pauseReq(e, version, true)), `판 ${version}`).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    }
    expect(await rowOf(e)).toBeUndefined();
    expect(await exists(ctl(e))).toBe(0);
  });

  test('ASVS v5.0.0-15.3.5 ④ 판은 수로 엄격 비교한다: 9 다음 10이 이기고, 늦은 9와 같은 판 10은 바꾸지 않고 10을 답한다', async () => {
    const e = randomUUID();
    await pod().control.apply(pauseReq(e, 9, true));
    const ten = randomUUID();
    expect((await pod().control.apply(pauseReq(e, 10, false, ten))).appliedVersion).toBe(10);
    expect((await pod().control.apply(pauseReq(e, 9, true))).appliedVersion).toBe(10);
    expect((await pod().control.apply(pauseReq(e, 10, true))).appliedVersion).toBe(10);
    expect(await rowOf(e)).toMatchObject({ paused: false, paused_revision: '10', paused_command_id: ten });
    expect(await hash(ctl(e))).toMatchObject({ paused: '0', pausedRev: '10', pausedCmd: ten });
  });

  test.each([
    ['모르는 칸', '{"paused":true,"extra":1}'],
    ['틀린 형', '{"paused":1}'],
    ['칸 없음', '{}'],
    ['빈 글', ''],
    ['배열', '[true]'],
  ])('ASVS v5.0.0-2.1.1 ⑧ 명령 3 %s는 INVALID_ARGUMENT이고 쓰기 0', async (_n, json) => {
    const e = randomUUID();
    await expect(pod().control.apply({ commandId: randomUUID(), scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', version: 100, desiredStateJson: json })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(await rowOf(e)).toBeUndefined();
    expect(await exists(ctl(e))).toBe(0);
  });

  test('ASVS v5.0.0-2.1.1 ⑨ 범위가 빈 글이거나 회차 ID(UUID)·PLATFORM이 아니면 INVALID_ARGUMENT', async () => {
    for (const scope of ['', 'platform', 'not-a-uuid']) {
      await expect(pod().control.apply(pauseReq(scope, 100, true)), `범위 '${scope}'`).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    }
  });

  test.each(['CONTROL_KIND_ADMISSION_TARGET', 'CONTROL_KIND_ADMISSION_PAUSE', 'CONTROL_KIND_LOBBY_BANNER', 'CONTROL_KIND_AUTOMATION_STOP'])(
    'ASVS v5.0.0-2.1.1 ⑩ purchase-svc가 받지 않는 종류 %s는 UNIMPLEMENTED이고 쓰기 0',
    async (kind) => {
      const e = randomUUID();
      await expect(pod().control.apply({ commandId: randomUUID(), scope: e, kind, version: 100, desiredStateJson: '{"paused":true}' })).rejects.toMatchObject({ code: status.UNIMPLEMENTED });
      expect(await rowOf(e)).toBeUndefined();
    },
  );
});

describe('F021-IDLE 판매 일시정지 중 유휴 시계 (B16, ADR-0365 결정 8)', () => {
  const sessionKey = (jti: string) => `s:session:{${jti}}`;
  const indexKey = (e: string) => `s:{event:${e}}:sessions`;
  const streamKey = (e: string) => `s:{event:${e}}:stream`;
  const setField = (jti: string, field: string, value: number) => redis.command(['HSET', sessionKey(jti), field, String(value)], { key: sessionKey(jti) });
  const dueNow = (e: string, jti: string, at: number) => redis.command(['ZADD', indexKey(e), 'XX', String(at), jti], { key: indexKey(e) });
  const score = async (e: string, jti: string) => {
    const v = await redis.command(['ZSCORE', indexKey(e), jti], { key: indexKey(e) });
    return v === null || v === undefined ? undefined : Number(String(v));
  };
  /** 그 회차 Stream의 SESSION_ENDED 항목: 세션 ID → 끝난 까닭 */
  async function endedIn(e: string): Promise<Map<string, string>> {
    const raw = (await redis.command(['XRANGE', streamKey(e), '-', '+'], { key: streamKey(e) })) as unknown[];
    const out = new Map<string, string>();
    for (const entry of raw ?? []) {
      const flat = Array.isArray(entry) ? (entry[1] as unknown[]) : Object.entries((entry as { message?: Record<string, unknown> }).message ?? {}).flat();
      const f: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) f[String(flat[i])] = String(flat[i + 1]);
      if (f.type === 'SESSION_ENDED' && f.purchaseSessionId) out.set(f.purchaseSessionId, f.reason ?? '');
    }
    return out;
  }

  test('F021-IDLE ① 정지 동안 유휴 시한이 지난 세션을 끝내지 않고(최대 체류는 끝낸다), 풀린 뒤 처음 볼 때 유휴 시한을 풀린 시각 + 5분 [가정]으로 다시 쓴다', async () => {
    const owner = pods[0]!;
    const idle = await firstHold(owner, E.idle, 'A01');
    const maxed = await firstHold(owner, E.idle, 'A02');
    const ctrl = await firstHold(owner, E.idleCtrl, 'A01');
    expect([idle.status, maxed.status, ctrl.status], '세 구매 세션을 열지 못했다').toEqual([201, 201, 201]);

    const pauseCmd = randomUUID();
    await toAll(pauseReq(E.idle, Date.now(), true, pauseCmd));
    // fixed-wait: 파드 메모리의 정지 상태(결정 7·8)를 바깥에서 볼 면이 없어, 받지 않은 파드도 다시 맞춤 한 주기(2초 [가정])를 지나게 기다린다 F-02-1
    await sleep(2_500);

    const past = Date.now() - 1_000;
    await setField(idle.jti, 'idle', past);
    await setField(maxed.jti, 'max', past);
    await setField(ctrl.jti, 'idle', past);
    for (const [e, jti] of [[E.idle, idle.jti], [E.idle, maxed.jti], [E.idleCtrl, ctrl.jti]] as const) await dueNow(e, jti, past);

    // 대조: 정지가 없는 회차의 유휴 세션은 끝난다(정리 반복이 돈다는 증거). 정지 회차의 최대 체류 세션도 끝난다
    await expect.poll(async () => (await endedIn(E.idleCtrl)).get(ctrl.jti), { timeout: 6_000, interval: 200 }).toBe('IDLE');
    await expect.poll(async () => (await endedIn(E.idle)).get(maxed.jti), { timeout: 6_000, interval: 200 }).toBe('MAX_STAY');
    // 정지 회차의 유휴 세션은 끝내지 않고 다음 볼 시각만 미룬다
    await expect.poll(async () => (await score(E.idle, idle.jti)) ?? -1, { timeout: 6_000, interval: 200 }).toBeGreaterThan(past);
    expect((await endedIn(E.idle)).has(idle.jti), '정지 동안 유휴로 끝냈다').toBe(false);
    expect(await exists(sessionKey(idle.jti))).toBe(1);

    // 풀기
    const r0 = Date.now();
    await toAll(pauseReq(E.idle, Date.now() + 1, false));
    const r1 = Date.now();
    await dueNow(E.idle, idle.jti, Date.now());
    await expect.poll(async () => Number((await hash(sessionKey(idle.jti))).idle ?? 0), { timeout: 8_000, interval: 200 }).toBeGreaterThanOrEqual(r0 + IDLE_MS);
    const rewritten = Number((await hash(sessionKey(idle.jti))).idle);
    // 풀린 시각은 보낸 때와 받은 파드가 아는 때 사이다(받지 않은 파드는 다시 맞춤 한 주기 안)
    expect(rewritten).toBeLessThanOrEqual(r1 + 2_500 + IDLE_MS);
    expect((await endedIn(E.idle)).has(idle.jti)).toBe(false);
  }, 60_000);
});
