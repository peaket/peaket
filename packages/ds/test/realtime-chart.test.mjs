// 실시간 그래프가 들고 있는 양의 상한과 실시간 방식 설정(F-03-2 OPS-360 T17, CMP-033).
// 정본: ADR-0091 결정 4 '보관 상한'(관제 그래프 한 선은 최근 15분(1초 점 900개) [가정]만 고리 버퍼에, 그래프 한 장의 선은 6개 [가정]까지),
// docs/frontend.md §5.7 '그래프와 들고 있는 양'(x축 linear 밀리초·parsing: false·normalized: true·animation: false·축 최소·최대·update('none')·
// Decimation min-max), ADR-0361 결정 11. 단언 값은 정본에서 가져오고 코드 상수를 옮기지 않는다(경계 899·900·901, 선 5·6·7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RingChartData, RingSeries } from '../src/components/TimeSeriesChart/ring-series.ts';
import { REALTIME_UPDATE_MODE, realtimeChartOptions } from '../src/components/TimeSeriesChart/realtime.ts';

const CANON = { points: 900, series: 6, windowMs: 15 * 60_000 };

test('F-03-2 T17 ① 한 선의 고리 버퍼는 기본 900점을 넘지 않고 오래된 점부터 버린다(899·900·901)', () => {
  const s = new RingSeries();
  for (let i = 0; i < CANON.points - 1; i += 1) s.push(i * 1_000, i);
  assert.equal(s.size, 899);
  assert.deepEqual(s.toArray()[0], { x: 0, y: 0 });
  s.push(899_000, 899);
  assert.equal(s.size, 900);
  assert.deepEqual(s.toArray()[0], { x: 0, y: 0 });
  assert.deepEqual(s.toArray().at(-1), { x: 899_000, y: 899 });
  s.push(900_000, 900);
  assert.equal(s.size, 900, '901번째 점에도 900개');
  const arr = s.toArray();
  assert.equal(arr.length, 900);
  assert.deepEqual(arr[0], { x: 1_000, y: 1 }, '가장 오래된 점이 빠졌다');
  assert.deepEqual(arr.at(-1), { x: 900_000, y: 900 });
  // 오래된 것부터 차례대로(x가 늘기만 한다)
  assert.ok(arr.every((p, i) => i === 0 || p.x > arr[i - 1].x));
  // 많이 넣어도 900개(한참 돈 뒤에도 차례가 맞다)
  for (let i = 901; i < 5_000; i += 1) s.push(i * 1_000, i);
  assert.equal(s.toArray().length, 900);
  assert.deepEqual(s.toArray()[0], { x: (5_000 - 900) * 1_000, y: 5_000 - 900 });
  // 비우면 0
  s.clear();
  assert.deepEqual(s.toArray(), []);
});

test('F-03-2 T17 ② 한 장의 선은 기본 6개를 넘지 않고 먼저 들어온 선부터 버리며, 선마다 900점이다', () => {
  const c = new RingChartData();
  for (const id of ['a', 'b', 'c', 'd', 'e']) c.push(id, 0, 1);
  assert.deepEqual(c.ids(), ['a', 'b', 'c', 'd', 'e']);
  c.push('f', 0, 1);
  assert.deepEqual(c.ids(), ['a', 'b', 'c', 'd', 'e', 'f'], '6선까지');
  c.push('g', 0, 1);
  assert.deepEqual(c.ids(), ['b', 'c', 'd', 'e', 'f', 'g'], '7번째 선이 오면 먼저 들어온 a를 버린다');
  assert.deepEqual(c.pointsOf('a'), []);
  // 있는 선에 점을 더해도 선 수는 그대로
  c.push('b', 1_000, 2);
  assert.deepEqual(c.ids(), ['b', 'c', 'd', 'e', 'f', 'g']);
  for (let i = 0; i < 2 * CANON.points; i += 1) c.push('g', i * 1_000, i);
  assert.equal(c.pointsOf('g').length, 900);
  assert.equal(c.totalPoints, 900 + 2 + 4, '들고 있는 점 합이 상한 안(g 900 + b 2 + c·d·e·f 1씩)');
  assert.ok(c.totalPoints <= CANON.points * CANON.series);
});

test('F-03-2 T17 ③ 실시간 방식 설정은 x축 linear(창 끝 now, 기본 창 15분)·parsing false·normalized·animation false·Decimation min-max이고 갱신은 update(\'none\')다', () => {
  const now = Date.parse('2026-11-23T01:00:00.000Z');
  const o = realtimeChartOptions({ now, grid: '#222', ink: '#999' });
  assert.equal(o.animation, false);
  assert.equal(o.parsing, false);
  assert.equal(o.normalized, true);
  assert.deepEqual(o.plugins.decimation, { enabled: true, algorithm: 'min-max' });
  assert.equal(o.scales.x.type, 'linear');
  assert.equal(o.scales.x.max, now);
  assert.equal(o.scales.x.max - o.scales.x.min, CANON.windowMs);
  assert.equal(realtimeChartOptions({ now, windowMs: 60_000, grid: '#222', ink: '#999' }).scales.x.min, now - 60_000);
  // 눈금 글자는 KST 시:분:초
  assert.equal(o.scales.x.ticks.callback(now), '10:00:00');
  assert.equal(REALTIME_UPDATE_MODE, 'none');
  // 부품이 값 바뀜에 그래프를 새로 만들지 않고 이 방식으로 고친다(부품 원본의 chart.update 호출이 이것 하나다)
  const code = readFileSync(new URL('../src/components/TimeSeriesChart/TimeSeriesChart.tsx', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  assert.deepEqual([...code.matchAll(/\bchart\.update\(([^)]*)\)/g)].map((m) => m[1]), ['REALTIME_UPDATE_MODE']);
});
