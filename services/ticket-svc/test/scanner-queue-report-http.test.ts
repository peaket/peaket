// F-05-6 큐 비움 보고 경로 HTTP 시험(BUILD_ORDER GAT-180, O-T29 ⑤).
// 정본: docs/features/offline-gate.md §7.3 'GAT-180 마감 규칙'의 '큐 비움 보고'(기기 인증만으로도, 스캔 올리기와 같은 출처·JSON 확인,
// 토큰 회차 다르면 403 scanner-event-mismatch, 배치 없으면 409 no-placement·저장 안 함, 마지막 보고 하나 덮어쓰기·204),
// openapi putScannerEventQueueReport(403·409·415, 본문 additionalProperties false·pendingUploads 정수 0 이상),
// docs/security/asvs/offline-gate.md 3.5.1·3.5.2, 계획 docs/review/plans/F-05-6.md §4(ScannerWiring에 저장소를 꽂는 자리).
// 허용 출처는 정본 기본값 https://scanner.peaket.example이다. 저장되었는지는 바깥 포트로 본다: 같은 저장소의 마감 판단(close)이
// 역할 유효 끝 뒤 그 회차를 ALL_REPORTED로 마감하면 보고가 저장된 것이고, closed false면 저장되지 않은 것이다(회차마다 새로 만든다).
// 새 모듈(메모리 저장소)은 아직 없으므로 서비스는 시험 안에서 처음 쓸 때 만든다(불러오기 실패가 그 시험의 실패가 된다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { athOf, createService, fakeClock, MemoryDpopReplayStore, type AdminAuthzPort, type ScannerSessionAnswer, type ScannerSessionCheck } from '@peaket/platform';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEnrollmentAttemptLimiter } from '../src/modules/scanner/adapters/memory-enrollment-attempt-limiter.js';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import type { EntryCloseStore } from '../src/modules/scanner/domain/ports.js';

const NOW = Date.parse('2026-11-23T14:22:13.517Z');
const IAT = Math.floor(NOW / 1000);
/** 정본 '역할 유효 끝은 ends_at + 2시간'. 역할 유효 끝이 지금보다 5초 이르게 ends_at을 고른다(보고가 '비웠다'로 셀 수 있게) */
const ENDS = NOW - 7_200_000 - 5_000;
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000f0611';
const ADMIN = '0190f3a1-7c2e-7a00-8000-0000000f0612';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000f0613';
const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f0614';
const UNPLACED = '0190f3a1-7c2e-7a00-8000-0000000f0615';
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f0616';
const OTHER_SESSION = '0190f3a1-7c2e-7a00-8000-0000000f0617';
const TOKEN = 'f056-staff-token';
const ATH = athOf(TOKEN);
const HOST = 'scanner-api.peaket.example';
const PWA = 'https://scanner.peaket.example';
/** 목록 밖 출처마다 거부를 본다(자주 놓친 결함). undefined는 Origin 없음 */
const WRONG_ORIGINS: (string | undefined)[] = [
  'https://evil.example',
  undefined,
  'https://scanner.peaket.example:443',
  'https://scanner.peaket.example/',
  'https://SCANNER.peaket.example',
  'http://scanner.peaket.example',
  'null',
];

const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });
const operator: AdminAuthzPort = { getAdminAuthz: async () => ({ valid: true, role: 'operator' }) };

class Sessions implements ScannerSessionCheck {
  readonly answers = new Map<string, ScannerSessionAnswer>();
  async check(q: { scannerSessionId: string; deviceId: string }): Promise<ScannerSessionAnswer> {
    return this.answers.get(q.scannerSessionId) ?? { valid: false };
  }
}

type Key = { privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']; jwk: Record<string, unknown>; jkt: string };
async function keyOf(): Promise<Key> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(pair.publicKey)) as Record<string, unknown>;
  return { privateKey: pair.privateKey, jwk, jkt: await calculateJwkThumbprint(jwk as never, 'sha256') };
}

interface Rig {
  svc: Awaited<ReturnType<typeof createService>>;
  store: EntryCloseStore;
  shift: MemoryScannerShiftStore;
  sessions: Sessions;
  key: Key;
  unplacedKey: Key;
}

