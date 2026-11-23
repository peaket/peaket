// F-05-4 구현 리뷰 IR-03·04·06·07 재현 시험(새 파일, 화면 시험). 고치기 전에는 실패해야 한다.
// IR-03: 변경분 응답을 붙잡은 채 스캔을 끝내도 로컬 입장 상태가 남는가
// IR-04: 로그아웃 뒤 재로그인한 스태프의 스캔이 새 세션 ID로 올라가는가
// IR-06: online·visibilitychange가 업로드뿐 아니라 변경분도 받는가
// IR-07: 두 번째 shift의 serverTime으로 잰 오차를 쓰는가
import { expect, test } from '@playwright/test';

const API = 'https://scanner-api.peaket.example';
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f5491';
const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f5492';
const SESSION_A = '0190f3a1-7c2e-7a00-8000-0000000f5493';
const SESSION_B = '0190f3a1-7c2e-7a00-8000-0000000f5494';
const TICKET = '0190f3a1-7c2e-7a00-8b2a-6c1d5e7f5411';
const SEAT = 'R구역 12열 8번';
const verdict = (page, text) => page.getByRole('alert').filter({ hasText: text });

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
const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tokenFor = (session) => `${part({ alg: 'ES256', typ: 'JWT' })}.${part({ sub: 'acc-1', sid: session, aud: 'scanner', exp: Math.floor(Date.now() / 1000) + 7200 })}.c2lnbmF0dXJl`;
const vector = (seq) => ({ eventId: EVENT, seq, ticketSeq: 0, keySeq: seq, policySeq: 0, placementSeq: 1, flagSeq: 0, issuedAt: new Date().toISOString(), maxOfflineMs: 86_400_000 });

async function scannerApi(page, wallet, o = {}) {
  const log = { scans: [], order: [], offline: false, shifts: 0, packages: 0, changes: 0 };
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
      log.shifts++;
      log.order.push('shift');
      const serverTime = o.shiftServerTime?.(log.shifts) ?? new Date().toISOString();
      const placement = o.shiftPlacement?.(log.shifts) ?? { gateZone: '동문', mode: 'IN', version: 3 };
      return json(200, {
        serverTime,
        eventId: EVENT,
        reentryAllowed: o.reentryAllowed ?? false,
        placement,
        packageSeq: 10,
        role: 'gate_staff',
        proxy: false,
        device: { deviceId: DEVICE, name: '동문-01', status: 'ACTIVE', credentialType: 'DEVICE_KEY', enrolled: true, mtls: false },
        assignment: { assignmentId: 'as-1', role: 'gate_staff', validFrom: new Date(Date.now() - 3_600_000).toISOString(), validUntil: new Date(Date.now() + 3_600_000).toISOString(), proxy: false },
        package: { seq: 10, issuedAt: serverTime, maxOfflineMs: 86_400_000, stale: false },
        versionVector: vector(10),
        auth: { deviceProof: 'DPOP', staffSession: true, confirmation: 'jkt' },
      });
    }
    if (path === '/v1/scanner/shift/readiness') return route.fulfill({ status: 204, headers: cors });
    if (path === `/v1/scanner/events/${EVENT}/package`) {
      log.packages++;
      log.order.push('package');
      return json(200, {
        eventId: EVENT,
        reentryAllowed: o.reentryAllowed ?? false,
        gateZones: ['동문', '서문'],
        serverTime: o.packageServerTime?.() ?? new Date().toISOString(),
        tickets: [{ ticketId: TICKET, gateZone: '동문', seatLabel: SEAT, status: 'ACTIVE', keys: [{ keyId: wallet.keyId, publicKey: wallet.publicKey }] }],
        revokedKeyIds: [],
        lastSeq: 10,
        versionVector: vector(10),
      });
    }
    if (path === `/v1/scanner/events/${EVENT}/changes`) {
      log.changes++;
      log.order.push('changes');
      const pageBody = await (o.changesReply?.(log.changes) ?? { changes: [], lastSeq: 10 });
      return json(200, { changes: pageBody.changes, lastSeq: pageBody.lastSeq, hasMore: false, versionVector: vector(pageBody.lastSeq) });
    }
    if (path === '/v1/scanner/scans' && req.method() === 'POST') {
      const body = req.postDataJSON();
      log.order.push('scans');
      const reply = o.scanReply?.(log.scans.length + 1) ?? { status: 200 };
      log.scans.push({ authorization: req.headers().authorization ?? null, body, ok: reply.status === 200 });
      if (reply.status === 200) return json(200, { acceptedIds: body.map((b) => b.id), resyncRequired: reply.resyncRequired ?? false, staleIds: [], flags: [] });
      return json(reply.status, { type: `https://peaket.example/problems/${reply.type ?? 'unauthorized'}`, title: '대역', status: reply.status }, reply.headers ?? {});
    }
    return json(404, { type: 'about:blank', title: '대역에 없는 경로', status: 404 });
  });
  return log;
}

