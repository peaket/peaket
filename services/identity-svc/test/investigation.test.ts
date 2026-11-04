// 부정 예매 조사용 값(docs/features/identity.md §9.1 '조사용 값의 첫 구현', BUILD_ORDER BOT-045, I-T63·I-T64·I-T67, ADR-0171).
// 라벨 키 링(10분 캐시·축소 동작), 기기·연락처 가명, ComputeContactRef·BatchGetInvestigationRefs를 메모리 저장소와 가짜 KMS로 본다. PostgreSQL·KMS 흉내 서버는 test-int/investigation.int.test.ts.
import { createHmac } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { InvRefKeyRing } from '../src/modules/session/adapters/inv-ref-key-ring.js';
import { MemoryMergeProposals } from '../src/modules/session/adapters/memory-merge-proposals.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { AddProvider } from '../src/modules/session/application/add-provider.js';
import { BackfillContactRefs } from '../src/modules/session/application/backfill-contact-refs.js';
import { ComputeContactRef } from '../src/modules/session/application/compute-contact-ref.js';
import { ConfirmMerge } from '../src/modules/session/application/confirm-merge.js';
import { GetInvestigationRefs } from '../src/modules/session/application/get-investigation-refs.js';
import { InvRefError } from '../src/modules/session/application/inv-ref-error.js';
import { MergePlanner } from '../src/modules/session/application/plan-merge.js';
import { contactEmail, invRef, labelKeyMessage, toE164 } from '../src/modules/session/domain/inv-ref.js';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { noBlockChecker } from '../src/modules/session/adapters/grpc-merge-checkers.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { phoneContactRefs } from '../src/modules/session/adapters/phone-contact-refs.js';
import { agencyResult, ISSUER, kit, newKey, testAgency } from './support.js';

const DEVICE_KEY = Buffer.alloc(32, 7);
const CONTACT_KEY = Buffer.alloc(32, 9);
const expectRef = (key: Buffer, v: number, value: string) => `k${v}.${createHmac('sha256', key).update(value, 'utf8').digest('base64url')}`;

/** KMS GenerateMac 대역: 키 ID마다 뿌리 키로 HMAC한다. fail이 있으면 그 오류를 던진다 */
function fakeKms() {
  const roots: Record<string, Buffer> = { 'kms-device': Buffer.alloc(32, 1), 'kms-contact': Buffer.alloc(32, 2) };
  const calls: string[] = [];
  const k = {
    calls,
    roots,
    fail: undefined as Error | undefined,
    async mac(keyId: string, message: Uint8Array) {
      calls.push(`${keyId}|${Buffer.from(message).toString('utf8')}`);
      if (k.fail) throw k.fail;
      return createHmac('sha256', roots[keyId]!).update(message).digest();
    },
  };
  return k;
}

describe('계산식과 맞추기(§9.1)', () => {
  test('invRef는_k판번호점과_base64urlHMAC이고_라벨키는PEAKET-inv-ref-v1과라벨을KMS로MAC한값이다', () => {
    expect(invRef(DEVICE_KEY, 3, 'dev-1')).toBe(expectRef(DEVICE_KEY, 3, 'dev-1'));
    expect(Buffer.from(labelKeyMessage('contact')).toString('utf8')).toBe('PEAKET-inv-ref-v1|contact');
  });

  test('I-T64_이메일은소문자·앞뒤빈칸을빼고_휴대폰은E164로맞춘다', () => {
    expect(contactEmail('  Fan@Example.com ')).toBe('fan@example.com');
    expect(contactEmail('   ')).toBeNull();
    expect(contactEmail(null)).toBeNull();
    expect(toE164('010-1234-5678')).toBe('+821012345678');
    expect(toE164('+82 10 1234 5678')).toBe('+821012345678');
    expect(toE164('01012345678')).toBe('+821012345678');
    expect(toE164('+1 415 555 0100')).toBe('+14155550100');
    // 국제 표기에 국내 앞자리 0이 남은 모양도 같은 값으로(새 맥락 리뷰 낮음 7)
    expect(toE164('+82 010-1234-5678')).toBe('+821012345678');
    // 국제전화 앞자리 00으로 쓴 모양(다시 검토 낮음 7)
    expect(toE164('0082 10-1234-5678')).toBe('+821012345678');
    expect(toE164('0082 010-1234-5678')).toBe('+821012345678');
    expect(toE164('1234')).toBeNull();
    expect(toE164('010-1234-567a')).toBeNull();
  });
});

