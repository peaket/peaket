// F-04-9 역누적분포 표 시험. 정본: docs/features/forensic-replay.md §5.3·§8 FX-T1.
// 표는 빌드 스크립트가 만들고, 생성기는 정수 표를 선형 보간만 한다(로그·지수 함수를 실행 중에 쓰지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTables, TABLE_SIZE } from '../../../scripts/build-inv-cdf.mjs';
import { TABLE_SIZE as RUNTIME_TABLE_SIZE, sampleEntropy, sampleExponential, sampleResponse } from './cdf.ts';
import {
  INV_ENTROPY_BOT_Q6,
  INV_ENTROPY_HUMAN_Q6,
  INV_EXP_Q6,
  INV_RESPONSE_BOT_Q6,
  INV_RESPONSE_HUMAN_Q6,
} from './inv-cdf-table.ts';
import { Xoshiro128 } from './prng.ts';

test('FX-T1 ③ 역누적분포 표 빌드 출력이 소스 표와 같다', () => {
  assert.equal(TABLE_SIZE, 4_096);
  assert.equal(RUNTIME_TABLE_SIZE, 4_096);
  const tables = buildTables();
  assert.deepEqual(tables.exponential, [...INV_EXP_Q6]);
  assert.deepEqual(tables.responseHuman, [...INV_RESPONSE_HUMAN_Q6]);
  assert.deepEqual(tables.responseBot, [...INV_RESPONSE_BOT_Q6]);
  assert.deepEqual(tables.entropyHuman, [...INV_ENTROPY_HUMAN_Q6]);
  assert.deepEqual(tables.entropyBot, [...INV_ENTROPY_BOT_Q6]);
  for (const table of [INV_EXP_Q6, INV_RESPONSE_HUMAN_Q6, INV_RESPONSE_BOT_Q6, INV_ENTROPY_HUMAN_Q6, INV_ENTROPY_BOT_Q6]) {
    assert.equal(table.length, TABLE_SIZE);
    assert.ok(table.every((v) => Number.isInteger(v)));
    for (let i = 1; i < table.length; i += 1) assert.ok(table[i] >= table[i - 1], '표는 단조 비감소여야 한다');
  }
});

test('FX-T1 ③ 표 샘플이 정한 범위 안에 있고 표 사이를 보간한다', () => {
  const rng = new Xoshiro128('cdf-range');
  for (let i = 0; i < 200; i += 1) {
    const exp = sampleExponential(rng);
    const human = sampleResponse(rng, 'human');
    const bot = sampleResponse(rng, 'bot');
    const humanEntropy = sampleEntropy(rng, 'human');
    const botEntropy = sampleEntropy(rng, 'bot');
    assert.ok(exp >= 0 && Number.isFinite(exp));
    assert.ok(human >= 50 && human <= 7_000);
    assert.ok(bot >= 20 && bot <= 1_600);
    assert.ok(humanEntropy >= 0.05 && humanEntropy <= 3.5);
    assert.ok(botEntropy >= 0.02 && botEntropy <= 1.2);
  }
});
