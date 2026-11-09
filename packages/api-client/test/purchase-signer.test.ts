// 구매 세션 서명기(docs/frontend.md §5.3 '키 수명'·'순서 보장', ADR-0221 결정 3·4). 저장소는 메모리 판으로 본다.
// IndexedDB 판과 실제 Web Locks는 세 엔진 검사(tools/web-checks/purchase)가 본다.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { b64u, purchaseMac } from '../src/purchase/crypto';
import { memoryStore } from '../src/purchase/store';
import { PURCHASE_KEY_RETAIN_MS, PurchaseKeyError, clearPurchaseSessions, openPurchaseSession, pageLocks, type LockManagerLike } from '../src/purchase/signer';

const subtle = globalThis.crypto.subtle;
const utf8 = (s: string) => new TextEncoder().encode(s);
const NOW = Date.parse('2026-11-06T10:00:00Z');
const serverJwk = () => {
  const j = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  return { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, kid: 'k1' };
};
const token = (jti: string, expSec = NOW / 1000 + 900) => `${b64u(utf8('{"alg":"ES256"}'))}.${b64u(utf8(JSON.stringify({ jti, exp: expSec })))}.c2ln`;
const deps = (store = memoryStore(), locks: LockManagerLike = pageLocks()) => ({ subtle, store, locks, now: () => NOW });

