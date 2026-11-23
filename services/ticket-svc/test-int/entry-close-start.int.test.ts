// F-05-6 입장 기록 마감 실제 서버 연결 시험: 시작 파일 start()로 ticket-svc를 띄우고(실제 PostgreSQL, HTTP·관리 포트),
// 시작 파일이 조립한 배경 작업(EntryCloseTick)이 실제 HTTP 큐 비움 보고·core 판매 설정·core 알림·ops CS 건과 이어지는지 본다(BUILD_ORDER GAT-180, O-T29 ①②④⑥).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'·§7.4 운영 확인(지표·로그 이름), docs/api/guidelines.md §8.1(내부 토큰),
// asyncapi CaseRequested, 계획 docs/review/plans/F-05-6.md §4 '시작 파일'·§6·§8.
// core-svc·ops-svc 자리는 내부 경로 모양 HTTP 대역 하나다(답을 회차마다 바꾸고 멈출 수 있다). 시계는 실제 시계라 회차의 ends_at을
// 지금보다 2시간(+24시간) 넘게 이르게 골라 역할 유효 끝이 지나 있게 한다. 경계값(R−1ms·R+24h−1ms)은 단위 시험이 가짜 시계로 본다.
// 시험이 기다리지 않게 판단 주기를 시작 옵션 entryCloseEveryMs로 줄인다(계획 §6 '시계·주기를 줄인 시작 옵션'). 판정은 바깥에서 본다:
// entry_close·scanner_unreported_case 행, 대역이 받은 요청, 관리 포트 /metrics, 로그 줄.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { Writable } from 'node:stream';
import { createDatabase, type Database } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateTicket } from '../scripts/migrate.mjs';
import { DrizzleScannerDeviceStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-device-store.js';
import { DrizzleScannerShiftStore } from '../src/modules/scanner/adapters/db/drizzle-scanner-shift-store.js';
import { start, type StartedService, type StartOptions } from '../src/start.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

/** 정본 '역할 유효 끝은 ends_at + 2시간' */
const ROLE_END_AFTER_ENDS_MS = 7_200_000;
/** 정본 '24시간 [가정]' */
const UNREPORTED_WAIT_MS = 86_400_000;
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000f0661';
const STAFF = '0190f3a1-7c2e-7a00-8000-0000000f0662';
const API_HOST = 'scanner-api.peaket.example';
const PWA = 'https://scanner.peaket.example';
const INTERNAL = 'f056-internal-token';
const POLL = { timeout: 20_000, interval: 100 };

const unreportedKey = (eventId: string, deviceId: string): string => {
  const h = createHash('sha256').update(`scanner-unreported:${eventId}:${deviceId}`).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

// ---- core-svc·ops-svc 자리: 내부 경로 HTTP 대역 ----
type SaleMode = { kind: 'ok'; endsAtMs: number } | { kind: '503' } | { kind: 'hang' };
type CloseMode = 'ok' | '503' | { other: string };
type CaseMode = 'ok' | '503' | 'refuse';
const standIn = {
  sale: new Map<string, SaleMode>(),
  saleAsked: new Map<string, number>(),
  closeMode: new Map<string, CloseMode>(),
  closes: [] as { eventId: string; body: { closedAt?: string }; token: string | undefined }[],
  caseQueue: new Map<string, CaseMode[]>(),
  cases: [] as { body: Record<string, string>; token: string | undefined }[],
  hanging: [] as ServerResponse[],
  server: undefined as Server | undefined,
  port: 0,
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function startStandIn(): Promise<void> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://stand-in');
      const token = typeof req.headers['x-peaket-internal-token'] === 'string' ? req.headers['x-peaket-internal-token'] : undefined;
      const raw = await readBody(req);
      const sale = /^\/internal\/v1\/events\/([0-9a-f-]{36})\/sale-config$/.exec(url.pathname);
      if (req.method === 'GET' && sale) {
        const eventId = sale[1]!;
        standIn.saleAsked.set(eventId, (standIn.saleAsked.get(eventId) ?? 0) + 1);
        const mode = standIn.sale.get(eventId);
        if (!mode) return json(res, 404, { type: 'https://peaket.example/problems/not-found', status: 404 });
        if (mode.kind === '503') return json(res, 503, { status: 503 });
        if (mode.kind === 'hang') return void standIn.hanging.push(res);
        return json(res, 200, { eventId, promoterId: PROMOTER, rev: 1, reentryAllowed: false, opensAtMs: mode.endsAtMs - 30 * 86_400_000, endsAtMs: mode.endsAtMs, entryOpensAtMs: null, entryClosedAtMs: null });
      }
      const closed = /^\/internal\/v1\/events\/([0-9a-f-]{36})\/entry-closed$/.exec(url.pathname);
      if (req.method === 'PUT' && closed) {
        const eventId = closed[1]!;
        const body = JSON.parse(raw || '{}') as { closedAt?: string };
        standIn.closes.push({ eventId, body, token });
        const mode = standIn.closeMode.get(eventId) ?? 'ok';
        if (mode === '503') return json(res, 503, { status: 503 });
        return json(res, 200, { entryClosedAt: mode === 'ok' ? body.closedAt : mode.other });
      }
      if (req.method === 'POST' && url.pathname === '/internal/v1/cs-cases') {
        const body = JSON.parse(raw || '{}') as Record<string, string>;
        standIn.cases.push({ body, token });
        const mode = standIn.caseQueue.get(body.sourceId ?? '')?.shift() ?? 'ok';
        if (mode === '503') return json(res, 503, { status: 503 });
        return json(res, 202, { accepted: mode === 'ok' });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/internal/v1/ops-alerts')) return json(res, 202, { accepted: true });
      json(res, 404, { status: 404 });
    })();
  });
  standIn.port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  standIn.server = server;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// ---- 상태 ----