describe('라벨 키 링(10분 캐시와 축소 동작)', () => {
  test('KMS로라벨키를받아메모리에두고값마다KMS를부르지않으며_10분이지나도다시받지못하면칸을비우고까닭을센다', async () => {
    const clock = fakeClock({ now: Date.parse('2026-11-04T00:00:00Z') });
    const kms = fakeKms();
    const missing: string[] = [];
    const ring = new InvRefKeyRing({ sources: [{ label: 'device', version: 2, kmsKeyId: 'kms-device' }, { label: 'contact', version: 1, kmsKeyId: 'kms-contact' }], client: kms, clock, onMissing: (l, r) => missing.push(`${l}:${r}`) });
    // 받기 전에는 비고 센다(시작은 기다리지 않는다)
    expect(ring.ref('device', 'd1')).toBeUndefined();
    await ring.refresh();
    const labelKey = createHmac('sha256', kms.roots['kms-device']!).update('PEAKET-inv-ref-v1|device').digest();
    expect(ring.ref('device', 'd1')).toBe(expectRef(labelKey, 2, 'd1'));
    expect(ring.ref('device', 'd2')).toBeDefined();
    expect(kms.calls).toEqual(['kms-device|PEAKET-inv-ref-v1|device', 'kms-contact|PEAKET-inv-ref-v1|contact']);
    // 다시 받지 못해도 받은 지 10분까지는 쓴다
    kms.fail = Object.assign(new Error('rate'), { name: 'ThrottlingException' });
    clock.advance(9 * 60_000);
    await ring.refresh();
    expect(ring.ref('device', 'd1')).toBe(expectRef(labelKey, 2, 'd1'));
    clock.advance(60_000 + 1);
    expect(ring.ref('device', 'd1')).toBeUndefined();
    kms.fail = new Error('down');
    await ring.refresh();
    expect(ring.ref('contact', 'x')).toBeUndefined();
    expect(missing).toEqual(['device:KMS_ERROR', 'device:THROTTLED', 'contact:KMS_ERROR']);
    kms.fail = undefined;
    await ring.refresh();
    expect(ring.ref('contact', 'x')).toBeDefined();
  });

  test('로컬·CI는라벨키값을바로받고_KMS주소는local·ci에서만_설정이없는라벨은늘비며세지않고경고한다', () => {
    const { ring, warnings } = InvRefKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: DEVICE_KEY.toString('base64') }, fakeClock({ now: 0 }));
    const missing: string[] = [];
    ring.onMissing((l, r) => missing.push(`${l}:${r}`));
    expect(ring.ref('device', 'd1')).toBe(expectRef(DEVICE_KEY, 1, 'd1'));
    expect(ring.ref('contact', 'x')).toBeUndefined();
    expect(missing).toEqual([]);
    expect(warnings.join(' ')).toMatch(/PEAKET_INV_REF_CONTACT/);
    expect(() => InvRefKeyRing.fromEnv({ PEAKET_ENV: 'prod', PEAKET_INV_REF_DEVICE_KEY: DEVICE_KEY.toString('base64') }, fakeClock({ now: 0 }))).toThrow(/local·ci/);
    expect(() => InvRefKeyRing.fromEnv({ PEAKET_ENV: 'prod', PEAKET_INV_REF_DEVICE_KMS_KEY: 'k', PEAKET_KMS_ENDPOINT: 'http://x' }, fakeClock({ now: 0 }))).toThrow(/PEAKET_KMS_ENDPOINT/);
    expect(() => InvRefKeyRing.fromEnv({ PEAKET_ENV: 'prod', PEAKET_INV_REF_DEVICE_KMS_KEY: 'alias/x' }, fakeClock({ now: 0 }))).toThrow(/별칭/);
    // 라벨마다 다른 KMS 키다(같으면 두 라벨 값이 이어진다, 새 맥락 리뷰 낮음 6)
    expect(() => InvRefKeyRing.fromEnv({ PEAKET_ENV: 'prod', PEAKET_INV_REF_DEVICE_KMS_KEY: 'arn:aws:kms:ap-northeast-2:1:key/same', PEAKET_INV_REF_CONTACT_KMS_KEY: 'same' }, fakeClock({ now: 0 }), () => fakeKms())).toThrow(/다른 KMS 키/);
    // relay처럼 라벨을 골라 받는다(기기 라벨 키를 갖지 않게, 새 맥락 리뷰 낮음 5)
    const only = InvRefKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: DEVICE_KEY.toString('base64'), PEAKET_INV_REF_CONTACT_KEY: CONTACT_KEY.toString('base64') }, fakeClock({ now: 0 }), undefined, ['contact']);
    expect(only.ring.ref('device', 'd1')).toBeUndefined();
    expect(only.ring.ref('contact', 'x')).toBe(expectRef(CONTACT_KEY, 1, 'x'));
  });
});

