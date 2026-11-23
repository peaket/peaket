// F-05-6 책임자 이상 표시 목록 거르기 HTTP 시험(BUILD_ORDER GAT-190, O-T53 ①~③, 감사 C1-16).
// 정본: docs/features/offline-gate.md §7.2 '책임자 이상 표시 목록 거르기'(요청한 기기의 그 회차 배치 구역과 티켓 구역이 같은 표시만,
// OVERRIDE_REVIEW는 넣지 않음, 처리 상태로는 거르지 않음, 배치 없으면 409 no-placement, 처리는 같은 회차면 받음, 커서 모양 그대로),
// §11 O-T53, openapi listScannerEventFlags(409). 이상 표시는 저장소의 업로드 판정으로 만들고(동문·서문 '중복 입장', 동문 예외 통과),
// 목록은 실제 HTTP 경로(platform ScannerGuard → ticket-svc)로 받는다. 같은 시험의 실제 PostgreSQL 쪽은 test-int/scanner-flags-zone.int.test.ts다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { athOf, createService, fakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type ScannerSessionAnswer, type ScannerSessionCheck } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import type { GateFlagPage, ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';

const NOW = Date.parse('2026-11-23T11:30:00.000Z');
const IAT = Math.floor(NOW / 1000);
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000f0631';
const ADMIN = '0190f3a1-7c2e-7a00-8000-0000000f0632';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000f0633';
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f0634';
const EAST_LEAD = '0190f3a1-7c2e-7a00-8000-0000000f0635';
const WEST_LEAD = '0190f3a1-7c2e-7a00-8000-0000000f0636';
const NO_PLACEMENT = '0190f3a1-7c2e-7a00-8000-0000000f0637';
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f0638';
const T_EAST_1 = '0190f3a1-7c2e-7a00-8000-0000000f0641';
const T_EAST_2 = '0190f3a1-7c2e-7a00-8000-0000000f0642';
const T_EAST_OVERRIDE = '0190f3a1-7c2e-7a00-8000-0000000f0643';
const T_WEST = '0190f3a1-7c2e-7a00-8000-0000000f0644';
/** 처리 시험이 따로 쓰는 서문 티켓(다른 시험의 표시를 바꾸지 않는다, 시험 리뷰 RV-10) */
const T_WEST_RESOLVE = '0190f3a1-7c2e-7a00-8000-0000000f0645';
/** 배치 없는 책임자 기기가 배치된 다른 회차(어느 회차든 배치가 있으면 통과하는 틀린 구현을 잡는다) */
const OTHER_EVENT = '0190f3a1-7c2e-7a00-8000-0000000f0646';
const TOKEN = 'f056-lead-token';
const ATH = athOf(TOKEN);
const HOST = 'scanner-api.peaket.example';
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

class Sessions implements ScannerSessionCheck {
  async check(q: { scannerSessionId: string; deviceId: string }): Promise<ScannerSessionAnswer> {
    return q.scannerSessionId === SESSION ? { valid: true, role: 'gate_lead', eventId: EVENT } : { valid: false };
  }
}
const operator: AdminAuthzPort = { getAdminAuthz: async () => ({ valid: true, role: 'operator' }) };