let pg: PostgresContainer;
let database: Database;
let svc: StartedService;
const logLines: string[] = [];

interface Key {
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  jwk: Record<string, unknown>;
  jkt: string;
}

async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

/** 실제 HTTP 요청(Origin 머리를 그대로 보내려고 node:http를 쓴다) */
function call(method: string, path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: svc.ports.appPort, method, path, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': API_HOST, 'content-length': String(Buffer.byteLength(payload)), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function deviceCall(key: Key, method: 'PUT' | 'POST', path: string, body: unknown) {
  const dpop = await new SignJWT({ jti: randomUUID(), htm: method, htu: `https://${API_HOST}${path}`, iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk as never })
    .sign(key.privateKey);
  return call(method, path, { dpop, origin: PWA, 'content-type': 'application/json' }, body);
}

/** 관리 포트 /metrics에서 이름과 이름표 조각이 모두 맞는 줄의 합(줄이 없으면 0) */
async function metric(name: string, labels: string[] = []): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${svc.ports.managementPort}/metrics`)).text();
  let sum = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    if (!labels.every((l) => line.includes(l))) continue;
    sum += Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return sum;
}

/** 회차 하나: 티켓(발권 때 받은 회차 시작), core 판매 설정(ends_at), 배치·근무 준비를 마친 기기 n대(DPoP 키 묶음) */
async function eventOf(o: { endsAtMs: number; devices: number; sale?: SaleMode; closeMode?: CloseMode }): Promise<{ eventId: string; ticketId: string; devices: { deviceId: string; key: Key }[] }> {
  const eventId = randomUUID();
  standIn.sale.set(eventId, o.sale ?? { kind: 'ok', endsAtMs: o.endsAtMs });
  if (o.closeMode) standIn.closeMode.set(eventId, o.closeMode);
  const deviceStore = new DrizzleScannerDeviceStore(database);
  const shifts = new DrizzleScannerShiftStore(database);
  const devices: { deviceId: string; key: Key }[] = [];
  for (let n = 0; n < o.devices; n++) {
    const deviceId = randomUUID();
    const key = await keyOf();
    await deviceStore.register({ deviceId, name: `f056-${n}-${deviceId.slice(0, 6)}`, promoterId: PROMOTER, enrolledBy: STAFF, atMs: Date.now() });
    await deviceStore.bindCredential({ deviceId, jkt: key.jkt, atMs: Date.now() });
    await shifts.putPlacement({ eventId, deviceId, gateZone: '동문', mode: 'IN', setBy: STAFF, atMs: o.endsAtMs - 4 * 3_600_000, expectedVersion: 0 });
    await shifts.reportReadiness({ eventId, deviceId, packageSeq: 1, clockOffsetMs: 0, pendingUploads: 0, reportedBy: STAFF, atMs: o.endsAtMs - 3 * 3_600_000 });
    devices.push({ deviceId, key });
  }
  // 티켓 행을 마지막에 넣는다: 그때부터 배경 작업의 후보가 된다
  const ticketId = randomUUID();
  await database.pool.query(
    `insert into ticket (id, account_id, payer_account_id, order_id, event_id, seat_id, gate_zone, status, issue_generation, qr_payload, key_hash, event_starts_at, created_at)
     values ($1, $2, $2, $3, $4, $5, '동문', 'ACTIVE', 1, 'qr', 'hash', $6, now())`,
    [ticketId, randomUUID(), randomUUID(), eventId, randomUUID(), new Date(o.endsAtMs - 3 * 3_600_000)],
  );
  return { eventId, ticketId, devices };
}

interface CloseRow {
  closedAtMs: number;
  reason: string;
  roleEndsAtMs: number;
  coreSynced: boolean;
}
async function closeRow(eventId: string): Promise<CloseRow | undefined> {
  const r = await database.pool.query<{ closed_at: Date; reason: string; role_ends_at: Date; core_synced_at: Date | null }>(
    'select closed_at, reason, role_ends_at, core_synced_at from entry_close where event_id = $1',
    [eventId],
  );
  const row = r.rows[0];
  return row ? { closedAtMs: row.closed_at.getTime(), reason: row.reason, roleEndsAtMs: row.role_ends_at.getTime(), coreSynced: row.core_synced_at !== null } : undefined;
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateTicket(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'ticket-svc-entry-close-start-int', max: 4 });
  await startStandIn();
  const options: StartOptions & { entryCloseEveryMs: number } = {
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_DATABASE_URL: pg.url,
      PEAKET_CORE_HTTP_URL: `http://127.0.0.1:${standIn.port}`,
      PEAKET_OPS_HTTP_URL: `http://127.0.0.1:${standIn.port}`,
      PEAKET_INTERNAL_TOKEN: INTERNAL,
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(await freePort()),
      PEAKET_GRPC_PORT: String(await freePort()),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 6).toString('base64'),
      PEAKET_LOG_LEVEL: 'info',
    },
    logDestination: new Writable({
      write: (c: Buffer, _e, cb) => {
        logLines.push(c.toString('utf8'));
        cb();
      },
    }),
    entryCloseEveryMs: 200,
  };
  svc = await start(options);
}, 180_000);