/** 기기·연락처 라벨 키가 고정인 링 */
const fixedRing = () => new InvRefKeyRing({ sources: [{ label: 'device', version: 1, key: DEVICE_KEY }, { label: 'contact', version: 1, key: CONTACT_KEY }], clock: fakeClock({ now: 0 }) });

async function setup(o: { contactKey?: boolean } = {}) {
  const sessions = new MemorySessionStore();
  const ring = o.contactKey === false ? new InvRefKeyRing({ sources: [{ label: 'device', version: 1, key: DEVICE_KEY }], clock: fakeClock({ now: 0 }) }) : fixedRing();
  const k = await kit(sessions, { invRefs: ring });
  const login = (provider: 'kakao' | 'naver' | 'google', sub: string, email: string | null = null, deviceId: string | null = null) =>
    k.create.run({ idempotencyKey: newKey(), provider, providerUserId: sub, email, emailVerified: email !== null, deviceId });
  return { sessions, k, ring, login };
}

describe('기기·연락처 가명 쓰기(I-T63·I-T64)', () => {
  test('I-T63_로그인기기행은기기라벨키의invRef이고_I-T64가입이메일은맞춘값의EMAIL행이다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-a', '  Fan@Example.com ', 'dev-1');
    expect(t.sessions.devicesOf(a.accountId)).toEqual([expectRef(DEVICE_KEY, 1, 'dev-1')]);
    expect(t.sessions.contactRefsOf(a.accountId)).toEqual([{ kind: 'EMAIL', ref: expectRef(CONTACT_KEY, 1, 'fan@example.com') }]);
    // 이메일 없는 가입은 행이 없다
    const b = await t.login('naver', 'n-b');
    expect(t.sessions.contactRefsOf(b.accountId)).toEqual([]);
  });

  test('I-T64⑤_탈퇴로계정을지우면연락처가명행이없고_병합은흡수계정의행을지운다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-e', 'a@peaket.test');
    await t.sessions.transaction((tx) => tx.eraseAccount(a.accountId, t.k.clock.now()));
    expect(t.sessions.contactRefsOf(a.accountId)).toEqual([]);
    // 병합
    const x = await t.login('kakao', 'k-x', 'x@peaket.test');
    const y = await t.login('google', 'g-y', 'y@peaket.test');
    const reauth = new JoseReauthVerifier(t.k.keys, ISSUER, t.k.clock);
    const proposals = new MemoryMergeProposals(t.k.clock);
    const planner = new MergePlanner(t.sessions, { pidsOf: async () => [] }, (['purchase', 'ticket', 'core'] as const).map(noBlockChecker), proposals, t.k.clock);
    const token = async () => (await t.k.signer.reauth({ accountId: x.accountId, sessionId: x.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, t.k.clock.now())).token;
    const r = await new AddProvider(t.sessions, reauth, t.k.clock, planner).add({ accountId: x.accountId, sessionId: x.sessionId, reauthToken: await token(), provider: 'google', providerUserId: 'g-y' });
    await new ConfirmMerge(t.sessions, reauth, planner, proposals, t.k.clock).run({ accountId: x.accountId, sessionId: x.sessionId, proposalId: r.mergeProposalId!, reauthToken: await token() });
    expect(t.sessions.contactRefsOf(y.accountId)).toEqual([]);
    expect(t.sessions.contactRefsOf(x.accountId)).toHaveLength(1);
  });

  test('연락처라벨키가없어쓰지못한EMAIL행은_정비가account.email로다시계산한다', async () => {
    const t = await setup({ contactKey: false });
    const a = await t.login('kakao', 'k-bf', 'Late@Peaket.test');
    expect(t.sessions.contactRefsOf(a.accountId)).toEqual([]);
    const done = await new BackfillContactRefs(t.sessions, fixedRing(), t.k.clock).run(100);
    expect(done).toBe(1);
    expect(t.sessions.contactRefsOf(a.accountId)).toEqual([{ kind: 'EMAIL', ref: expectRef(CONTACT_KEY, 1, 'late@peaket.test') }]);
    expect(await new BackfillContactRefs(t.sessions, fixedRing(), t.k.clock).run(100)).toBe(0);
  });

  test('새맥락리뷰중간1_정비는묶음을넘어끝까지돌고_맞출수없는이메일이앞을막지않으며_탈퇴유예계정에는새가명을만들지않는다', async () => {
    const t = await setup({ contactKey: false });
    // 맞출 수 없는 이메일(빈칸뿐)을 가진 계정이 ID 순서 앞에 묶음 크기보다 많이 있어도(가짜 시계라 먼저 만든 계정의 ID가 앞이다, 다시 검토 중간 2)
    const blanks: string[] = [];
    for (let i = 0; i < 3; i++) {
      t.k.clock.advance(1);
      blanks.push((await t.login('kakao', `k-blank-${i}`, '   ')).accountId);
    }
    const made: string[] = [];
    for (let i = 0; i < 7; i++) {
      t.k.clock.advance(1);
      made.push((await t.login('kakao', `k-many-${i}`, `m${i}@peaket.test`)).accountId);
    }
    const pending = await t.login('kakao', 'k-pend', 'p@peaket.test');
    t.sessions.setStatus(pending.accountId, 'WITHDRAWAL_PENDING');
    // 한 묶음 2개로도 모두 채운다
    expect(await new BackfillContactRefs(t.sessions, fixedRing(), t.k.clock).run(2)).toBe(7);
    for (const id of made) expect(t.sessions.contactRefsOf(id)).toHaveLength(1);
    for (const id of blanks) expect(t.sessions.contactRefsOf(id)).toEqual([]);
    expect([...blanks].sort()).toEqual(blanks);
    expect(blanks[2]! < made[0]!).toBe(true);
    expect(t.sessions.contactRefsOf(pending.accountId)).toEqual([]);
  });

  test('다시검토낮음6_정비중에라벨키가없어지면그자리에서멈추고_채운수를돌려준다', async () => {
    const t = await setup({ contactKey: false });
    for (let i = 0; i < 6; i++) await t.login('kakao', `k-stop-${i}`, `s${i}@peaket.test`);
    let calls = 0;
    const flaky = { ref: (_l: 'device' | 'contact', v: string) => (++calls <= 3 ? `k1.${v}` : undefined) };
    expect(await new BackfillContactRefs(t.sessions, flaky, t.k.clock).run(2)).toBe(3);
    expect(calls).toBe(4);
  });
});

