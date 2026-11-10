// 등록 뒤 공연 이미지 올리기의 리뷰 재현 시험(BAT-145 리뷰 1차, ADR-0257 결정 4, docs/frontend.md §4.1 '기다림').
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canRetry, uploadImages } from './image-upload.ts';
import { IMAGE_TEXT, placePicked, runUploads } from './images.ts';

/** 서버 흉내: 상세 이미지를 받은 order 자리(넘으면 끝)에 넣는다 */
function fakeServer(fail) {
  const details = [];
  const sent = [];
  const send = async (_productionId, item, file) => {
    sent.push([file.name, item]);
    const f = fail.get(file.name);
    if (f) throw f;
    if (item.kind === 'DETAIL') details.splice(Math.min(item.order ?? details.length, details.length), 0, file.name);
  };
  return { details, sent, send };
}

const images = [
  { key: 'p', alt: '포스터' },
  { key: 'a', alt: 'A' },
  { key: 'b', alt: 'B' },
  { key: 'c', alt: 'C' },
];
const files = { p: { name: 'P' }, a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' } };

test('HOT-190 앞 줄이 실패한 뒤 [다시 올리기]해도 서버 상세 순서가 줄 차례와 같다(order는 앞선 상세 줄 가운데 올림 완료 장수)', async () => {
  const fail = new Map([
    ['A', { status: 415, type: 'image-type-unsupported', extensions: {} }],
    ['B', { status: 500, type: 'about:blank', extensions: {} }],
  ]);
  const s = fakeServer(fail);
  const first = await uploadImages({ productionId: 'P1', images, fileOf: (k) => files[k], send: s.send });
  assert.deepEqual(
    first.map((r) => [r.key, r.status]),
    [
      ['p', 'done'],
      ['a', 'error'],
      ['b', 'error'],
      ['c', 'done'],
    ],
  );
  assert.deepEqual(s.details, ['C']);
  fail.delete('B');
  const done = first.filter((r) => r.status === 'done').map((r) => r.key);
  await uploadImages({ productionId: 'P1', images, fileOf: (k) => files[k], send: s.send, only: ['b'], done });
  assert.deepEqual(s.details, ['B', 'C']);
  assert.deepEqual(s.sent.at(-1), ['B', { kind: 'DETAIL', alt: 'B', order: 0 }]);
});

test('HOT-190 503의 Retry-After는 하한이다: 남은 장은 보내지 않고 그 시각(하한 × (1 + 0~20%))까지 [다시 올리기]를 잠근다', async () => {
  const fail = new Map([['A', { status: 503, type: 'image-processing-unavailable', extensions: {}, retryFloorMs: 30_000 }]]);
  const s = fakeServer(fail);
  const out = await uploadImages({ productionId: 'P1', images, fileOf: (k) => files[k], send: s.send, now: () => 1_000, random: () => 0.5 });
  assert.deepEqual(
    s.sent.map(([n]) => n),
    ['P', 'A'],
  );
  const retryAt = 1_000 + 30_000 * 1.1;
  assert.deepEqual(
    out.map((r) => [r.key, r.status, r.retryAt]),
    [
      ['p', 'done', undefined],
      ['a', 'error', retryAt],
      ['b', 'error', retryAt],
      ['c', 'error', retryAt],
    ],
  );
  assert.equal(out[2].message, IMAGE_TEXT.unavailable);
  assert.equal(canRetry(out[1], retryAt - 1), false);
  assert.equal(canRetry(out[1], retryAt), true);
  assert.equal(canRetry(out[0], retryAt), false);
  assert.equal(canRetry({ key: 'x', kind: 'DETAIL', status: 'error', message: 'm' }, 0), true);
});

test('HOT-190 올리기가 401이면 남은 장을 보내지 않고 로그인으로 보낼 줄임을 알린다', async () => {
  const s = fakeServer(new Map([['A', { status: 401, type: 'about:blank', extensions: {} }]]));
  const out = await uploadImages({ productionId: 'P1', images, fileOf: (k) => files[k], send: s.send });
  assert.deepEqual(
    s.sent.map(([n]) => n),
    ['P', 'A'],
  );
  assert.deepEqual(
    out.map((r) => [r.key, r.status, r.unauthorized]),
    [
      ['p', 'done', undefined],
      ['a', 'error', true],
      ['b', 'error', true],
      ['c', 'error', true],
    ],
  );
});

test('HOT-190 올리기 코드 덩어리를 받지 못하면 올릴 줄을 모두 오류(다시 올리기 가능)로 둔다(올리는 중에 멈추지 않는다)', async () => {
  const seen = [];
  const out = await runUploads({ load: () => Promise.reject(new Error('ChunkLoadError')), productionId: 'P1', images, fileOf: (k) => files[k], send: async () => {}, only: ['a', 'c'], onEach: (r) => seen.push(r) });
  assert.deepEqual(out, [
    { key: 'a', kind: 'DETAIL', status: 'error', message: IMAGE_TEXT.unavailable },
    { key: 'c', kind: 'DETAIL', status: 'error', message: IMAGE_TEXT.unavailable },
  ]);
  assert.deepEqual(seen, out);
  assert.ok(out.every((r) => canRetry(r, 0)));
});

test('HOT-190 여러 장을 한꺼번에 고르면 복원한 빈 줄을 채우지 않고 새 줄로 붙인다(어느 대체 텍스트가 어느 그림인지는 줄마다 고른다)', () => {
  const restored = [
    { key: 'p', alt: '포스터 글' },
    { key: 'd', alt: '출연진 글' },
  ];
  let n = 0;
  const r = placePicked(restored, 2, () => `new${++n}`);
  assert.deepEqual(r, {
    list: [...restored, { key: 'new1', alt: '' }, { key: 'new2', alt: '' }],
    assigned: ['new1', 'new2'],
    overflow: 0,
  });
  // 11줄이 모두 복원한 줄이어도 새 줄은 더하지 않는다(그 줄들은 줄마다 [파일 고르기]로 채운다)
  const eleven = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, alt: `글 ${i}` }));
  assert.deepEqual(placePicked(eleven, 1, () => 'x'), { list: eleven, assigned: [], overflow: 1 });
});
