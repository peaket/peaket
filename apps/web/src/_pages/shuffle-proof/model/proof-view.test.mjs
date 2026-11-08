// SCR-019 화면 모델: 검증 정보 API의 응답을 화면 값으로 옮긴다(d5 §5.19 상태, ADR-0232)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProofView, NO_FILE_FLAGS, previewStateOf, resultFileHref, resultStep, seedBadgesOf, seedNote, sortModeOf, verifyDisabledReason } from './proof-view.ts';

const fmt = { dateTime: (ms) => `D${ms}`, time: (ms) => `T${ms}`, dateTimeSec: (ms) => `DS${ms}`, timeSec: (ms) => `TS${ms}` };
const OPENS = 1_800_000_000_000;
const group = (o = {}) => ({ chain: 'quicknet', algorithm: 'v1', fixedAt: new Date(OPENS).toISOString(), resultPathPrefix: '/v1/queues/e/shuffle-results/', fileCount: 4096, ...o });
const api = (o = {}) => ({ eventId: 'e', opensAt: new Date(OPENS).toISOString(), seedRevealAt: new Date(OPENS + 3_600_000).toISOString(), lobby: group(), batch: group({ resultPathPrefix: '/v1/queues/e/batch-results/' }), ...o });
const view = (a, now = OPENS - 1) => buildProofView(a, { nowMs: now, filesOrigin: 'https://f.example', fmt });

test('POL-005 셔플 전이면 before 모양이다', () => {
  const v = view(api({ lobby: group({ commit: 'c'.repeat(64), committedAt: new Date(OPENS - 600_000).toISOString(), round: 8_000_000, roundAt: new Date(OPENS + 3_000).toISOString() }) }));
  assert.equal(v.flags.preT0, true);
  assert.equal(v.flags.commitOpen, true);
  assert.equal(v.flags.rootOpen, false);
  assert.equal(v.proof.lobby.seedHash, 'c'.repeat(64));
  assert.equal(v.proof.lobby.round, `8,000,000 · TS${OPENS + 3_000}`);
});

test('POL-005 머클 루트만 공시됐으면 게시 전이고, 게시되면 파일 주소가 생긴다', () => {
  const root = view(api({ lobby: group({ merkleRoot: 'b'.repeat(64) }) }), OPENS + 1_000);
  assert.deepEqual([root.flags.preT0, root.flags.rootOpen, root.flags.pub], [false, true, false]);
  const pub = view(api({ lobby: group({ merkleRoot: 'b'.repeat(64), beacon: 'a'.repeat(64), beaconSignature: 'd'.repeat(96), publishedAt: new Date(OPENS + 6_000).toISOString() }) }), OPENS + 7_000);
  assert.equal(pub.flags.pub, true);
  assert.equal(pub.proof.result.fileBase, 'https://f.example/v1/queues/e/shuffle-results/');
  assert.equal(resultFileHref(pub.proof.result.fileBase, 'abc'.padEnd(64, '0')), 'https://f.example/v1/queues/e/shuffle-results/abc.json');
  assert.equal(pub.proof.result.publishedAt, `DS${OPENS + 6_000}`);
});

test('POL-005 묶음 구간은 로비와 따로 판단한다(로비 게시 전이어도 묶음 머클 루트·비콘을 보인다)', () => {
  const v = view(api({ lobby: group(), batch: group({ resultPathPrefix: '/b/', merkleRoot: 'b'.repeat(64), beacon: 'a'.repeat(64), beaconSignature: 'd'.repeat(96), publishedAt: new Date(OPENS + 8_000).toISOString() }) }), OPENS + 9_000);
  assert.deepEqual([v.flags.pub, v.flags.rootOpen, v.flags.batchPub, v.flags.batchRootOpen], [false, false, true, true]);
  assert.equal(v.proof.batch.beacon, 'a'.repeat(64));
  assert.equal(v.proof.batch.signature, 'd'.repeat(96));
});

test('POL-005 묶음이 멈추면 묶음 쪽에 사유를 보이고, FIFO도 사유를 보인다', () => {
  const hybrid = view(api({ batch: group({ stopped: { reason: 'beacon', at: new Date(OPENS).toISOString() } }) }), OPENS + 1_000);
  assert.equal(hybrid.flags.stoppedNote, null);
  assert.ok(hybrid.flags.batchStoppedNote.includes('비콘'));
  const fifo = view(api({ lobby: null, batch: group({ stopped: { reason: 'members_changed', at: new Date(OPENS).toISOString() } }) }), OPENS + 1_000);
  assert.ok(fifo.flags.batchStoppedNote.includes('참가자'));
});

