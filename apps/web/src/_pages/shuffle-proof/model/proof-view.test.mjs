// SCR-019 화면 모델: 검증 정보 API의 응답을 화면 값으로 옮긴다(d5 §5.19 상태, ADR-0232)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildProofView, disclosureBadgesOf, NO_DISCLOSURE, NO_FILE_FLAGS, previewStateOf, resultFileHref, resultStep, seedBadgesOf, seedNote, sortModeOf, verifyDisabledReason } from './proof-view.ts';

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

const LIMITATION = '이 경우 시드를 아는 내부자가 결과를 미리 알 수 있다';
const EMERGENCY = { at: new Date(OPENS + 70_000).toISOString(), reason: 'drand 비콘을 60초 넘게 받지 못했다', stopReason: 'beacon', limitation: LIMITATION };

test('Q-T27 POL-005 비상 구간은 사유·한계·시각을 구간별로 낸다', () => {
  const v = view(api({ lobby: group({ emergency: EMERGENCY }) }), OPENS + 80_000);
  assert.deepEqual(v.flags.disclosure.emergency, { at: `DS${OPENS + 70_000}`, reason: EMERGENCY.reason, limitation: LIMITATION });
  assert.deepEqual(v.flags.batchDisclosure, NO_DISCLOSURE);
  const fifo = view(api({ lobby: null, batch: group({ emergency: EMERGENCY }) }), OPENS + 80_000);
  assert.deepEqual(fifo.flags.disclosure, NO_DISCLOSURE);
  assert.equal(fifo.flags.batchDisclosure.emergency.reason, EMERGENCY.reason);
});

test('Q-T27 POL-005 비상 구간은 머리 배지로도 비콘이 없음을 알린다', () => {
  const v = view(api({ lobby: group({ emergency: EMERGENCY }) }), OPENS + 80_000);
  assert.deepEqual(disclosureBadgesOf(v.flags), [{ label: '로비 비상 셔플(비콘 없음)', tone: 'warning' }]);
  assert.deepEqual(disclosureBadgesOf(view(api(), OPENS + 80_000).flags), []);
});

test('Q-T27 POL-005 비상 구간의 게시 전 안내는 drand 라운드를 기다린다고 적지 않는다', () => {
  const step = resultStep({ pub: false, rootOpen: true, stoppedNote: null, emergency: true });
  assert.doesNotMatch(step.note, /drand/);
  assert.match(step.note, /비상 셔플/);
  assert.equal(resultStep({ pub: true, rootOpen: true, stoppedNote: null, emergency: true }).note, null);
  assert.equal(resultStep({ pub: false, rootOpen: true, stoppedNote: '멈춤', emergency: true }).note, '멈춤');
});

test('Q-T27 POL-005 다시 공시 이력을 차례대로 모두 낸다', () => {
  const redisclosures = [
    { at: new Date(OPENS - 30_000).toISOString(), previousRound: 8_000_000, round: 8_000_010, reason: '오픈 시각이 바뀌었다' },
    { at: new Date(OPENS - 20_000).toISOString(), previousRound: 8_000_010, round: 8_000_020, reason: '또 바뀌었다' },
  ];
  const v = view(api({ batch: group({ round: 8_000_020, redisclosures }) }), OPENS);
  assert.deepEqual(v.flags.batchDisclosure.redisclosures, [
    { at: `DS${OPENS - 30_000}`, previousRound: '8,000,000', round: '8,000,010', reason: '오픈 시각이 바뀌었다' },
    { at: `DS${OPENS - 20_000}`, previousRound: '8,000,010', round: '8,000,020', reason: '또 바뀌었다' },
  ]);
  assert.equal(v.flags.batchDisclosure.invalidNote, null);
});

test('Q-T27 POL-005 읽지 못한 칸이 있으면 위조·손상 가능성을 칸별 정해진 글과 배지로 알린다', () => {
  const lobby = view(api({ lobby: group({ invalidDisclosures: ['emergency'] }) }), OPENS);
  assert.match(lobby.flags.disclosure.invalidNote, /비상 셔플 기록을 읽지 못했습니다.*위조나 손상/);
  assert.deepEqual(disclosureBadgesOf(lobby.flags), [{ label: '로비 공시 확인 불가', tone: 'danger' }]);
  assert.match(view(api({ lobby: group({ invalidDisclosures: ['redisclosures'] }) }), OPENS).flags.disclosure.invalidNote, /다시 공시 기록을 읽지 못했습니다/);
  assert.match(view(api({ lobby: group({ invalidDisclosures: ['emergency', 'redisclosures'] }) }), OPENS).flags.disclosure.invalidNote, /비상 셔플·다시 공시 기록을/);
});

