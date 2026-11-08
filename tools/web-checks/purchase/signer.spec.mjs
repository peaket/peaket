// 구매 세션 서명기 세 엔진 검사(FE-T7 브라우저 칸, docs/frontend.md §5.3·§5.17, ADR-0221 결정 7). Chromium·WebKit·Firefox 실제 브라우저에서
// ① 서버와 같은 시험 벡터, ② 브라우저 키 × 서버 키 합의 왕복(서버 쪽 식은 이 시험이 node:crypto로 따로 센다), ③ IndexedDB에 둔 추출 불가 키로
// 다시 연 페이지의 MAC과 내보내기 거절, ④ 같은 문맥의 두 탭이 같은 jti로 동시에 보낼 때 서버가 받은 일련번호 차례(Web Locks ps:{jti})와 ⑤ 복제한 탭(FE-T6)을 본다.
// 모듈은 packages/api-client/src/purchase의 원본을 타입만 지워 그대로 쓴다(purchase/server.mjs).
import { createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { expect, test } from '@playwright/test';

const NOW_SEC = () => Math.floor(Date.now() / 1000);
const b64u = (b) => Buffer.from(b).toString('base64url');
const token = (jti) => `${b64u('{"alg":"ES256"}')}.${b64u(JSON.stringify({ jti, exp: NOW_SEC() + 900 }))}.c2ln`;

/** 서버 쪽 식(packages/platform purchaseRequestKey·purchaseMac과 같다)으로 브라우저 MAC을 확인한다 */
function serverMac(server, clientPublicKey, jti, method, pathAndQuery, seq, body) {
  const point = Buffer.from(clientPublicKey, 'base64url');
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) }, format: 'jwk' });
  const shared = diffieHellman({ privateKey: server.privateKey, publicKey: pub });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(jti, 'utf8'), Buffer.from('PEAKET-purchase-v1', 'utf8'), 32));
  const input = `${method}\n${pathAndQuery}\n${seq}\n${createHash('sha256').update(body, 'utf8').digest('base64url')}`;
  return createHmac('sha256', key).update(input, 'utf8').digest('base64url');
}

function serverKey() {
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = k.publicKey.export({ format: 'jwk' });
  return { ...k, jwk: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, kid: 'k1' } };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('FE-T7 서버와 같은 시험 벡터: HKDF 키 바이트·본문 해시·MAC', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const C = await import('/m/crypto');
    const v = await (await fetch('/vectors.json')).json();
    const hex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
    const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
    const enc = new TextEncoder();
    const key = await C.requestKey(crypto.subtle, hex(v.sharedSecretHex), v.jti, true);
    const signKey = await C.requestKey(crypto.subtle, hex(v.sharedSecretHex), v.jti);
    const cases = [];
    for (const c of v.cases) {
      cases.push({
        hash: (await C.bodyHash(crypto.subtle, enc.encode(c.body))) === c.bodySha256B64u,
        input: C.macInput(c.method, c.pathAndQuery, c.seq, c.bodySha256B64u) === c.macInput,
        mac: (await C.purchaseMac(crypto.subtle, signKey, c.method, c.pathAndQuery, c.seq, enc.encode(c.body))) === c.mac,
      });
    }
    return { keyHex: toHex(await crypto.subtle.exportKey('raw', key)), want: v.keyHex, info: C.PURCHASE_KEY_INFO === v.info, length: key.algorithm.length, cases };
  });
  expect(out.keyHex).toBe(out.want);
  expect(out.info).toBe(true);
  expect(out.length).toBe(256);
  expect(out.cases.length).toBeGreaterThan(0);
  for (const c of out.cases) expect(c).toEqual({ hash: true, input: true, mac: true });
});

