// 관리 계정 토큰 갱신 유스케이스의 판정(docs/features/identity.md §6 '관리 계정 토큰 갱신과 로그아웃의 첫 구현', BUILD_ORDER BOT-130, I-T46). 메모리 저장소로 본다.
import { createHash, randomBytes } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { expect, test } from 'vitest';
import { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { RefreshAdminSession } from '../src/modules/admin/application/refresh-admin-session.js';

const M = 60_000;
const ACC = '0190f3a1-7c2e-7a00-8000-000000000ca1';

function harness() {
  const clock = fakeClock({ now: Date.parse('2026-11-05T11:00:00Z') });
  const store = new MemoryAdminAccountStore();
  store.create({ id: ACC, role: 'commander', email: 'rt.unit@peaket.example', status: 'ACTIVE', now: clock.now() });
  const seen: string[] = [];
  const signer = { access: async (c: { sessionId: string; scopes?: readonly string[] }, now: number) => ({ token: `at.${c.sessionId}.${(c.scopes ?? []).join(',')}`, expiresAt: now + 15 * M }) };
  const uc = new RefreshAdminSession(store, signer, { failure: () => {}, alert: () => {}, refreshed: (aud, r) => void seen.push(`${aud}:${r}`) }, clock);
  const open = async (id: string) => {
    const rt = randomBytes(32).toString('base64url');
    const now = clock.now();
    await store.createSession({ id, accountId: ACC, aud: 'ops', refreshHash: createHash('sha256').update(rt).digest(), refreshFamily: id, pairRef: 'p'.repeat(32), createdAt: now, absoluteExpiresAt: now + 24 * 60 * M, idleExpiresAt: now + 60 * M }, 2);
    return rt;
  };
  return { clock, store, uc, open, seen };
}

test('I-T46_보호잠금중인계정의열린세션은갱신되고_역할이관제역할이아니게바뀌면401과세션종료(ROLE_CHANGED)다', async () => {
  const t = harness();
  const rt = await t.open('0190f3a1-7c2e-7a00-8000-000000000cb1');
  await t.store.updateLoginState(ACC, t.clock.now(), (cur) => ({ next: { ...cur, lockKind: 'PROTECT' }, notices: [] }));
  const ok = await t.uc.run({ aud: 'ops', refreshToken: rt });
  expect(ok.result).toBe('OK');
  t.store.setRole(ACC, 'partner_admin');
  expect(await t.uc.run({ aud: 'ops', refreshToken: ok.result === 'OK' ? ok.refreshToken : '' })).toEqual({ result: 'INVALID' });
  expect(t.store.terminatedEvents()).toEqual([{ accountId: ACC, sessionId: '0190f3a1-7c2e-7a00-8000-000000000cb1', reason: 'ROLE_CHANGED' }]);
  expect(t.seen).toEqual(['ops:rotated', 'ops:invalid']);
});

test('I-T46⑥_재시도유예는회전뒤30초까지이고_30초를넘기면같은앞토큰은탈취로보아패밀리를끝낸다', async () => {
  const t = harness();
  const rt = await t.open('0190f3a1-7c2e-7a00-8000-000000000cb2');
  expect((await t.uc.run({ aud: 'ops', refreshToken: rt })).result).toBe('OK');
  t.clock.advance(30_000);
  expect((await t.uc.run({ aud: 'ops', refreshToken: rt })).result).toBe('OK');
  t.clock.advance(1);
  expect(await t.uc.run({ aud: 'ops', refreshToken: rt })).toEqual({ result: 'REUSED' });
  expect(t.store.terminatedEvents()).toEqual([{ accountId: ACC, sessionId: '0190f3a1-7c2e-7a00-8000-000000000cb2', reason: 'REFRESH_REUSE' }]);
  expect(t.seen).toEqual(['ops:rotated', 'ops:retried', 'ops:reused']);
  // 끝난 패밀리의 토큰은 그 뒤 무효(다시 끝내지 않는다)
  expect(await t.uc.run({ aud: 'ops', refreshToken: rt })).toEqual({ result: 'INVALID' });
  expect(t.store.terminatedEvents()).toHaveLength(1);
});

test('정비는절대만료가지난발급해시만지운다', async () => {
  const t = harness();
  await t.open('0190f3a1-7c2e-7a00-8000-000000000cb3');
  expect(await t.store.purgeRefreshHashes(t.clock.now() + 24 * 60 * M)).toBe(0);
  expect(await t.store.purgeRefreshHashes(t.clock.now() + 24 * 60 * M + 1)).toBe(1);
});

test('서명이실패하면회전을적지않아_30초뒤같은토큰도탈취가아니라회전이다(재검토 2026-11-05)', async () => {
  const t = harness();
  const rt = await t.open('0190f3a1-7c2e-7a00-8000-000000000cb4');
  const broken = new RefreshAdminSession(t.store, { access: async () => { throw new Error('관리 토큰 키 없음'); } }, { failure: () => {}, alert: () => {} }, t.clock);
  await expect(broken.run({ aud: 'ops', refreshToken: rt })).rejects.toThrow();
  t.clock.advance(31_000);
  expect((await t.uc.run({ aud: 'ops', refreshToken: rt })).result).toBe('OK');
  expect(t.store.terminatedEvents()).toEqual([]);
});

test('메모리저장소도같은토큰의동시갱신을차례로세워하나는회전·하나는재시도이고_재시도는유휴만료를늘리지않는다', async () => {
  const t = harness();
  const id = '0190f3a1-7c2e-7a00-8000-000000000cb5';
  const rt = await t.open(id);
  t.clock.advance(10 * M);
  const both = await Promise.all([t.uc.run({ aud: 'ops', refreshToken: rt }), t.uc.run({ aud: 'ops', refreshToken: rt })]);
  expect(both.map((r) => r.result)).toEqual(['OK', 'OK']);
  expect(t.seen).toEqual(['ops:rotated', 'ops:retried']);
  const idle = t.store.sessions(ACC).find((s) => s.id === id)!.idleExpiresAt;
  expect(idle).toBe(t.clock.now() + 60 * M);
  t.clock.advance(5_000);
  const again = await t.uc.run({ aud: 'ops', refreshToken: rt });
  expect(again.result).toBe('OK');
  expect(t.seen.at(-1)).toBe('ops:retried');
  expect(t.store.sessions(ACC).find((s) => s.id === id)!.idleExpiresAt).toBe(idle);
});

test('관리지표는팬과같은갱신지표(aud partner·ops)로보낸다_재사용탐지SEV3경보에함께잡힌다(identity §10.1)', async () => {
  const { PromAdminLoginSignals } = await import('../src/modules/admin/adapters/prom-admin-login-signals.js');
  const got: string[] = [];
  const s = new PromAdminLoginSignals({ refreshed: (aud, r) => void got.push(`${aud}:${r}`) });
  s.refreshed('partner', 'reused');
  expect(got).toEqual(['partner:reused']);
});

test('재초대대기(INVITED)계정의남은세션은갱신하지않지만DELETE로끝내지않는다(세션은재초대쪽이끝낸다)', async () => {
  const t = harness();
  const rt = await t.open('0190f3a1-7c2e-7a00-8000-000000000cb6');
  // 보호 잠금 뒤 재초대처럼 같은 행을 재초대 대기로 바꾼다(메모리 저장소의 create는 지운 행 자리에 다시 쓴다)
  t.store.remove(ACC);
  t.store.create({ id: ACC, role: 'commander', email: 'rt.unit@peaket.example', status: 'INVITED', now: t.clock.now() });
  expect(await t.uc.run({ aud: 'ops', refreshToken: rt })).toEqual({ result: 'INVALID' });
  expect(t.store.terminatedEvents()).toEqual([]);
});

test('메모리저장소의갱신트랜잭션이던지면그트랜잭션이바꾼것만되돌리고_그사이다른로그아웃은남는다(재검토 2026-11-05)', async () => {
  const t = harness();
  const a = '0190f3a1-7c2e-7a00-8000-000000000cb7';
  const b = '0190f3a1-7c2e-7a00-8000-000000000cb8';
  const rt = await t.open(a);
  await t.open(b);
  const before = t.store.sessions(ACC).find((s) => s.id === a)!;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inside = new Promise<void>((r) => (entered = r));
  const failing = t.store.refreshTransaction(async (tx) => {
    entered();
    const s = await tx.findByRefreshHash(createHash('sha256').update(rt).digest());
    await tx.rotateRefresh(s!.id, Buffer.alloc(32, 9), t.clock.now(), t.clock.now() + 60 * M);
    await tx.recordRefreshHash({ hash: Buffer.alloc(32, 9), sessionId: s!.id, refreshFamily: s!.refreshFamily, issuedAt: t.clock.now(), expiresAt: s!.absoluteExpiresAt });
    await tx.terminateSessions([a], 'REFRESH_REUSE', t.clock.now());
    await gate;
    throw new Error('되돌린다');
  });
  // 그 사이 큐 밖의 로그아웃(트랜잭션이 시작한 뒤)
  await inside;
  expect(await t.store.endSession(ACC, b, 'LOGOUT', t.clock.now())).toBe(true);
  release();
  await expect(failing).rejects.toThrow('되돌린다');
  expect(t.store.sessions(ACC).find((s) => s.id === a)).toEqual(before);
  expect(t.store.sessions(ACC).find((s) => s.id === b)!.terminationReason).toBe('LOGOUT');
  expect(t.store.terminatedEvents()).toEqual([{ accountId: ACC, sessionId: b, reason: 'LOGOUT' }]);
  // 되돌린 발급 해시는 없다: 처음 토큰은 지금 토큰 그대로 회전된다
  expect((await t.uc.run({ aud: 'ops', refreshToken: rt })).result).toBe('OK');
});

test('지운계정의세션에옛토큰이오면탈취가아니라DELETE로끝낸다(팬 갱신과 같은 차례)', async () => {
  const t = harness();
  const id = '0190f3a1-7c2e-7a00-8000-000000000cb9';
  const rt = await t.open(id);
  expect((await t.uc.run({ aud: 'ops', refreshToken: rt })).result).toBe('OK');
  t.clock.advance(31_000);
  t.store.remove(ACC);
  expect(await t.uc.run({ aud: 'ops', refreshToken: rt })).toEqual({ result: 'INVALID' });
  expect(t.store.terminatedEvents()).toEqual([{ accountId: ACC, sessionId: id, reason: 'DELETE' }]);
  expect(t.seen).not.toContain('ops:reused');
});
