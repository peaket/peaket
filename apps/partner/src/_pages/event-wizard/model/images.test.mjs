// 공연 이미지 입력·임시저장·등록 뒤 올리기(SCR-021 1단계 CMP-069, d5 §6.4, ADR-0257 결정 4). 순수 함수와 임시저장 관리만 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DraftKeeper } from './draft-keeper.ts';
import { emptyDraft, parseDraft, serializeDraft } from './form.ts';
import { uploadImages } from './image-upload.ts';
import { altIssue, fileIssue, headerSize, IMAGE_TEXT, imageErrors, moveImage, placePicked, sizeIssue, uploadPlan, uploadProblemText } from './images.ts';

const png = (extra = []) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 0x20, 0, 0, 4, 0, 8, 6, 0, 0, 0, 0, 0, 0, 0, ...extra]);
const chunk = (type, len = 0) => [0, 0, 0, len, ...[...type].map((c) => c.charCodeAt(0)), ...new Array(len).fill(0), 0, 0, 0, 0];
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const webp = (flags = 0) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 30, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...[...'VP8X'].map((c) => c.charCodeAt(0)), 10, 0, 0, 0, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

test('화면 검사: 형식은 파일 앞부분·Content-Type·확장자가 같아야 하고, 10MB를 넘거나 움직이는 이미지면 d5 문구로 막는다', () => {
  const MB10 = 10 * 1024 * 1024;
  assert.equal(fileIssue({ head: png(), type: 'image/png', name: 'a.PNG', size: MB10 }), null);
  assert.equal(fileIssue({ head: jpeg, type: 'image/jpeg', name: 'a.jpeg', size: 1 }), null);
  assert.equal(fileIssue({ head: webp(), type: 'image/webp', name: 'a.webp', size: 1 }), null);
  assert.equal(fileIssue({ head: png(), type: 'image/png', name: 'a.png', size: MB10 + 1 }), '한 장에 10MB까지 올릴 수 있습니다');
  for (const bad of [
    { head: png(), type: 'image/jpeg', name: 'a.jpg' },
    { head: png(), type: 'image/png', name: 'a.jpg' },
    { head: new TextEncoder().encode('GIF89a......'), type: 'image/gif', name: 'a.gif' },
    { head: new TextEncoder().encode('<svg/>'), type: 'image/svg+xml', name: 'a.svg' },
    { head: png(), type: 'image/png', name: 'noext' },
  ])
    assert.equal(fileIssue({ ...bad, size: 1 }), 'JPEG, PNG, WebP 이미지만 올릴 수 있습니다', bad.name);
  assert.equal(fileIssue({ head: png([...chunk('acTL', 8), ...chunk('IDAT', 4)]), type: 'image/png', name: 'a.png', size: 1 }), '움직이는 이미지는 올릴 수 없습니다');
  assert.equal(fileIssue({ head: png([...chunk('IDAT', 4), ...chunk('acTL', 8)]), type: 'image/png', name: 'a.png', size: 1 }), null);
  assert.equal(fileIssue({ head: webp(0x02), type: 'image/webp', name: 'a.webp', size: 1 }), '움직이는 이미지는 올릴 수 없습니다');
});

test('해상도 검사: 포스터(첫 줄)는 800×1,000 이상의 세로형, 상세는 가로 800 이상, 긴 변 20,000·4,000만 화소 상한', () => {
  assert.equal(sizeIssue('POSTER', 800, 1000), null);
  assert.equal(sizeIssue('POSTER', 799, 1000), IMAGE_TEXT.poster);
  assert.equal(sizeIssue('POSTER', 1200, 1200), IMAGE_TEXT.poster);
  assert.equal(sizeIssue('DETAIL', 800, 10), null);
  assert.equal(sizeIssue('DETAIL', 799, 2000), '상세 이미지는 가로 800px 이상이어야 합니다');
  assert.equal(sizeIssue('DETAIL', 20_000, 2_000), null);
  assert.equal(sizeIssue('DETAIL', 20_001, 1_000), '긴 변 20,000px, 4,000만 화소를 넘는 이미지는 올릴 수 없습니다. 나눠서 올려 주세요');
  assert.equal(sizeIssue('DETAIL', 8_000, 5_001), IMAGE_TEXT.pixels);
  assert.equal(sizeIssue('DETAIL', 0, 0), '이미지를 읽지 못했습니다. 다른 파일로 다시 올려 주세요');
  assert.equal(altIssue('가'.repeat(300)), null);
  assert.equal(altIssue('가'.repeat(301)), '대체 텍스트는 300자까지 적을 수 있습니다');
  assert.equal(altIssue('  '), '대체 텍스트를 적어 주세요');
});

