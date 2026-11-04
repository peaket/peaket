// 5만 석 배치 생성기 시험(BUILD_ORDER BAS-190, K5 PoC의 도구). 인수 시험 ID K5는 브라우저 측정(seatmap.spec.mjs)에만 단다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync } from 'node:zlib';
import { generateLayout, toObjectLayout, sizes, brotli, FLAG, DEFAULT_GRID } from './layout.mjs';

test('도구 미리 압축(brotli 11)은 풀면 원문이고 크기 표의 brotli 값과 같다(정적 서버가 layout.json.br로 준다)', () => {
  const text = JSON.stringify(generateLayout({ sections: 2, rows: 3, perRow: 4 }));
  const br = brotli(text);
  assert.equal(brotliDecompressSync(br).toString(), text);
  assert.equal(br.length, sizes(text).brotli);
});

test('도구 기본 배치는 5만 석이고 구역 색인 범위가 겹치지 않고 빈틈없이 이어진다', () => {
  const l = generateLayout();
  assert.equal(l.seatCount, 50_000);
  assert.equal(l.sections.length, DEFAULT_GRID.sections);
  let next = 0;
  for (const s of l.sections) {
    assert.equal(s.seatIndexRange.start, next);
    const n = s.seats.seatId.length;
    assert.equal(s.seatIndexRange.end, next + n - 1);
    for (const k of ['row', 'number', 'x', 'y', 'tier', 'flags']) assert.equal(s.seats[k].length, n, k);
    next += n;
  }
  assert.equal(next, 50_000);
});

test('도구 좌석 ID는 모두 다르고 좌표는 캔버스 안이며 같은 입력이면 같은 배치다', () => {
  const l = generateLayout();
  const ids = new Set(l.sections.flatMap((s) => s.seats.seatId));
  assert.equal(ids.size, 50_000);
  const { minX, minY, width, height } = l.canvas;
  for (const s of l.sections) {
    for (let i = 0; i < s.seats.x.length; i++) {
      assert.ok(s.seats.x[i] >= minX && s.seats.x[i] <= minX + width);
      assert.ok(s.seats.y[i] >= minY && s.seats.y[i] <= minY + height);
    }
  }
  assert.equal(JSON.stringify(generateLayout()), JSON.stringify(l));
});

test('도구 같은 열의 이웃 좌석은 좌석 간격(50cm)에서 흔들림(±5cm)을 뺀 만큼 이상 떨어진다', () => {
  const s = generateLayout().sections[0].seats;
  for (let i = 1; i < 100; i++) {
    const d = Math.hypot(s.x[i] - s.x[i - 1], s.y[i] - s.y[i - 1]);
    assert.ok(d >= 39, `${i}: ${d}`);
  }
});

test('도구 객체 배열 꼴은 같은 좌석을 openapi SeatMapLayout 칸으로 담는다', () => {
  const l = generateLayout({ sections: 2, rows: 2, perRow: 3 });
  const o = toObjectLayout(l);
  assert.equal(o.sections[1].seats[0].index, 6);
  assert.deepEqual(Object.keys(o.sections[0].seats[0]), ['seatId', 'index', 'row', 'number', 'x', 'y', 'tierId', 'wheelchair']);
  assert.equal(o.sections[0].seats.filter((x) => x.wheelchair).length, 2);
  assert.equal(l.sections[0].seats.flags.filter((f) => f & FLAG.WHEELCHAIR).length, 2);
});

test('도구 크기는 압축 전·gzip·brotli 바이트 수다', () => {
  const s = sizes('a'.repeat(10_000));
  assert.equal(s.raw, 10_000);
  assert.ok(s.gzip < 200 && s.brotli < 200);
});
