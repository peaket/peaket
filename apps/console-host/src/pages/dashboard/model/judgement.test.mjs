// 위젯 아래 '판단:' 한 줄의 글(pages/dashboard/model/judgement.ts의 judgementOf(widgetKey)) 시험(F-03-3 T16, 시험 먼저 ADR-0372). 구현 전 트리에는 파일이 없어 가져오기부터 실패한다.
// 정본: docs/design/d5-screen-blueprint.md §7.2 '위젯의 연결 판단' 표(ADR-0069), docs/features/control-tower.md §2 '연결 판단'.
// 같은 글을 시험에 옮겨 적지 않고 d5 표를 읽어, 그 줄의 손잡이(명령 번호·런북 번호·엔지니어 호출)가 판단 글에 모두 있는지 본다(계획 §5 T16).
// 판단 글은 한 곳(model)에 두고 원격 위젯 자리(WidgetSlot)와 호스트 위젯이 함께 쓴다(계획 1-12). 표본은 셋: 버짓·결제사·포화도.
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../../shared/api/live/live.test.resolve.mjs', import.meta.url);

const D5 = readFileSync(new URL('../../../../../../docs/design/d5-screen-blueprint.md', import.meta.url), 'utf8');
function judgementRow(tab, widget) {
  const start = D5.indexOf('위젯의 연결 판단(추천 적용 2026-10-20, ADR-0069)');
  assert.ok(start > 0, 'd5 연결 판단 표를 찾지 못했다');
  const row = D5.slice(start)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(`| ${tab} | ${widget} |`));
  assert.ok(row, `d5 연결 판단 표에 '${tab} | ${widget}' 줄이 없다`);
  return row.split('|')[3].trim();
}
const handlesOf = (s) => [...new Set([...(s.match(/명령 \d+/g) ?? []), ...(s.match(/RB-\d+/g) ?? []), ...(s.includes('엔지니어') ? ['엔지니어'] : [])])];

test('F-03-3 T16 ② 판단 줄 표본 셋(버짓·결제사·포화도)은 d5 연결 판단 표 그 줄의 명령·런북·엔지니어 호출을 모두 담는다', async () => {
  const { judgementOf } = await import('./judgement.ts');
  const samples = [
    ['ops-budget.journeys', 'T=0·판매 중', '소진 배수·남은 허용 실패'],
    ['purchase-pg-status.summary', '판매 중', '결제사'],
    ['ops-saturation.summary', '판매 중', '포화도 요약'],
  ];
  const missing = samples.map(([key, tab, widget]) => {
    const line = judgementOf(key);
    assert.equal(typeof line, 'string', `${key}의 판단 글이 없다`);
    assert.ok(line.length > 0);
    const want = handlesOf(judgementRow(tab, widget));
    assert.ok(want.length > 0, `${widget} 줄에서 손잡이를 찾지 못했다`);
    return [key, want.filter((h) => !line.includes(h))];
  });
  assert.deepEqual(
    missing,
    samples.map(([key]) => [key, []]),
  );
});

test('F-03-3 T16 ③ 진단 힌트 위젯(ops-diagnostics.summary)에는 판단 줄이 없다(운영 명령이 없는 숫자라 판단 위젯과 나눈다)', async () => {
  const { judgementOf } = await import('./judgement.ts');
  assert.equal(judgementOf('ops-diagnostics.summary'), undefined);
});