type Key = { privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']; jwk: Record<string, unknown>; jkt: string };
async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

let svc: Awaited<ReturnType<typeof createService>>;
let gate: MemoryScannerGateStore;
const keys = new Map<string, Key>();
/** 표시 ID → (티켓, 종류) */
const flagIds: Record<'east1' | 'east2' | 'override' | 'west', string> = { east1: '', east2: '', override: '', west: '' };

let deviceSeq = 0;
const scanOf = (ticketId: string, gateZone: string, atMs: number, over: Partial<ScanEventInput> = {}): ScanEventInput => ({
  id: randomUUID(),
  eventId: EVENT,
  ticketId,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone,
  scannedAtDevice: new Date(atMs).toISOString(),
  knownSeq: 0,
  deviceSeq: ++deviceSeq,
  ...over,
});

/** 저장소 업로드 판정으로 이상 표시를 만들고 그 ID를 돌려준다 */
async function flagOf(ticketId: string, gateZone: string, kind: 'DUPLICATE' | 'OVERRIDE_REVIEW'): Promise<string> {
  const scans = kind === 'DUPLICATE' ? [scanOf(ticketId, gateZone, NOW - 120_000), scanOf(ticketId, gateZone, NOW - 60_000)] : [scanOf(ticketId, gateZone, NOW - 90_000, { method: 'OVERRIDE', overrideNote: '액정 파손' })];
  const res = await gate.acceptScans({ eventId: EVENT, deviceId: EAST_LEAD, sessionId: SESSION, staffAccountId: ACCOUNT, scans, nowMs: NOW - 30_000 });
  const mine = res.flags.filter((f) => f.kind === kind);
  expect(mine, `${ticketId} ${kind}`).toHaveLength(1);
  return mine[0]!.flagId;
}

beforeAll(async () => {
  const clock = fakeClock({ now: NOW });
  const devices = new MemoryScannerDeviceStore();
  gate = new MemoryScannerGateStore();
  gate.seedTicket({ ticketId: T_EAST_1, eventId: EVENT, seatId: 'E-1', gateZone: '동문', status: 'ACTIVE' });
  gate.seedTicket({ ticketId: T_EAST_2, eventId: EVENT, seatId: 'E-2', gateZone: '동문', status: 'ACTIVE' });
  gate.seedTicket({ ticketId: T_EAST_OVERRIDE, eventId: EVENT, seatId: 'E-3', gateZone: '동문', status: 'ACTIVE' });
  gate.seedTicket({ ticketId: T_WEST, eventId: EVENT, seatId: 'W-1', gateZone: '서문', status: 'ACTIVE' });
  gate.seedTicket({ ticketId: T_WEST_RESOLVE, eventId: EVENT, seatId: 'W-2', gateZone: '서문', status: 'ACTIVE' });
  const shift = new MemoryScannerShiftStore(gate);
  for (const [deviceId, name] of [[EAST_LEAD, '동문-책임'], [WEST_LEAD, '서문-책임'], [NO_PLACEMENT, '미배치-책임']] as const) {
    const k = await keyOf();
    keys.set(deviceId, k);
    await devices.register({ deviceId, name, promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
    await devices.bindCredential({ deviceId, jkt: k.jkt, atMs: NOW });
  }
  await shift.putPlacement({ eventId: EVENT, deviceId: EAST_LEAD, gateZone: '동문', mode: 'IN', setBy: ADMIN, atMs: NOW - 3_600_000, expectedVersion: 0 });
  await shift.putPlacement({ eventId: EVENT, deviceId: WEST_LEAD, gateZone: '서문', mode: 'IN', setBy: ADMIN, atMs: NOW - 3_600_000, expectedVersion: 0 });
  await shift.putPlacement({ eventId: OTHER_EVENT, deviceId: NO_PLACEMENT, gateZone: '동문', mode: 'IN', setBy: ADMIN, atMs: NOW - 3_600_000, expectedVersion: 0 });
  flagIds.east1 = await flagOf(T_EAST_1, '동문', 'DUPLICATE');
  flagIds.east2 = await flagOf(T_EAST_2, '동문', 'DUPLICATE');
  flagIds.override = await flagOf(T_EAST_OVERRIDE, '동문', 'OVERRIDE_REVIEW');
  flagIds.west = await flagOf(T_WEST, '서문', 'DUPLICATE');
  // 처리한(정상 확인) 동문 표시도 목록에 상태와 함께 남는다
  await gate.resolveFlag({ eventId: EVENT, flagId: flagIds.east1, status: 'OK', note: '정상 확인', resolvedBy: ACCOUNT, nowMs: NOW - 10_000 });
  svc = await createService({
    name: 'ticket-svc-flags-zone',
    module: AppModule.register({ scanner: { store: devices, codes: new MemoryEnrollmentCodeStore(clock), replay: new MemoryDpopReplayStore(clock), gate, shift } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: operator,
    scanner: { devices, sessions: new Sessions(), replay: new MemoryDpopReplayStore(clock) },
  });
});

afterAll(async () => {
  await svc?.close().catch(() => {});
});

async function call(deviceId: string, method: 'GET' | 'POST', url: string, body?: unknown) {
  const k = keys.get(deviceId)!;
  const htu = `https://${HOST}${url.split('?')[0]}`;
  const dpop = await new SignJWT({ jti: randomUUID(), htm: method, htu, iat: IAT, ath: ATH }).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: k.jwk as never }).sign(k.privateKey);
  return svc.http.inject({
    method,
    url,
    headers: {
      authorization: `DPoP ${TOKEN}`,
      dpop,
      'x-user-id': ACCOUNT,
      'x-session-id': SESSION,
      'x-user-aud': 'scanner',
      'x-user-jkt': k.jkt,
      'x-user-ath': ATH,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': HOST,
      ...(body !== undefined ? { origin: 'https://scanner.peaket.example', 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

/** 커서를 따라 모든 쪽을 받는다. 다음 커서가 있는 쪽은 limit개를 꽉 채워야 한다(거르기를 쪽 나눈 뒤에 하는 결함을 잡는다) */
async function allPages(deviceId: string, limit: number): Promise<GateFlagPage['items']> {
  const items: GateFlagPage['items'] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await call(deviceId, 'GET', `/v1/scanner/events/${EVENT}/flags?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(r.statusCode, `쪽 ${page}`).toBe(200);
    const body = JSON.parse(r.payload) as GateFlagPage;
    if (body.nextCursor !== undefined) expect(body.items, `쪽 ${page}는 꽉 찼다`).toHaveLength(limit);
    items.push(...body.items);
    if (body.nextCursor === undefined) return items;
    cursor = body.nextCursor;
  }
  throw new Error('쪽이 10개를 넘었다');
}

const summary = (items: GateFlagPage['items']) => items.map((f) => ({ flagId: f.flagId, ticketId: f.ticketId, gateZone: f.gateZone, kind: f.kind, status: f.status })).sort((a, b) => a.flagId.localeCompare(b.flagId));

describe('책임자 이상 표시 목록 거르기(O-T53, offline-gate §7.2)', () => {
  test('O-T53 ① 동문 책임자 기기는 동문 티켓의 중복 입장 표시만 받고(처리한 표시는 상태 OK로 남음) 서문 표시는 없다. 쪽을 나눠도 같다', async () => {
    const want = summary([
      { flagId: flagIds.east1, ticketId: T_EAST_1, gateZone: '동문', kind: 'DUPLICATE', status: 'OK', seatLabel: '', awareness: 'CONCURRENT', createdAt: '' },
      { flagId: flagIds.east2, ticketId: T_EAST_2, gateZone: '동문', kind: 'DUPLICATE', status: 'OPEN', seatLabel: '', awareness: 'CONCURRENT', createdAt: '' },
    ]);
    expect(summary(await allPages(EAST_LEAD, 50))).toEqual(want);
    expect(summary(await allPages(EAST_LEAD, 1))).toEqual(want);
  });

  test('O-T53 ① 서문 책임자 기기는 서문 표시 하나만 받는다', async () => {
    expect(summary((await allPages(WEST_LEAD, 50)).filter((f) => f.ticketId !== T_WEST_RESOLVE))).toEqual([{ flagId: flagIds.west, ticketId: T_WEST, gateZone: '서문', kind: 'DUPLICATE', status: 'OPEN' }]);
  });

  test('O-T53 ② 같은 구역의 예외 통과 사후 검토 표시(OVERRIDE_REVIEW)는 목록에 없다', async () => {
    const items = await allPages(EAST_LEAD, 50);
    expect(items.map((f) => f.kind)).not.toContain('OVERRIDE_REVIEW');
    expect(items.map((f) => f.flagId)).not.toContain(flagIds.override);
  });

  test('O-T53 ③ 그 회차 배치가 없는 책임자 기기는 다른 회차에 배치가 있어도 409 no-placement다', async () => {
    const r = await call(NO_PLACEMENT, 'GET', `/v1/scanner/events/${EVENT}/flags`);
    expect(r.statusCode).toBe(409);
    expect((JSON.parse(r.payload) as { type?: string }).type).toBe('https://peaket.example/problems/no-placement');
  });

  test('O-T53 ③ 동문 책임자가 서문 표시를 ID로 처리하면 받는다(200, 상태가 바뀐다)', async () => {
    const own = await flagOf(T_WEST_RESOLVE, '서문', 'DUPLICATE');
    const r = await call(EAST_LEAD, 'POST', `/v1/scanner/flags/${own}/resolution`, { status: 'SUSPECT', note: '옆 구역 대신 확인' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ flagId: own, ticketId: T_WEST_RESOLVE, status: 'SUSPECT' });
    expect(summary((await allPages(WEST_LEAD, 50)).filter((f) => f.ticketId === T_WEST_RESOLVE))).toEqual([{ flagId: own, ticketId: T_WEST_RESOLVE, gateZone: '서문', kind: 'DUPLICATE', status: 'SUSPECT' }]);
  });
});