test('Q-T27 POL-005 위장한 비콘 기록은 ③에서도 믿지 않는다고 알린다', () => {
  const v = view(api({ lobby: group({ beacon: '5a0a07005e996232e2cc59a91675773e1df94dd0af57f5c0c46306e0a028e6dc', beaconSignature: 'ab'.repeat(48) }) }), OPENS);
  assert.match(v.flags.disclosure.invalidNote, /공시한 값이 규격과 맞지 않습니다.*위조나 손상/);
  assert.deepEqual(disclosureBadgesOf(v.flags), [{ label: '로비 공시 확인 불가', tone: 'danger' }]);
  assert.match(view(api({ lobby: group({ beacon: 'a'.repeat(64), beaconSignature: 'ab'.repeat(64) }) }), OPENS).flags.disclosure.invalidNote, /규격과 맞지 않습니다/);
});

test('Q-T27 POL-005 참가자 0명 구간은 비콘 없이 시드만 있어도 어긋난 구간이 아니다', () => {
  const v = view(api({ lobby: group({ seed: 'e'.repeat(64), fileCount: 0 }) }), OPENS + 3_700_000);
  assert.deepEqual(v.flags.disclosure, NO_DISCLOSURE);
});

test('Q-T27 POL-005 비콘이 아직 없는 게시 전 구간은 어긋난 구간이 아니다', () => {
  assert.deepEqual(view(api({ lobby: group({ commit: 'c'.repeat(64) }) }), OPENS).flags.disclosure, NO_DISCLOSURE);
});

test('Q-T27 POL-005 공시 시각은 ISO 형식만 받는다', () => {
  for (const at of ['1', 'hello 1', 'garbage', '2026-11-10', 1]) {
    const v = view(api({ lobby: group({ emergency: { ...EMERGENCY, at } }) }), OPENS + 80_000);
    assert.equal(v.flags.disclosure.emergency, null, String(at));
    assert.ok(v.flags.disclosure.invalidNote);
  }
  assert.ok(view(api({ lobby: group({ emergency: { ...EMERGENCY, at: '2026-11-10T11:00:00+09:00' } }) }), OPENS + 80_000).flags.disclosure.emergency);
});

test('Q-T27 POL-005 읽지 못한 칸 목록의 항목이 글이 아니면 모르는 칸으로 다룬다(던지지 않는다)', () => {
  const v = view(api({ lobby: group({ invalidDisclosures: [{ toString: null }] }) }), OPENS);
  assert.match(v.flags.disclosure.invalidNote, /위조나 손상/);
});

test('Q-T27 POL-005 빈 다시 공시 이력과 같은 라운드 줄은 잘못으로 본다(서버 proof.ts와 맞춘다)', () => {
  assert.match(view(api({ lobby: group({ redisclosures: [] }) }), OPENS).flags.disclosure.invalidNote, /다시 공시 기록을/);
  const same = view(api({ lobby: group({ round: 7, redisclosures: [{ at: EMERGENCY.at, previousRound: 7, round: 7, reason: '같은 라운드' }] }) }), OPENS);
  assert.deepEqual(same.flags.disclosure.redisclosures, []);
  assert.match(same.flags.disclosure.invalidNote, /다시 공시 기록을/);
});