test('고른 파일은 끝에 새 줄로 붙이고 11장을 넘지 않는다. 옮기면 첫 줄이 포스터가 된다', () => {
  const list = [
    { key: 'a', alt: '포스터' },
    { key: 'b', alt: '상세' },
  ];
  let n = 0;
  const r = placePicked(list, 3, () => `new${++n}`);
  assert.deepEqual(r, { list: [...list, { key: 'new1', alt: '' }, { key: 'new2', alt: '' }, { key: 'new3', alt: '' }], assigned: ['new1', 'new2', 'new3'], overflow: 0 });
  const full = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, alt: 'x' }));
  const over = placePicked(full, 3, () => `n${++n}`);
  assert.deepEqual([over.list.length, over.assigned.length, over.overflow], [11, 1, 2]);
  assert.deepEqual(moveImage(list, 'b', 'up').map((x) => x.key), ['b', 'a']);
  assert.deepEqual(moveImage(list, 'a', 'up').map((x) => x.key), ['a', 'b']);
  assert.deepEqual(uploadPlan(moveImage(list, 'b', 'up')), [
    { key: 'b', kind: 'POSTER', alt: '상세' },
    { key: 'a', kind: 'DETAIL', alt: '포스터' },
  ]);
});

test('다음 단계·등록 전 오류: 파일 없는 줄은 "이미지는 다시 골라 주세요", 검사에 걸린 줄은 그 문구, 대체 텍스트 빠짐', () => {
  const list = [
    { key: 'a', alt: '' },
    { key: 'b', alt: '상세' },
    { key: 'c', alt: '상세' },
  ];
  const state = { a: { hasFile: true, issue: null }, b: { hasFile: false }, c: { hasFile: true, issue: IMAGE_TEXT.detail } };
  assert.deepEqual(imageErrors(list, (k) => state[k]), [
    { key: 'a', message: '대체 텍스트를 적어 주세요' },
    { key: 'b', message: '이미지는 다시 골라 주세요' },
    { key: 'c', message: '상세 이미지는 가로 800px 이상이어야 합니다' },
  ]);
  assert.deepEqual(imageErrors([], () => ({ hasFile: true })), []);
});

test('임시저장에는 이미지 줄의 키·대체 텍스트·순서만 들어가고 파일·파일 이름은 들어가지 않으며, 새로고침 뒤 그대로 되돌아온다', () => {
  const store = { draft: null, key: null, readDraft: () => store.draft, writeDraft: (v) => ((store.draft = v), true), readKey: () => null, writeKey: () => true, clear: () => (store.draft = null) };
  const keeper = new DraftKeeper(store, emptyDraft());
  keeper.restore();
  const images = [
    { key: 'p', alt: '포스터 글' },
    { key: 'd', alt: '상세 글' },
  ];
  keeper.change({ ...emptyDraft(), title: '겨울', images });
  assert.equal(keeper.flush(), 'saved');
  const saved = JSON.parse(store.draft);
  assert.deepEqual(saved.draft.images, images);
  assert.doesNotMatch(store.draft, /fileName|\.png|blob:/);
  // 새로고침: 같은 저장소에서 새 관리자로 되돌린다
  const again = new DraftKeeper(store, emptyDraft());
  assert.deepEqual(again.restore().images, images);
  // 이미지 칸이 생기기 전의 임시저장도 읽고(빈 목록), 파일 이름 같은 다른 칸이 든 줄은 받지 않는다
  const old = JSON.parse(serializeDraft(emptyDraft()));
  delete old.draft.images;
  assert.deepEqual(parseDraft(JSON.stringify(old)).images, []);
  const tampered = JSON.parse(serializeDraft({ ...emptyDraft(), images }));
  tampered.draft.images[0].fileName = 'secret.png';
  assert.equal(parseDraft(JSON.stringify(tampered)), null);
  const tooMany = JSON.parse(serializeDraft({ ...emptyDraft(), images: Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, alt: '' })) }));
  assert.equal(parseDraft(JSON.stringify(tooMany)), null);
});