describe('ComputeContactRef(purchase-svc의 예매자 번호)', () => {
  test('I-T64②_E164번호의연락처가명을돌려주고_모양이틀리면INVALID_라벨키가없으면UNAVAILABLE_초당상한을넘으면EXHAUSTED다', () => {
    const clock = fakeClock({ now: 0 });
    const c = new ComputeContactRef(fixedRing(), clock, 2);
    expect(c.run('+821012345678')).toBe(expectRef(CONTACT_KEY, 1, '+821012345678'));
    const code = (f: () => unknown) => {
      try {
        f();
        return 'OK';
      } catch (e) {
        return e instanceof InvRefError ? e.code : 'OTHER';
      }
    };
    expect(code(() => c.run('010-1234-5678'))).toBe('INVALID');
    // +82 뒤에 국내 앞자리 0이 남은 값은 E.164가 아니다(같은 번호가 다른 가명이 되지 않게, 다시 검토 중간 1)
    expect(code(() => c.run('+8201012345678'))).toBe('INVALID');
    expect(code(() => c.run('+82101234'))).toBe('OK');
    expect(code(() => c.run('+821012345679'))).toBe('EXHAUSTED');
    clock.advance(1_000);
    expect(code(() => c.run('+821012345679'))).toBe('OK');
    const none = new ComputeContactRef(new InvRefKeyRing({ sources: [], clock }), clock, 10);
    expect(code(() => none.run('+821012345678'))).toBe('UNAVAILABLE');
  });
});

