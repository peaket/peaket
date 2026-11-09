// SCR-019 내 순번 검증 흐름(d5 §5.19 ⑥, ADR-0232 결정 9): 내 구간 찾기 → 결과 파일 모으기 → 커밋·비콘·머클 루트 대조 → 다시 계산
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { commitmentHex, EMERGENCY_BEACON_HEX, merkleRootHex, recomputeOrder } from './recompute.ts';
import { BLS_NOTE, createWorkerFetch, estimateDownload, pickStoredToken, verifyToken } from './verify-flow.ts';
import { verdictOf } from '../../../../../../packages/ds/src/components/ShuffleProofPanel/verify-run.ts';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const EVENT = 'evt-flow';
const SEED = 'aa'.repeat(32);
const SIG = 'ab'.repeat(48);
const BEACON = createHash('sha256').update(Buffer.from(SIG, 'hex')).digest('hex');
const OPEN = Date.parse('2026-11-10T11:00:00Z');

async function world({ orderBeacon, ...o } = {}) {
  const tokens = ['1', '2', '3', '4'].map(sha).sort();
  const root = await merkleRootHex(tokens);
  const commit = await commitmentHex(EVENT, SEED);
  // 비상 셔플 구간의 결과 파일은 고정 비콘으로 섞여 있다(비콘·서명 칸은 응답에 없다)
  const beaconHex = orderBeacon ?? (o.emergency ? EMERGENCY_BEACON_HEX : BEACON);
  const order = await recomputeOrder({ eventId: EVENT, seedHex: SEED, beaconHex, sortedTokens: tokens, rootHex: root });
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
    // 실제 회차는 앞자리 4,096개를 모두 쓴다(빈 앞자리는 빈 표). 시험의 앞자리 밖도 읽히는 빈 파일로 둔다
    return { status: 200, body: files.get(name) ?? {} };
  };
  return { api, mine, entries, fetched, fetchFile, files, myPrefix };
}

const deps = (w, extra = {}) => ({ filesOrigin: 'https://f.example', fetchFile: w.fetchFile, hasWebCrypto: () => true, ...extra });

test('POL-005 모두 맞으면 파일과 다시 계산한 순번이 같고, BLS 서명은 확인하지 않았다고 적는다', async () => {
  const w = await world();
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.deepEqual(r, { fileRank: '12', recomputedRank: '12', matched: true, note: BLS_NOTE });
  assert.ok(w.fetched[0].startsWith('https://f.example/v1/queues/'));
  assert.equal(r.note.includes('확인하지 않'), true);
});

const LIMITATION = '시드를 아는 내부자가 결과를 미리 알 수 있습니다';
const EMERGENCY = { at: new Date(OPEN + 70_000).toISOString(), reason: 'drand 비콘을 60초 넘게 받지 못했다', stopReason: 'beacon', limitation: '이 경우 시드를 아는 내부자가 결과를 미리 알 수 있다' };
const noBeacon = (o = {}) => ({ beacon: undefined, beaconSignature: undefined, emergency: EMERGENCY, ...o });
const NOT_FOUND = { error: '결과 파일에서 이 토큰 해시를 찾지 못했습니다' };

test('Q-T27 POL-005 비상 구간은 고정 비콘으로 다시 계산해 순번이 같고, 파일에서 못 찾았다고 잘못 안내하지 않는다', async () => {
  const w = await world(noBeacon());
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.notDeepEqual(r, NOT_FOUND);
  assert.equal(r.fileRank, '12');
  assert.equal(r.recomputedRank, '12');
  assert.equal(r.matched, true);
});

test('Q-T27 POL-005 비상 구간은 순번이 맞아도 결론 제목에 비콘 없음과 한계를 함께 내고, 공개 난수로 검증했다고 적지 않는다', async () => {
  const w = await world(noBeacon());
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.equal(r.conclusion.tone, 'warning');
  assert.match(r.conclusion.title, /비콘 없이 시드만으로/);
  assert.ok(r.note.includes('비콘(외부 공개 난수) 없이 시드만으로'));
  assert.ok(r.note.includes(LIMITATION));
  assert.doesNotMatch(`${r.conclusion.title} ${r.note}`, /drand|BLS|공개 난수로 (검증|확인)/);
});

