// 조사용 가명 키 회전의 이음(docs/features/identity.md §9.1 '조사용 가명 키 회전 이음의 첫 구현', docs/security/secrets-and-keys.md 회전 절차 ③④⑧, BUILD_ORDER BOT-046, I-T73).
// 옛 판(1) 키로 만든 기기·연락처 행이 있는 계정에서 새 판(2) 키와 이음 기간을 켜고, 다시 로그인·정비·다시 본인확인·조사 적재 조회·이음 닫기를 메모리 저장소로 본다.
import { createHmac } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { InvRefKeyRing } from '../src/modules/session/adapters/inv-ref-key-ring.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { deviceRefsOf, phoneContactRefs } from '../src/modules/session/adapters/phone-contact-refs.js';
import { CloseInvRefBridge, INV_REF_BRIDGE_GRACE_MS } from '../src/modules/session/application/close-inv-ref-bridge.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { GetInvestigationRefs } from '../src/modules/session/application/get-investigation-refs.js';
import { RotateContactRefs } from '../src/modules/session/application/rotate-contact-refs.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, kit, newKey, testAgency } from './support.js';

const D1 = Buffer.alloc(32, 1);
const D2 = Buffer.alloc(32, 2);
const C1 = Buffer.alloc(32, 3);
const C2 = Buffer.alloc(32, 4);
const ref = (key: Buffer, v: number, value: string) => `k${v}.${createHmac('sha256', key).update(value, 'utf8').digest('base64url')}`;
const DAY = 86_400_000;

async function setup() {
  const clock = fakeClock({ now: Date.parse('2026-11-05T00:00:00Z') });
  const sessions = new MemorySessionStore();
  const verifications = new MemoryVerificationStore();
  const closure = new CloseAccount(sessions, clock);
  const until = clock.now() + 30 * DAY;
  const oldRing = new InvRefKeyRing({ sources: [{ label: 'device', version: 1, key: D1 }, { label: 'contact', version: 1, key: C1 }], clock });
  const bridged = new InvRefKeyRing({
    sources: [
      { label: 'device', version: 2, key: D2, previous: { version: 1, key: D1 }, bridgeUntil: until },
      { label: 'contact', version: 2, key: C2, previous: { version: 1, key: C1 }, bridgeUntil: until },
    ],
    clock,
  });
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const verify = async (ring: InvRefKeyRing, accountId: string, phone: string, purpose: 'FIRST' | 'REVERIFY') => {
    const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId: null, purpose, next: '/' });
    await new ConfirmVerification(verifications, provider, hashers, closure, clock, phoneContactRefs(ring)).run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person: 'rot-person', phone }) });
  };
  return { clock, sessions, verifications, until, oldRing, bridged, verify };
}

describe('라벨 키 링의 두 판', () => {
  test('I-T73_새판으로쓰고_이음기간에는옛판값도주며_지나면주지않는다_설정은옛판이작고이음끝이있고키가달라야한다', () => {
    const t0 = Date.parse('2026-11-05T00:00:00Z');
    const clock = fakeClock({ now: t0 });
    const r = new InvRefKeyRing({ sources: [{ label: 'device', version: 2, key: D2, previous: { version: 1, key: D1 }, bridgeUntil: t0 + DAY }], clock });
    expect(r.ref('device', 'x')).toBe(ref(D2, 2, 'x'));
    expect(r.prevRef('device', 'x')).toBe(ref(D1, 1, 'x'));
    expect(r.bridgeOf('device')).toEqual({ prevVersion: 1, until: t0 + DAY });
    clock.advance(DAY);
    expect(r.prevRef('device', 'x')).toBeUndefined();
    const env = (o: Record<string, string>) => InvRefKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: D2.toString('base64'), PEAKET_INV_REF_DEVICE_KEY_VERSION: '2', ...o }, clock);
    const ok = env({ PEAKET_INV_REF_DEVICE_PREVIOUS_KEY: D1.toString('base64'), PEAKET_INV_REF_DEVICE_PREVIOUS_KEY_VERSION: '1', PEAKET_INV_REF_DEVICE_BRIDGE_UNTIL: new Date(t0 + 30 * DAY).toISOString() });
    expect(ok.ring.prevRef('device', 'x')).toBe(ref(D1, 1, 'x'));
    expect(() => env({ PEAKET_INV_REF_DEVICE_PREVIOUS_KEY: D1.toString('base64'), PEAKET_INV_REF_DEVICE_PREVIOUS_KEY_VERSION: '2', PEAKET_INV_REF_DEVICE_BRIDGE_UNTIL: new Date(t0).toISOString() })).toThrow(/옛 판/);
    expect(() => env({ PEAKET_INV_REF_DEVICE_PREVIOUS_KEY: D1.toString('base64'), PEAKET_INV_REF_DEVICE_PREVIOUS_KEY_VERSION: '1' })).toThrow(/BRIDGE_UNTIL/);
  });
});