test('등록 뒤 올리기: 포스터부터 한 장씩 차례로 보내고 실패한 줄은 서버 판정을 d5 문구로 남기며, [다시 올리기]는 그 줄만 다시 보낸다', async () => {
  const images = [
    { key: 'p', alt: ' 포스터 ' },
    { key: 'd1', alt: '상세 1' },
    { key: 'd2', alt: '상세 2' },
    { key: 'd3', alt: '상세 3' },
  ];
  const files = { p: { name: 'p.png' }, d1: { name: 'd1.png' }, d3: { name: 'd3.png' } };
  const sent = [];
  const fail = new Set(['d1']);
  const send = async (productionId, item, file) => {
    sent.push([productionId, item, file.name]);
    if (fail.has(file.name.split('.')[0])) throw { status: 422, type: 'image-spec-invalid', extensions: { reason: 'DETAIL_SPEC' } };
  };
  const seen = [];
  const out = await uploadImages({ productionId: 'P1', images, fileOf: (k) => files[k], send, onEach: (r) => seen.push(r.key) });
  assert.deepEqual(sent, [
    ['P1', { kind: 'POSTER', alt: '포스터' }, 'p.png'],
    ['P1', { kind: 'DETAIL', alt: '상세 1', order: 0 }, 'd1.png'],
    ['P1', { kind: 'DETAIL', alt: '상세 3', order: 0 }, 'd3.png'],
  ]);
  assert.deepEqual(out, [
    { key: 'p', kind: 'POSTER', status: 'done' },
    { key: 'd1', kind: 'DETAIL', status: 'error', message: '상세 이미지는 가로 800px 이상이어야 합니다' },
    { key: 'd2', kind: 'DETAIL', status: 'error', message: '이미지는 다시 골라 주세요' },
    { key: 'd3', kind: 'DETAIL', status: 'done' },
  ]);
  assert.deepEqual(seen, ['p', 'd1', 'd2', 'd3']);
  fail.clear();
  sent.length = 0;
  const again = await uploadImages({ productionId: 'P1', images, fileOf: (k) => files[k], send, only: ['d1'], done: ['p', 'd3'] });
  assert.deepEqual(again, [{ key: 'd1', kind: 'DETAIL', status: 'done' }]);
  assert.deepEqual(sent, [['P1', { kind: 'DETAIL', alt: '상세 1', order: 0 }, 'd1.png']]);
});

test('올리기 실패 응답을 줄 문구로 옮긴다(서버 글을 그대로 보이지 않는다)', () => {
  const t = (type, status, extensions = {}) => uploadProblemText({ type, status, extensions });
  assert.equal(t('image-type-unsupported', 415), IMAGE_TEXT.type);
  assert.equal(t('image-too-large', 413), IMAGE_TEXT.size);
  assert.equal(t('image-limit-exceeded', 409), '포스터 1장과 상세 이미지 10장까지 올릴 수 있습니다');
  assert.equal(t('image-spec-invalid', 422, { reason: 'POSTER_SPEC' }), IMAGE_TEXT.poster);
  assert.equal(t('image-spec-invalid', 422, { reason: 'PIXEL_LIMIT' }), IMAGE_TEXT.pixels);
  assert.equal(t('image-spec-invalid', 422, { reason: 'MALWARE' }), IMAGE_TEXT.unreadable);
  assert.equal(t('image-processing-unavailable', 503), IMAGE_TEXT.unavailable);
  assert.equal(t('network', 0), IMAGE_TEXT.unavailable);
  assert.equal(t('not-found', 404), IMAGE_TEXT.failed);
  // 칸막이(429 server-busy)와 남은 시간 부족(504 deadline-exceeded)은 잠시 뒤 다시 올릴 수 있는 실패다
  assert.equal(t('server-busy', 429), IMAGE_TEXT.unavailable);
  assert.equal(t('deadline-exceeded', 504), IMAGE_TEXT.unavailable);
});

test('디코딩 전에 파일 앞부분의 크기를 읽는다(PNG IHDR·WebP VP8X·JPEG SOF), 모르면 없다', () => {
  assert.deepEqual(headerSize(png()), { width: 800, height: 1024 });
  const vp8x = webp();
  vp8x.set([0x1f, 0x03, 0x00, 0xe7, 0x03, 0x00], 24);
  assert.deepEqual(headerSize(vp8x), { width: 800, height: 1000 });
  const sof = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x4e, 0x21, 0x4e, 0x22, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(headerSize(sof), { width: 20002, height: 20001 });
  assert.equal(headerSize(jpeg), undefined);
  assert.equal(headerSize(new TextEncoder().encode('GIF89a......')), undefined);
});