test('Q-T27 POL-005 브라우저가 보지 못한 비상 처리 서명은 확인했다고 적지 않는다', async () => {
  const w = await world(noBeacon());
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.ok(r.note.includes('서명은 이 화면에서 확인하지 않았습니다'));
});

test('Q-T27 POL-005 비상 구간도 시드가 커밋과 다르면 불일치이고 결론을 누그러뜨리지 않는다', async () => {
  const w = await world(noBeacon({ commit: 'f'.repeat(64) }));
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.equal(r.recomputedRank, '시드 커밋 불일치');
  assert.equal(r.matched, false);
  assert.equal(r.conclusion, undefined);
  assert.ok(r.note.includes(LIMITATION));
  assert.doesNotMatch(r.note, /확인했습니다/);
});

test('Q-T27 POL-005 비상 구간도 머클 루트가 다르면 일치가 아니다', async () => {
  const bad = await world(noBeacon({ merkleRoot: 'd'.repeat(64) }));
  assert.equal((await verifyToken(bad.api, bad.mine, deps(bad))).recomputedRank, '머클 루트 불일치');
});

test('Q-T27 POL-005 비상 구간은 루트·라운드 시각을 보지 않되(서버의 late_root와 같다) 초록이 아니라 주의까지만 낸다', async () => {
  for (const o of [{ rootAt: new Date(OPEN + 9000).toISOString() }, { rootAt: undefined }, { rootAt: 'garbage' }, { roundAt: undefined }, { roundAt: 'garbage' }]) {
    const w = await world(noBeacon(o));
    const r = await verifyToken(w.api, w.mine, deps(w));
    assert.equal(r.matched, true, JSON.stringify(o));
    assert.equal(r.recomputedRank, '12');
    assert.equal(verdictOf(r).tone, 'warning');
    assert.match(verdictOf(r).title, /비콘 없이 시드만으로/);
  }
});

test('Q-T27 POL-005 일반 구간은 늦은 루트이면 그대로 일치가 아니다', async () => {
  const w = await world({ rootAt: new Date(OPEN + 9000).toISOString() });
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.equal(r.matched, false);
  assert.equal(verdictOf(r).tone, 'danger');
});

test('Q-T27 POL-005 읽지 못한 공시 칸이 있으면 결과 파일을 모으지 않고 그 구간을 확인됨으로 내지 않는다', async () => {
  const w = await world({ beacon: undefined, beaconSignature: undefined, invalidDisclosures: ['emergency'] });
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.notDeepEqual(r, NOT_FOUND);
  assert.equal(r.fileRank, '12');
  assert.equal(r.recomputedRank, '확인하지 않음');
  assert.notEqual(r.fileRank, r.recomputedRank);
  assert.equal(r.conclusion.tone, 'danger');
  assert.match(r.note, /위조나 손상/);
  assert.equal(w.fetched.length, 1);
});

test('Q-T27 POL-005 다시 공시 칸을 읽지 못하면 비콘이 맞아도 확인됨으로 내지 않는다', async () => {
  const w = await world({ invalidDisclosures: ['redisclosures'] });
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.equal(r.recomputedRank, '확인하지 않음');
  assert.equal(r.conclusion.tone, 'danger');
});

test('Q-T27 POL-005 모양이 틀린 비상 칸은 읽지 못한 공시와 같게 다룬다', async () => {
  for (const emergency of [null, 'x', { ...EMERGENCY, reason: 7 }, { ...EMERGENCY, reason: '' }, { ...EMERGENCY, reason: '가'.repeat(201) }, { ...EMERGENCY, limitation: undefined }, { ...EMERGENCY, stopReason: 'late_root' }, { ...EMERGENCY, at: 'x' }, { ...EMERGENCY, at: '1' }, { ...EMERGENCY, at: 'hello 1' }]) {
    const w = await world(noBeacon({ emergency }));
    assert.equal((await verifyToken(w.api, w.mine, deps(w))).recomputedRank, '확인하지 않음');
  }
});

