// 조사용 가명 키 회전의 이음 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §9.1 '조사용 가명 키 회전 이음의 첫 구현', BUILD_ORDER BOT-046, I-T73).
// 마이그레이션 0015(ref_prev), 기기 행 새 판으로 바꾸기·정비 다시 계산·조회의 두 판 싣기·이음 닫기의 실제 SQL을 돈다. 라벨 키는 로컬 값(KMS 경로는 investigation.int.test.ts).
import { createHmac } from 'node:crypto';
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleSessionStore } from '../src/modules/session/adapters/db/drizzle-session-store.js';
import { InvRefKeyRing } from '../src/modules/session/adapters/inv-ref-key-ring.js';
import { phoneContactRefs } from '../src/modules/session/adapters/phone-contact-refs.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { CloseInvRefBridge, INV_REF_BRIDGE_GRACE_MS } from '../src/modules/session/application/close-inv-ref-bridge.js';
import { GetInvestigationRefs } from '../src/modules/session/application/get-investigation-refs.js';
import { RotateContactRefs } from '../src/modules/session/application/rotate-contact-refs.js';
import { DrizzleVerificationStore } from '../src/modules/verification/adapters/db/drizzle-verification-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, kit, newKey, testAgency } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-05T00:00:00.000Z') });
const DAY = 86_400_000;
const D1 = Buffer.alloc(32, 11);
const D2 = Buffer.alloc(32, 12);
const C1 = Buffer.alloc(32, 13);
const C2 = Buffer.alloc(32, 14);
const ref = (key: Buffer, v: number, value: string) => `k${v}.${createHmac('sha256', key).update(value, 'utf8').digest('base64url')}`;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-inv-rotation-test', max: 8 });
  await ensureOutboxPartitions(database, clock);
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

