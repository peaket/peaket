// F-05-9 K10 하네스의 '실제 파일 계약' 시험(계획 docs/review/plans/F-05-9.md §8·§13).
// 목(mock)이 아니라 저장소에 있는 계획·실행 파일·설정을 그대로 읽어, 측정 준비가 빠지지 않았는지 본다.
// 측정값을 판정하지 않는다. 실제 판정은 측정 창의 k10-measure.spec.mjs가 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = process.cwd();
const read = (p) => readFileSync(resolve(here, p), 'utf8');
const plan = read('../../docs/review/plans/F-05-9.md');
const spec = read('scanner-k10/k10-measure.spec.mjs');
const fixture = read('scanner-k10/fixture.mjs');
const lib = read('scanner-k10/k10-lib.mjs');
const config = read('playwright.scanner-k10.config.mjs');

test('K10 시나리오 6종 계약: 계획에 S1~S6이 있고 하네스에 S3~S6이 있다', () => {
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) assert.match(plan, new RegExp(`\\| ${id} \\|`), `계획 §4에 ${id}이 없다`);
  for (const id of ['K10-S3', 'K10-S4', 'K10-S5', 'K10-S6']) assert.match(spec, new RegExp(id), `실행 파일에 ${id}이 없다`);
  // S1·S2는 기존 시험을 쓴다. 계획이 그 명령을 가리키는지 본다.
  assert.match(plan, /scanner-scan/, 'S1이 기존 scanner-scan 시험을 가리키지 않는다');
  assert.match(plan, /scanner-f054\.int\.test\.ts/, 'S2가 기존 통합 시험을 가리키지 않는다');
});

test('O-T40 계약: 전환 실행 3회·업로드 중·변경분 중·판정 시험이 있고 측정 전에는 미측정이다', () => {
  assert.match(spec, /K10-O-T40-a 전환 사이에 끊기 r1/);
  assert.match(spec, /K10-O-T40-a 전환 사이에 끊기 r2/);
  assert.match(spec, /K10-O-T40-a 전환 사이에 끊기 r3/);
  assert.match(spec, /K10-O-T40-b 업로드가 진행 중일 때/);
  assert.match(spec, /K10-O-T40-c 변경분 받기가 진행 중일 때/);
  assert.match(spec, /test\('O-T40 전환 앞뒤 판정이/);
  assert.match(plan, /O-T40 \(a\) 전환 사이 \| 미측정 \| 미측정 \| 미측정/);
  assert.match(lib, /export function judgeTransition/);
});

test('O-T41 계약: 온라인·오프라인 3회 실행과 판정 시험이 있고 90% 경계를 쓴다', () => {
  for (const condition of ['온라인', '오프라인']) {
    for (const run of [1, 2, 3]) assert.match(spec, new RegExp(`K10-O-T41 ${condition} r${run}`), `${condition} r${run} 시험이 없다`);
  }
  assert.match(spec, /test\('O-T41 오프라인 분당 통과 인원 중앙값이 온라인의 90% 이상이다'/);
  assert.match(lib, /laneRatioPercent: 90/);
  assert.match(lib, /export function judgeLane/);
  assert.match(plan, /O-T41 온라인 \| 미측정 \| 미측정 \| 미측정/);
  assert.match(plan, /O-T41 오프라인 \| 미측정 \| 미측정 \| 미측정/);
});

test('K10 측정 실행 계약: 측정 창에서만 돌고, 스캐너 빌드·Chromium·가짜 API를 쓴다', () => {
  assert.match(spec, /K10_MEASURE === '1'/);
  assert.match(spec, /test\.skip\(!RUN/);
  assert.match(fixture, /scanner-api\.peaket\.example/);
  assert.match(fixture, /BarcodeDetector/);
  assert.match(config, /a\.name === 'scanner'/);
  assert.match(config, /testMatch: \/k10-measure\\\.spec\\\.mjs\$/);
  assert.match(config, /devices\['Desktop Chrome'\]/);
  assert.match(plan, /## 14\. 검증/);
  assert.match(plan, /30k\/s\(F-04-8\), 100만·K1·K2·K7\(F-08-2·F-08-8\)/);
});