test('Q-T27 POL-005 비상 표시와 drand 비콘이 함께 있으면 공시가 어긋난 것이라 확인됨으로 내지 않는다', async () => {
  const w = await world({ emergency: EMERGENCY });
  assert.equal((await verifyToken(w.api, w.mine, deps(w))).recomputedRank, '확인하지 않음');
});

test('Q-T27 POL-005 응답의 읽지 못한 칸 목록이 배열이 아니어도 안전한 쪽으로 다룬다', async () => {
  const w = await world({ invalidDisclosures: 'emergency' });
  assert.equal((await verifyToken(w.api, w.mine, deps(w))).recomputedRank, '확인하지 않음');
});

test('Q-T27 POL-005 읽지 못한 칸이 있어도 파일에 없는 토큰은 찾지 못했다고 알린다', async () => {
  const w = await world({ invalidDisclosures: ['emergency'] });
  assert.deepEqual(await verifyToken(w.api, 'c'.repeat(64), deps(w)), NOT_FOUND);
});

const PREIMAGE_HEX = Buffer.from('PEAKET-shuffle-v1-no-beacon', 'utf8').toString('hex');
const untrusted = (r) => {
  assert.equal(r.matched, false);
  assert.equal(r.recomputedRank, '확인하지 않음');
  assert.equal(r.conclusion.tone, 'danger');
};

test('Q-T27 POL-005 비상 표시를 지우고 비콘 칸에 고정값을 넣어 일반 일치로 위장하면 확인됨으로 내지 않는다', async () => {
  const w = await world({ orderBeacon: EMERGENCY_BEACON_HEX, beacon: EMERGENCY_BEACON_HEX, beaconSignature: PREIMAGE_HEX });
  untrusted(await verifyToken(w.api, w.mine, deps(w)));
  assert.equal(w.fetched.length, 1);
});

test('Q-T27 POL-005 서명 자리가 16진 96자가 아니면 확인됨으로 내지 않는다(ADR-0239 결정 3의 G1 48바이트)', async () => {
  const hashOf = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
  for (const sig of ['ab'.repeat(47), 'ab'.repeat(49), 'ab'.repeat(64), 'AB'.repeat(48), 'zz'.repeat(48)]) {
    const beacon = /^[0-9a-fA-F]+$/.test(sig) ? hashOf(sig) : BEACON;
    const w = await world({ orderBeacon: beacon, beacon, beaconSignature: sig });
    untrusted(await verifyToken(w.api, w.mine, deps(w)));
  }
});

test('Q-T27 POL-005 비콘과 서명 중 하나만 있으면 확인됨으로 내지 않는다', async () => {
  for (const o of [{ beaconSignature: undefined }, { beaconSignature: '' }, { beacon: undefined }]) {
    const w = await world(o);
    untrusted(await verifyToken(w.api, w.mine, deps(w)));
  }
});

test('Q-T27 POL-005 시드가 있는데 비콘도 비상 표시도 없으면 값이 어긋난 구간으로 낸다(찾지 못했다고 하지 않는다)', async () => {
  const w = await world({ beacon: undefined, beaconSignature: undefined });
  untrusted(await verifyToken(w.api, w.mine, deps(w)));
});

test('Q-T27 POL-005 시드가 있는데 커밋·머클 루트·첫 번호가 없거나 모양이 틀리면 값이 어긋난 구간으로 낸다', async () => {
  for (const o of [{ commit: undefined }, { commit: 'abc' }, { merkleRoot: undefined }, { firstSeq: undefined }, { firstSeq: '11' }, { firstSeq: 0 }, { seed: 'zz' }]) {
    const w = await world(o);
    untrusted(await verifyToken(w.api, w.mine, deps(w)));
  }
});