describe('BatchGetInvestigationRefs(조사 적재)', () => {
  test('I-T67①_계정마다연락처·기기가명을주고_탈퇴한계정은빈항목_없는계정은빼며_500개를넘거나모양이틀리면INVALID다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-i', 'i@peaket.test', 'dev-i1');
    await t.login('kakao', 'k-i', null, 'dev-i2');
    const gone = await t.login('google', 'g-gone', 'g@peaket.test', 'dev-g');
    await t.sessions.transaction((tx) => tx.eraseAccount(gone.accountId, t.k.clock.now()));
    const q = new GetInvestigationRefs(t.sessions, t.k.clock);
    const missingId = '0190f3a1-7c2e-7a00-8000-0000000000ff';
    const items = await q.run([a.accountId, gone.accountId, missingId]);
    expect(items).toEqual([
      { accountId: a.accountId, contactRefs: [{ kind: 'EMAIL', ref: expectRef(CONTACT_KEY, 1, 'i@peaket.test') }], deviceRefs: [expectRef(DEVICE_KEY, 1, 'dev-i1'), expectRef(DEVICE_KEY, 1, 'dev-i2')], identityConflicts: [] },
      { accountId: gone.accountId, contactRefs: [], deviceRefs: [], identityConflicts: [] },
    ]);
    await expect(q.run(['nope'])).rejects.toBeInstanceOf(InvRefError);
    // 물은 모양 그대로 돌려준다(대문자로 물으면 대문자, 새 맥락 리뷰 낮음 9)
    expect((await q.run([a.accountId.toUpperCase()])).map((x) => x.accountId)).toEqual([a.accountId.toUpperCase()]);
    await expect(q.run(Array.from({ length: 501 }, () => a.accountId))).rejects.toBeInstanceOf(InvRefError);
  });
});

describe('본인확인 번호의 PHONE 연락처 가명(I-T64)', () => {
  test('I-T64①④②_본인확인결과번호를E164로맞춘PHONE행이고_다시본인확인해번호가바뀌면값을바꾸며_ComputeContactRef의예매자번호값과같다_번호원문은두지않는다', async () => {
    const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') });
    const sessions = new MemorySessionStore();
    const verifications = new MemoryVerificationStore();
    const closure = new CloseAccount(sessions, clock);
    const ring = fixedRing();
    const k = await kit(sessions, { clock, invRefs: ring });
    const provider = testAgency(clock);
    const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
    const verify = async (accountId: string, person: string, phone: string | undefined, purpose: 'FIRST' | 'REVERIFY' = 'FIRST') => {
      const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId: null, purpose, next: '/' });
      await new ConfirmVerification(verifications, provider, hashers, closure, clock, phoneContactRefs(ring)).run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person, phone }) });
    };
    const a = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-ph', email: null, deviceId: null });
    await verify(a.accountId, 'ph-person', '010-1234-5678');
    expect(verifications.contactRefsOf(a.accountId)).toEqual([{ kind: 'PHONE', ref: expectRef(CONTACT_KEY, 1, '+821012345678') }]);
    // 다른 계정 주문의 예매자 번호(+82 10 1234 5678을 purchase-svc가 E.164로 맞춘 값)와 같은 값이다
    expect(new ComputeContactRef(ring, clock, 10).run('+821012345678')).toBe(verifications.contactRefsOf(a.accountId)[0]!.ref);
    clock.advance(60_000);
    await verify(a.accountId, 'ph-person', '010-9999-0000', 'REVERIFY');
    expect(verifications.contactRefsOf(a.accountId)).toEqual([{ kind: 'PHONE', ref: expectRef(CONTACT_KEY, 1, '+821099990000') }]);
    // 번호가 없거나 모양이 틀리면 행을 바꾸지 않는다
    clock.advance(60_000);
    await verify(a.accountId, 'ph-person', 'not-a-number', 'REVERIFY');
    expect(verifications.contactRefsOf(a.accountId)).toEqual([{ kind: 'PHONE', ref: expectRef(CONTACT_KEY, 1, '+821099990000') }]);
    // 다른 사람의 본인확인(같은 계정, FAILED)은 번호를 쓰지 않는다
    clock.advance(60_000);
    await verify(a.accountId, 'someone-else', '010-5555-5555', 'REVERIFY');
    expect(verifications.contactRefsOf(a.accountId)[0]!.ref).toBe(expectRef(CONTACT_KEY, 1, '+821099990000'));
  });
});