test('[ASVS v5.0.0-3.2.2] Q-T27 ③에 옮기는 사유·한계는 서버가 적은 글임을 표시하고, 이력의 React 키에 줄 번호를 쓴다', () => {
  const body = readFileSync(fileURLToPath(new URL('../ui/ShuffleProofBody.tsx', import.meta.url)), 'utf8');
  assert.match(body, /서버가 적은 사유/);
  assert.match(body, /서버가 적은 한계/);
  assert.match(body, /서버가 적은 글입니다/);
  assert.match(body, /items\.map\(\(r, i\) =>/);
  assert.match(body, /key=\{`\$\{i\}:/);
});

test('Q-T27 POL-005 라운드가 안전한 정수가 아니면 던지지 않고 그 구간을 읽지 못한 공시로 낸다', () => {
  for (const round of [{ toLocaleString: 1 }, '7', 1.5, 0, 2 ** 53, null]) {
    const v = view(api({ lobby: group({ round }) }), OPENS);
    assert.match(v.flags.disclosure.invalidNote, /규격과 맞지 않습니다/, String(round));
    assert.equal(v.proof.lobby.round, '');
    assert.equal(v.proof.result.roundLabel, '');
  }
  const batch = view(api({ batch: group({ round: '7' }) }), OPENS);
  assert.equal(batch.proof.batch.round, '');
  assert.match(batch.flags.batchDisclosure.invalidNote, /규격과 맞지 않습니다/);
});

test('POL-005 표시용 시각이 깨지면 NaN 대신 —로 내고, 없는 칸은 비워 둔다', () => {
  const v = view(api({ lobby: group({ commit: 'c'.repeat(64), committedAt: 'garbage', round: 9, roundAt: 'x', publishedAt: 'bad' }) }), OPENS);
  assert.equal(v.proof.lobby.at, '—');
  assert.equal(v.proof.lobby.round, '9 · —');
  assert.equal(v.proof.result.publishedAt, '—');
  assert.equal(view(api({ lobby: group({ committedAt: { toString: null } }) }), OPENS).proof.lobby.at, '—');
  assert.equal(view(api(), OPENS).proof.lobby.at, '');
  for (const text of [v.proof.lobby.at, v.proof.lobby.round, v.proof.result.publishedAt]) assert.doesNotMatch(text, /NaN/);
});

test('[ASVS v5.0.0-3.2.2] Q-T27 모르는 칸 이름은 화면에 옮기지 않는다', () => {
  const note = view(api({ lobby: group({ invalidDisclosures: ['<img src=x onerror=1>'] }) }), OPENS).flags.disclosure.invalidNote;
  assert.ok(note);
  assert.doesNotMatch(note, /img|onerror/);
});

test('[ASVS v5.0.0-3.2.2] Q-T27 글이 아닌 사유는 화면 값으로 넘기지 않는다(React가 객체를 그리다 화면이 깨지지 않게)', () => {
  const v = view(api({ lobby: group({ emergency: { ...EMERGENCY, reason: { toString: 'x' } }, redisclosures: [{ at: EMERGENCY.at, previousRound: 1, round: 2, reason: ['a'] }] }) }), OPENS);
  assert.equal(v.flags.disclosure.emergency, null);
  assert.deepEqual(v.flags.disclosure.redisclosures, []);
  assert.ok(v.flags.disclosure.invalidNote);
});

test('[ASVS v5.0.0-3.2.2] Q-T27 받은 사유는 글자 그대로 넘기고, 검증 화면은 HTML로 넣지 않는다', () => {
  const reason = '<img src=x onerror=alert(1)>';
  const v = view(api({ lobby: group({ emergency: { ...EMERGENCY, reason } }) }), OPENS);
  assert.equal(v.flags.disclosure.emergency.reason, reason);
  for (const file of ['../ui/ShuffleProofBody.tsx', '../ui/ShuffleProofLive.tsx', '../ui/ShuffleProofPage.tsx']) {
    assert.doesNotMatch(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'), /dangerouslySetInnerHTML/);
  }
});

test('[ASVS v5.0.0-3.2.2] Q-T27 멈춤 이유 unknown의 detail은 아는 값만 정해진 글로 낸다', () => {
  const at = new Date(OPENS).toISOString();
  const note = (detail) => view(api({ lobby: group({ stopped: { reason: 'unknown', at, detail } }) }), OPENS).flags.stoppedNote;
  assert.equal(note('unauthorized'), '순서 계산을 멈췄습니다. 비상 처리 기록의 서명을 확인하지 못했습니다');
  assert.equal(note('seed_unavailable'), '순서 계산을 멈췄습니다. 원본 시드를 꺼내지 못했습니다');
  assert.equal(note('<img src=x>'), '순서 계산을 멈췄습니다');
  assert.equal(note(7), '순서 계산을 멈췄습니다');
});

test('[ASVS v5.0.0-3.2.2] 멈춤 사유는 정해진 글로만 낸다(받은 값을 화면에 옮기지 않는다)', () => {
  const v = view(api({ lobby: group({ stopped: { reason: 'beacon', at: new Date(OPENS).toISOString() } }) }), OPENS + 1_000);
  assert.ok(v.flags.stoppedNote.includes('비콘'));
  assert.equal(view(api({ lobby: group({ stopped: { reason: 'unknown', at: new Date(OPENS).toISOString() } }) }), OPENS).flags.stoppedNote, '순서 계산을 멈췄습니다');
  assert.equal(view(api({ lobby: group({ stopped: { reason: '<img>', at: new Date(OPENS).toISOString() } }) }), OPENS).flags.stoppedNote, '순서 계산을 멈췄습니다');
});