afterAll(async () => {
  for (const res of standIn.hanging) res.destroy();
  await svc?.close().catch(() => {});
  await new Promise<void>((resolve) => (standIn.server ? standIn.server.close(() => resolve()) : resolve()));
  await database?.close().catch(() => {});
  pg?.stop();
});

describe('F-05-6 실제 ticket-svc(start) 입장 기록 마감', () => {
  test('O-T29 ① 두 기기가 HTTP로 비움을 보고하면 시작 파일의 배경 작업이 ALL_REPORTED로 마감하고, 마감 시각을 내부 토큰과 함께 core에 알리며 지표·로그 줄이 남는다', async () => {
    const before = await metric('ticket_entry_closes_total', ['reason="ALL_REPORTED"']);
    const emptyBefore = await metric('ticket_scanner_queue_reports_total', ['result="empty"']);
    const ends = Date.now() - ROLE_END_AFTER_ENDS_MS - 60_000;
    const e = await eventOf({ endsAtMs: ends, devices: 2 });
    // 보고 전에는 마감하지 않는다(대기 끝 전이고 두 기기가 보고하지 않았다)
    await expect.poll(() => standIn.saleAsked.get(e.eventId) ?? 0, POLL).toBeGreaterThan(0);
    expect(await closeRow(e.eventId)).toBeUndefined();
    for (const d of e.devices) {
      const r = await deviceCall(d.key, 'PUT', `/v1/scanner/queue-reports/${e.eventId}`, { pendingUploads: 0 });
      expect(r.status, r.text).toBe(204);
    }
    await expect.poll(async () => (await closeRow(e.eventId))?.coreSynced ?? false, POLL).toBe(true);
    const row = (await closeRow(e.eventId))!;
    expect(row).toMatchObject({ reason: 'ALL_REPORTED', roleEndsAtMs: ends + ROLE_END_AFTER_ENDS_MS });
    const notices = standIn.closes.filter((c) => c.eventId === e.eventId);
    expect(notices.length).toBeGreaterThanOrEqual(1);
    for (const n of notices) {
      expect(Date.parse(n.body.closedAt ?? ''), '알린 마감 시각').toBe(row.closedAtMs);
      expect(n.token).toBe(INTERNAL);
    }
    expect(standIn.cases.filter((c) => c.body.sourceId?.startsWith(`${e.eventId}/`))).toEqual([]);
    await expect.poll(() => metric('ticket_entry_closes_total', ['reason="ALL_REPORTED"']), POLL).toBe(before + 1);
    expect(await metric('ticket_scanner_queue_reports_total', ['result="empty"'])).toBe(emptyBefore + 2);
    expect(logLines.some((l) => l.includes('entry-close.closed') && l.includes(e.eventId) && l.includes('ALL_REPORTED'))).toBe(true);
  });

  test('O-T29 ② 한 대가 보고하지 않은 회차는 대기 끝 뒤 TIMEOUT으로 마감되고, ops에 그 기기의 미보고 건 하나를 내부 토큰과 함께 보낸다', async () => {
    const unreportedBefore = await metric('ticket_scanner_unreported_total');
    const timeoutBefore = await metric('ticket_entry_closes_total', ['reason="TIMEOUT"']);
    const ends = Date.now() - ROLE_END_AFTER_ENDS_MS - UNREPORTED_WAIT_MS - 60_000;
    // IR-04(시험 경합 고침): 이미 TIMEOUT 창을 지난 회차라 200ms 배경 판단이 보고 커밋 전에 돌면 두 기기 모두
    // 미보고로 마감해 건이 둘이 된다. 판매 설정을 503으로 두어 배경 판단이 ends_unknown으로 건너뛰게 하고,
    // 한 대의 보고가 커밋된(204) 뒤 되살려 TIMEOUT 마감을 기다린다. 단언의 뜻은 그대로다
    const e = await eventOf({ endsAtMs: ends, devices: 2, sale: { kind: '503' } });
    // 한 대는 비웠다고 보고하고 한 대는 보고하지 않는다
    expect((await deviceCall(e.devices[0]!.key, 'PUT', `/v1/scanner/queue-reports/${e.eventId}`, { pendingUploads: 0 })).status).toBe(204);
    standIn.sale.set(e.eventId, { kind: 'ok', endsAtMs: ends });
    const silent = e.devices[1]!.deviceId;
    await expect.poll(async () => Number((await database.pool.query('select count(*)::int as n from scanner_unreported_case where event_id = $1 and opened_at is not null', [e.eventId])).rows[0].n), POLL).toBe(1);
    const row = (await closeRow(e.eventId))!;
    expect(row.reason).toBe('TIMEOUT');
    const sent = standIn.cases.filter((c) => c.body.sourceId?.startsWith(`${e.eventId}/`));
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const c of sent) {
      expect(c.token).toBe(INTERNAL);
      expect(c.body).toEqual({
        eventKey: unreportedKey(e.eventId, silent),
        kind: 'SCANNER_UNREPORTED',
        sourceId: `${e.eventId}/${silent}`,
        category: 'UNREPORTED_AT_CLOSE',
        createdAt: new Date(row.closedAtMs).toISOString(),
        dueBaseAt: new Date(row.closedAtMs).toISOString(),
      });
    }
    expect(await metric('ticket_scanner_unreported_total')).toBe(unreportedBefore + 1);
    expect(await metric('ticket_entry_closes_total', ['reason="TIMEOUT"'])).toBe(timeoutBefore + 1);
  });

  test('O-T29 ⑥ core 내부 입구가 503이면 마감 행은 남고 알린 시각이 비며 실패 지표가 오른다. 되살리면 다시 보내 채워지고 보낸 마감 시각은 늘 같다', async () => {
    const failuresBefore = await metric('ticket_entry_close_core_sync_failures_total');
    const e = await eventOf({ endsAtMs: Date.now() - ROLE_END_AFTER_ENDS_MS - 60_000, devices: 0, closeMode: '503' });
    await expect.poll(() => standIn.closes.filter((c) => c.eventId === e.eventId).length, POLL).toBeGreaterThanOrEqual(2);
    const row = (await closeRow(e.eventId))!;
    expect(row).toMatchObject({ reason: 'ALL_REPORTED', coreSynced: false });
    expect(await metric('ticket_entry_close_core_sync_failures_total')).toBeGreaterThanOrEqual(failuresBefore + 2);
    expect(logLines.some((l) => l.includes('entry-close.core-sync-failed') && l.includes(e.eventId))).toBe(true);
    standIn.closeMode.set(e.eventId, 'ok');
    await expect.poll(async () => (await closeRow(e.eventId))?.coreSynced ?? false, POLL).toBe(true);
    expect(new Set(standIn.closes.filter((c) => c.eventId === e.eventId).map((c) => Date.parse(c.body.closedAt ?? '')))).toEqual(new Set([row.closedAtMs]));
    expect((await closeRow(e.eventId))!.closedAtMs).toBe(row.closedAtMs);
  });

  test('O-T29 ⑥ core가 이미 다른 마감 시각을 갖고 있으면 ticket-svc 마감 시각은 그대로이고 알린 것으로 적으며 entry-close.core-mismatch 경고를 남긴다', async () => {
    const other = new Date(Date.now() - 3_600_000).toISOString();
    const e = await eventOf({ endsAtMs: Date.now() - ROLE_END_AFTER_ENDS_MS - 120_000, devices: 0, closeMode: { other } });
    await expect.poll(async () => (await closeRow(e.eventId))?.coreSynced ?? false, POLL).toBe(true);
    const row = (await closeRow(e.eventId))!;
    expect(row.closedAtMs).not.toBe(Date.parse(other));
    expect(Date.parse(standIn.closes.find((c) => c.eventId === e.eventId)!.body.closedAt ?? '')).toBe(row.closedAtMs);
    expect(logLines.some((l) => l.includes('entry-close.core-mismatch') && l.includes(e.eventId))).toBe(true);
  });

  test('O-T29 ⑥ ops가 503·accepted false로 답하면 건 행이 열리지 않은 채 남아 다시 보내고, 받은 뒤 연 시각이 채워진다(같은 eventKey 하나, 그 뒤로는 보내지 않음)', async () => {
    const sendFailuresBefore = await metric('ticket_cs_case_send_failures_total', ['kind="SCANNER_UNREPORTED"']);
    const ends = Date.now() - ROLE_END_AFTER_ENDS_MS - UNREPORTED_WAIT_MS - 120_000;
    // 답 차례를 기기 ID(sourceId)에 걸어야 하므로, 판매 설정을 503으로 두어 차례를 걸 때까지 마감되지 않게 한다
    const made = await eventOf({ endsAtMs: ends, devices: 1, sale: { kind: '503' } });
    const sourceId = `${made.eventId}/${made.devices[0]!.deviceId}`;
    standIn.caseQueue.set(sourceId, ['503', 'refuse']);
    standIn.sale.set(made.eventId, { kind: 'ok', endsAtMs: ends });
    const opened = async (): Promise<number> =>
      Number((await database.pool.query('select count(*)::int as n from scanner_unreported_case where event_id = $1 and opened_at is not null', [made.eventId])).rows[0].n);
    await expect.poll(opened, POLL).toBe(1);
    const sent = () => standIn.cases.filter((c) => c.body.sourceId === sourceId);
    // 503 한 번, accepted false 한 번, 받음 한 번(판단이 겹치면 받음이 한 번 더 갈 수 있다)
    expect(sent().length).toBeGreaterThanOrEqual(3);
    expect(new Set(sent().map((c) => c.body.eventKey))).toEqual(new Set([unreportedKey(made.eventId, made.devices[0]!.deviceId)]));
    expect(await metric('ticket_cs_case_send_failures_total', ['kind="SCANNER_UNREPORTED"'])).toBeGreaterThanOrEqual(sendFailuresBefore + 2);
    expect(logLines.some((l) => l.includes('scanner-unreported.case-failed') && l.includes(made.eventId))).toBe(true);
    // 받은 뒤에는 더 보내지 않는다: 마감되지 않는 보초 회차로 판단이 두 번 돈 뒤 센 값과, 다시 두 번 돈 뒤 센 값이 같다
    const sentinel = await eventOf({ endsAtMs: ends, devices: 0, sale: { kind: '503' } });
    const asked = () => standIn.saleAsked.get(sentinel.eventId) ?? 0;
    await expect.poll(asked, POLL).toBeGreaterThanOrEqual(2);
    const settled = sent().length;
    const mark = asked();
    await expect.poll(asked, POLL).toBeGreaterThanOrEqual(mark + 2);
    expect(sent().length).toBe(settled);
  });

  test('O-T29 ⑥ core 판매 설정이 503이거나 답하지 않는 회차는 판단마다 물어도 마감하지 않고, 같은 때 다른 회차는 마감한다. 되살리면 마감한다', async () => {
    const skippedBefore = await metric('ticket_entry_close_skipped_total', ['reason="ends_unknown"']);
    const ends = Date.now() - ROLE_END_AFTER_ENDS_MS - 60_000;
    // 답 없는 회차와 503 회차가 더 오래된 시작이라 정상 회차보다 먼저 묻는다(답 없는 호출이 판단 전체를 막으면 정상 회차가 마감되지 않는다, 시험 리뷰 RV-11)
    const hang = await eventOf({ endsAtMs: ends - 2_000, devices: 0, sale: { kind: 'hang' } });
    const down = await eventOf({ endsAtMs: ends - 1_000, devices: 0, sale: { kind: '503' } });
    const ok = await eventOf({ endsAtMs: ends, devices: 0 });
    await expect.poll(async () => (await closeRow(ok.eventId)) !== undefined, POLL).toBe(true);
    await expect.poll(() => Math.min(standIn.saleAsked.get(down.eventId) ?? 0, standIn.saleAsked.get(hang.eventId) ?? 0), POLL).toBeGreaterThanOrEqual(2);
    expect(await closeRow(down.eventId)).toBeUndefined();
    expect(await closeRow(hang.eventId)).toBeUndefined();
    // 끝 시각을 모른 회차는 판단마다 건너뜀 지표를 올리고 로그 줄을 남긴다(정본 §7.4)
    expect(await metric('ticket_entry_close_skipped_total', ['reason="ends_unknown"'])).toBeGreaterThanOrEqual(skippedBefore + 4);
    expect(logLines.some((l) => l.includes('entry-close.ends-unknown') && l.includes(down.eventId))).toBe(true);
    standIn.sale.set(down.eventId, { kind: 'ok', endsAtMs: ends });
    standIn.sale.set(hang.eventId, { kind: 'ok', endsAtMs: ends });
    await expect.poll(async () => (await closeRow(down.eventId)) !== undefined && (await closeRow(hang.eventId)) !== undefined, POLL).toBe(true);
  });

  test('O-T29 ④ 마감 뒤 기기 인증만으로 올라온 기록은 200으로 받아 저장하고 AFTER_CLOSE 표시를 단다', async () => {
    const e = await eventOf({ endsAtMs: Date.now() - ROLE_END_AFTER_ENDS_MS - 60_000, devices: 1 });
    expect((await deviceCall(e.devices[0]!.key, 'PUT', `/v1/scanner/queue-reports/${e.eventId}`, { pendingUploads: 0 })).status).toBe(204);
    await expect.poll(async () => (await closeRow(e.eventId)) !== undefined, POLL).toBe(true);
    const closedAt = (await closeRow(e.eventId))!.closedAtMs;
    const scanId = randomUUID();
    const r = await deviceCall(e.devices[0]!.key, 'POST', '/v1/scanner/scans', [
      { id: scanId, eventId: e.eventId, ticketId: e.ticketId, scannerSessionId: randomUUID(), direction: 'IN', method: 'QR', result: 'PASS', gateZone: '동문', scannedAtDevice: new Date(closedAt - 900_000).toISOString(), knownSeq: 0, deviceSeq: 1 },
    ]);
    expect(r.status, r.text).toBe(200);
    expect((JSON.parse(r.text) as { acceptedIds: string[] }).acceptedIds).toEqual([scanId]);
    expect(Number((await database.pool.query('select count(*)::int as n from scan_event where event_id = $1 and id = $2', [e.eventId, scanId])).rows[0].n)).toBe(1);
    const kinds = (await database.pool.query<{ kind: string }>('select kind from gate_flag where event_id = $1', [e.eventId])).rows.map((x) => x.kind);
    expect(kinds).toContain('AFTER_CLOSE');
  });
});
