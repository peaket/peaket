// F-04-17 운영 재생 화면 연결 시험. 정본: docs/features/forensic-replay.md §2.1·§2.3·§4.2·§6.8, d5 §7.17.
// 순수 모델은 다른 시험이 값으로 보고, 이 파일은 화면 파일이 그 모델을 실제로 잇는지 소스로 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'src/operating');
const REPLAY = resolve(process.cwd(), 'src/lib/replay');

function read(name) {
  const path = resolve(ROOT, name);
  assert.ok(existsSync(path), `운영 화면 src/operating/${name}이 없다`);
  return readFileSync(path, 'utf8');
}

function operatingSources() {
  assert.ok(existsSync(ROOT), '운영 화면 폴더(src/operating)가 없다');
  return readdirSync(ROOT)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => ({ name: f, source: readFileSync(resolve(ROOT, f), 'utf8') }));
}

test('FX-T21 ⑥ 운영 화면은 해독·검증·재생 준비를 순서대로 잇는다', () => {
  const app = read('OperatingApp.tsx');
  const calls = [
    'replayOperation',
    'replayHeadersIssue',
    'arrayBuffer',
    'replayEnvelopeOf',
    'replayFileIssue',
    'decodeArrowIpc',
    'validateDecodedReplay',
    'prepareReplay',
  ];
  const order = calls.map((name) => app.indexOf(`${name}(`));
  for (let i = 0; i < order.length; i += 1) assert.ok(order[i] >= 0, `OperatingApp이 ${calls[i]}을 부르지 않는다`);
  for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], `${calls[i - 1]} 다음에 ${calls[i]} 순서가 아니다`);
  assert.ok(app.indexOf('replayFileIssue(') < app.indexOf('replayFileValidation('), 'F-04-16 검증 경계가 남아 있어야 한다');
  assert.match(app, /setFile\(null\)/, '화면을 떠날 때 파일을 지우지 않는다');
  assert.match(app, /setSession\(null\)/, '화면을 떠날 때 재생 세션을 지우지 않는다');
  assert.match(app, /AbortController/, '받기를 멈추는 신호가 없다');
  assert.match(app, /<ReadyMain/, '받은 뒤 준비 상태를 보이지 않는다');
  assert.match(app, /<ReplayMain/, '해독·검증 뒤 재생 화면을 그리지 않는다');

  const ipcPath = resolve(REPLAY, 'arrow-ipc.ts');
  const purePath = resolve(REPLAY, 'arrow.ts');
  assert.ok(existsSync(ipcPath), 'Arrow IPC 읽기(src/lib/replay/arrow-ipc.ts)가 없다');
  assert.ok(existsSync(purePath), 'Arrow 표 해독(src/lib/replay/arrow.ts)이 없다');
  const ipc = readFileSync(ipcPath, 'utf8');
  const pure = readFileSync(purePath, 'utf8');
  assert.match(ipc, /from\s+['"]apache-arrow['"]/);
  assert.doesNotMatch(pure, /apache-arrow/);
  for (const { name, source } of operatingSources()) {
    assert.doesNotMatch(source, /from\s+['"]apache-arrow['"]/, `${name}이 apache-arrow를 직접 가져온다`);
  }
});

test('FX-T8 ① 타임라인은 role=slider와 aria-value*로 키보드 값을 알린다', () => {
  const timeline = read('ReplayTimeline.tsx');
  assert.match(timeline, /role=["']slider["']/, '타임라인이 슬라이더 역할을 쓰지 않는다');
  assert.match(timeline, /aria-valuemin/, 'aria-valuemin이 없다');
  assert.match(timeline, /aria-valuemax/, 'aria-valuemax가 없다');
  assert.match(timeline, /aria-valuenow/, 'aria-valuenow가 없다');
  assert.match(timeline, /tabIndex/, '키보드 초점을 받지 못한다');
  assert.match(timeline, /onKeyDown/, '키보드 처리기가 없다');
  assert.match(timeline, /timelineKey\(/, '키보드 상태 전이를 부르지 않는다');
  assert.match(timeline, /parseOffset\(/, '숫자 입력을 읽지 않는다');
  assert.match(timeline, /rangeFromInput\(/, '숫자 입력 구간을 만들지 않는다');
  assert.match(timeline, /[×]1|[×]10|[×]60/, '배속 단추가 없다');

  const main = read('ReplayMain.tsx');
  assert.match(main, /requestAnimationFrame/, '재생을 프레임으로 돌리지 않는다');
  assert.match(main, /cancelAnimationFrame/, '재생 프레임을 정리하지 않는다');
  assert.match(main, /advancePlayback\(/, '재생 위치를 진행하지 않는다');
  assert.match(main, /reconstructAt\(/, '재생 위치의 좌석 상태를 만들지 않는다');
});

test('FX-T8 ④ 타임라인·요약·기준선에 표로 보기가 있다', () => {
  const all = operatingSources();
  const text = all.map((f) => f.source).join('\n');
  const toggles = text.match(/표로 보기/g) ?? [];
  assert.ok(toggles.length >= 3, `표로 보기 단추가 3개 미만이다(${toggles.length})`);
  const tableFile = all.find((f) => f.source.includes('<table'));
  assert.ok(tableFile, '표를 그리는 파일이 없다');
  assert.match(tableFile.source, /<caption/, '표에 caption이 없다');
  assert.match(tableFile.source, /<th/, '표에 머리 칸이 없다');
});

test('FX-T21 ⑥ 버린 사건 warning 띠가 정본 문구를 쓴다', () => {
  const main = read('ReplayMain.tsx');
  assert.match(main, /droppedNotice\(/, '버린 사건 수를 정본 문구로 만들지 않는다');
  assert.match(main, /role=["']status["']/, '버린 사건 띠에 알림 역할이 없다');
  assert.match(main, /aria-live/, '버린 사건 띠에 aria-live가 없다');
  const sessionPath = resolve(REPLAY, 'session.ts');
  assert.ok(existsSync(sessionPath), '재생 세션(src/lib/replay/session.ts)이 없다');
  const session = readFileSync(sessionPath, 'utf8');
  assert.match(session, /규칙에 맞지 않는 사건/, '정본 문구가 없다');
  assert.match(session, /prepareReplay\(/, '재생 세션을 만들지 않는다');
});
