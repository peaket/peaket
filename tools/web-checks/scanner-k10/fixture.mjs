// F-05-9 K10 브라우저 측정 하네스(계획 docs/review/plans/F-05-9.md §4·§5).
// 제품 코드가 아니다. 스캐너 앱 빌드를 띄우고, 가짜 스캐너 API·가짜 BarcodeDetector로
// QR을 대는 순간(present) → 디코딩(decoded) → 판정 화면(verdict)을 잰다.
// 서버 판정·중복 표시는 F-05-4·F-05-6 통합 시험이 본다. 여기서는 앱의 판정·큐·화면만 본다.
import { expect } from '@playwright/test';

export const API = 'https://scanner-api.peaket.example';
export const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f5481';
export const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f5482';
export const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f5483';
export const SEAT = 'R구역 12열 8번';

const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** base45(offline-gate §3). QR 영숫자 모드다. */
export function base45(bytes) {
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

/** 지갑 기기 키 하나. 공개키는 압축 33바이트, keyId는 SPKI SHA-256 앞 8바이트다(offline-gate §2). */
export async function newKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const compressed = new Uint8Array(33);
  compressed[0] = (raw[64] & 1) === 1 ? 0x03 : 0x02;
  compressed.set(raw.slice(1, 33), 1);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const keyIdBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', spki)).slice(0, 8);
  return {
    privateKey: pair.privateKey,
    keyIdBytes,
    keyId: Buffer.from(keyIdBytes).toString('base64url'),
    publicKey: Buffer.from(compressed).toString('base64url'),
  };
}

/** 한 실행 안에서 겹치지 않는 티켓 ID(UUID 꼴, 32 hex). */
export function ticketId(n) {
  return `0190f3a1-7c2e-7a00-8b2a-${(n >>> 0).toString(16).padStart(12, '0')}`;
}

/** QR v1(offline-gate §3): 버전 1바이트 + 티켓 16바이트 + keyId 8바이트 + 초 4바이트 + 서명. */
export async function qrOf(key, id, atMs) {
  const ticket = Buffer.from(id.replace(/-/g, ''), 'hex');
  const ts = Buffer.alloc(4);
  ts.writeUInt32BE(Math.floor(atMs / 1000));
  const message = Buffer.concat([Buffer.from('PEAKET-QR-v1'), ticket, Buffer.from(key.keyIdBytes), ts]);
  const sig = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, message));
  return base45(new Uint8Array(Buffer.concat([Buffer.from([1]), ticket, Buffer.from(key.keyIdBytes), ts, sig])));
}