describe('이음 기간의 기기·연락처(I-T73)', () => {
  test('I-T73②_옛판기기행이있는계정이같은기기로다시로그인하면새기기로세지않고그행이새판값과옛판대응을갖는다', async () => {
    const t = await setup();
    const before = await kit(t.sessions, { clock: t.clock, invRefs: t.oldRing });
    const a = await before.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-rot', email: 'Rot@Peaket.test', deviceId: 'dev-rot' });
    expect(t.sessions.devicesOf(a.accountId)).toEqual([ref(D1, 1, 'dev-rot')]);
    const after = await kit(t.sessions, { clock: t.clock, invRefs: t.bridged });
    await after.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-rot', email: null, deviceId: 'dev-rot' });
    expect(t.sessions.devicesOf(a.accountId)).toEqual([ref(D2, 2, 'dev-rot')]);
    expect(t.sessions.devicePrevsOf(a.accountId)).toEqual([ref(D1, 1, 'dev-rot')]);
    // 이음 기간에 새로 묶는 기기도 옛 판 대응을 둔다
    await after.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-rot', email: null, deviceId: 'dev-new' });
    expect(t.sessions.devicePrevsOf(a.accountId)).toEqual([ref(D1, 1, 'dev-rot'), ref(D1, 1, 'dev-new')]);
  });

  test('I-T73③④⑤_정비는EMAIL행을새판으로바꾸고옛판을두며PHONE은그대로_다시본인확인하면PHONE이두판을갖고_조사적재는두판값을함께받는다', async () => {
    const t = await setup();
    const before = await kit(t.sessions, { clock: t.clock, invRefs: t.oldRing });
    const a = await before.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-rot2', email: 'Rot2@Peaket.test', deviceId: 'dev-rot2' });
    await t.verify(t.oldRing, a.accountId, '010-1234-5678', 'FIRST');
    expect(t.verifications.contactRefsOf(a.accountId)).toEqual([{ kind: 'PHONE', ref: ref(C1, 1, '+821012345678') }]);
    // ③ 정비: EMAIL은 새 판(옛 판은 ref_prev), PHONE은 원문이 없어 그대로
    expect(await new RotateContactRefs(t.sessions, t.bridged, t.bridged, t.clock).run(1)).toBe(1);
    expect(t.sessions.contactRowsOf(a.accountId)).toEqual([{ kind: 'EMAIL', ref: ref(C2, 2, 'rot2@peaket.test'), refPrev: ref(C1, 1, 'rot2@peaket.test') }]);
    expect(await new RotateContactRefs(t.sessions, t.bridged, t.bridged, t.clock).run(1)).toBe(0);
    // ④ 다시 본인확인: PHONE이 새 판과 옛 판을 갖는다
    t.clock.advance(60_000);
    await t.verify(t.bridged, a.accountId, '010-1234-5678', 'REVERIFY');
    expect(t.verifications.phoneRowOf(a.accountId)).toEqual({ ref: ref(C2, 2, '+821012345678'), refPrev: ref(C1, 1, '+821012345678') });
    // ⑤ 조사 적재: 기기·연락처의 두 판 값을 함께 싣는다(메모리 세션 저장소는 PHONE 행을 보지 못해 EMAIL만)
    const after = await kit(t.sessions, { clock: t.clock, invRefs: t.bridged });
    await after.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-rot2', email: null, deviceId: 'dev-rot2' });
    const [item] = await new GetInvestigationRefs(t.sessions, t.clock).run([a.accountId]);
    expect(new Set(item!.deviceRefs)).toEqual(new Set([ref(D2, 2, 'dev-rot2'), ref(D1, 1, 'dev-rot2')]));
    expect(item!.contactRefs).toEqual([
      { kind: 'EMAIL', ref: ref(C2, 2, 'rot2@peaket.test') },
      { kind: 'EMAIL', ref: ref(C1, 1, 'rot2@peaket.test') },
    ]);
  });

  test('I-T73⑥_이음기간끝+7일이지나면옛판값과다시로그인하지않은기기의옛판행을지우고_그전에는지우지않는다', async () => {
    const t = await setup();
    const before = await kit(t.sessions, { clock: t.clock, invRefs: t.oldRing });
    const a = await before.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-rot3', email: 'r3@peaket.test', deviceId: 'dev-again' });
    await before.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-rot3', email: null, deviceId: 'dev-stale' });
    const after = await kit(t.sessions, { clock: t.clock, invRefs: t.bridged });
    await after.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-rot3', email: null, deviceId: 'dev-again' });
    await new RotateContactRefs(t.sessions, t.bridged, t.bridged, t.clock).run(100);
    const close = new CloseInvRefBridge(t.sessions, t.bridged, t.clock);
    t.clock.advance(30 * DAY + INV_REF_BRIDGE_GRACE_MS - 1);
    expect(await close.run()).toEqual({ device: null, contact: null });
    t.clock.advance(2);
    expect(await close.run()).toEqual({ device: { cleared: 1, removed: 1 }, contact: { cleared: 1 } });
    expect(t.sessions.devicesOf(a.accountId)).toEqual([ref(D2, 2, 'dev-again')]);
    expect(t.sessions.devicePrevsOf(a.accountId)).toEqual([]);
    expect(t.sessions.contactRowsOf(a.accountId)).toEqual([{ kind: 'EMAIL', ref: ref(C2, 2, 'r3@peaket.test'), refPrev: null }]);
    // 이음 기간이 지난 뒤에는 옛 판으로 계산하지 않는다
    expect(t.bridged.prevRef('device', 'dev-again')).toBeUndefined();
  });
});

