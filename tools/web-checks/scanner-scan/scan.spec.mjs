// F-05-4 스캐너 실제 연결 화면 시험(계획 docs/review/plans/F-05-4.md §8): ?live=1 근무 준비 → 판정 → 큐·기기 저장소, 새로고침·오프라인 판정,
// 업로드 401 invalid_token, [로그아웃], 저장소 셋의 개인정보 칸, BarcodeDetector 없음, 오차를 잰 적 없는 기기, 판정 화면 유지.
// 정본: docs/features/offline-gate.md §6.4 '스캐너 앱 판정 첫 구현'·§6.5 '업로드 첫 구현', docs/frontend.md §3.8 '회차 목록 저장', docs/design/d5-screen-blueprint.md §8.2~§8.4.
// 스캐너 API는 page.route로 openapi 모양 응답을 준다(덧붙임 시험). 서버 쪽 판정은 services/ticket-svc/test-int/scanner-f054.int.test.ts가 본다.
// QR v1은 시험이 Node WebCrypto 키로 offline-gate §3 형식대로 직접 서명한다(월렛 코드를 읽지 않는다).
import { expect, test } from '@playwright/test';

const API = 'https://scanner-api.peaket.example';
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f5481';
const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f5482';
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f5483';
const TICKET = '0190f3a1-7c2e-7a00-8b2a-6c1d5e7f5401';
const SEAT = 'R구역 12열 8번';
/** 판정 결과(ds ScanResult, role=alert) 가운데 그 글이 든 것 */
const verdict = (page, text) => page.getByRole('alert').filter({ hasText: text });
/** 관람객 개인정보로 읽히는 칸 이름(ASVS 14.3.3) */
const PERSONAL_FIELD = /name|phone|mobile|tel$|email|mail|contact|holder|buyer|이름|연락처|전화/i;

// ---- QR v1(offline-gate §3) ----
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function base45(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const n = bytes[i] * 256 + bytes[i + 1];
    out += B45[n % 45] + B45[Math.floor(n / 45) % 45] + B45[Math.floor(n / 2025)];
  }
  if (bytes.length % 2 === 1) {
    const n = bytes[bytes.length - 1];
    out += B45[n % 45] + B45[Math.floor(n / 45)];
  }
  return out;
}
async function walletKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const compressed = new Uint8Array(33);
  compressed[0] = (raw[64] & 1) === 1 ? 0x03 : 0x02;
  compressed.set(raw.slice(1, 33), 1);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const keyIdBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', spki)).slice(0, 8);
  return { privateKey: pair.privateKey, keyIdBytes, keyId: Buffer.from(keyIdBytes).toString('base64url'), publicKey: Buffer.from(compressed).toString('base64url') };
}
async function qrOf(k, ticketId, atMs) {
  const id = Buffer.from(ticketId.replace(/-/g, ''), 'hex');
  const ts = Buffer.alloc(4);
  ts.writeUInt32BE(Math.floor(atMs / 1000));
  const message = Buffer.concat([Buffer.from('PEAKET-QR-v1'), id, Buffer.from(k.keyIdBytes), ts]);
  const sig = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, message));
  return base45(new Uint8Array(Buffer.concat([Buffer.from([1]), id, Buffer.from(k.keyIdBytes), ts, sig])));
}

/** 스태프 토큰 꼴(내용에 sid). 서명은 서버가 보므로 화면 시험에서는 아무 값이다 */
const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const STAFF_TOKEN = `${part({ alg: 'ES256', typ: 'JWT' })}.${part({ sub: 'acc-1', sid: SESSION, aud: 'scanner', exp: Math.floor(Date.now() / 1000) + 7200 })}.c2lnbmF0dXJl`;

const vector = (seq) => ({ eventId: EVENT, seq, ticketSeq: 0, keySeq: seq, policySeq: 0, placementSeq: 1, flagSeq: 0, issuedAt: new Date().toISOString(), maxOfflineMs: 86_400_000 });