test('FE-T7 합의 왕복과 IndexedDB의 추출 불가 키: 다시 연 페이지에서도 같은 공개키·이어지는 번호·서버가 확인하는 MAC', async ({ page }) => {
  const server = serverKey();
  const jti = `rt-${test.info().project.name}-${Date.now()}`;
  const t = token(jti);
  const open = (arg) =>
    page.evaluate(async ({ t, jwk, body }) => {
      const S = await import('/m/signer');
      const s = await S.openPurchaseSession({ admissionToken: t, serverEcdhPublicKey: jwk });
      const h = await s.run((sign) => sign('POST', '/v1/events/evt-01/holds?x=1', new TextEncoder().encode(body)));
      return { pub: s.clientPublicKey, h, locks: typeof navigator.locks?.request === 'function' };
    }, arg);
  const first = await open({ t, jwk: server.jwk, body: '{"seatIds":["A-1"]}' });
  expect(first.locks).toBe(true);
  expect(first.h['x-purchase-seq']).toBe('1');
  expect(first.h['x-admission-token']).toBe(t);
  expect(first.h['x-purchase-mac']).toBe(serverMac(server, first.pub, jti, 'POST', '/v1/events/evt-01/holds?x=1', 1, '{"seatIds":["A-1"]}'));

  await page.reload();
  const again = await open({ t, jwk: server.jwk, body: '' });
  expect(again.pub).toBe(first.pub);
  expect(again.h['x-purchase-seq']).toBe('2');
  expect(again.h['x-purchase-mac']).toBe(serverMac(server, first.pub, jti, 'POST', '/v1/events/evt-01/holds?x=1', 2, ''));

  // 저장한 키는 추출 불가로 남고 내보낼 수 없다. 입장 토큰은 저장하지 않는다(ADR-0221 결정 3)
  const stored = await page.evaluate(async (jti) => {
    const St = await import('/m/store');
    const rec = await St.indexedDbStore().get(jti);
    let exported = 'yes';
    try {
      await crypto.subtle.exportKey('raw', rec.key);
    } catch (e) {
      exported = e.name;
    }
    return { extractable: rec.key.extractable, usages: rec.key.usages, seq: rec.seq, fields: Object.keys(rec).sort(), exported };
  }, jti);
  expect(stored).toEqual({ extractable: false, usages: ['sign'], seq: 2, fields: ['clientPublicKey', 'exp', 'jti', 'key', 'seq'], exported: 'InvalidAccessError' });
});

test('FE-T7 두 탭이 같은 jti로 동시에 보내도 서버가 받은 일련번호는 1부터 빠짐·겹침·뒤집힘 없이 오른다(Web Locks ps:{jti})', async ({ page, context, request }) => {
  const server = serverKey();
  const jti = `tabs-${test.info().project.name}-${Date.now()}`;
  const t = token(jti);
  const other = await context.newPage();
  await other.goto('/');
  await request.delete('/sink');
  const burst = (p) =>
    p.evaluate(async ({ t, jwk }) => {
      const S = await import('/m/signer');
      const s = await S.openPurchaseSession({ admissionToken: t, serverEcdhPublicKey: jwk });
      // 요청마다 서버가 0~30ms 뒤 답한다: 잠금이 응답까지 쥐고 있으면 서버가 동시에 처리하는 요청은 늘 하나다
      await Promise.all(
        Array.from({ length: 8 }, () =>
          s.run(async (sign) => {
            const h = await sign('POST', '/sink', new Uint8Array());
            await fetch(`/sink?d=${Math.floor(Math.random() * 30)}`, { method: 'POST', headers: h });
          }),
        ),
      );
      return s.clientPublicKey;
    }, { t, jwk: server.jwk });
  const [a, b] = await Promise.all([burst(page), burst(other)]);
  expect(a).toBe(b);
  const got = await (await request.get('/sink')).json();
  expect(got.seqs).toEqual(Array.from({ length: 16 }, (_, i) => String(i + 1)));
  expect(got.maxInflight, '잠금이 응답까지 이어져야 한다').toBe(1);
  await other.close();
});