/** 내 줄의 값만 바꾼 결과 파일 */
const forge = (w, value) => {
  w.files.get(w.myPrefix)[w.mine] = value;
  return w;
};

test('Q-T27 POL-005 결과 파일의 값이 실패 문구나 숫자 글이면 글자가 같아도 일치로 내지 않는다', async () => {
  for (const value of ['머클 루트 불일치', '12', '시드 커밋 불일치', null, 12.5, 0, -1]) {
    const w = forge(await world(), value);
    const r = await verifyToken(w.api, w.mine, deps(w));
    assert.equal(r.matched, false, String(value));
    assert.equal(r.fileRank, '—');
    assert.equal(r.conclusion, undefined);
  }
});

test('Q-T27 POL-005 비상 구간도 결과 파일의 값을 글자로 맞춰 주의 결론을 받지 못한다', async () => {
  const w = forge(await world(noBeacon()), '머클 루트 불일치');
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.equal(r.matched, false);
  assert.equal(r.conclusion, undefined);
});

test('Q-T27 POL-005 머클 루트 늦음과 같은 글을 파일에 넣어도 일치로 내지 않는다', async () => {
  const w = forge(await world({ rootAt: new Date(OPEN + 9000).toISOString() }), '머클 루트를 비콘 라운드 뒤에 공시함');
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.equal(r.recomputedRank, '머클 루트를 비콘 라운드 뒤에 공시함');
  assert.equal(r.matched, false);
});

test('Q-T27 POL-005 파일 수를 줄여 내 번호가 양쪽 다 비어도 일치로 내지 않는다', async () => {
  const w = await world();
  const other = Object.keys(w.entries).find((h) => h !== w.mine);
  w.api.lobby.fileCount = 1;
  w.api.lobby.merkleRoot = await merkleRootHex([other]);
  const inner = w.fetchFile;
  w.fetchFile = async (url) => (url.endsWith('/000.json') ? { status: 200, body: { [other]: 11 } } : inner(url));
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.equal(r.matched, false);
});

test('Q-T27 POL-005 머클 루트나 라운드 시각이 없거나 읽을 수 없으면 일치로 내지 않는다', async () => {
  for (const o of [{ rootAt: undefined }, { rootAt: 'garbage' }, { rootAt: '1' }, { roundAt: undefined }, { roundAt: 'garbage' }]) {
    const w = await world(o);
    const r = await verifyToken(w.api, w.mine, deps(w));
    assert.equal(r.matched, false, JSON.stringify(o));
    assert.equal(r.recomputedRank, '머클 루트 공시 시각을 확인할 수 없음');
  }
});

const stoppedAt = new Date(OPEN).toISOString();

test('Q-T27 POL-005 서명을 확인하지 못해 멈춘 구간은 다시 계산 값이 맞아도 믿을 수 없다고 낸다', async () => {
  const w = await world({ stopped: { reason: 'unknown', detail: 'unauthorized', at: stoppedAt } });
  const r = await verifyToken(w.api, w.mine, deps(w));
  untrusted(r);
  assert.match(r.note, /서명을 확인하지 못했습니다/);
  assert.equal(w.fetched.length, 1);
});

test('Q-T27 POL-005 그 밖의 이유로 멈춘 구간은 사유 문구와 함께 확인됨으로 내지 않는다', async () => {
  const w = await world({ stopped: { reason: 'members_changed', at: stoppedAt } });
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.equal(r.matched, false);
  assert.equal(r.recomputedRank, '확인하지 않음');
  assert.equal(r.conclusion.tone, 'danger');
  assert.match(r.conclusion.title, /순서 계산을 멈춰/);
  assert.equal(r.note, '순서 계산을 멈췄습니다. 공시한 참가자 목록과 게시할 목록이 다릅니다');
});