/**
 * 스캐너 API 대역. scans는 업로드마다 { authorization, body }를 적고 scanReply(n)이 답을 정한다(없으면 모두 받는다).
 * offline이 참이면 모든 API 요청을 끊는다(연결 끊김).
 */
async function scannerApi(page, wallet, o = {}) {
  const log = { scans: [], changes: 0, offline: false };
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const cors = {
      'access-control-allow-origin': req.headers().origin ?? '*',
      'access-control-allow-headers': 'content-type, dpop, authorization, accept',
      'access-control-allow-methods': 'GET, POST, PUT',
      'access-control-expose-headers': 'date, www-authenticate, retry-after',
    };
    if (log.offline) return route.abort('internetdisconnected');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const path = new URL(req.url()).pathname;
    const json = (status, body, extra = {}) => route.fulfill({ status, headers: { ...cors, 'content-type': status < 300 ? 'application/json' : 'application/problem+json', ...extra }, body: JSON.stringify(body) });
    if (path === '/v1/scanner/shift') {
      return json(200, {
        serverTime: new Date().toISOString(),
        eventId: EVENT,
        reentryAllowed: false,
        placement: { gateZone: '동문', mode: 'IN' },
        packageSeq: 10,
        role: 'gate_staff',
        proxy: false,
        device: { deviceId: DEVICE, name: '동문-01', status: 'ACTIVE', credentialType: 'DEVICE_KEY', enrolled: true, mtls: false },
        assignment: { assignmentId: 'as-1', role: 'gate_staff', validFrom: new Date(Date.now() - 3_600_000).toISOString(), validUntil: new Date(Date.now() + 3_600_000).toISOString(), proxy: false },
        package: { seq: 10, issuedAt: new Date().toISOString(), maxOfflineMs: 86_400_000, stale: false },
        versionVector: vector(10),
        auth: { deviceProof: 'DPOP', staffSession: true, confirmation: 'jkt' },
      });
    }
    if (path === '/v1/scanner/shift/readiness') return route.fulfill({ status: 204, headers: cors });
    if (path === `/v1/scanner/events/${EVENT}/package`) {
      return json(200, {
        eventId: EVENT,
        reentryAllowed: false,
        gateZones: ['동문', '서문'],
        serverTime: new Date().toISOString(),
        tickets: [{ ticketId: TICKET, gateZone: '동문', seatLabel: SEAT, status: 'ACTIVE', keys: [{ keyId: wallet.keyId, publicKey: wallet.publicKey }] }],
        revokedKeyIds: [],
        lastSeq: 10,
        versionVector: vector(10),
      });
    }
    if (path === `/v1/scanner/events/${EVENT}/changes`) {
      log.changes++;
      return json(200, { changes: [], lastSeq: 10, hasMore: false, versionVector: vector(10) });
    }
    if (path === `/v1/scanner/events/${EVENT}/flags`) return json(200, { items: [] });
    if (path === '/v1/scanner/scans' && req.method() === 'POST') {
      const body = req.postDataJSON();
      log.scans.push({ authorization: req.headers().authorization ?? null, body });
      const reply = o.scanReply?.(log.scans.length) ?? { status: 200 };
      if (reply.status === 200) return json(200, { acceptedIds: body.map((b) => b.id), resyncRequired: false, staleIds: [], flags: [] });
      return json(reply.status, { type: `https://peaket.example/problems/${reply.type ?? 'unauthorized'}`, title: '대역', status: reply.status }, reply.headers ?? {});
    }
    return json(404, { type: 'about:blank', title: '대역에 없는 경로', status: 404 });
  });
  return log;
}