test('POL-005 머클 루트를 라운드 뒤에 공시했으면 표시한다', () => {
  const v = view(api({ lobby: group({ merkleRoot: 'b'.repeat(64), rootAt: new Date(OPENS + 9_000).toISOString(), roundAt: new Date(OPENS + 3_000).toISOString() }) }), OPENS + 10_000);
  assert.equal(v.flags.rootLate, true);
  assert.equal(view(api({ lobby: group({ merkleRoot: 'b'.repeat(64), rootAt: new Date(OPENS + 1_000).toISOString(), roundAt: new Date(OPENS + 3_000).toISOString() }) }), OPENS + 10_000).flags.rootLate, false);
});

test('FR-038 어느 구간이든 시드가 열리면 다시 계산할 수 있다', () => {
  const v = view(api({ lobby: group({ stopped: { reason: 'beacon', at: new Date(OPENS).toISOString() } }), batch: group({ seed: 'e'.repeat(64), publishedAt: new Date(OPENS).toISOString() }) }), OPENS + 3_700_000);
  assert.equal(v.flags.seedOpen, false);
  assert.equal(v.flags.verifyOpen, true);
});

test('정렬 이름은 켠 구간에서 정한다', () => {
  assert.equal(sortModeOf(api()), 'HYBRID');
  assert.equal(sortModeOf(api({ lobby: null })), 'FIFO');
  assert.equal(sortModeOf(api({ batch: null })), 'PREQUEUE_SHUFFLE');
});

test('POL-005 게시 뒤에 멈춘 구간도 ③에 값과 함께 사유를 보인다', () => {
  const stopped = { reason: 'members_changed', at: new Date(OPENS).toISOString() };
  const v = view(api({ lobby: group({ merkleRoot: 'b'.repeat(64), beacon: 'a'.repeat(64), beaconSignature: 'd'.repeat(96), publishedAt: new Date(OPENS + 6_000).toISOString(), stopped }), batch: null }), OPENS + 3_700_000);
  const step = resultStep({ pub: v.flags.pub, rootOpen: v.flags.rootOpen, stoppedNote: v.flags.stoppedNote });
  assert.equal(step.showValues, true);
  assert.ok(step.note.includes('참가자'));
  assert.deepEqual(resultStep({ pub: true, rootOpen: true, stoppedNote: null }), { showValues: true, note: null });
  assert.equal(resultStep({ pub: false, rootOpen: true, stoppedNote: null }).note, '순서 계산 중입니다. 공시한 drand 라운드를 받은 뒤 결과를 게시합니다');
  assert.equal(resultStep({ pub: false, rootOpen: false, stoppedNote: null }).note, '공시한 drand 라운드를 받은 뒤 결과를 게시합니다');
});

test('POL-005 멈춘 구간은 ⑤·⑥이 공개 예정이 아니라 공개하지 않는다고 안내한다', () => {
  const stopped = { reason: 'beacon', at: new Date(OPENS).toISOString() };
  const v = view(api({ lobby: group({ publishedAt: new Date(OPENS + 6_000).toISOString(), stopped }), batch: null }), OPENS + 3_700_000);
  assert.equal(v.flags.allStopped, true);
  assert.equal(seedNote(v.flags.stoppedNote, '오픈 60분 뒤 원본 시드를 공개합니다'), '이 구간은 순서 계산을 멈춰 원본 시드를 공개하지 않습니다');
  assert.equal(seedNote(null, '오픈 60분 뒤 원본 시드를 공개합니다'), '오픈 60분 뒤 원본 시드를 공개합니다');
  assert.equal(verifyDisabledReason(v.flags, 'S'), '순서 계산을 멈춘 구간은 원본 시드를 공개하지 않아 다시 계산할 수 없습니다');
  const pending = view(api({ lobby: group(), batch: null }), OPENS + 1_000);
  assert.equal(verifyDisabledReason(pending.flags, 'S'), '원본 시드를 공개한 뒤(S) 다시 계산할 수 있습니다');
  const open = view(api({ lobby: group({ seed: 'e'.repeat(64) }), batch: null }), OPENS + 3_700_000);
  assert.equal(verifyDisabledReason(open.flags, 'S'), null);
});

