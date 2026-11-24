// GAT-030 키 증명 PoC 도구의 단위 시험. 브라우저 없이 QR 두 판의 길이·base45·모듈 수와 판정 규칙을 본다.
// 디코딩 시간 측정은 `node key-proof-poc/run.mjs`가 맡는다(브라우저·zxing-wasm 필요).
import test from 'node:test';
import assert from 'node:assert/strict';
import { base45Decode, decodeQrV1, QR_V1_BASE45_LENGTH, QR_V1_BYTES } from '../../../apps/web/src/features/wallet-device-key/qr-v1.ts';
import {
  buildPanels,
  decodeKeyProof,
  EXPECT,
  KEY_ID,
  keyProofMessage,
  PROOF_BYTES,
  PROOF_VALID_UNTIL_SECONDS,
  QR_TIME_SECONDS,
  SERVER_PUBLIC_KEY,
  TICKET_ID,
} from './fixtures.mjs';
import { judge, LEVELS, percentile, summarize } from './levels.mjs';

const BASE45_ALPHABET = /^[0-9A-Z $%*+\-./:]+$/;

test('GAT-030 ① QR v1 판은 93바이트·base45 140자이고 원래 바이트로 돌아온다', () => {
  const { qrV1 } = buildPanels();
  assert.equal(qrV1.byteLength, QR_V1_BYTES);
  assert.equal(qrV1.byteLength, EXPECT.qrV1.bytes);
  assert.equal(qrV1.textLength, QR_V1_BASE45_LENGTH);
  assert.match(qrV1.text, BASE45_ALPHABET);
  const decodedBytes = base45Decode(qrV1.text);
  assert.deepEqual(decodedBytes, qrV1.bytes);
  const fields = decodeQrV1(decodedBytes);
  assert.equal(fields.ticketId, TICKET_ID);
  assert.deepEqual(fields.keyId, KEY_ID);
  assert.equal(fields.timeSeconds, QR_TIME_SECONDS);
  assert.equal(fields.signature.length, 64);
});

test('GAT-030 ② 키 증명 판은 증명 110바이트를 더한 203바이트·305자이고 증명 칸이 맞다', () => {
  const { keyProof } = buildPanels();
  assert.equal(keyProof.proof.length, PROOF_BYTES);
  assert.equal(keyProof.proof.length, 110);
  assert.equal(keyProof.byteLength, 93 + 110);
  assert.equal(keyProof.byteLength, EXPECT.keyProof.bytes);
  assert.equal(keyProof.textLength, EXPECT.keyProof.text);
  assert.equal(keyProof.textLength, 305);
  assert.match(keyProof.text, BASE45_ALPHABET);
  assert.deepEqual(base45Decode(keyProof.text), keyProof.bytes);
  assert.deepEqual(keyProof.bytes.slice(0, 93), keyProof.qrBytes);

  const proof = decodeKeyProof(keyProof.proof);
  assert.deepEqual(proof.keyId, KEY_ID);
  assert.deepEqual(proof.publicKey, SERVER_PUBLIC_KEY);
  assert.equal(proof.publicKey.length, 33);
  assert.ok(proof.publicKey[0] === 2 || proof.publicKey[0] === 3);
  assert.equal(proof.validUntilSeconds, PROOF_VALID_UNTIL_SECONDS);
  assert.ok(proof.validUntilSeconds > QR_TIME_SECONDS);
  assert.equal(proof.signature.length, 64);

  const message = keyProofMessage();
  // "PEAKET-KEY-PROOF-v1"(19) ‖ 티켓 ID(16) ‖ keyId(8) ‖ 공개키(33) ‖ 유효 기한(4)
  assert.equal(message.length, 19 + 16 + 8 + 33 + 4);
});