/** 가짜 BarcodeDetector: window.__peaketQr에 넣은 글자를 한 번 돌려준다(카메라 화면 내용과 상관없이) */
async function fakeDetector(page, { present = true } = {}) {
  await page.addInitScript((present) => {
    if (!present) {
      delete window.BarcodeDetector;
      return;
    }
    class FakeBarcodeDetector {
      static async getSupportedFormats() {
        return ['qr_code'];
      }
      async detect() {
        const raw = window.__peaketQr;
        if (!raw) return [];
        window.__peaketQr = undefined;
        return [{ rawValue: raw, format: 'qr_code', boundingBox: { x: 0, y: 0, width: 10, height: 10 }, cornerPoints: [] }];
      }
    }
    window.BarcodeDetector = FakeBarcodeDetector;
  }, present);
}

/** 로그인을 마친 기기: peaket-scanner-auth에 기기 키(꺼낼 수 없는 CryptoKey)와 스태프 토큰을 둔다(key-store.ts와 같은 자리) */
async function signedIn(page) {
  await page.goto('/scan?state=통과');
  await page.evaluate(async (token) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('peaket-scanner-auth', 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('keys')) r.result.createObjectStore('keys');
        if (!r.result.objectStoreNames.contains('session')) r.result.createObjectStore('session');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const j = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const publicJwk = { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ crv: 'P-256', kty: 'EC', x: j.x, y: j.y }))));
    const jkt = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await new Promise((res, rej) => {
      const tx = db.transaction(['keys', 'session'], 'readwrite');
      tx.objectStore('keys').put({ privateKey: pair.privateKey, publicJwk, jkt }, 'device');
      tx.objectStore('session').put({ token, expiresAtMs: Date.now() + 3_600_000 }, 'staff-token');
      tx.oncomplete = () => res(undefined);
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, STAFF_TOKEN);
}

/** 브라우저 저장소 셋(IndexedDB 모든 DB·저장소, localStorage, sessionStorage)의 키와 값 */
async function dumpStorage(page) {
  return page.evaluate(async () => {
    const plain = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof ArrayBuffer || ArrayBuffer.isView(x) ? '[bytes]' : typeof CryptoKey !== 'undefined' && x instanceof CryptoKey ? '[key]' : x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x)) ?? null);
    const out = { indexedDB: {}, localStorage: {}, sessionStorage: {} };
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      out.indexedDB[name] = {};
      for (const store of [...db.objectStoreNames]) {
        const [keys, values] = await Promise.all(
          ['getAllKeys', 'getAll'].map(
            (m) =>
              new Promise((res, rej) => {
                const r = db.transaction(store, 'readonly').objectStore(store)[m]();
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
              }),
          ),
        );
        out.indexedDB[name][store] = keys.map((k, i) => ({ key: plain(k), value: plain(values[i]) }));
      }
      db.close();
    }
    for (const [name, s] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) for (let i = 0; i < s.length; i++) out[name][s.key(i)] = s.getItem(s.key(i));
    return out;
  });
}
function fieldNames(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) fieldNames(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      fieldNames(x, out);
    }
  } else if (typeof v === 'string' && v.startsWith('{')) {
    try {
      fieldNames(JSON.parse(v), out);
    } catch {
      // JSON이 아닌 글자
    }
  }
  return out;
}
const queueCount = async (page) => ((await dumpStorage(page)).indexedDB['peaket-scanner-queue']?.scanQueue ?? []).length;

/** 근무 준비(SCR-033)에서 [스캔 시작]을 눌러 판정 화면(SCR-034)으로 간다 */
async function startShift(page) {
  await page.goto('/setup?live=1');
  const start = page.getByRole('button', { name: '스캔 시작' });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();
  await expect(page).toHaveURL(/\/scan(\?|$)/);
}
async function scan(page, raw) {
  await page.evaluate((r) => {
    window.__peaketQr = r;
  }, raw);
}