async function fakeDetector(page) {
  await page.addInitScript(() => {
    class FakeBarcodeDetector {
      static async getSupportedFormats() {
        return ['qr_code'];
      }
      async detect() {
        const raw = window.__peaketQr;
        if (!raw) return [];
        window.__peaketQr = undefined;
        return [{ rawValue: raw, format: 'qr_code' }];
      }
    }
    window.BarcodeDetector = FakeBarcodeDetector;
  });
}

async function signedIn(page, token) {
  await page.goto('/scan?state=통과');
  await page.evaluate(async (t) => {
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
      tx.objectStore('session').put({ token: t, expiresAtMs: Date.now() + 3_600_000 }, 'staff-token');
      tx.oncomplete = () => res(undefined);
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, token);
}

async function setStaffToken(page, token) {
  await page.evaluate(async (t) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('peaket-scanner-auth', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').put({ token: t, expiresAtMs: Date.now() + 3_600_000 }, 'staff-token');
      tx.oncomplete = () => res(undefined);
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, token);
}

const queueCount = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('peaket-scanner-queue', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains('scanQueue')) {
      db.close();
      return 0;
    }
    const n = await new Promise((res, rej) => {
      const r = db.transaction('scanQueue', 'readonly').objectStore('scanQueue').count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return n;
  });

/** peaket-scanner의 cursor 행 lastSeq(변경분이 실제로 저장됐는지) */
const cursorSeq = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('peaket-scanner', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!db.objectStoreNames.contains('cursor')) {
      db.close();
      return 0;
    }
    const rows = await new Promise((res, rej) => {
      const r = db.transaction('cursor', 'readonly').objectStore('cursor').getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return rows[0]?.lastSeq ?? 0;
  });

async function startShift(page) {
  await page.goto('/setup?live=1');
  const start = page.getByRole('button', { name: '스캔 시작' });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();
  await expect(page).toHaveURL(/\/scan(\?|$)/);
}
const scan = (page, raw) =>
  page.evaluate((r) => {
    window.__peaketQr = r;
  }, raw);
const goInApp = (page, href) =>
  page.evaluate((h) => {
    history.pushState(null, '', h);
    dispatchEvent(new PopStateEvent('popstate'));
  }, href);

test('IR-03 변경분 응답을 기다리는 동안 통과한 로컬 입장 상태가 저장 뒤에도 남는다', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  let release;
  const gate = new Promise((r) => (release = r));
  const api = await scannerApi(page, wallet, {
    changesReply: async () => {
      await gate;
      return { changes: [{ seq: 11, kind: 'SCAN_STATE', payload: { v: 1, ticketId: '0190f3a1-7c2e-7a00-8b2a-6c1d5e7f54ff', direction: 'IN', scannedAtDevice: new Date(Date.now() - 30_000).toISOString(), gateZone: '동문', deviceId: 'other' } }], lastSeq: 11 };
    },
    scanReply: () => ({ status: 200 }),
  });
  await signedIn(page, tokenFor(SESSION_A));
  await page.clock.install();
  await startShift(page);
  await page.clock.fastForward(60_000);
  await expect.poll(() => api.changes).toBe(1);
  await scan(page, await qrOf(wallet, TICKET, await page.evaluate(() => Date.now())));
  await expect(verdict(page, '통과')).toBeVisible();
  await expect.poll(() => queueCount(page)).toBe(1);
  release();
  await expect.poll(() => cursorSeq(page)).toBeGreaterThanOrEqual(11);
  await page.clock.fastForward(3_100);
  await scan(page, await qrOf(wallet, TICKET, await page.evaluate(() => Date.now())));
  await expect(verdict(page, '거부')).toContainText(/이미 입장한 티켓입니다/);
});

test('IR-04 로그아웃 뒤 재로그인한 스태프의 스캔은 새 세션 ID로 올라간다', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  const api = await scannerApi(page, wallet, { scanReply: () => ({ status: 200 }) });
  await signedIn(page, tokenFor(SESSION_A));
  await startShift(page);
  await scan(page, await qrOf(wallet, TICKET, Date.now()));
  await expect(verdict(page, '통과')).toBeVisible();
  await page.goto('/sync?live=1');
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await setStaffToken(page, tokenFor(SESSION_B));
  await goInApp(page, '/setup?live=1');
  await expect(page.getByRole('button', { name: '스캔 시작' })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole('button', { name: '스캔 시작' }).click();
  await expect(page).toHaveURL(/\/scan(\?|$)/);
  await scan(page, await qrOf(wallet, TICKET, Date.now()));
  await expect(page.getByRole('alert')).toBeVisible();
  await goInApp(page, '/sync?live=1');
  await page.getByRole('button', { name: '지금 동기화' }).click();
  await expect.poll(() => api.scans.at(-1)?.body?.[0]?.scannerSessionId).toBe(SESSION_B);
});

test('IR-04 업로드 401 invalid_token 뒤 새 토큰으로 로그인하면 새 세션 ID로 올리고 변경분 타이머도 새로 선다', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  const api = await scannerApi(page, wallet, {
    scanReply: (n) => (n === 1 ? { status: 401, type: 'unauthorized', headers: { 'www-authenticate': 'DPoP error="invalid_token"' } } : { status: 200 }),
  });
  await signedIn(page, tokenFor(SESSION_A));
  await page.clock.install();
  await startShift(page);
  await scan(page, await qrOf(wallet, TICKET, await page.evaluate(() => Date.now())));
  await expect(verdict(page, '통과')).toBeVisible();
  await goInApp(page, '/sync?live=1');
  await page.getByRole('button', { name: '지금 동기화' }).click();
  await expect(page).toHaveURL(/\/login(\?|$)/);
  // 401로 런타임이 멈췄으면 60초가 지나도 옛 세션의 변경분 요청이 없어야 한다
  const stoppedAt = api.changes;
  await page.clock.fastForward(60_000);
  expect(api.changes).toBe(stoppedAt);
  // 새 스태프로 로그인해 SPA로 근무 준비에 간다(새로고침 없이)
  await setStaffToken(page, tokenFor(SESSION_B));
  await goInApp(page, '/setup?live=1');
  const start = page.getByRole('button', { name: '스캔 시작' });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();
  await expect(page).toHaveURL(/\/scan(\?|$)/);
  await scan(page, await qrOf(wallet, TICKET, await page.evaluate(() => Date.now())));
  await expect(page.getByRole('alert')).toBeVisible();
  await goInApp(page, '/sync?live=1');
  await page.getByRole('button', { name: '지금 동기화' }).click();
  await expect.poll(() => api.scans.at(-1)?.body?.[0]?.scannerSessionId).toBe(SESSION_B);
  // 새 세션의 변경분 타이머가 다시 선다
  const restartedAt = api.changes;
  await page.clock.fastForward(60_000);
  await expect.poll(() => api.changes).toBeGreaterThan(restartedAt);
});

test('IR-06 online·visibilitychange는 업로드뿐 아니라 변경분도 바로 받는다', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  const api = await scannerApi(page, wallet);
  await signedIn(page, tokenFor(SESSION_A));
  await page.clock.install();
  await startShift(page);
  const before = api.changes;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => api.changes).toBeGreaterThan(before);
  const afterOnline = api.changes;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => api.changes).toBeGreaterThan(afterOnline);
});

test('IR-07 두 번째 shift의 serverTime으로 잰 오차로 판정한다', async ({ page }) => {
  const wallet = await walletKey();
  await fakeDetector(page);
  await scannerApi(page, wallet, { shiftServerTime: (n) => new Date(Date.now() + (n === 1 ? 0 : 120_000)).toISOString() });
  await signedIn(page, tokenFor(SESSION_A));
  await startShift(page);
  await scan(page, await qrOf(wallet, TICKET, Date.now() + 120_000));
  await expect(verdict(page, '통과')).toBeVisible();
});