describe('받는 층(gRPC)', () => {
  test('ComputeContactRef는contact_ref를주고_모양INVALID_ARGUMENT_라벨키없음UNAVAILABLE_상한RESOURCE_EXHAUSTED다_BatchGet은종류열거와Timestamp로옮긴다', async () => {
    const { contactRefHandlers, investigationRefHandlers } = await import('../src/modules/session/inbound/session.grpc.js');
    const clock = fakeClock({ now: 0 });
    type H = Record<string, (call: { request: Record<string, unknown> }, cb: (e: unknown, v?: unknown) => void) => void>;
    const errors: string[] = [];
    const call = (h: H, m: string, request: Record<string, unknown>) => new Promise<{ e: unknown; v: unknown }>((res) => h[m]!({ request }, (e, v) => res({ e, v })));
    const c = contactRefHandlers({ compute: new ComputeContactRef(fixedRing(), clock, 1) }, (m) => errors.push(m)) as H;
    expect((await call(c, 'ComputeContactRef', { phone_e164: '+821012345678' })).v).toEqual({ contact_ref: expectRef(CONTACT_KEY, 1, '+821012345678') });
    expect(((await call(c, 'ComputeContactRef', { phone_e164: '+821012345678' })).e as { code: number }).code).toBe(8);
    expect(((await call(c, 'ComputeContactRef', { phone_e164: '010' })).e as { code: number }).code).toBe(3);
    const none = contactRefHandlers({ compute: new ComputeContactRef(new InvRefKeyRing({ sources: [], clock }), clock, 10) }, (m) => errors.push(m)) as H;
    expect(((await call(none, 'ComputeContactRef', { phone_e164: '+821012345678' })).e as { code: number }).code).toBe(14);
    const at = Date.parse('2026-11-01T00:00:00.250Z');
    const i = investigationRefHandlers(
      { refs: { run: async () => [{ accountId: 'a', contactRefs: [{ kind: 'PHONE' as const, ref: 'k1.p' }, { kind: 'EMAIL' as const, ref: 'k1.e' }], deviceRefs: ['k1.d'], identityConflicts: [{ otherAccountId: 'b', attemptedAt: at }] }] } },
      (m) => errors.push(m),
    ) as H;
    expect((await call(i, 'BatchGetInvestigationRefs', { account_ids: ['a'] })).v).toEqual({
      items: [
        {
          account_id: 'a',
          contact_refs: [
            { kind: 'CONTACT_REF_KIND_PHONE', ref: 'k1.p' },
            { kind: 'CONTACT_REF_KIND_EMAIL', ref: 'k1.e' },
          ],
          device_refs: ['k1.d'],
          identity_conflicts: [{ other_account_id: 'b', attempted_at: { seconds: Math.floor(at / 1000), nanos: 250_000_000 } }],
        },
      ],
    });
    const bad = investigationRefHandlers({ refs: new GetInvestigationRefs(new MemorySessionStore(), clock) }, (m) => errors.push(m)) as H;
    expect(((await call(bad, 'BatchGetInvestigationRefs', { account_ids: ['x'] })).e as { code: number }).code).toBe(3);
    expect(errors).toEqual([]);
  });
});