test('POL-005 시드 공개 배지는 구간별 상태가 다르면 나눠 보인다', () => {
  const stopped = { reason: 'beacon', at: new Date(OPENS).toISOString() };
  const mixed = view(api({ lobby: group({ stopped }), batch: group({ seed: 'e'.repeat(64) }) }), OPENS + 3_700_000);
  assert.deepEqual(seedBadgesOf(mixed.flags), [
    { label: '로비 시드 공개 안 함(멈춤)', tone: 'warning' },
    { label: '묶음 시드 공개됨', tone: 'success' },
  ]);
  const same = view(api({ lobby: group({ seed: 'e'.repeat(64) }), batch: group({ seed: 'f'.repeat(64) }) }), OPENS + 3_700_000);
  assert.deepEqual(seedBadgesOf(same.flags), [{ label: '원본 시드 공개됨', tone: 'success' }]);
  const fifo = view(api({ lobby: null, batch: group() }), OPENS + 1_000);
  assert.deepEqual(seedBadgesOf(fifo.flags), [{ label: '원본 시드 공개 전', tone: 'warning' }]);
});

test('묶음 구간과 게시·라운드 시각은 초까지 보인다', () => {
  const v = view(api({ batch: group({ fixedAt: new Date(OPENS + 2_000).toISOString(), round: 9, roundAt: new Date(OPENS + 3_000).toISOString(), publishedAt: new Date(OPENS + 6_000).toISOString() }) }), OPENS + 7_000);
  assert.equal(v.proof.batch.window, `DS${OPENS}~TS${OPENS + 2_000}`);
  assert.equal(v.proof.batch.round, `9 · TS${OPENS + 3_000}`);
});

test('파일 없음 플래그는 머리만 보이게 한다(배지·셔플 전 안내 없음)', () => {
  assert.equal(NO_FILE_FLAGS.noFile, true);
  assert.equal(NO_FILE_FLAGS.preT0, false);
});

test('H2 미리보기는 개발 서버에서 아는 상태 이름일 때만 연다', () => {
  const states = ['셔플 전', '검증 결과 일치'];
  assert.equal(previewStateOf('검증 결과 일치', 'development', states), '검증 결과 일치');
  assert.equal(previewStateOf('검증 결과 일치', 'production', states), null);
  assert.equal(previewStateOf('x', 'development', states), null);
  assert.equal(previewStateOf(undefined, 'development', states), null);
});

test('FR-038 시드가 있으면 revealed다(⑥ 다시 계산 가능)', () => {
  const v = view(api({ lobby: group({ publishedAt: new Date(OPENS).toISOString(), seed: 'e'.repeat(64) }) }), OPENS + 3_700_000);
  assert.equal(v.flags.seedOpen, true);
  assert.equal(v.proof.seed.value, 'e'.repeat(64));
});

test('FIFO 공연은 로비 없이 묶음 공개만 있다', () => {
  const v = view(api({ lobby: null, batch: group({ merkleRoot: 'b'.repeat(64), publishedAt: new Date(OPENS + 6_000).toISOString(), seed: 'f'.repeat(64) }) }), OPENS + 3_700_000);
  assert.equal(v.flags.fifo, true);
  assert.equal(v.flags.seedOpen, true);
  assert.equal(v.proof.batch.merkleRoot, 'b'.repeat(64));
});

test('[ASVS v5.0.0-3.2.2] 멈춤 사유는 정해진 글로만 낸다(받은 값을 화면에 옮기지 않는다)', () => {
  const v = view(api({ lobby: group({ stopped: { reason: 'beacon', at: new Date(OPENS).toISOString() } }) }), OPENS + 1_000);
  assert.ok(v.flags.stoppedNote.includes('비콘'));
  assert.equal(view(api({ lobby: group({ stopped: { reason: 'unknown', at: new Date(OPENS).toISOString() } }) }), OPENS).flags.stoppedNote, '순서 계산을 멈췄습니다');
  assert.equal(view(api({ lobby: group({ stopped: { reason: '<img>', at: new Date(OPENS).toISOString() } }) }), OPENS).flags.stoppedNote, '순서 계산을 멈췄습니다');
});
