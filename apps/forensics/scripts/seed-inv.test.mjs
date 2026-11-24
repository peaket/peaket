// 조사 갈래 시험 시드 시험(docs/features/forensic-replay.md §5.5, docs/streaming.md §10 ST-T21·ST-T24, F-04-10).
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInvSeed } from './seed-inv.mjs';

const args = {
  seed: 'seed-A',
  eventId: '11111111-1111-7111-8111-111111111111',
  performanceDate: '2026-12-01',
  seats: 1_000,
  queueSize: 200,
  windowMs: 120_000,
  botRatio: 0.1,
};
const seed = buildInvSeed(args);

test('ST-T21 ⑪ 시드가 같은 생성기 시드로 같은 inv 행을 만들고 심어 둔 묶음을 넣는다', () => {
  const again = buildInvSeed({ ...args });
  assert.equal(JSON.stringify(again), JSON.stringify(seed));
  assert.notEqual(JSON.stringify(buildInvSeed({ ...args, seed: 'seed-B' })), JSON.stringify(seed));
  assert.ok(seed.stats.sessions > 0);
  // 9개 계정이 같은 결제 수단으로 27장
  assert.equal(seed.bundles.paymentNine.accountIds.length, 9);
  assert.equal(seed.bundles.paymentNine.saleCount, 27);
  const payLinks = seed.links.filter((l) => l.kind === 'PAYMENT_METHOD' && l.value === seed.bundles.paymentNine.paymentRef);
  assert.equal(new Set(payLinks.map((l) => l.account_id)).size, 9);
  // 입장 토큰 없이 홀드한 계정 하나: QUEUE_ENTER·ADMIT 없이 HOLD_TRY만
  const bypass = seed.bundles.bypass.accountId;
  const steps = seed.steps.filter((s) => s.account_id === bypass);
  assert.ok(steps.map((s) => s.step).includes('HOLD_TRY'));
  assert.ok(!steps.map((s) => s.step).includes('ADMIT'));
  assert.ok(!steps.map((s) => s.step).includes('QUEUE_ENTER'));
  // 가족 두 계정은 같은 연락처, 이동통신 같은 IP 50개는 OTHER, 행동만 비슷한 10개, 약한 결제 연결 둘
  assert.equal(seed.bundles.family.accountIds.length, 2);
  const contacts = seed.links.filter((l) => l.kind === 'CONTACT' && l.value === seed.bundles.family.contactRef);
  assert.deepEqual(new Set(contacts.map((l) => l.account_id)), new Set(seed.bundles.family.accountIds));
  assert.equal(seed.bundles.mobile.accountIds.length, 50);
  const mobile = seed.requests.filter((r) => seed.bundles.mobile.accountIds.includes(r.account_id));
  assert.ok(mobile.every((r) => r.ip === seed.bundles.mobile.ip && r.net_class === 'OTHER'));
  assert.equal(seed.bundles.similarBehavior.accountIds.length, 10);
  assert.equal(seed.behaviors.filter((b) => seed.bundles.similarBehavior.pids.includes(b.pid)).length, 10);
  assert.equal(seed.bundles.weakPair.accountIds.length, 2);
  const weak = seed.links.filter((l) => l.kind === 'PAYMENT_METHOD' && l.value === seed.bundles.weakPair.paymentRef);
  assert.deepEqual(new Set(weak.map((l) => l.account_id)), new Set(seed.bundles.weakPair.accountIds));
});

test('ST-T24 ⑥ 시드 회차의 retain_until이 공연일 + 30일이다', () => {
  const retain = '2026-12-31T00:00:00.000Z';
  for (const row of [...seed.requests, ...seed.steps, ...seed.behaviors, ...seed.links]) {
    assert.equal(row.retain_until, retain);
    assert.equal(row.event_id, args.eventId);
  }
  assert.deepEqual(new Set(seed.steps.map((s) => s.ingested_at)), new Set(['2026-12-01T09:00:00.000Z']));
});