let rigP: Promise<Rig> | undefined;
/** 서비스는 처음 쓰는 시험에서 한 번 만든다(새 모듈이 없으면 그 시험이 실패한다) */
function rig(): Promise<Rig> {
  rigP ??= (async () => {
    const { MemoryEntryCloseStore } = await import('../src/modules/scanner/adapters/memory-entry-close-store.js');
    const clock = fakeClock({ now: NOW });
    const devices = new MemoryScannerDeviceStore();
    const gate = new MemoryScannerGateStore();
    const shift = new MemoryScannerShiftStore(gate);
    const store = new MemoryEntryCloseStore({ shifts: shift });
    const key = await keyOf();
    const unplacedKey = await keyOf();
    for (const [deviceId, k, name] of [[DEVICE, key, '동문-01'], [UNPLACED, unplacedKey, '동문-02']] as const) {
      await devices.register({ deviceId, name, promoterId: PROMOTER, enrolledBy: ADMIN, atMs: NOW });
      await devices.bindCredential({ deviceId, jkt: k.jkt, atMs: NOW });
    }
    const sessions = new Sessions();
    const svc = await createService({
      name: 'ticket-svc-queue-report',
      module: AppModule.register({
        scanner: {
          store: devices,
          codes: new MemoryEnrollmentCodeStore(clock),
          replay: new MemoryDpopReplayStore(clock),
          gate,
          shift,
          entryClose: store,
          limiter: new MemoryEnrollmentAttemptLimiter(() => clock.now()),
        },
      }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet(),
      adminAuthz: operator,
      scanner: { devices, sessions, replay: new MemoryDpopReplayStore(clock) },
    });
    return { svc, store, shift, sessions, key, unplacedKey };
  })();
  return rigP;
}

afterAll(async () => {
  if (rigP) await (await rigP.catch(() => undefined))?.svc.close();
});

/**
 * 새 회차 하나: DEVICE는 배치·근무 준비(로그인했던 기기). withUnplaced면 UNPLACED도 근무 준비를 했다(배치는 없음).
 * 로그인했던 기기가 DEVICE뿐이면 closedNow는 DEVICE의 비움 보고가 저장되었는지만 본다
 */
async function freshEvent(r: Rig, o: { withUnplaced?: boolean } = {}): Promise<string> {
  const eventId = randomUUID();
  await r.shift.putPlacement({ eventId, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ADMIN, atMs: NOW - 86_400_000, expectedVersion: 0 });
  for (const deviceId of o.withUnplaced ? [DEVICE, UNPLACED] : [DEVICE]) {
    await r.shift.reportReadiness({ eventId, deviceId, packageSeq: 1, clockOffsetMs: 0, pendingUploads: 0, reportedBy: ACCOUNT, atMs: NOW - 86_000_000 });
  }
  r.sessions.answers.set(SESSION, { valid: true, role: 'gate_staff', eventId });
  return eventId;
}

const path = (eventId: string) => `/v1/scanner/queue-reports/${eventId}`;

async function report(r: Rig, eventId: string, o: { origin?: string; contentType?: string; body?: unknown; raw?: string; key?: Key; token?: { session: string } } = {}) {
  const key = o.key ?? r.key;
  const p = path(eventId);
  const proof = await new SignJWT({ jti: randomUUID(), htm: 'PUT', htu: `https://${HOST}${p}`, iat: IAT, ...(o.token ? { ath: ATH } : {}) })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk as never })
    .sign(key.privateKey);
  return r.svc.http.inject({
    method: 'PUT',
    url: p,
    headers: {
      dpop: proof,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': HOST,
      'content-type': o.contentType ?? 'application/json',
      ...(o.token
        ? { authorization: `DPoP ${TOKEN}`, 'x-user-id': ACCOUNT, 'x-session-id': o.token.session, 'x-user-aud': 'scanner', 'x-user-jkt': key.jkt, 'x-user-ath': ATH }
        : {}),
      ...(o.origin !== undefined ? { origin: o.origin } : {}),
    },
    payload: o.raw ?? JSON.stringify(o.body ?? { pendingUploads: 0 }),
  });
}

const problemType = (payload: string): unknown => (JSON.parse(payload) as { type?: unknown }).type;
/** 이 회차를 역할 유효 끝 뒤 지금 판단하면 마감되는가(= DEVICE의 비움 보고가 저장되었는가). 회차마다 한 번만 부른다 */
const closedNow = async (r: Rig, eventId: string): Promise<boolean> => (await r.store.close({ eventId, nowMs: NOW, endsAtMs: ENDS, clockNow: () => NOW })).closed;