test('GAT-140 ?live=1 근무 준비 → 판정 → 통과면 스캔 큐 1건·peaket-scanner에 목록·입장 상태·deviceSeq 1이 남고, 새로고침 뒤 연결이 끊겨도 같은 티켓은 이미 입장으로 거부된다', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  const api = await scannerApi(page, wallet, { scanReply: () => ({ status: 503, type: 'scanner-auth-unavailable', headers: { 'retry-after': '1' } }) });
  await signedIn(page);
  await startShift(page);
  await scan(page, await qrOf(wallet, TICKET, Date.now()));
  await expect(verdict(page, '통과')).toBeVisible();
  await expect(verdict(page, '통과')).toContainText(SEAT);
  await expect.poll(() => queueCount(page)).toBe(1);
  const db = (await dumpStorage(page)).indexedDB['peaket-scanner'];
  expect(Object.keys(db ?? {}).sort()).toEqual(expect.arrayContaining(['cursor', 'entryState', 'keys', 'meta', 'revoked', 'tickets']));
  expect(JSON.stringify(db.tickets)).toContain(TICKET);
  expect(JSON.stringify(db.keys)).toContain(wallet.publicKey);
  expect(db.entryState.some((r) => (r.key === TICKET || r.value?.ticketId === TICKET) && r.value?.lastDirection === 'IN')).toBe(true);
  expect(db.meta.some((r) => r.value?.deviceSeq === 1)).toBe(true);

  // 새로고침 뒤 연결 끊김: 기기 저장소의 목록·입장 상태로 판정한다
  api.offline = true;
  await page.reload();
  await expect(page).toHaveURL(/\/scan(\?|$)/);
  await scan(page, await qrOf(wallet, TICKET, Date.now()));
  await expect(verdict(page, '거부')).toContainText(/이미 입장한 티켓입니다\(\d{2}:\d{2}, 동문\)/);
  await expect.poll(() => queueCount(page)).toBe(2);
});

test('O-T21 ③ 업로드가 401 invalid_token이면 다음 요청은 Authorization 없이 같은 기록을 보내고, 큐가 비며 로그인 화면으로 간다', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  const api = await scannerApi(page, wallet, {
    scanReply: (n) => (n === 1 ? { status: 401, type: 'unauthorized', headers: { 'www-authenticate': 'DPoP error="invalid_token"' } } : { status: 200 }),
  });
  await signedIn(page);
  await startShift(page);
  await scan(page, await qrOf(wallet, TICKET, Date.now()));
  await expect(verdict(page, '통과')).toBeVisible();
  // 판정 뒤 5초 묶음으로 올라간다
  await expect.poll(() => api.scans.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  expect(api.scans[0].authorization).toBe(`DPoP ${STAFF_TOKEN}`);
  expect(api.scans[1].authorization).toBeNull();
  expect(api.scans[1].body.map((b) => b.id)).toEqual(api.scans[0].body.map((b) => b.id));
  expect(api.scans[0].body[0]).toMatchObject({ eventId: EVENT, ticketId: TICKET, scannerSessionId: SESSION, direction: 'IN', method: 'QR', result: 'PASS', gateZone: '동문', keyId: wallet.keyId, knownSeq: 10, deviceSeq: 1 });
  await expect.poll(() => queueCount(page)).toBe(0);
  await expect(page).toHaveURL(/\/login(\?|$)/);
  const auth = (await dumpStorage(page)).indexedDB['peaket-scanner-auth'];
  expect(auth.session).toEqual([]);
});

test('GAT-140 7.4.4 [로그아웃]이 SCR-033·034·035 상단에 보이고, 누르면 큐를 올린 뒤 스태프 토큰 저장소가 빈다 [ASVS v5.0.0-7.4.4]', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  let accept = false;
  const api = await scannerApi(page, wallet, { scanReply: () => (accept ? { status: 200 } : { status: 503, type: 'scanner-auth-unavailable' }) });
  await signedIn(page);
  await page.goto('/setup?live=1');
  await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible();
  await startShift(page);
  await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible();
  await scan(page, await qrOf(wallet, TICKET, Date.now()));
  await expect(verdict(page, '통과')).toBeVisible();
  await expect.poll(() => queueCount(page)).toBe(1);
  await page.goto('/sync?live=1');
  const logout = page.getByRole('button', { name: '로그아웃' });
  await expect(logout).toBeVisible();
  accept = true;
  const sent0 = api.scans.length;
  await logout.click();
  await expect.poll(() => queueCount(page)).toBe(0);
  expect(api.scans.length).toBeGreaterThan(sent0);
  await expect.poll(async () => (await dumpStorage(page)).indexedDB['peaket-scanner-auth']?.session ?? []).toEqual([]);
  expect((await dumpStorage(page)).sessionStorage['peaket.scanner.staff-token']).toBeUndefined();
});