describe('새 맥락 리뷰 고침(BOT-046)', () => {
  test('높음1_운영조립의기기가명어댑터는옛판값도넘긴다(main과시험이같은함수를쓴다)', () => {
    const t0 = Date.parse('2026-11-05T00:00:00Z');
    const ring = new InvRefKeyRing({ sources: [{ label: 'device', version: 2, key: D2, previous: { version: 1, key: D1 }, bridgeUntil: t0 + DAY }], clock: fakeClock({ now: t0 }) });
    const d = deviceRefsOf(ring);
    expect(d.ref('x')).toBe(ref(D2, 2, 'x'));
    expect(d.prevRef?.('x')).toBe(ref(D1, 1, 'x'));
  });

  test('높음1_다시로그인한기기는세션의기기ID가그대로이고기기한도로끝나는세션이없다', async () => {
    const t = await setup();
    const before = await kit(t.sessions, { clock: t.clock, invRefs: t.oldRing });
    const a = await before.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-same', email: null, deviceId: 'dev-same' });
    const after = await kit(t.sessions, { clock: t.clock, invRefs: t.bridged });
    const b = await after.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-same', email: null, deviceId: 'dev-same' });
    expect(t.sessions.peekSession(b.sessionId)?.deviceId).toBe(t.sessions.peekSession(a.sessionId)?.deviceId);
    expect(after.signals.seen.filter((x) => x.startsWith('terminated:DEVICE_LIMIT'))).toEqual([]);
  });

  test('중간2_옛판값을이미둔행을옛판없이다시쓰면옛판값을지우지않고_판이바뀌면지금값을옛판으로둔다', async () => {
    const t = await setup();
    const id = (await (await kit(t.sessions, { clock: t.clock, invRefs: t.oldRing })).create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-keep', email: null, deviceId: null })).accountId;
    await t.sessions.transaction((tx) => tx.setContactRef({ accountId: id, kind: 'EMAIL', ref: 'k2.new', refPrev: 'k1.old', now: 1 }));
    await t.sessions.transaction((tx) => tx.setContactRef({ accountId: id, kind: 'EMAIL', ref: 'k2.new', refPrev: null, now: 2 }));
    expect(t.sessions.contactRowsOf(id)).toEqual([{ kind: 'EMAIL', ref: 'k2.new', refPrev: 'k1.old' }]);
    await t.sessions.transaction((tx) => tx.setContactRef({ accountId: id, kind: 'EMAIL', ref: 'k3.newer', now: 3 }));
    expect(t.sessions.contactRowsOf(id)).toEqual([{ kind: 'EMAIL', ref: 'k3.newer', refPrev: 'k2.new' }]);
  });

  test('중간3_이음기간인데옛판라벨키를받지못하면센다_낮음7이음끝뒤에는옛판키를받지않는다', async () => {
    const t0 = Date.parse('2026-11-05T00:00:00Z');
    const clock = fakeClock({ now: t0 });
    const calls: string[] = [];
    const missing: string[] = [];
    const kms = {
      async mac(keyId: string, m: Uint8Array) {
        calls.push(keyId);
        if (keyId === 'old') throw new Error('denied');
        return createHmac('sha256', Buffer.alloc(32, 9)).update(m).digest();
      },
    };
    const ring = new InvRefKeyRing({ sources: [{ label: 'device', version: 2, kmsKeyId: 'new', previous: { version: 1, kmsKeyId: 'old' }, bridgeUntil: t0 + DAY }], client: kms, clock, onMissing: (l, r) => missing.push(`${l}:${r}`) });
    await ring.refresh();
    expect(ring.prevRef('device', 'x')).toBeUndefined();
    expect(missing).toEqual(['device:KMS_ERROR']);
    clock.advance(DAY);
    calls.length = 0;
    await ring.refresh();
    expect(calls).toEqual(['new']);
  });

  test('중간4_이음설정의옛판이지금판보다작지않으면relay도시작하지않는다', () => {
    expect(() => InvRefKeyRing.bridgesFromEnv({ PEAKET_INV_REF_DEVICE_KEY_VERSION: '2', PEAKET_INV_REF_DEVICE_PREVIOUS_KEY_VERSION: '2', PEAKET_INV_REF_DEVICE_BRIDGE_UNTIL: '2026-12-05T00:00:00Z' })).toThrow(/옛 판/);
    expect(InvRefKeyRing.bridgesFromEnv({ PEAKET_INV_REF_DEVICE_KEY_VERSION: '2', PEAKET_INV_REF_DEVICE_PREVIOUS_KEY_VERSION: '1', PEAKET_INV_REF_DEVICE_BRIDGE_UNTIL: '2026-12-05T00:00:00Z' }).bridgeOf('device')).toEqual({ prevVersion: 1, until: Date.parse('2026-12-05T00:00:00Z'), writeVersion: 2 });
  });

  test('중간5·6_EMAIL다시계산은옛판키없이이음설정으로돌고_이음끝뒤에도새판이아닌행을바꾸되옛판값은두지않는다', async () => {
    const t = await setup();
    const before = await kit(t.sessions, { clock: t.clock, invRefs: t.oldRing });
    const a = await before.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-r5', email: 'r5@peaket.test', deviceId: null });
    const late = await before.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-r6', email: 'r6@peaket.test', deviceId: null });
    t.sessions.setStatus(late.accountId, 'WITHDRAWAL_PENDING');
    // relay처럼 새 판 키만 있는 링과 키 없는 이음 설정
    const newOnly = new InvRefKeyRing({ sources: [{ label: 'contact', version: 2, key: C2 }], clock: t.clock });
    const bridges = { bridgeOf: () => ({ prevVersion: 1, until: t.until, writeVersion: 2 }) };
    expect(await new RotateContactRefs(t.sessions, newOnly, bridges, t.clock).run(10)).toBe(1);
    expect(t.sessions.contactRowsOf(a.accountId)).toEqual([{ kind: 'EMAIL', ref: ref(C2, 2, 'r5@peaket.test'), refPrev: ref(C1, 1, 'r5@peaket.test') }]);
    // 탈퇴 유예에서 돌아온 계정은 이음이 끝난 뒤에도 새 판으로 바꾼다(옛 판 값은 이미 지운 뒤라 두지 않는다)
    t.sessions.setStatus(late.accountId, 'ACTIVE');
    t.clock.advance(40 * DAY);
    expect(await new RotateContactRefs(t.sessions, newOnly, bridges, t.clock).run(10)).toBe(1);
    expect(t.sessions.contactRowsOf(late.accountId)).toEqual([{ kind: 'EMAIL', ref: ref(C2, 2, 'r6@peaket.test'), refPrev: null }]);
  });

  test('다시검토중간1_이음안에다시본인확인하지않은PHONE행은이음끝뒤다시본인확인해도옛판값을새로두지않는다', async () => {
    const t = await setup();
    const k = await kit(t.sessions, { clock: t.clock, invRefs: t.oldRing });
    const a = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-ph-late', email: null, deviceId: null });
    await t.verify(t.oldRing, a.accountId, '010-1111-2222', 'FIRST');
    t.clock.advance(31 * DAY);
    await t.verify(t.bridged, a.accountId, '010-1111-2222', 'REVERIFY');
    expect(t.verifications.phoneRowOf(a.accountId)).toEqual({ ref: ref(C2, 2, '+821011112222'), refPrev: null });
  });

  test('다시검토낮음3_EMAIL다시계산은묶음상한까지만돈다', async () => {
    const t = await setup();
    const k = await kit(t.sessions, { clock: t.clock, invRefs: t.oldRing });
    for (let i = 0; i < 3; i++) {
      t.clock.advance(1);
      await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `k-cap-${i}`, email: `cap${i}@peaket.test`, deviceId: null });
    }
    expect(await new RotateContactRefs(t.sessions, t.bridged, t.bridged, t.clock).run(1, 2)).toBe(2);
    expect(await new RotateContactRefs(t.sessions, t.bridged, t.bridged, t.clock).run(1, 2)).toBe(1);
  });
});