test('GAT-030 ③ 같은 입력이면 같은 바이트·같은 QR 모듈이 나온다', () => {
  const first = buildPanels();
  const second = buildPanels();
  for (const id of ['qrV1', 'keyProof']) {
    assert.deepEqual(first[id].bytes, second[id].bytes);
    assert.equal(first[id].text, second[id].text);
    assert.equal(first[id].matrix.size, second[id].matrix.size);
    assert.deepEqual(first[id].matrix.cells, second[id].matrix.cells);
    assert.equal(first[id].matrix.cells.length, first[id].matrix.size ** 2);
    assert.ok(first[id].matrix.cells.every((cell) => typeof cell === 'boolean'));
  }
  assert.equal(first.qrV1.matrix.size, EXPECT.qrV1.modules);
  assert.equal(first.qrV1.qrVersion, EXPECT.qrV1.version);
  assert.equal(first.keyProof.matrix.size, EXPECT.keyProof.modules);
  assert.equal(first.keyProof.qrVersion, EXPECT.keyProof.version);
});

test('GAT-030 ④ 열화 단계는 다섯이고 흐림·기울임은 커지고 밝기는 낮아진다', () => {
  assert.equal(LEVELS.length, 5);
  assert.deepEqual(LEVELS.map((level) => level.id), ['L1', 'L2', 'L3', 'L4', 'L5']);
  for (let i = 1; i < LEVELS.length; i++) {
    assert.ok(LEVELS[i].blurPx > LEVELS[i - 1].blurPx);
    assert.ok(LEVELS[i].rotateDeg > LEVELS[i - 1].rotateDeg);
    assert.ok(LEVELS[i].brightness < LEVELS[i - 1].brightness);
  }
  assert.equal(LEVELS[0].blurPx, 0);
  assert.equal(LEVELS[0].rotateDeg, 0);
  assert.equal(LEVELS[0].brightness, 1);
});

test('GAT-030 ⑤ 요약은 실패한 시도도 시간 표본에 넣고 p50·p95·실패율을 낸다', () => {
  const times = Array.from({ length: 100 }, (_, i) => i + 1);
  const summary = summarize({ times, failures: 3 });
  assert.equal(summary.attempts, 100);
  assert.equal(summary.failures, 3);
  assert.equal(summary.failureRate, 0.03);
  assert.equal(summary.p50, 50);
  assert.equal(summary.p95, 95);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 100);
  assert.equal(percentile([10], 0.95), 10);
});

function resultsWith(keyProofLevels = {}, qrV1Levels = {}) {
  const make = (overrides) => {
    const out = {};
    for (const level of LEVELS) {
      out[level.id] = { p50: 10, p95: 20, failures: 0, attempts: 1000, failureRate: 0, ...overrides[level.id] };
    }
    return out;
  };
  return { 'qr-v1': make(qrV1Levels), 'key-proof': make(keyProofLevels) };
}

test('GAT-030 ⑥ 판정: 맑음·약한 열화가 기준 안이면 채택 가능(조건부)이다', () => {
  assert.equal(judge(resultsWith()).verdict, '채택 가능(조건부)');
});

test('GAT-030 ⑦ 판정: 맑음 실패율·p95, 약한 열화 실패율, 열화 한계 가운데 하나라도 어긋나면 보류다', () => {
  assert.equal(judge(resultsWith({ L1: { p95: 151, failures: 0, failureRate: 0 } })).verdict, '보류');
  assert.equal(judge(resultsWith({ L1: { p50: 10, p95: 20, failures: 11, attempts: 1000, failureRate: 0.011 } })).verdict, '보류');
  assert.equal(judge(resultsWith({ L2: { failures: 51, attempts: 1000, failureRate: 0.051 } })).verdict, '보류');
  const earlier = judge(resultsWith({ L3: { failures: 200, attempts: 1000, failureRate: 0.2 } }, { L4: { failures: 200, attempts: 1000, failureRate: 0.2 } }));
  assert.equal(earlier.verdict, '보류');
  assert.equal(earlier.edge.keyProof, 'L3');
  assert.equal(earlier.edge.qrV1, 'L4');
});
