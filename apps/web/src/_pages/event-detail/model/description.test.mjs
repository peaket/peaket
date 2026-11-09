// 공연 설명 구조 문서 → 화면 블록(CMP-070, docs/frontend.md §5.14.3, ADR-0204, ADR-0244, ADR-0247)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingTags, toDescriptionBlocks } from './description.ts';
import { toEventDetail } from './detail.ts';

const text = (v, b) => ({ t: 'text', v, ...(b ? { b: true } : {}) });

test('허용 노드 다섯을 그대로 넘긴다', () => {
  const blocks = [
    { t: 'h', level: 2, c: [text('제목')] },
    { t: 'h', level: 3, c: [text('작은 제목')] },
    { t: 'p', c: [text('굵게', true), { t: 'br' }, text('<b>글자</b>')] },
    { t: 'ul', items: [[text('하나')]] },
    { t: 'ol', items: [[text('첫째')]] },
  ];
  assert.deepEqual(toDescriptionBlocks({ v: 1, blocks }), blocks);
});

test('빈 문단과 빈 목록 줄은 그리지 않는다', () => {
  assert.deepEqual(toDescriptionBlocks({ v: 1, blocks: [{ t: 'p', c: [] }, { t: 'p', c: [text('a')] }, { t: 'ul', items: [[], [text('b')]] }, { t: 'ol', items: [[]] }] }), [
    { t: 'p', c: [text('a')] },
    { t: 'ul', items: [[text('b')]] },
  ]);
});

test('모르는 판·노드가 하나라도 있으면 null이다(글자판으로 그린다)', () => {
  assert.equal(toDescriptionBlocks(undefined), null);
  assert.equal(toDescriptionBlocks('x'), null);
  assert.equal(toDescriptionBlocks({ v: 2, blocks: [] }), null);
  assert.equal(toDescriptionBlocks({ v: 1, blocks: 'x' }), null);
  assert.equal(toDescriptionBlocks({ v: 1, blocks: [{ t: 'video' }] }), null);
  assert.equal(toDescriptionBlocks({ v: 1, blocks: [{ t: 'p', c: [{ t: 'img', src: 'x' }] }] }), null);
  assert.equal(toDescriptionBlocks({ v: 1, blocks: [{ t: 'h', level: 1, c: [text('a')] }] }), null);
  assert.equal(toDescriptionBlocks({ v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: 1 }] }] }), null);
  assert.equal(toDescriptionBlocks({ v: 1, blocks: [{ t: 'ul', items: 'x' }] }), null);
});

test('내용이 없으면 null이다', () => {
  assert.equal(toDescriptionBlocks({ v: 1, blocks: [] }), null);
  assert.equal(toDescriptionBlocks({ v: 1, blocks: [{ t: 'p', c: [] }] }), null);
});

const api = (o = {}) => ({
  eventId: '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01',
  productionId: '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4d01',
  title: 'LUMEN',
  startsAt: '2026-12-24T10:00:00.000Z',
  openAt: '2026-11-20T11:00:00.000Z',
  saleEndsAt: '2026-12-23T10:00:00.000Z',
  sellerName: '(주)피켓공연',
  ...o,
});

test('공연 상세: 구조 문서가 있으면 블록을, 없으면 글자판 문단을 준다', () => {
  const doc = { v: 1, blocks: [{ t: 'p', c: [text('서식 글', true)] }] };
  const a = toEventDetail(api({ description: doc, descriptionText: '서식 글' }));
  assert.deepEqual(a.descriptionBlocks, doc.blocks);
  assert.equal(a.hasDetail, true);
  const b = toEventDetail(api({ descriptionText: '글자판' }));
  assert.equal(b.descriptionBlocks, null);
  assert.deepEqual(b.description, ['글자판']);
  const c = toEventDetail(api({ description: { v: 9, blocks: [] }, descriptionText: '글자판' }));
  assert.equal(c.descriptionBlocks, null);
  assert.deepEqual(c.description, ['글자판']);
});

test('리뷰 재현: 제목 차례를 건너뛰지 않는다(절 제목이 h2)', () => {
  const h = (level) => ({ t: 'h', level, c: [text('x')] });
  const p = { t: 'p', c: [text('y')] };
  assert.deepEqual(headingTags([h(3), p, h(3)]), ['h3', null, 'h3']);
  assert.deepEqual(headingTags([h(2), h(3), p, h(2), h(3)]), ['h3', 'h4', null, 'h3', 'h4']);
  assert.deepEqual(headingTags([h(3), h(2), h(3)]), ['h3', 'h3', 'h4']);
});