describe('큐 비움 보고의 출처·JSON 확인(O-T29 ⑤, offline-gate §7.3)', () => {
  test('O-T29 ⑤ 다른 사이트·Origin 없음·:443 붙음 등 PWA 출처와 다른 값마다 403 scanner-origin-forbidden이고 저장하지 않는다 [ASVS v5.0.0-3.5.1]', async () => {
    const r = await rig();
    const eventId = await freshEvent(r);
    for (const origin of WRONG_ORIGINS) {
      const res = await report(r, eventId, origin === undefined ? {} : { origin });
      expect(res.statusCode, String(origin)).toBe(403);
      expect(problemType(res.payload), String(origin)).toBe('https://peaket.example/problems/scanner-origin-forbidden');
    }
    // 스태프 토큰을 붙여도 같다
    const withToken = await report(r, eventId, { origin: 'https://evil.example', token: { session: SESSION } });
    expect(withToken.statusCode).toBe(403);
    expect(await closedNow(r, eventId)).toBe(false);
  });

  test('O-T29 ⑤ 양식·text/plain 본문은 PWA 출처여도 415이고 저장하지 않는다 [ASVS v5.0.0-3.5.2]', async () => {
    const r = await rig();
    const eventId = await freshEvent(r);
    const form = await report(r, eventId, { origin: PWA, contentType: 'application/x-www-form-urlencoded', raw: 'pendingUploads=0' });
    expect(form.statusCode).toBe(415);
    const text = await report(r, eventId, { origin: PWA, contentType: 'text/plain', raw: '{"pendingUploads":0}' });
    expect(text.statusCode).toBe(415);
    expect(await closedNow(r, eventId)).toBe(false);
  });
});

describe('큐 비움 보고의 배치·회차·본문(O-T29 ⑤)', () => {
  test('O-T29 ⑤ 그 회차에 배치가 없는 기기는 409 no-placement이고 저장하지 않는다', async () => {
    const r = await rig();
    const eventId = await freshEvent(r, { withUnplaced: true });
    // DEVICE는 비웠다고 보고해 두고, 배치 없는 UNPLACED의 보고만 거절되는지 본다(UNPLACED가 저장되지 않아 마감되지 않는다)
    expect((await report(r, eventId, { origin: PWA })).statusCode).toBe(204);
    const res = await report(r, eventId, { origin: PWA, key: r.unplacedKey });
    expect(res.statusCode).toBe(409);
    expect(problemType(res.payload)).toBe('https://peaket.example/problems/no-placement');
    expect(await closedNow(r, eventId)).toBe(false);
  });

  test('O-T29 ⑤ 스태프 토큰의 회차와 경로 회차가 다르면 403 scanner-event-mismatch이고 저장하지 않는다', async () => {
    const r = await rig();
    const eventId = await freshEvent(r);
    r.sessions.answers.set(OTHER_SESSION, { valid: true, role: 'gate_staff', eventId: randomUUID() });
    const res = await report(r, eventId, { origin: PWA, token: { session: OTHER_SESSION } });
    expect(res.statusCode).toBe(403);
    expect(problemType(res.payload)).toBe('https://peaket.example/problems/scanner-event-mismatch');
    expect(await closedNow(r, eventId)).toBe(false);
  });

  test('O-T29 ⑤ 음수·실수·글자·빠짐·남는 칸 본문은 400이고 저장하지 않는다', async () => {
    const r = await rig();
    const eventId = await freshEvent(r);
    for (const body of [{ pendingUploads: -1 }, { pendingUploads: 0.5 }, { pendingUploads: '0' }, {}, { pendingUploads: 0, deviceId: DEVICE }]) {
      const res = await report(r, eventId, { origin: PWA, body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await closedNow(r, eventId)).toBe(false);
  });

  test('O-T29 ⑤ 기기 인증만의 정상 보고는 204이고 다시 보내도 204·결과가 같다(그 뒤 판단에서 ALL_REPORTED)', async () => {
    const r = await rig();
    const eventId = await freshEvent(r);
    const first = await report(r, eventId, { origin: PWA });
    expect(first.statusCode).toBe(204);
    expect(first.payload).toBe('');
    expect((await report(r, eventId, { origin: PWA })).statusCode).toBe(204);
    expect(await r.store.close({ eventId, nowMs: NOW, endsAtMs: ENDS, clockNow: () => NOW })).toEqual({ closed: true, reason: 'ALL_REPORTED', closedAtMs: NOW, unreported: 0 });
  });

  test('O-T29 ⑤ 같은 회차 스태프 토큰을 붙인 보고도 204로 저장되고, 남은 기록 1의 보고는 비운 것으로 세지 않다가 0으로 덮어쓰면 센다', async () => {
    const r = await rig();
    const eventId = await freshEvent(r, { withUnplaced: true });
    await r.shift.putPlacement({ eventId, deviceId: UNPLACED, gateZone: '동문', mode: 'IN', setBy: ADMIN, atMs: NOW - 1, expectedVersion: 0 });
    expect((await report(r, eventId, { origin: PWA, token: { session: SESSION } })).statusCode).toBe(204);
    expect((await report(r, eventId, { origin: PWA, key: r.unplacedKey, body: { pendingUploads: 1 } })).statusCode).toBe(204);
    expect(await closedNow(r, eventId)).toBe(false);
    expect((await report(r, eventId, { origin: PWA, key: r.unplacedKey, body: { pendingUploads: 0 } })).statusCode).toBe(204);
    // 마감되면 토큰을 붙인 DEVICE의 보고도 저장되어 있었다
    expect(await closedNow(r, eventId)).toBe(true);
  });
});
