// F-07-9 SCR-024 실제 API 판매 정책의 휴대폰 배치(I-01, AC-02). d5 §3.9: 표는 카드 목록으로 바꾸고,
// 규칙 편집·저장·JSON 보기·시뮬레이션·명단 올리기는 태블릿·데스크톱에서만 한다.
// 낱말 근접이 아니라 표→카드 전환과 카드 안의 값, 편집 구역 숨김을 구조로 본다. 기준 트리에서 실패한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./LiveSalePolicy.tsx', import.meta.url), 'utf8');

function between(startNeedle, endNeedle, from = 0) {
  const start = source.indexOf(startNeedle, from);
  assert.ok(start > -1, `${startNeedle}를 찾지 못했다`);
  const end = source.indexOf(endNeedle, start);
  assert.ok(end > start, `${startNeedle} 뒤의 ${endNeedle}를 찾지 못했다`);
  return { block: source.slice(start, end), start, end };
}

test('AC-02 데스크톱 규칙 표는 max-md:hidden 상자 안에 있고, 모바일 규칙 목록은 따로 있다', () => {
  const wrap = source.indexOf('table-wrap');
  const table = source.indexOf('<table', wrap);
  assert.ok(wrap > -1 && table > wrap, '규칙 표 또는 table-wrap이 없다');
  assert.match(source.slice(wrap, table), /max-md:hidden/, '규칙 표가 휴대폰에서 숨지 않는다');
  const mobile = between('aria-label="등록 규칙 목록"', '</ul>');
  assert.match(mobile.block, /rules\.map/, '모바일 규칙 카드 목록이 rules를 그리지 않는다');
  assert.match(mobile.block, /r\.name/, '카드에 규칙 이름이 없다');
  assert.match(mobile.block, /summaryOf\(r\)/, '카드에 조건 요약이 없다');
  assert.match(mobile.block, /초안/, '카드에 상태(초안)가 없다');
});

test('AC-02 규칙 편집·저장·JSON 보기는 max-md:hidden 구역 안에 있다', () => {
  const edit = between('aria-labelledby="h-live-edit"', '</section>');
  const sectionStart = source.lastIndexOf('<section', edit.start);
  assert.match(source.slice(sectionStart, edit.start), /max-md:hidden/, '규칙 편집 구역이 휴대폰에서 숨지 않는다');
  for (const label of ['판매 정책 저장', 'JSON 보기']) assert.ok(edit.block.includes(label), `편집 구역에 '${label}'이 없다`);
});

test('AC-02 시뮬레이션 구역은 max-md:hidden이고 안내 카드가 그 자리를 대신한다', () => {
  const sim = between('aria-labelledby="h-live-sim"', '</section>');
  const sectionStart = source.lastIndexOf('<section', sim.start);
  assert.match(source.slice(sectionStart, sim.start), /max-md:hidden/, '시뮬레이션 구역이 휴대폰에서 숨지 않는다');
  assert.match(source, /BigScreenNotice/);
  assert.match(source, /규칙 편집과 시뮬레이션은 태블릿이나 데스크톱에서 합니다/);
});

test('AC-02 새 규칙·명단 올리기는 휴대폰 조작으로 남기지 않는다', () => {
  const newRule = source.indexOf('새 규칙');
  assert.ok(newRule > -1, '새 규칙 버튼이 없다');
  const buttonStart = source.lastIndexOf('<button', newRule);
  assert.match(source.slice(buttonStart, newRule), /max-md:hidden/, '새 규칙 버튼이 휴대폰에서 숨지 않는다');

  const file = source.indexOf('id="live-list-file"');
  assert.ok(file > -1, '명단 파일 칸이 없다');
  const fieldStart = source.lastIndexOf('<div', file);
  assert.match(source.slice(fieldStart, file), /max-md:hidden/, '명단 올리기 칸이 휴대폰에서 숨지 않는다');
});

test('AC-02 불러오기·404·오류 상태는 폭과 무관하게 글로 남는다', () => {
  assert.match(source, /state === 'loading'/);
  assert.match(source, /state === 'notFound'/);
  assert.match(source, /state === 'error'/);
  assert.match(source, /role="alert"/);
});