test('GAT-140 판정 뒤 브라우저 저장소 셋에 관람객 이름·연락처 칸이 없고 스태프 토큰은 peaket-scanner·스캔 큐에 없다 [ASVS v5.0.0-14.3.3]', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  await scannerApi(page, wallet, { scanReply: () => ({ status: 503, type: 'scanner-auth-unavailable' }) });
  await signedIn(page);
  await startShift(page);
  await scan(page, await qrOf(wallet, TICKET, Date.now()));
  await expect(verdict(page, '통과')).toBeVisible();
  await expect.poll(() => queueCount(page)).toBe(1);
  const all = await dumpStorage(page);
  expect(Object.keys(all.indexedDB)).toEqual(expect.arrayContaining(['peaket-scanner', 'peaket-scanner-queue', 'peaket-scanner-auth']));
  const names = fieldNames(all);
  expect(names.has('seatLabel') || names.has('ticketId'), '칸을 실제로 모았다').toBe(true);
  expect([...names].filter((n) => PERSONAL_FIELD.test(n))).toEqual([]);
  for (const db of ['peaket-scanner', 'peaket-scanner-queue']) expect(JSON.stringify(all.indexedDB[db]).includes(STAFF_TOKEN), db).toBe(false);
});

test('GAT-140 BarcodeDetector가 없는 브라우저는 판정 화면이 카메라 고장(스태프) 안내로 닫힌다', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page, { present: false });
  await scannerApi(page, wallet);
  await signedIn(page);
  await startShift(page);
  await expect(page.getByText('예비 기기로 바꾸거나 현장 책임자를 부르세요')).toBeVisible();
});

test('O-T5 시계 오차를 잰 적 없는 기기(근무 준비 전)로 판정 화면을 열면 준비 안 됨이고 판정하지 않는다', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  await scannerApi(page, wallet);
  await signedIn(page);
  await page.goto('/scan?live=1');
  await expect(page.getByText('준비 안 됨')).toBeVisible();
  await scan(page, await qrOf(wallet, TICKET, Date.now()));
  await expect.poll(() => queueCount(page)).toBe(0);
  await expect(verdict(page, '통과')).toHaveCount(0);
});

test('GAT-140 판정 화면은 2초 안팎 유지된 뒤 판정 대기로 돌아간다(가짜 시계: 판정 뒤 1,200ms 넘게 남고 2,800ms 안에 사라짐, 정확한 경계는 단위 시험 scan-live.test.ts)', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  await scannerApi(page, wallet, { scanReply: () => ({ status: 503, type: 'scanner-auth-unavailable' }) });
  await page.clock.install();
  await signedIn(page);
  await startShift(page);
  const t0 = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(t0 + 1_000);
  await scan(page, await qrOf(wallet, TICKET, t0 + 1_000));
  // 디코딩 반복이 돌 만큼만 시계를 민다(이 안에서 판정이 나온다)
  await page.clock.runFor(400);
  const pass = verdict(page, '통과');
  await expect(pass).toBeVisible();
  await page.clock.runFor(1_200); // 판정 뒤 1,200~1,600ms
  await expect(pass).toBeVisible();
  await page.clock.runFor(1_200); // 판정 뒤 2,400~2,800ms
  await expect(verdict(page, '통과')).toHaveCount(0);
});