const SEED_PENDING = { error: '이 구간은 원본 시드를 공개한 뒤 다시 계산할 수 있습니다' };
const FILE_UNREADABLE = { error: '결과 파일을 받지 못해 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요' };

test('POL-005 시드 공개 전 구간의 토큰은 찾지 못했다고 하지 않고 시드 공개 뒤 계산할 수 있다고 알린다', async () => {
  const w = await world({ seed: undefined });
  assert.deepEqual(await verifyToken(w.api, w.mine, deps(w)), SEED_PENDING);
});

test('POL-005 파일을 읽지 못하면 찾지 못했다고 하지 않는다(404·망 오류·표가 아닌 본문)', async () => {
  for (const fetchFile of [async () => ({ status: 404 }), async () => ({ status: 0 }), async () => ({ status: 500 }), async () => { throw new Error('망'); }, async () => ({ status: 200, body: null }), async () => ({ status: 200, body: 7 }), async () => ({ status: 200, body: [] })]) {
    const w = await world();
    assert.deepEqual(await verifyToken(w.api, w.mine, deps(w, { fetchFile })), FILE_UNREADABLE);
  }
});

/** 화면 쪽이 Worker에 답하는 길 그대로: 받은 바이트를 receive로 넘긴다 */
const workerFetch = (answer) => {
  const worker = createWorkerFetch(({ fetch: { id, url } }) => {
    const reply = answer(url);
    queueMicrotask(() => worker.receive({ id, status: 200, buffer: new TextEncoder().encode(reply).buffer }));
  });
  return worker.fetchFile;
};

test('POL-005 Worker 경로도 200 상태의 JSON 아닌 결과 파일은 파일을 받지 못한 것으로 낸다', async () => {
  const posted = [];
  const { fetchFile, receive } = createWorkerFetch((m) => posted.push(m));
  const got = fetchFile('https://f/a.json');
  receive({ id: posted[0].fetch.id, status: 200, buffer: new TextEncoder().encode('<html>').buffer });
  assert.equal((await got).status, 0);
  const w = await world();
  assert.deepEqual(await verifyToken(w.api, w.mine, deps(w, { fetchFile: workerFetch(() => '<html>') })), FILE_UNREADABLE);
});

test('POL-005 전체 결과 파일을 모으다 하나를 못 받아도 같은 안내를 낸다(두 경로가 같다)', async () => {
  const w = await world();
  const real = w.fetchFile;
  let n = 0;
  const fetchFile = async (url) => ((n += 1), n === 1 ? real(url) : url.endsWith('/003.json') ? { status: 500 } : real(url));
  assert.deepEqual(await verifyToken(w.api, w.mine, deps(w, { fetchFile })), FILE_UNREADABLE);
  const viaWorker = await world();
  const inner = viaWorker.fetchFile;
  let m = 0;
  const raw = createWorkerFetch(({ fetch: { id, url } }) => {
    m += 1;
    void inner(url).then((r) => raw.receive({ id, status: 200, buffer: new TextEncoder().encode(m > 1 && url.endsWith('/003.json') ? '<html>' : JSON.stringify(r.body)).buffer }));
  });
  assert.deepEqual(await verifyToken(viaWorker.api, viaWorker.mine, deps(viaWorker, { fetchFile: raw.fetchFile })), FILE_UNREADABLE);
});

test('POL-005 취소는 전체 파일 모으기에서도 파일 읽기 실패로 바꾸지 않는다', async () => {
  const w = await world();
  const c = new AbortController();
  const inner = w.fetchFile;
  let n = 0;
  const fetchFile = async (url) => {
    n += 1;
    if (n === 1) c.abort();
    return inner(url);
  };
  await assert.rejects(verifyToken(w.api, w.mine, deps(w, { fetchFile, signal: c.signal })), { name: 'AbortError' });
});