describe('키 수명', () => {
  test('처음 열면 추출 불가 키·일련번호 0·만료·보낸 공개키를 jti로 둔다', async () => {
    const store = memoryStore();
    const s = await openPurchaseSession({ admissionToken: token('j-1'), serverEcdhPublicKey: serverJwk(), purchaseSessionExpiresAt: '2026-11-06T10:10:00Z' }, deps(store));
    expect(s.jti).toBe('j-1');
    expect(Buffer.from(s.clientPublicKey, 'base64url').length).toBe(65);
    const rec = await store.get('j-1');
    expect(rec).toMatchObject({ jti: 'j-1', seq: 0, exp: Date.parse('2026-11-06T10:10:00Z'), clientPublicKey: s.clientPublicKey });
    expect(rec!.key.extractable).toBe(false);
    // 입장 토큰은 저장하지 않는다(ADR-0221 결정 3)
    expect(JSON.stringify(Object.keys(rec!))).not.toMatch(/token/i);
  });

  test('만료는 purchaseSessionExpiresAt, 없으면 입장 토큰 exp다', async () => {
    const store = memoryStore();
    await openPurchaseSession({ admissionToken: token('j-2', NOW / 1000 + 600), serverEcdhPublicKey: serverJwk() }, deps(store));
    expect((await store.get('j-2'))!.exp).toBe(NOW + 600_000);
  });

  test('같은 jti가 살아 있으면 새로 만들지 않는다(새로고침해도 같은 공개키를 다시 보낸다)', async () => {
    const store = memoryStore();
    const jwk = serverJwk();
    const a = await openPurchaseSession({ admissionToken: token('j-3'), serverEcdhPublicKey: jwk }, deps(store));
    await a.run((sign) => sign('POST', '/v1/events/e/holds', utf8('{}')));
    const b = await openPurchaseSession({ admissionToken: token('j-3'), serverEcdhPublicKey: jwk }, deps(store));
    expect(b.clientPublicKey).toBe(a.clientPublicKey);
    expect((await store.get('j-3'))!.seq).toBe(1);
  });

  test('두 탭이 같이 열어도 키는 하나다(먼저 둔 것을 쓴다)', async () => {
    const store = memoryStore();
    const jwk = serverJwk();
    const [a, b] = await Promise.all([1, 2].map(() => openPurchaseSession({ admissionToken: token('j-4'), serverEcdhPublicKey: jwk }, deps(store))));
    expect(a!.clientPublicKey).toBe(b!.clientPublicKey);
    const ha = await a!.run((sign) => sign('POST', '/p', utf8('x')));
    const hb = await b!.run((sign) => sign('POST', '/p', utf8('x')));
    const rec = await store.get('j-4');
    expect(ha['x-purchase-mac']).toBe(await purchaseMac(subtle, rec!.key, 'POST', '/p', 1, utf8('x')));
    expect(hb['x-purchase-mac']).toBe(await purchaseMac(subtle, rec!.key, 'POST', '/p', 2, utf8('x')));
  });

  test.each([
    ['입장 토큰 모양이 틀림', { admissionToken: 'nope', serverEcdhPublicKey: serverJwk() }, 'token'],
    ['서버 공개키가 없음', { admissionToken: token('j-5') }, 'server-key'],
    ['서버 공개키가 곡선 위의 점이 아님', { admissionToken: token('j-6'), serverEcdhPublicKey: { kty: 'EC', crv: 'P-256', x: b64u(new Uint8Array(32).fill(1)), y: b64u(new Uint8Array(32).fill(2)) } }, 'server-key'],
    ['purchaseSessionExpiresAt가 날짜가 아님', { admissionToken: token('j-8'), serverEcdhPublicKey: serverJwk(), purchaseSessionExpiresAt: 'soon' }, 'token'],
  ])('열지 못한다: %s', async (_, o, reason) => {
    const store = memoryStore();
    const err = await openPurchaseSession(o as never, deps(store)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseKeyError);
    expect((err as PurchaseKeyError).reason).toBe(reason);
    expect(await store.all()).toEqual([]);
  });

  test('기기 시계가 빨라도 구매 세션을 열고 키를 지우지 않는다(만료 판단은 서버가 한다, openapi purchaseSessionExpiresAt)', async () => {
    const store = memoryStore();
    const jwk = serverJwk();
    const o = { admissionToken: token('skew', NOW / 1000 + 900), serverEcdhPublicKey: jwk };
    const a = await openPurchaseSession(o, deps(store));
    // 기기 시계가 세션 만료보다 한 시간 앞서 있다: 첫 열기·복귀 화면의 다시 열기 모두 된다
    const fast = { ...deps(store), now: () => NOW + 900_000 + 3_600_000 };
    const b = await openPurchaseSession(o, fast);
    expect(b.clientPublicKey).toBe(a.clientPublicKey);
    const fresh = await openPurchaseSession({ admissionToken: token('skew-2', NOW / 1000 + 900), serverEcdhPublicKey: jwk }, fast);
    expect(fresh.jti).toBe('skew-2');
  });

  test('만료하고 여유(24시간)가 지난 항목만 열 때 지운다', async () => {
    const store = memoryStore();
    const jwk = serverJwk();
    await openPurchaseSession({ admissionToken: token('old', NOW / 1000 + 1), serverEcdhPublicKey: jwk }, deps(store));
    await openPurchaseSession({ admissionToken: token('keep'), serverEcdhPublicKey: jwk }, { ...deps(store), now: () => NOW + 2_000 });
    expect((await store.all()).map((r) => r.jti)).toEqual(['keep', 'old']);
    await openPurchaseSession({ admissionToken: token('new', NOW / 1000 + 200_000), serverEcdhPublicKey: jwk }, { ...deps(store), now: () => NOW + 900_000 + PURCHASE_KEY_RETAIN_MS });
    expect((await store.all()).map((r) => r.jti)).toEqual(['new']);
  });

  test('세션 끝(end)은 그 항목을 지우고, 그 뒤 서명은 거절한다', async () => {
    const store = memoryStore();
    const s = await openPurchaseSession({ admissionToken: token('j-9'), serverEcdhPublicKey: serverJwk() }, deps(store));
    await s.end();
    expect(await store.get('j-9')).toBeUndefined();
    const err = await s.run((sign) => sign('DELETE', '/x', new Uint8Array())).catch((e: unknown) => e);
    expect((err as PurchaseKeyError).reason).toBe('ended');
  });

  test('로그아웃은 모두 지운다(clearPurchaseSessions)', async () => {
    const store = memoryStore();
    const jwk = serverJwk();
    await openPurchaseSession({ admissionToken: token('a'), serverEcdhPublicKey: jwk }, deps(store));
    await openPurchaseSession({ admissionToken: token('b'), serverEcdhPublicKey: jwk }, deps(store));
    await clearPurchaseSessions({ store });
    expect(await store.all()).toEqual([]);
  });
});

