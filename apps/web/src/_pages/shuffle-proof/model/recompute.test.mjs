// SCR-019 내 순번 다시 계산(ADR-0232 결정 9): 파이썬 참조 구현이 만든 기준값(packages/shuffle/test/vectors.json)과 바이트까지 같아야 한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { collectEntries, commitmentHex, EMERGENCY_BEACON_HEX, merkleRootHex, recomputeOrder, verifyEmergencyRank, verifyRank } from './recompute.ts';

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../../../packages/shuffle/test/vectors.json', import.meta.url)), 'utf8'));
const sorted = [...vectors.tokens].sort();

test('FR-038 머클 루트가 참조 구현과 같다', async () => {
  assert.equal(await merkleRootHex(sorted), vectors.merkleRoot);
  assert.equal(await merkleRootHex([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('FR-038 POL-005 시드·비콘·머클 루트로 만든 셔플이 참조 구현과 같다', async () => {
  const order = await recomputeOrder({ eventId: vectors.event, seedHex: vectors.seed, beaconHex: vectors.beacon, sortedTokens: sorted, rootHex: vectors.merkleRoot });
  assert.deepEqual(order, vectors.shuffled);
});

test('POL-005 16진이 아닌 값은 0으로 바꾸지 않고 거절한다', async () => {
  await assert.rejects(commitmentHex('e', 'zz'.repeat(32)));
  await assert.rejects(commitmentHex('e', 'abc'));
  await assert.rejects(merkleRootHex(['zz'.repeat(32)]));
});

test('POL-005 커밋은 참조 구현과 같은 식이다', async () => {
  assert.equal(await commitmentHex(vectors.event, vectors.seed), vectors.commitment);
});

/** 비콘 값 = SHA-256(서명)인 일관된 입력을 만든다(순서는 위 시험이 참조 구현과 견준다) */
async function consistent() {
  const signatureHex = 'ab'.repeat(48);
  const beaconHex = createHash('sha256').update(Buffer.from(signatureHex, 'hex')).digest('hex');
  const order = await recomputeOrder({ eventId: vectors.event, seedHex: vectors.seed, beaconHex, sortedTokens: sorted, rootHex: vectors.merkleRoot });
  const entries = Object.fromEntries(order.map((h, i) => [h, 100 + i]));
  return { eventId: vectors.event, seedHex: vectors.seed, commitHex: vectors.commitment, signatureHex, beaconHex, merkleRootHex: vectors.merkleRoot, firstSeq: 100, tokenHash: order[3], entries };
}

test('POL-005 커밋·비콘·머클 루트가 모두 맞으면 내 순번을 다시 계산한다', async () => {
  assert.deepEqual(await verifyRank(await consistent()), { commitMatches: true, beaconMatches: true, rootMatches: true, fileSeq: 103, recomputedSeq: 103 });
});

test('POL-005 시드가 커밋과 다르면 다시 계산하지 않는다(비콘을 본 뒤 고른 시드를 막는다)', async () => {
  const r = await verifyRank({ ...(await consistent()), commitHex: 'f'.repeat(64) });
  assert.equal(r.commitMatches, false);
  assert.equal(r.recomputedSeq, null);
});

test('POL-005 비콘 값이 SHA-256(서명)과 다르면 다시 계산하지 않는다', async () => {
  const r = await verifyRank({ ...(await consistent()), signatureHex: 'cd'.repeat(48) });
  assert.equal(r.beaconMatches, false);
  assert.equal(r.recomputedSeq, null);
});

test('POL-005 파일에서 참가자가 빠지면 머클 루트가 달라 일치로 내지 않는다', async () => {
  const c = await consistent();
  const without = Object.fromEntries(Object.entries(c.entries).filter(([h]) => h !== sorted[0]));
  const r = await verifyRank({ ...c, entries: without, tokenHash: Object.keys(without)[0] });
  assert.equal(r.rootMatches, false);
  assert.equal(r.recomputedSeq, null);
});

/** 고정 비콘으로 섞은 결과 파일을 흉내 낸다(서명은 없다) */
async function emergencyInput() {
  const order = await recomputeOrder({ eventId: vectors.event, seedHex: vectors.seed, beaconHex: EMERGENCY_BEACON_HEX, sortedTokens: sorted, rootHex: vectors.merkleRoot });
  const entries = Object.fromEntries(order.map((h, i) => [h, 100 + i]));
  return { eventId: vectors.event, seedHex: vectors.seed, commitHex: vectors.commitment, merkleRootHex: vectors.merkleRoot, firstSeq: 100, tokenHash: order[3], entries };
}

test('Q-T27 POL-005 비상 셔플의 고정 비콘은 SHA-256("PEAKET-shuffle-v1-no-beacon")이고 참조 구현과 같다', () => {
  assert.equal(EMERGENCY_BEACON_HEX, createHash('sha256').update('PEAKET-shuffle-v1-no-beacon', 'utf8').digest('hex'));
  assert.equal(EMERGENCY_BEACON_HEX, vectors.emergency.beacon);
});

test('Q-T27 POL-005 고정 비콘으로 다시 계산한 순서가 파이썬 참조 구현과 같다', async () => {
  const order = await recomputeOrder({ eventId: vectors.event, seedHex: vectors.seed, beaconHex: EMERGENCY_BEACON_HEX, sortedTokens: sorted, rootHex: vectors.merkleRoot });
  assert.deepEqual(order, vectors.emergency.shuffled);
});

test('Q-T27 POL-005 비상 셔플은 서명 없이 커밋·머클 루트를 대조해 내 순번을 다시 계산한다', async () => {
  assert.deepEqual(await verifyEmergencyRank(await emergencyInput()), { commitMatches: true, beaconMatches: true, rootMatches: true, fileSeq: 103, recomputedSeq: 103 });
});

test('Q-T27 POL-005 결과 파일의 번호가 1 이상의 안전한 정수가 아니면 없는 것으로 본다', async () => {
  const input = await emergencyInput();
  for (const value of ['103', '머클 루트 불일치', 0, -1, 1.5, 2 ** 53, null, {}]) {
    const r = await verifyEmergencyRank({ ...input, entries: { ...input.entries, [input.tokenHash]: value } });
    assert.equal(r.fileSeq, null, String(value));
  }
});

test('Q-T27 POL-005 비상 셔플도 시드가 커밋과 다르거나 참가자가 빠지면 다시 계산하지 않는다', async () => {
  const bad = await verifyEmergencyRank({ ...(await emergencyInput()), commitHex: 'f'.repeat(64) });
  assert.equal(bad.commitMatches, false);
  assert.equal(bad.recomputedSeq, null);
  const input = await emergencyInput();
  const without = Object.fromEntries(Object.entries(input.entries).filter(([h]) => h !== sorted[0]));
  const r = await verifyEmergencyRank({ ...input, entries: without, tokenHash: Object.keys(without)[0] });
  assert.equal(r.rootMatches, false);
  assert.equal(r.recomputedSeq, null);
});

test('FR-038 결과 파일 4,096개를 모아 합치고, 파일이 하나라도 없으면 던진다', async () => {
  const urls = [];
  const fetchFile = async (url) => {
    urls.push(url);
    return url.endsWith('/000.json') ? { status: 200, body: { aa: 1 } } : url.endsWith('/fff.json') ? { status: 200, body: { bb: 2 } } : { status: 200, body: {} };
  };
  const entries = await collectEntries('https://f.example/v1/queues/e/shuffle-results/', 4096, fetchFile);
  assert.deepEqual(entries, { aa: 1, bb: 2 });
  assert.equal(urls.length, 4096);
  await assert.rejects(collectEntries('https://f.example/', 4096, async (u) => (u.endsWith('/0ab.json') ? { status: 404 } : { status: 200, body: {} })));
});