test('Q-T27 POL-005 믿을 수 없는 구간은 파일이 없어도 다시 시도하라고 하지 않고 믿을 수 없다고 낸다', async () => {
  const gone = { fetchFile: async () => ({ status: 404 }) };
  const a = await world({ seed: undefined, stopped: { reason: 'unknown', detail: 'unauthorized', at: new Date(OPEN).toISOString() } });
  const unauthorized = await verifyToken(a.api, a.mine, deps(a, gone));
  untrusted(unauthorized);
  assert.equal(unauthorized.fileRank, '—');
  assert.match(unauthorized.note, /서명을 확인하지 못했습니다/);
  const b = await world({ beacon: undefined, beaconSignature: undefined, invalidDisclosures: ['emergency'] });
  const invalid = await verifyToken(b.api, b.mine, deps(b, { fetchFile: async () => ({ status: 0 }) }));
  untrusted(invalid);
  assert.match(invalid.note, /위조나 손상/);
});

test('Q-T27 POL-005 한 구간이 믿을 수 없어 파일이 없어도 다른 구간에서 찾은 토큰은 그 구간 결과를 낸다', async () => {
  const w = await world();
  w.api.batch = w.api.lobby;
  w.api.lobby = { ...w.api.lobby, resultPathPrefix: '/lobby/', stopped: { reason: 'unknown', detail: 'unauthorized', at: new Date(OPEN).toISOString() } };
  const inner = w.fetchFile;
  const fetchFile = async (url) => (url.includes('/lobby/') ? { status: 404 } : inner(url));
  assert.equal((await verifyToken(w.api, w.mine, deps(w, { fetchFile }))).matched, true);
});

test('POL-005 멈춤 사유마다 파일이 없어도 다시 시도하라고 하지 않는다', async () => {
  for (const stopped of [{ reason: 'beacon' }, { reason: 'stale_round' }, { reason: 'late_commit' }, { reason: 'no_commit' }, { reason: 'late_root' }, { reason: 'members_changed' }, { reason: 'unknown', detail: 'seed_unavailable' }, { reason: 'unknown' }]) {
    const w = await world({ seed: undefined, beacon: undefined, beaconSignature: undefined, stopped: { ...stopped, at: new Date(OPEN).toISOString() } });
    const r = await verifyToken(w.api, w.mine, deps(w, { fetchFile: async () => ({ status: 404 }) }));
    assert.doesNotMatch(r.error, /다시 시도/, JSON.stringify(stopped));
    assert.deepEqual(r, { error: '순서 계산을 멈춘 구간은 원본 시드를 공개하지 않아 다시 계산할 수 없습니다' });
  }
});

test('POL-005 취소는 파일 읽기 실패로 바꾸지 않는다', async () => {
  const w = await world();
  const fetchFile = async () => { throw new DOMException('취소했습니다', 'AbortError'); };
  await assert.rejects(verifyToken(w.api, w.mine, deps(w, { fetchFile })), { name: 'AbortError' });
});

test('POL-005 결과를 게시하지 않아 파일이 없는 시드 공개 전 구간만 있으면 시드 공개 전으로 알린다', async () => {
  const w = await world({ seed: undefined });
  assert.deepEqual(await verifyToken(w.api, w.mine, deps(w, { fetchFile: async () => ({ status: 404 }) })), SEED_PENDING);
});

test('POL-005 멈춰서 파일이 없는 구간만 있으면 멈춤을 알린다', async () => {
  const w = await world({ seed: undefined, stopped: { reason: 'beacon', at: stoppedAt } });
  assert.deepEqual(await verifyToken(w.api, w.mine, deps(w, { fetchFile: async () => ({ status: 404 }) })), { error: '순서 계산을 멈춘 구간은 원본 시드를 공개하지 않아 다시 계산할 수 없습니다' });
});

test('POL-005 읽을 결과 파일이 없는 회차는 찾지 못했다고 하지 않는다', async () => {
  const w = await world({ fileCount: 0 });
  assert.deepEqual(await verifyToken(w.api, w.mine, deps(w)), { error: '이 회차에는 다시 계산할 결과 파일이 없습니다' });
  assert.equal(w.fetched.length, 0);
});