describe('순서 보장(ps:{jti} 잠금)', () => {
  test('서명할 때마다 일련번호를 1씩 올리고 머리 셋을 준다', async () => {
    const store = memoryStore();
    const t = token('s-1');
    const s = await openPurchaseSession({ admissionToken: t, serverEcdhPublicKey: serverJwk() }, deps(store));
    const h = await s.run(async (sign) => [await sign('POST', '/v1/events/e/holds?x=1', utf8('{"a":1}')), await sign('POST', '/v1/events/e/holds?x=1', utf8('{"a":1}'))]);
    expect(h.map((x) => x['x-purchase-seq'])).toEqual(['1', '2']);
    expect(h[0]!['x-admission-token']).toBe(t);
    const key = (await store.get('s-1'))!.key;
    expect(h[1]!['x-purchase-mac']).toBe(await purchaseMac(subtle, key, 'POST', '/v1/events/e/holds?x=1', 2, utf8('{"a":1}')));
  });

  test('한 jti의 요청은 하나씩 보낸다: 앞 요청이 끝나기 전에 다음 요청은 서명하지 않는다', async () => {
    const store = memoryStore();
    const s = await openPurchaseSession({ admissionToken: token('s-2'), serverEcdhPublicKey: serverJwk() }, deps(store));
    const log: string[] = [];
    let release!: () => void;
    const first = s.run(async (sign) => {
      log.push(`a:${(await sign('POST', '/a', new Uint8Array()))['x-purchase-seq']}`);
      await new Promise<void>((r) => (release = r));
      log.push('a:done');
    });
    const second = s.run(async (sign) => void log.push(`b:${(await sign('POST', '/b', new Uint8Array()))['x-purchase-seq']}`));
    await vi.waitFor(() => expect(log).toEqual(['a:1']));
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(['a:1']);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(['a:1', 'a:done', 'b:2']);
  });

  test('앞 요청이 실패해도 잠금을 놓는다', async () => {
    const s = await openPurchaseSession({ admissionToken: token('s-3'), serverEcdhPublicKey: serverJwk() }, deps());
    await expect(s.run(async () => Promise.reject(new Error('net')))).rejects.toThrow('net');
    await expect(s.run(async (sign) => (await sign('POST', '/b', new Uint8Array()))['x-purchase-seq'])).resolves.toBe('1');
  });

  test('Web Locks 대체: 기다리던 요청이 취소돼도 뒤 요청은 앞 요청이 끝난 뒤에 시작한다', async () => {
    const locks = pageLocks();
    const log: string[] = [];
    let release!: () => void;
    const a = locks.request('n', {}, () => new Promise<void>((r) => ((release = r), log.push('a')))).then(() => log.push('a:done'));
    const leave = new AbortController();
    const b = locks.request('n', { signal: leave.signal }, async () => void log.push('b'));
    const c = locks.request('n', {}, async () => void log.push('c'));
    leave.abort(new DOMException('떠남', 'AbortError'));
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(['a']);
    release();
    await Promise.all([a, c]);
    expect(log).toEqual(['a', 'a:done', 'c']);
  });

  test('서명 중 저장소 오류는 storage 까닭의 PurchaseKeyError다', async () => {
    const store = memoryStore();
    const s = await openPurchaseSession({ admissionToken: token('s-6'), serverEcdhPublicKey: serverJwk() }, deps(store));
    store.nextSeq = () => Promise.reject(new DOMException('가득 참', 'QuotaExceededError'));
    const err = await s.run((sign) => sign('POST', '/x', new Uint8Array())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseKeyError);
    expect((err as PurchaseKeyError).reason).toBe('storage');
  });

  test('Web Locks가 있으면 그것을 ps:{jti} 이름으로 쓴다', async () => {
    const names: string[] = [];
    const locks: LockManagerLike = { request: (name, opts, cb) => (names.push(name), (cb as () => Promise<unknown>)()) };
    const s = await openPurchaseSession({ admissionToken: token('s-4'), serverEcdhPublicKey: serverJwk() }, deps(memoryStore(), locks));
    await s.run(async (sign) => sign('POST', '/a', new Uint8Array()));
    expect(names).toEqual(['ps:s-4']);
  });

  test('화면이 떠나면 잠금을 기다리지 않는다(AbortSignal)', async () => {
    const s = await openPurchaseSession({ admissionToken: token('s-5'), serverEcdhPublicKey: serverJwk() }, deps());
    let release!: () => void;
    const first = s.run(() => new Promise<void>((r) => (release = r)));
    const leave = new AbortController();
    const second = s.run(async () => 'sent', leave.signal);
    leave.abort(new DOMException('떠남', 'AbortError'));
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await first;
  });
});
