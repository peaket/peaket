// F-04-18 후보 패널 화면 배선 시험. 정본: docs/features/forensic-replay.md §2.1~§2.3·§3.1·§3.3, d5 §7.17.
// 순수 모델은 candidate.test.mjs가 값으로 보고, 이 파일은 화면 파일이 그 모델을 실제로 잇는지 소스로 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OPERATING = resolve(process.cwd(), 'src/operating');
const WORKERS = resolve(process.cwd(), 'src/workers');
const REPLAY = resolve(process.cwd(), 'src/lib/replay');

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

function readReplay(name) {
  const path = resolve(REPLAY, name);
  assert.ok(existsSync(path), `재생 모듈 src/lib/replay/${name}이 없다`);
  return readFileSync(path, 'utf8');
}

function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function allSources() {
  const out = [];
  for (const root of [OPERATING, REPLAY, WORKERS]) {
    if (!existsSync(root)) continue;
    const visit = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.(ts|tsx)$/.test(path)) out.push({ path, source: codeOnly(readFileSync(path, 'utf8')) });
      }
    };
    visit(root);
  }
  assert.ok(out.length > 0, '운영 화면·재생 모듈 파일이 없다');
  return out;
}

test('FX-T9 ①⑨ 후보 패널은 원천에 맞는 제목·문구와 표 보기를 늘 두고, 합성에서만 정밀도를 보인다', () => {
  const panel = readOperating('CandidatePanel.tsx');
  const main = readOperating('ReplayMain.tsx');

  assert.match(panel, /candidatePanelKind\(/, '원천별 패널 종류를 고르지 않는다');
  assert.match(panel, /panelSections\(/, '원천별로 보일 부분을 고르지 않는다');
  assert.match(panel, /candidateNotice\(/, '원천별 고정 문구를 그리지 않는다');
  assert.match(panel, /<ScatterPlot/, '합성 산점도를 그리지 않는다');
  assert.match(panel, /<DistributionPlot/, '연구 한 축 분포를 그리지 않는다');
  assert.match(panel, /<StepBaseline/, '조사 기준선을 그리지 않는다');
  assert.match(panel, /sections\.precision/, '합성에서만 정밀도를 보이는 분기가 없다');
  assert.match(panel, /precisionNotice\(/, '합성 정밀도 경고를 그리지 않는다');
  assert.match(panel, /selectionStats\(/, '합성 정답 기준 정밀도·재현율을 세지 않는다');
  assert.match(panel, /candidateTableRows\(/, '요약 표를 같은 모델에서 만들지 않는다');
  assert.match(panel, /histogramRows\(/, '연구 분포 표를 같은 히스토그램에서 만들지 않는다');
  assert.match(panel, /표로 보기/, '후보 패널에 표로 보기가 없다');
  assert.match(panel, /ReplayTable/, '후보 패널이 공용 표를 쓰지 않는다');
  assert.match(main, /<CandidatePanel/, '재생 화면이 후보 패널을 넣지 않는다');
  assert.match(main, /filter=/, '재생 화면이 교차 필터를 후보 패널에 넘기지 않는다');
});

test('FX-T9 ⑤ 후보 영역을 고르면 그 세션의 좌석을 점등하고 지우면 점등을 지운다', () => {
  const panel = readOperating('CandidatePanel.tsx');
  const main = readOperating('ReplayMain.tsx');
  const seat = readOperating('SeatReplay.tsx');

  assert.match(panel, /selectionMask\(/, '교차 필터를 후보 계산에 잇지 않는다');
  assert.match(panel, /maskToKeep\(/, '필터 마스크를 keep 배열로 바꾸지 않는다');
  assert.match(panel, /seatsOfSessions\(/, '고른 세션의 좌석을 고르지 않는다');
  assert.match(panel, /onHighlight\(\[\]\)/, '고르기를 지울 때 점등을 지우지 않는다');
  assert.match(panel, /onHighlight\(/, '고른 좌석을 화면에 넘기지 않는다');
  assert.match(main, /highlight/, '고른 좌석 상태가 없다');
  assert.match(main, /<SeatReplay/, '좌석 리플레이를 그리지 않는다');
  assert.match(main, /highlight=/, '좌석 리플레이에 고른 좌석을 넘기지 않는다');
  assert.match(seat, /highlight/, '좌석 리플레이가 고른 좌석을 받지 않는다');
  assert.match(seat, /고른 영역/, '고른 영역 범례가 없다');
  assert.match(seat, /strokeRect/, '고른 좌석에 굵은 테두리를 그리지 않는다');
});

test('UI-11 ② 산점도는 로그 눈금을 쓰고, WebGL2가 없으면 2D 표본으로 그린다', () => {
  const scatter = readOperating('ScatterPlot.tsx');
  assert.match(scatter, /scatterPosition\(/, '로그 가로축·선형 세로축 위치를 쓰지 않는다');
  assert.match(scatter, /webgl2Available\(/, 'WebGL2 지원을 보지 않는다');
  assert.match(scatter, /renderPlan\(/, '2D 표본 계획을 만들지 않는다');
  assert.match(scatter, /samplePoints\(/, '2D 표본을 고르지 않는다');
  assert.match(scatter, /map2dLabel\(/, '2D 대체 안내를 보이지 않는다');
  assert.match(scatter, /getContext\(/, '캔버스 컨텍스트를 얻지 않는다');
  assert.match(scatter, /['"]2d['"]/, '2D 컨텍스트를 쓰지 않는다');
});

test('UI-12 ② 상태 띠는 필터·프레임·긴 작업과 복사 방식을 보이고, 잰 값이 없으면 —를 쓴다', () => {
  const strip = readOperating('PerfStrip.tsx');
  const main = readOperating('ReplayMain.tsx');
  assert.match(strip, /perfStatus\(/, '성능 값을 판정하지 않는다');
  assert.match(strip, /clockModeLabel\(/, '공유 시계 사용 여부를 보이지 않는다');
  assert.match(strip, /SHARED_CLOCK_ENABLED/, '공유 시계를 켰는지 상수를 쓰지 않는다');
  assert.doesNotMatch(strip, /isolationLabel\(/, '격리 여부를 공유 메모리 사용처럼 보인다');
  assert.match(strip, /필터/, '필터 반영 시간이 없다');
  assert.match(strip, /프레임/, '프레임 시간이 없다');
  assert.match(strip, /긴 작업/, '긴 작업 수가 없다');
  assert.match(strip, /—/, '측정 없음을 —로 보이지 않는다');
  assert.match(strip, /filterP95/, '필터 p95 값이 없다');
  assert.match(strip, /frameP95/, '프레임 p95 값이 없다');
  assert.match(main, /<PerfStrip/, '재생 화면이 상태 띠를 넣지 않는다');
});

test('UI-13 ② [ASVS v5.0.0-1.1.2·1.4.1·3.7.1] Worker 계산·HTML 금지·WebAssembly/WebGPU 금지를 지킨다', () => {
  const hook = readOperating('useCandidateWorker.ts');
  const worker = readWorker('candidate.worker.ts');
  const baseline = readOperating('StepBaseline.tsx');

  assert.match(hook, /new Worker\(new URL\(/, '후보 Worker를 상대 주소로 만들지 않는다');
  assert.match(hook, /\{\s*type:\s*['"]module['"]\s*\}/, 'Worker를 module 형식으로 만들지 않는다');
  assert.match(hook, /candidateRequest\(/, '요청 복사본·전송 목록을 만들지 않는다');
  assert.match(hook, /decodeWorkerMessage\(/, 'Worker 응답을 검사하지 않는다');
  assert.match(hook, /postMessage\(/, 'Worker에 계산을 맡기지 않는다');
  assert.match(hook, /candidateModel\(/, 'Worker가 없을 때 메인 스레드 계산이 없다');
  assert.match(hook, /catch/, 'Worker 오류를 잡아 메인 계산으로 돌아가지 않는다');
  assert.match(hook, /terminate\(/, '화면을 떠날 때 Worker를 끝내지 않는다');

  assert.match(worker, /onmessage/, 'Worker가 메시지를 받지 않는다');
  assert.match(worker, /decodeWorkerMessage\(/, 'Worker가 메시지 형식을 검사하지 않는다');
  assert.match(worker, /candidateModel\(/, 'Worker가 같은 순수 함수를 쓰지 않는다');
  assert.match(worker, /candidateDoneBuffers\(/, 'Worker 응답 버퍼를 전송 목록으로 넘기지 않는다');
  assert.match(worker, /postMessage\(/, 'Worker가 결과를 돌려주지 않는다');
  assert.doesNotMatch(worker, /new\s+SharedArrayBuffer|SharedArrayBuffer\s*\(/, 'Worker가 공유 메모리를 쓴다');
  assert.doesNotMatch(worker, /\bAtomics\./, 'Worker가 Atomics를 쓴다');

  // 조사 기준선은 묶음 계정의 단계별 점과 묶음 밖 1·50·99 띠를 함께 그린다.
  assert.match(baseline, /journeys\(/, '묶음 계정 여정을 그리지 않는다');
  assert.match(baseline, /stageDurations\(/, '묶음 계정 단계 시간을 그리지 않는다');
  assert.match(baseline, /stageBands\(/, '묶음 밖 기준선 띠를 그리지 않는다');
  assert.match(baseline, /baselineRows\(/, '기준선 표를 만들지 않는다');

  // ASVS 1.1.2·1.4.1·3.7.1: HTML 문자열·WebAssembly·WebGPU를 쓰지 않고, 글자는 Canvas fillText로 그린다.
  for (const { path, source } of allSources()) {
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/, `${path}에 HTML 문자열 주입이 있다`);
    assert.doesNotMatch(source, /WebAssembly/, `${path}에 WebAssembly가 있다`);
    assert.doesNotMatch(source, /navigator\.gpu|WebGPU|GPUDevice/, `${path}에 WebGPU가 있다`);
  }
  for (const name of ['ScatterPlot.tsx', 'DistributionPlot.tsx', 'StepBaseline.tsx']) {
    assert.match(codeOnly(readOperating(name)), /fillText\(/, `${name}이 Canvas 글자(fillText)를 쓰지 않는다`);
  }
  assert.doesNotMatch(codeOnly(readReplay('candidate.ts')), /WebAssembly/, '후보 모델이 WebAssembly를 쓴다');
  assert.doesNotMatch(codeOnly(readReplay('chart-runtime.ts')), /WebGPU|navigator\.gpu/, '차트 런타임이 WebGPU를 쓴다');
});
