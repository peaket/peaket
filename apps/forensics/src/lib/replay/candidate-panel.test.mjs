// F-04-18 후보 패널 화면 배선 시험. 정본: docs/features/forensic-replay.md §2.1~§2.3·§3.1·§3.3, d5 §7.17.
// 순수 모델은 candidate.test.mjs가 값으로 보고, 이 파일은 화면 파일이 그 모델을 실제로 잇는지 소스로 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OPERATING = resolve(process.cwd(), 'src/operating');
const WORKERS = resolve(process.cwd(), 'src/workers');

function readOperating(name) {
  const path = resolve(OPERATING, name);
  assert.ok(existsSync(path), `운영 화면 src/operating/${name}이 없다`);
  return readFileSync(path, 'utf8');
}

function readWorker(name) {
  const path = resolve(WORKERS, name);
  assert.ok(existsSync(path), `Worker src/workers/${name}이 없다`);
  return readFileSync(path, 'utf8');
}

test('FX-T9 ① 후보 패널은 원천에 맞는 제목·문구와 표 보기를 늘 둔다', () => {
  const panel = readOperating('CandidatePanel.tsx');
  const main = readOperating('ReplayMain.tsx');

  assert.match(panel, /candidatePanelKind\(/, '원천별 패널 종류를 고르지 않는다');
  assert.match(panel, /candidateNotice\(/, '원천별 고정 문구를 그리지 않는다');
  assert.match(panel, /<ScatterPlot/, '합성 산점도를 그리지 않는다');
  assert.match(panel, /<DistributionPlot/, '연구 한 축 분포를 그리지 않는다');
  assert.match(panel, /<StepBaseline/, '조사 기준선을 그리지 않는다');
  assert.match(panel, /precisionNotice\(/, '합성 정밀도 경고를 그리지 않는다');
  assert.match(panel, /selectionStats\(/, '합성 정답 기준 정밀도·재현율을 세지 않는다');
  assert.match(panel, /표로 보기/, '후보 패널에 표로 보기가 없다');
  assert.match(panel, /ReplayTable/, '후보 패널이 공용 표를 쓰지 않는다');
  assert.match(main, /<CandidatePanel/, '재생 화면이 후보 패널을 넣지 않는다');
});

test('FX-T9 ⑤ 후보 영역을 고르면 그 세션의 좌석을 좌석맵에 점등한다', () => {
  const panel = readOperating('CandidatePanel.tsx');
  const main = readOperating('ReplayMain.tsx');
  const seat = readOperating('SeatReplay.tsx');

  assert.match(panel, /seatsOfSessions\(/, '고른 세션의 좌석을 고르지 않는다');
  assert.match(panel, /onHighlight\(/, '고른 좌석을 화면에 넘기지 않는다');
  assert.match(main, /highlight/, '고른 좌석 상태가 없다');
  assert.match(main, /<SeatReplay/, '좌석 리플레이를 그리지 않는다');
  assert.match(main, /highlight=/, '좌석 리플레이에 고른 좌석을 넘기지 않는다');
  assert.match(seat, /highlight/, '좌석 리플레이가 고른 좌석을 받지 않는다');
  assert.match(seat, /고른 영역/, '고른 영역 범례가 없다');
  assert.match(seat, /strokeRect/, '고른 좌석에 굵은 테두리를 그리지 않는다');
});

test('UI-11 ② 산점도는 WebGL2를 먼저 보고 없으면 2D 표본으로 그린다', () => {
  const scatter = readOperating('ScatterPlot.tsx');
  assert.match(scatter, /webgl2Available\(/, 'WebGL2 지원을 보지 않는다');
  assert.match(scatter, /renderPlan\(/, '2D 표본 계획을 만들지 않는다');
  assert.match(scatter, /samplePoints\(/, '2D 표본을 고르지 않는다');
  assert.match(scatter, /map2dLabel\(/, '2D 대체 안내를 보이지 않는다');
  assert.match(scatter, /getContext\(/, '캔버스 컨텍스트를 얻지 않는다');
  assert.match(scatter, /['"]2d['"]/, '2D 컨텍스트를 쓰지 않는다');
});

test('UI-12 ② 상태 띠는 필터·프레임·긴 작업·공유 메모리 값을 보인다', () => {
  const strip = readOperating('PerfStrip.tsx');
  const main = readOperating('ReplayMain.tsx');
  assert.match(strip, /perfStatus\(/, '성능 값을 판정하지 않는다');
  assert.match(strip, /isolationLabel\(/, '공유 메모리 여부를 보이지 않는다');
  assert.match(strip, /필터/, '필터 반영 시간이 없다');
  assert.match(strip, /프레임/, '프레임 시간이 없다');
  assert.match(strip, /긴 작업/, '긴 작업 수가 없다');
  assert.match(main, /<PerfStrip/, '재생 화면이 상태 띠를 넣지 않는다');
});

test('UI-13 ② 후보 계산은 Worker에 맡기고 없으면 메인 스레드의 같은 함수로 계산한다', () => {
  const hook = readOperating('useCandidateWorker.ts');
  const worker = readWorker('candidate.worker.ts');

  assert.match(hook, /new Worker\(/, '후보 Worker를 만들지 않는다');
  assert.match(hook, /decodeWorkerMessage\(/, 'Worker 응답을 검사하지 않는다');
  assert.match(hook, /postMessage\(/, 'Worker에 계산을 맡기지 않는다');
  assert.match(hook, /\.buffer/, 'Worker에 전송할 버퍼를 넘기지 않는다');
  assert.match(hook, /candidateModel\(/, 'Worker가 없을 때 메인 스레드 계산이 없다');
  assert.match(hook, /terminate\(/, '화면을 떠날 때 Worker를 끝내지 않는다');

  assert.match(worker, /onmessage/, 'Worker가 메시지를 받지 않는다');
  assert.match(worker, /decodeWorkerMessage\(/, 'Worker가 메시지 형식을 검사하지 않는다');
  assert.match(worker, /candidateModel\(/, 'Worker가 같은 순수 함수를 쓰지 않는다');
  assert.doesNotMatch(worker, /SharedArrayBuffer/, 'Worker가 공유 메모리를 쓴다');
});