test('FE-T6 복제한 탭: 입장 저장값을 복사한 탭과 함께 사도 서버가 받은 일련번호는 거꾸로 가지 않고, 한 탭이 끝내면 다른 탭의 다음 요청은 세션 끝이다', async ({ page, context, request }) => {
  const server = serverKey();
  const jti = `clone-${test.info().project.name}-${Date.now()}`;
  const key = 'peaket.admission.evt-clone';
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [key, JSON.stringify({ admissionToken: token(jti), serverEcdhPublicKey: server.jwk })]);
  // 탭을 복제하면 sessionStorage가 복사된다. Playwright에는 탭 복제가 없어 같은 값을 새 탭으로 옮겨 흉내 낸다(ADR-0218 결정 6)
  const copied = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith('peaket.admission.'))));
  expect(Object.keys(copied)).toEqual([key]);
  const clone = await context.newPage();
  await clone.goto('/');
  await clone.evaluate((e) => Object.entries(e).forEach(([k, v]) => sessionStorage.setItem(k, v)), copied);
  await request.delete('/sink');
  const buy = (p) =>
    p.evaluate(async (k) => {
      const S = await import('/m/signer');
      const s = await S.openPurchaseSession(JSON.parse(sessionStorage.getItem(k)));
      window.__session = s;
      // 사람이 누르듯 한 탭 안에서는 차례대로, 두 탭은 서로 겹쳐서 보낸다
      for (let i = 0; i < 6; i++) {
        await s.run(async (sign) => {
          const h = await sign('POST', '/sink', new Uint8Array());
          await fetch(`/sink?d=${Math.floor(Math.random() * 30)}`, { method: 'POST', headers: h });
        });
      }
      return s.clientPublicKey;
    }, key);
  const [a, b] = await Promise.all([buy(page), buy(clone)]);
  expect(a, '복제한 탭은 같은 구매 세션 키를 쓴다').toBe(b);
  const got = await (await request.get('/sink')).json();
  expect(got.seqs, '일련번호 역전 0').toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
  expect(got.maxInflight).toBe(1);

  await page.evaluate(() => window.__session.end());
  const reason = await clone.evaluate(() => window.__session.run((sign) => sign('POST', '/sink', new Uint8Array())).then(() => 'sent', (e) => e.reason));
  expect(reason, '끝낸 세션의 키는 다른 탭에서도 없다').toBe('ended');
  await clone.close();
});

test('FE-T7 IndexedDB 지우기(세션 끝·만료 여유·로그아웃)와 Web Locks 기다림 취소', async ({ page }) => {
  const server = serverKey();
  const out = await page.evaluate(async ({ jwk, a, b, c }) => {
    const S = await import('/m/signer');
    const St = await import('/m/store');
    const store = St.indexedDbStore();
    const old = Date.now() + 60_000;
    const open = (t, extra) => S.openPurchaseSession({ admissionToken: t, serverEcdhPublicKey: jwk, ...extra }, { store });
    const sa = await open(a);
    await open(b, { purchaseSessionExpiresAt: new Date(old).toISOString() });
    const ids = async () => (await store.all()).map((r) => r.jti).sort();
    const start = await ids();
    await sa.end();
    const afterEnd = await ids();
    let ended = '';
    await sa.run((sign) => sign('POST', '/x', new Uint8Array())).catch((e) => (ended = e.reason));
    await store.sweep(old);
    const afterSweep = await ids();
    const sc = await open(c);
    let release;
    const first = sc.run(() => new Promise((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    const leave = new AbortController();
    const waiting = sc.run(async () => 'sent', leave.signal).catch((e) => e.name);
    leave.abort(new DOMException('떠남', 'AbortError'));
    const aborted = await waiting;
    release();
    await first;
    await S.clearPurchaseSessions({ store });
    return { start, afterEnd, ended, afterSweep, aborted, afterClear: await ids() };
  }, { jwk: server.jwk, a: token('del-a'), b: token('del-b'), c: token('del-c') });
  expect(out).toEqual({ start: ['del-a', 'del-b'], afterEnd: ['del-b'], ended: 'ended', afterSweep: [], aborted: 'AbortError', afterClear: [] });
});
