// SCR-019 내 순번 검증 흐름(d5 §5.19 ⑥, ADR-0232 결정 9): 내 구간 찾기 → 결과 파일 모으기 → 커밋·비콘·머클 루트 대조 → 다시 계산
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { commitmentHex, merkleRootHex, recomputeOrder } from './recompute.ts';
import { BLS_NOTE, estimateDownload, pickStoredToken, verifyToken } from './verify-flow.ts';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const EVENT = 'evt-flow';
const SEED = 'aa'.repeat(32);
const SIG = 'ab'.repeat(48);
const BEACON = createHash('sha256').update(Buffer.from(SIG, 'hex')).digest('hex');
const OPEN = Date.parse('2026-11-10T11:00:00Z');

async function world(o = {}) {
  const tokens = ['1', '2', '3', '4'].map(sha).sort();
  const root = await merkleRootHex(tokens);
  const commit = await commitmentHex(EVENT, SEED);
  const order = await recomputeOrder({ eventId: EVENT, seedHex: SEED, beaconHex: BEACON, sortedTokens: tokens, rootHex: root });
  const entries = Object.fromEntries(order.map((h, i) => [h, 11 + i]));
  const group = { chain: 'quicknet', algorithm: 'v1', resultPathPrefix: `/v1/queues/${EVENT}/shuffle-results/`, fileCount: 8, commit, merkleRoot: root, firstSeq: 11, participantCount: 4, beacon: BEACON, beaconSignature: SIG, seed: SEED, roundAt: new Date(OPEN + 3000).toISOString(), rootAt: new Date(OPEN + 1000).toISOString(), ...o };
  const api = { eventId: EVENT, opensAt: new Date(OPEN).toISOString(), seedRevealAt: new Date(OPEN + 3_600_000).toISOString(), lobby: group, batch: null };
  // 시험에서는 앞자리 8개(0~7)만 쓴다
  const files = new Map();
  for (let p = 0; p < 8; p++) files.set(p.toString(16).padStart(3, '0'), {});
  for (const [h, seq] of Object.entries(entries)) {
    const p = (parseInt(h.slice(0, 3), 16) % 8).toString(16).padStart(3, '0');
    files.get(p)[h] = seq;
  }
  const mine = order[1];
  const myPrefix = (parseInt(mine.slice(0, 3), 16) % 8).toString(16).padStart(3, '0');
  const fetched = [];
  const fetchFile = async (url) => {
    fetched.push(url);
    const name = url.split('/').pop().replace('.json', '');
    if (name === mine.slice(0, 3)) return { status: 200, body: files.get(myPrefix) };
    return files.has(name) ? { status: 200, body: files.get(name) } : { status: 404 };
  };
  return { api, mine, entries, fetched, fetchFile };
}

const deps = (w, extra = {}) => ({ filesOrigin: 'https://f.example', fetchFile: w.fetchFile, hasWebCrypto: () => true, ...extra });

test('POL-005 모두 맞으면 파일과 다시 계산한 순번이 같고, BLS 서명은 확인하지 않았다고 적는다', async () => {
  const w = await world();
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.deepEqual(r, { fileRank: '12', recomputedRank: '12', note: BLS_NOTE });
  assert.ok(w.fetched[0].startsWith('https://f.example/v1/queues/'));
  assert.equal(r.note.includes('확인하지 않'), true);
});

test('POL-005 시드가 커밋과 다르면 일치가 아니다', async () => {
  const w = await world({ commit: 'f'.repeat(64) });
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.equal(r.recomputedRank, '시드 커밋 불일치');
  assert.notEqual(r.fileRank, r.recomputedRank);
});

test('POL-005 비콘 값이 서명의 해시와 다르면 일치가 아니다', async () => {
  const w = await world({ beacon: 'e'.repeat(64) });
  assert.equal((await verifyToken(w.api, w.mine, deps(w))).recomputedRank, '비콘 값 불일치');
});

test('POL-005 머클 루트를 라운드 뒤에 공시했으면 일치가 아니다(다시 계산 값이 맞아도)', async () => {
  const w = await world({ rootAt: new Date(OPEN + 9000).toISOString() });
  assert.equal((await verifyToken(w.api, w.mine, deps(w))).recomputedRank, '머클 루트를 비콘 라운드 뒤에 공시함');
});

test('POL-005 머클 루트가 다르면 일치가 아니다', async () => {
  const w = await world({ merkleRoot: 'd'.repeat(64) });
  assert.equal((await verifyToken(w.api, w.mine, deps(w))).recomputedRank, '머클 루트 불일치');
});

test('FR-038 해시 모양이 틀리거나 파일에 없으면 받지 않고 알린다', async () => {
  const w = await world();
  assert.deepEqual(await verifyToken(w.api, 'zz', deps(w)), { error: '토큰 해시는 16진수 64자입니다' });
  assert.deepEqual(await verifyToken(w.api, 'c'.repeat(64), deps(w)), { error: '결과 파일에서 이 토큰 해시를 찾지 못했습니다' });
});

test('WebCrypto가 없으면 내려받기 전에 알린다', async () => {
  const w = await world();
  const r = await verifyToken(w.api, w.mine, deps(w, { hasWebCrypto: () => false }));
  assert.deepEqual(r, { error: '이 브라우저에서는 다시 계산할 수 없습니다(암호 기능을 쓸 수 없습니다)' });
  assert.equal(w.fetched.length, 0);
});

test('진행률을 알리고 취소하면 던진다', async () => {
  const w = await world();
  const seen = [];
  await verifyToken(w.api, w.mine, deps(w, { onProgress: (p) => seen.push(p) }));
  assert.ok(seen.length > 0);
  assert.equal(seen[seen.length - 1].phase, 'compute');
  const c = new AbortController();
  c.abort();
  await assert.rejects(verifyToken(w.api, w.mine, deps(w, { signal: c.signal })), { name: 'AbortError' });
});

test('받을 크기는 참가자 수로 어림한다', () => {
  assert.equal(estimateDownload({ participantCount: 1_000_000, fileCount: 4096 }), '결과 파일 4,096개, 약 77MB를 받습니다');
  assert.equal(estimateDownload({ participantCount: 100, fileCount: 4096 }), '결과 파일 4,096개, 약 1MB 미만을 받습니다');
  assert.equal(estimateDownload({ fileCount: 4096 }), null);
});

test('자동 채움은 실제로 보낸 토큰을 읽는다', () => {
  assert.equal(pickStoredToken({ lobby: { lobbyToken: 'L' }, entry: { token: 'E' }, preverifyToken: 'P' }, false), 'L');
  assert.equal(pickStoredToken({ entry: { token: 'E' }, preverifyToken: 'P' }, false), 'E');
  assert.equal(pickStoredToken({ entry: { token: 'E' }, preverifyToken: 'P' }, true), 'E');
  assert.equal(pickStoredToken({ preverifyToken: 'P' }, true), 'P');
  assert.equal(pickStoredToken(null, true), undefined);
});