test('Q-T27 POL-005 ⑥의 한계 문장은 서버 글이 아니라 화면의 고정 문장이다(서버가 한계 없음이라고 적어도 바뀌지 않는다)', async () => {
  const w = await world(noBeacon({ emergency: { ...EMERGENCY, limitation: '한계 없음' } }));
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.ok(r.note.includes(LIMITATION));
  assert.doesNotMatch(r.note, /한계 없음/);
  const bad = await world(noBeacon({ emergency: { ...EMERGENCY, limitation: '한계 없음' }, commit: 'f'.repeat(64) }));
  assert.doesNotMatch((await verifyToken(bad.api, bad.mine, deps(bad))).note, /한계 없음/);
});

test('POL-005 빨간 결과에는 확인했다는 문장을 붙이지 않는다', async () => {
  for (const o of [{ commit: 'f'.repeat(64) }, { beacon: 'e'.repeat(64) }, { merkleRoot: 'd'.repeat(64) }, { rootAt: new Date(OPEN + 9000).toISOString() }]) {
    const w = await world(o);
    const r = await verifyToken(w.api, w.mine, deps(w));
    assert.equal(r.matched, false);
    assert.doesNotMatch(r.note, /확인했습니다/);
    assert.match(r.note, /BLS 서명 자체는 이 화면에서 확인하지 않았습니다/);
  }
});

test('Q-T27 POL-005 읽지 못한 칸 목록의 항목이 글이 아니어도 던지지 않는다', async () => {
  for (const invalidDisclosures of [[{ toString: null }], [null], [7]]) {
    const w = await world({ invalidDisclosures });
    untrusted(await verifyToken(w.api, w.mine, deps(w)));
  }
});

test('Q-T27 POL-005 라운드가 안전한 정수가 아니면 ⑥도 믿을 수 없다고 낸다', async () => {
  const w = await world({ round: '7' });
  untrusted(await verifyToken(w.api, w.mine, deps(w)));
});

test('Q-T27 POL-005 빈 다시 공시 이력과 같은 라운드 줄은 서버처럼 잘못으로 본다', async () => {
  const empty = await world({ redisclosures: [] });
  untrusted(await verifyToken(empty.api, empty.mine, deps(empty)));
  const same = await world({ round: 7, redisclosures: [{ at: new Date(OPEN - 30_000).toISOString(), previousRound: 7, round: 7, reason: '같은 라운드' }] });
  untrusted(await verifyToken(same.api, same.mine, deps(same)));
});

const REDISCLOSED = [{ at: new Date(OPEN - 30_000).toISOString(), previousRound: 7, round: 9, reason: '오픈 시각이 바뀌었다' }];

test('Q-T27 POL-005 라운드를 다시 공시한 구간은 비콘으로 다시 계산하고 다시 공시 사실을 함께 적는다', async () => {
  const w = await world({ round: 9, redisclosures: REDISCLOSED });
  const r = await verifyToken(w.api, w.mine, deps(w));
  assert.equal(r.recomputedRank, '12');
  assert.equal(r.matched, true);
  assert.ok(r.note.startsWith(BLS_NOTE));
  assert.match(r.note, /라운드를 다시 공시/);
  assert.equal(r.conclusion, undefined);
});

test('Q-T27 POL-005 다시 공시 이력이 공시 라운드와 이어지지 않으면 확인됨으로 내지 않는다', async () => {
  const wrongLast = await world({ round: 8, redisclosures: REDISCLOSED });
  assert.equal((await verifyToken(wrongLast.api, wrongLast.mine, deps(wrongLast))).recomputedRank, '확인하지 않음');
  const broken = await world({ round: 12, redisclosures: [...REDISCLOSED, { at: new Date(OPEN - 20_000).toISOString(), previousRound: 10, round: 12, reason: '다시' }] });
  assert.equal((await verifyToken(broken.api, broken.mine, deps(broken))).recomputedRank, '확인하지 않음');
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