/** 스태프 토큰 꼴(내용에 sid). 서명은 서버가 보므로 화면 시험에서는 아무 값이다. */
export function staffToken() {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'ES256', typ: 'JWT' })}.${part({ sub: 'acc-1', sid: SESSION, aud: 'scanner', exp: Math.floor(Date.now() / 1000) + 7_200 })}.c2lnbmF0dXJl`;
}

/** 이 회차 티켓 한 장. keys는 목록에 실린 공개키다. */
export function ticketOf(id, key, { status = 'ACTIVE', gateZone = '동문', seatLabel = SEAT } = {}) {
  return { ticketId: id, gateZone, seatLabel, status, keys: [{ keyId: key.keyId, publicKey: key.publicKey }] };
}

/**
 * 브라우저 안 계측기. `window.__k10`에 present·decoded·verdict·cleared 시각을 적는다.
 * 판정 화면은 `[aria-label="판정 결과"]`다(ds ScanResult, role=alert).
 */
export async function installProbe(page) {
  await page.addInitScript(() => {
    const K = (window.__k10 = { bootId: Math.random().toString(36).slice(2), presentedAt: 0, decodedAt: 0, verdictAt: 0, clearedAt: 0, text: '', log: [] });
    const read = () => {
      const el = document.querySelector('[aria-label="판정 결과"]');
      if (!el) {
        if (K.verdictAt && !K.clearedAt) K.clearedAt = performance.now();
        return;
      }
      const text = (el.textContent ?? '').trim();
      if (!text || !/통과|거부|확인 필요|다시 찍어 주세요/.test(text)) return;
      if (!K.presentedAt || performance.now() < K.presentedAt) return;
      if (!K.verdictAt) {
        K.verdictAt = performance.now();
        K.clearedAt = 0;
        K.text = text;
        K.log.push({ at: K.verdictAt, text });
      }
    };
    const start = () => {
      new MutationObserver(read).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      read();
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });
}

/** 가짜 BarcodeDetector. window.__peaketQr에 넣은 글자를 한 번 돌려주고 decodedAt을 적는다. */
export async function installFakeDetector(page) {
  await page.addInitScript(() => {
    class FakeBarcodeDetector {
      static async getSupportedFormats() {
        return ['qr_code'];
      }
      async detect() {
        const raw = window.__peaketQr;
        if (!raw) return [];
        window.__peaketQr = undefined;
        if (window.__k10) window.__k10.decodedAt = performance.now();
        return [{ rawValue: raw, format: 'qr_code', boundingBox: { x: 0, y: 0, width: 10, height: 10 }, cornerPoints: [] }];
      }
    }
    window.BarcodeDetector = FakeBarcodeDetector;
  });
}

const vector = (seq) => ({ eventId: EVENT, seq, ticketSeq: 0, keySeq: seq, policySeq: 0, placementSeq: 1, flagSeq: 0, issuedAt: new Date().toISOString(), maxOfflineMs: 86_400_000 });

/**
 * 스캐너 API 대역. `offline`이면 모든 요청을 끊는다.
 * `scanDelayMs`·`changesDelayMs`는 그 요청을 늦게 답해 '진행 중에 끊기'를 만들 때 쓴다.
 * `inFlight`는 지금 늦게 답하는 중인 경로(`scans`·`changes`)다.
 */
export async function fakeApi(page, { tickets, offline = false, scanDelayMs = 0, changesDelayMs = 0, scanReply, changesReply, reentryAllowed = false } = {}) {
  const log = { scans: [], scanCalls: [], changeCalls: [], unknownPaths: [], order: [], offline, shifts: 0, packages: 0, changes: 0, inFlight: undefined, scanDelayMs, changesDelayMs, scanReply, changesReply, loseScanResponseOnce: false };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      return json(200, {
        serverTime: new Date().toISOString(),
        eventId: EVENT,
        reentryAllowed,
        placement: { gateZone: '동문', mode: 'IN', version: 3 },
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
      log.packages++;
      log.order.push('package');
      return json(200, {
        eventId: EVENT,
        reentryAllowed,
        gateZones: ['동문', '서문'],
        serverTime: new Date().toISOString(),
        tickets,
        revokedKeyIds: [],
        lastSeq: 10,
        versionVector: vector(10),
      });
    }
    if (path === `/v1/scanner/events/${EVENT}/changes`) {
      log.changes++;
      log.order.push('changes');
      const after = new URL(req.url()).searchParams.get('after');
      const call = { at: Date.now(), after, aborted: false };
      log.changeCalls.push(call);
      if (log.changesDelayMs > 0) {
        log.inFlight = 'changes';
        await sleep(log.changesDelayMs);
        if (log.offline) {
          call.aborted = true;
          log.inFlight = undefined;
          return route.abort('internetdisconnected');
        }
        log.inFlight = undefined;
      }
      const pageData = log.changesReply?.(log.changes) ?? { changes: [], lastSeq: 10 };
      return json(200, { changes: pageData.changes, lastSeq: pageData.lastSeq, hasMore: false, versionVector: vector(pageData.lastSeq) });
    }
    if (path === `/v1/scanner/events/${EVENT}/flags`) return json(200, { items: [] });
    if (path === '/v1/scanner/scans' && req.method() === 'POST') {
      const body = req.postDataJSON();
      const ids = body.map((b) => b.id);
      log.order.push('scans');
      const call = { at: Date.now(), aborted: false, ids, responseLost: false };
      log.scanCalls.push(call);
      // 서버가 받고 응답을 잃은 갈래(RV059-04): 같은 ID가 다시 오는 것을 본다.
      if (log.loseScanResponseOnce) {
        log.loseScanResponseOnce = false;
        call.responseLost = true;
        log.scans.push({ ids, body, ok: true, responseLost: true, at: Date.now() });
        return route.abort('connectionreset');
      }
      if (log.scanDelayMs > 0) {
        log.inFlight = 'scans';
        await sleep(log.scanDelayMs);
        if (log.offline) {
          call.aborted = true;
          log.inFlight = undefined;
          return route.abort('internetdisconnected');
        }
        log.inFlight = undefined;
      }
      const reply = log.scanReply?.(log.scans.length + 1) ?? { status: 200 };
      log.scans.push({ ids, body, ok: reply.status === 200, at: Date.now() });
      if (reply.status === 200) return json(200, { acceptedIds: ids, resyncRequired: reply.resyncRequired ?? false, staleIds: [], flags: [] });
      return json(reply.status, { type: `https://peaket.example/problems/${reply.type ?? 'unauthorized'}`, title: '대역', status: reply.status }, reply.headers ?? {});
    }
    log.unknownPaths.push(path);
    return json(404, { type: 'about:blank', title: '대역에 없는 경로', status: 404 });
  });
  return log;
}

