// 정본 값 읽기 시험(FE-T36 크기 예산, docs/frontend.md §5.8)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCssBudgets, loadCssBudgets, semanticColor, rgb } from './canon.mjs';

const MD = `### 5.8 성능 예산 표

| 경로 묶음 | 첫 JS | CSS | 체감 목표 |
| --- | --- | --- | --- |
| 대기실 경량 페이지 | 50KB 이하(정본) | 10KB 미만(정본), 목표 8KB [가정] | LCP |
| 결제 화면 | 180KB [가정] | 20KB [가정] | INP |

### 5.9 다음 절

| 다른 표 | x | 99KB | y |
`;

test('도구 §5.8 표의 CSS 열에서 경로 묶음마다 첫 숫자를 예산(kB)으로 읽는다', () => {
  assert.deepEqual([...parseCssBudgets(MD)], [
    ['대기실 경량 페이지', 10],
    ['결제 화면', 20],
  ]);
});

test('도구 §5.8 표가 없거나 CSS 칸에 숫자가 없으면 멈춘다', () => {
  assert.throws(() => parseCssBudgets('# 없음'), /5\.8/);
  assert.throws(() => parseCssBudgets(MD.replace('20KB [가정]', '미정')), /결제 화면/);
});

test('도구 정본 §5.8 표에서 화면 묶음 열의 예산을 읽는다', () => {
  const budgets = loadCssBudgets();
  for (const row of ['대기실 경량 페이지', '좌석 화면', '결제 화면', '월렛', '파트너 콘솔', '관제 콘솔', '스캐너']) {
    assert.ok(budgets.has(row), `${row} 행이 없다`);
    assert.ok(budgets.get(row) > 0);
  }
});

test('도구 의미 색을 별칭까지 풀고 브라우저 계산 스타일 꼴로 바꾼다', () => {
  assert.match(semanticColor('light', 'primary'), /^#[0-9a-f]{6}$/);
  assert.equal(rgb('#0a10ff'), 'rgb(10, 16, 255)');
});

// BAT-170 웨이브 7 T9(ASVS 3.6.1): 외부 스크립트 결정 표에서 허용 출처를 읽는다. 단언 값은 docs/frontend.md §5.14.2 표의 세 출처다.
test('도구 외부 스크립트 결정 표(§5.14.2)에서 다른 출처 호스트만 읽는다', async () => {
  const { parseExternalScriptHosts, loadExternalScriptHosts } = await import('./canon.mjs');
  const md = [
    '#### 5.14.2 외부 스크립트 결정(ASVS 3.6.1)',
    '',
    '| 스크립트 | 싣는 화면 | 결정 |',
    '| --- | --- | --- |',
    '| 사람 확인 `https://challenges.example.com/v0/api.js` | 로비 | 늦게 싣는다 |',
    '| 결제 SDK(`js.pay.example/v2/standard`) | 결제 | 적재기 `loadPay` |',
    '| 다른 SDK(`cdn.other.example/v2/sdk.js`, npm `@other/sdk`) | 결제 | npm 판 |',
    '',
    '#### 5.14.3 다음 절',
    '| 스크립트 | 결정 |',
    '| --- | --- |',
    '| `https://not-in-table.example/x.js` | 다음 표 |',
  ].join('\n');
  assert.deepEqual([...parseExternalScriptHosts(md)].sort(), ['cdn.other.example', 'challenges.example.com', 'js.pay.example']);
  assert.throws(() => parseExternalScriptHosts('# 표 없음'), /5\.14\.2/);
  // 정본 표(docs/frontend.md §5.14.2): Turnstile·토스페이먼츠·포트원
  assert.deepEqual([...loadExternalScriptHosts()].sort(), ['cdn.portone.io', 'challenges.cloudflare.com', 'js.tosspayments.com']);
});
