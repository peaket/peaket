// FE-T1 대기실 경량 페이지 예산(docs/frontend.md §5.8 '대기실 경량 페이지' 행, §5.17 FE-T1, BUILD_ORDER BAS-220).
// 크기 자체는 `pnpm --filter @peaket/queue-room size`(size-limit, 빌드 뒤)가 막는다. 이 시험은 그 한도가 정본 숫자와 같은지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const here = new URL('..', import.meta.url);
const md = readFileSync(new URL('../../../docs/frontend.md', here), 'utf8');
// 같은 이름의 행이 다른 표(§2.2)에도 있어 §5.8 절 안에서 찾는다
const lines = md.split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith('### 5.8 성능 예산 표'));
const row = lines.slice(start).find((l) => l.startsWith('| 대기실 경량 페이지 |'));
const limits = JSON.parse(readFileSync(new URL('.size-limit.json', here), 'utf8'));
const kB = (s) => Number(/^([\d.]+) kB$/.exec(s)?.[1]);

test('FE-T1 size-limit의 JS 한도는 §5.8 대기실 행의 첫 JS(이하)와 같고 gzip으로 잰다', () => {
  assert.ok(row, '§5.8에 대기실 경량 페이지 행이 없다');
  const js = Number(/^\| 대기실 경량 페이지 \| (\d+)KB 이하/.exec(row)?.[1]);
  const entry = limits.find((l) => l.path === 'dist/assets/*.js');
  assert.equal(entry?.gzip, true);
  assert.equal(kB(entry.limit), js);
});

test('FE-T1 size-limit의 CSS 한도는 §5.8 대기실 행의 CSS(미만)보다 작고 gzip으로 잰다', () => {
  const css = Number(/^\| 대기실 경량 페이지 \| [^|]+\| (\d+)KB 미만/.exec(row)?.[1]);
  const entry = limits.find((l) => l.path === 'dist/assets/*.css');
  assert.equal(entry?.gzip, true);
  assert.ok(kB(entry.limit) < css && kB(entry.limit) > css - 0.1, `${entry.limit} vs ${css}KB 미만`);
});