/** 로그인을 마친 기기: peaket-scanner-auth에 기기 키(꺼낼 수 없는 CryptoKey)와 스태프 토큰을 둔다. */
export async function signedIn(page, token = staffToken()) {
  await page.goto('/scan?state=통과');
  await page.evaluate(async (staffTokenValue) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('peaket-scanner-auth', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('keys')) req.result.createObjectStore('keys');
        if (!req.result.objectStoreNames.contains('session')) req.result.createObjectStore('session');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y }))));
    const jkt = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['keys', 'session'], 'readwrite');
      tx.objectStore('keys').put({ privateKey: pair.privateKey, publicJwk, jkt }, 'device');
      tx.objectStore('session').put({ token: staffTokenValue, expiresAtMs: Date.now() + 3_600_000 }, 'staff-token');
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, token);
}

/** 근무 준비(SCR-033)에서 [스캔 시작]을 눌러 판정 화면(SCR-034)으로 간다. */
export async function startShift(page) {
  await page.goto('/setup?live=1');
  const start = page.getByRole('button', { name: '스캔 시작' });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();
  await expect(page).toHaveURL(/\/scan(\?|$)/);
}

/** 앞 판정 화면이 사라질 때까지 기다린다(닫힌 고리). */
export async function waitCleared(page, timeout = 5_000) {
  await page.waitForFunction(() => !window.__k10?.verdictAt || window.__k10.clearedAt > 0, undefined, { timeout });
}

/** QR을 대고 present 시각을 적는다. 앞 판정 화면이 남아 있으면 먼저 기다린다. */
export async function presentQr(page, raw) {
  await waitCleared(page);
  await page.evaluate((value) => {
    const K = window.__k10;
    K.presentedAt = performance.now();
    K.decodedAt = 0;
    K.verdictAt = 0;
    K.clearedAt = 0;
    K.text = '';
    window.__peaketQr = value;
  }, raw);
}

/** 판정 화면이 뜰 때까지 기다리고 계측값을 돌려준다. 결과가 없으면 던진다. */
export async function waitVerdict(page, timeout = 10_000) {
  await page.waitForFunction(() => window.__k10?.verdictAt > 0, undefined, { timeout });
  return page.evaluate(() => ({ ...window.__k10, log: [...window.__k10.log] }));
}

/** 판정 화면 글이 어느 결과인가. */
export function resultOf(text) {
  if (text.includes('통과')) return 'PASS';
  if (text.includes('다시 찍어')) return 'RETRY';
  if (text.includes('확인 필요')) return 'CHECK';
  return 'REJECT';
}

/** 스캔 큐 건수(IndexedDB peaket-scanner-queue). */
export async function queueCount(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('peaket-scanner-queue');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!db.objectStoreNames.contains('scanQueue')) {
      db.close();
      return 0;
    }
    const count = await new Promise((resolve, reject) => {
      const req = db.transaction('scanQueue', 'readonly').objectStore('scanQueue').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return count;
  });
}

/** 지금 브라우저가 온라인이라고 보는가(navigator.onLine). */
export async function onlineState(page) {
  return page.evaluate(() => navigator.onLine);
}

/** 가짜 API에 실제로 닿는가. 끊긴 동안은 fetch가 거부되어 false다. */
export async function apiReachable(page) {
  return page.evaluate(async (api) => {
    try {
      const res = await fetch(`${api}/v1/scanner/shift/readiness`, { method: 'GET', cache: 'no-store' });
      return res.ok || res.status === 204;
    } catch {
      return false;
    }
  }, API);
}

/** 앱이 저장한 티켓 상태(키·폐기·상태·변경분 커서). 변경분이 실제로 적용됐는지 본다. */
export async function ticketState(page, ticketId) {
  return page.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('peaket-scanner');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const getAll = (store) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const getOne = (store, key) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const [ticket, revoked, cursors] = await Promise.all([getOne('tickets', id), getAll('revoked'), getAll('cursor')]);
    db.close();
    return {
      status: ticket?.status,
      statusVersion: ticket?.statusVersion,
      keys: (ticket?.keys ?? []).map((k) => k.keyId),
      revoked: revoked.map((r) => r.keyId),
      cursors: cursors.map((c) => ({ eventId: c.eventId, lastSeq: c.lastSeq })),
    };
  }, ticketId);
}

/** 큐가 기대 건수가 될 때까지 기다린다. Playwright의 waitForFunction은 비동기 조건을 기다리지 않으므로 직접 돈다. */
export async function waitQueueCount(page, expected, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const count = await queueCount(page);
    if (count === expected) return;
    if (Date.now() > deadline) throw new Error(`스캔 큐가 ${expected}건이 되지 않았다(현재 ${count}건)`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 실행 전체에서 올라간 스캔 기록 ID(중복 포함). */
export function uploadedIds(api) {
  return api.scans.filter((s) => s.ok).flatMap((s) => s.ids);
}