test('I-T73_PostgreSQL에서_다시로그인은옛판기기행을새판으로바꾸고_정비는EMAIL을새판으로_다시본인확인은PHONE을두판으로_조회는두판을싣고_이음끝+7일뒤닫기는옛판을지운다', async () => {
  const sessions = new DrizzleSessionStore(database, clock);
  const verifications = new DrizzleVerificationStore(database);
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
  const verify = async (ring: InvRefKeyRing, accountId: string, purpose: 'FIRST' | 'REVERIFY') => {
    const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId: null, purpose, next: '/' });
    await new ConfirmVerification(verifications, provider, hashers, closure, clock, phoneContactRefs(ring)).run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person: 'pg-rot-person', phone: '010-4444-5555' }) });
  };
  // ① 옛 판(1)으로 기기 둘·EMAIL·PHONE 행
  const before = await kit(sessions, { clock, invRefs: oldRing });
  const login = (k: Awaited<ReturnType<typeof kit>>, deviceId: string, email: string | null = null) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-rot-1', email, deviceId });
  const a = await login(before, 'dev-again', 'Rot@Peaket.test');
  await login(before, 'dev-stale');
  await verify(oldRing, a.accountId, 'FIRST');
  // ② 새 판과 이음을 켠 뒤 같은 기기로 다시 로그인: 그 행이 새 판 값과 옛 판 대응을 갖는다(행이 늘지 않는다)
  const after = await kit(sessions, { clock, invRefs: bridged });
  await login(after, 'dev-again');
  expect(await q('select device_ref, device_ref_prev from device where account_id = $1 order by bound_at, id', [a.accountId])).toEqual(
    expect.arrayContaining([
      { device_ref: ref(D2, 2, 'dev-again'), device_ref_prev: ref(D1, 1, 'dev-again') },
      { device_ref: ref(D1, 1, 'dev-stale'), device_ref_prev: null },
    ]),
  );
  expect(await q('select 1 from device where account_id = $1', [a.accountId])).toHaveLength(2);
  // ③ 정비: EMAIL은 새 판·옛 판 대응, PHONE은 그대로
  expect(await new RotateContactRefs(sessions, bridged, bridged, clock).run(1)).toBe(1);
  expect(await q("select kind, ref, ref_prev from account_contact_ref where account_id = $1 order by kind desc", [a.accountId])).toEqual([
    { kind: 'PHONE', ref: ref(C1, 1, '+821044445555'), ref_prev: null },
    { kind: 'EMAIL', ref: ref(C2, 2, 'rot@peaket.test'), ref_prev: ref(C1, 1, 'rot@peaket.test') },
  ]);
  // ④ 다시 본인확인: PHONE이 두 판을 갖는다
  clock.advance(60_000);
  await verify(bridged, a.accountId, 'REVERIFY');
  expect(await q("select ref, ref_prev from account_contact_ref where account_id = $1 and kind = 'PHONE'", [a.accountId])).toEqual([{ ref: ref(C2, 2, '+821044445555'), ref_prev: ref(C1, 1, '+821044445555') }]);
  // ⑤ 조사 적재: 두 판 값을 함께 싣는다
  const [item] = await new GetInvestigationRefs(sessions, clock).run([a.accountId]);
  expect(new Set(item!.deviceRefs)).toEqual(new Set([ref(D2, 2, 'dev-again'), ref(D1, 1, 'dev-again'), ref(D1, 1, 'dev-stale')]));
  expect(new Set(item!.contactRefs.map((c) => `${c.kind}:${c.ref}`))).toEqual(
    new Set([`PHONE:${ref(C2, 2, '+821044445555')}`, `PHONE:${ref(C1, 1, '+821044445555')}`, `EMAIL:${ref(C2, 2, 'rot@peaket.test')}`, `EMAIL:${ref(C1, 1, 'rot@peaket.test')}`]),
  );
  // 이음 기간의 다른 계정(새 판 기기 행, 옛 판 기기 행 하나 더)
  const other = await kit(sessions, { clock, invRefs: bridged });
  const o = await other.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-rot-2', email: null, deviceId: 'dev-other-new' });
  await before.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-rot-3', email: null, deviceId: 'dev-other-stale' });
  // 옛 판 값을 주지 않고 판이 바뀌면 지금 값을 옛 판으로 둔다(SQL의 판 비교 갈래, 다시 검토 낮음 3)
  await sessions.transaction((tx) => tx.setContactRef({ accountId: o.accountId, kind: 'EMAIL', ref: 'k1.first', refPrev: null, now: clock.now() }));
  await sessions.transaction((tx) => tx.setContactRef({ accountId: o.accountId, kind: 'EMAIL', ref: 'k2.second', now: clock.now() }));
  expect(await q("select ref, ref_prev from account_contact_ref where account_id = $1 and kind = 'EMAIL'", [o.accountId])).toEqual([{ ref: 'k2.second', ref_prev: 'k1.first' }]);
  // 옛 판 값을 둔 행을 옛 판 없이 다시 써도 옛 판 값이 남는다(새 맥락 리뷰 중간 2)
  await sessions.transaction((tx) => tx.setContactRef({ accountId: a.accountId, kind: 'EMAIL', ref: ref(C2, 2, 'rot@peaket.test'), refPrev: null, now: clock.now() }));
  expect(await q("select ref_prev from account_contact_ref where account_id = $1 and kind = 'EMAIL'", [a.accountId])).toEqual([{ ref_prev: ref(C1, 1, 'rot@peaket.test') }]);
  // ⑥ 이음 끝 + 7일 뒤: 옛 판 값과 다시 로그인하지 않은 기기의 옛 판 행이 없다(묶음 1개씩 끝까지 지운다)
  clock.advance(30 * DAY + INV_REF_BRIDGE_GRACE_MS);
  const closed = await new CloseInvRefBridge(sessions, bridged, clock, 1).run();
  expect(closed.device).toMatchObject({ removed: 2 });
  expect(await q('select device_ref, device_ref_prev from device where account_id = $1', [a.accountId])).toEqual([{ device_ref: ref(D2, 2, 'dev-again'), device_ref_prev: null }]);
  expect(await q('select 1 from account_contact_ref where account_id = $1 and ref_prev is not null', [a.accountId])).toHaveLength(0);
  // 옛 판 행은 어느 계정에도 없고, 다른 계정의 새 판 기기 행은 그대로다
  expect(await q("select 1 from device where left(device_ref, 3) = 'k1.'")).toHaveLength(0);
  expect(await q('select device_ref from device where account_id = $1', [o.accountId])).toEqual([{ device_ref: ref(D2, 2, 'dev-other-new') }]);
});

test('다시검토중간1_PostgreSQL에서_이음안에다시본인확인하지않은PHONE행은이음끝뒤다시본인확인해도옛판값을두지않는다', async () => {
  const sessions = new DrizzleSessionStore(database, clock);
  const verifications = new DrizzleVerificationStore(database);
  const closure = new CloseAccount(sessions, clock);
  const until = clock.now() + 30 * DAY;
  const oldRing = new InvRefKeyRing({ sources: [{ label: 'contact', version: 1, key: C1 }], clock });
  const bridged = new InvRefKeyRing({ sources: [{ label: 'contact', version: 2, key: C2, previous: { version: 1, key: C1 }, bridgeUntil: until }], clock });
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  const k = await kit(sessions, { clock, invRefs: oldRing });
  const a = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'pg-rot-late', email: null, deviceId: null });
  const verify = async (ring: InvRefKeyRing, purpose: 'FIRST' | 'REVERIFY') => {
    const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId: a.accountId, sessionId: null, purpose, next: '/' });
    await new ConfirmVerification(verifications, provider, hashers, closure, clock, phoneContactRefs(ring)).run({ accountId: a.accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person: 'pg-rot-late-person', phone: '010-6666-7777' }) });
  };
  await verify(oldRing, 'FIRST');
  clock.advance(31 * DAY);
  await verify(bridged, 'REVERIFY');
  expect(await q("select ref, ref_prev from account_contact_ref where account_id = $1 and kind = 'PHONE'", [a.accountId])).toEqual([{ ref: ref(C2, 2, '+821066667777'), ref_prev: null }]);
});
