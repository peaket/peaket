// SCR-016 쓰기 모달의 사진 칸이 실제 업로드 경로를 쓰는지 본다(화면 배선 시험, F-07-10).
// 정본: docs/design/d5-screen-blueprint.md §5.16(사진 칸·상태 표), POL-042 ⑥, openapi POST /v1/review-images·ReviewWrite.images.
// 브라우저에서의 실제 누름은 웨이브 끝 브라우저 확인(F-08-7)이 맡고, 여기서는 순수 함수·전송 본문·문구 선택을 못 박는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as review from '../../../entities/review/model.ts';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const has = (src, re, label) => assert.ok(re.test(src), label);
const count = (src, re) => (src.match(re) ?? []).length;

test('WEB-01 사진 칸은 파일을 고르면 upload로 보내고, imageId를 받아 READY가 된다', () => {
  const ds = read('../../../../../../packages/ds/src/components/ImageUploader/ImageUploader.tsx');
  has(ds, /upload\?: \(file: File\) => Promise<\{ imageId: string \}>/, 'ImageUploader upload prop이 없다');
  has(ds, /imageId\?: string/, 'ImageUploaderItem imageId가 없다');
  has(ds, /"uploading"/, 'uploading 상태가 없다');
  has(ds, /"scanning"/, 'scanning 상태가 없다');
  has(ds, /await upload\(/, 'upload를 부르지 않는다');
  has(ds, /imageId: (out\.|result\.|uploaded\.)imageId|imageId: .*\.imageId/, '응답의 imageId를 항목에 쓰지 않는다');
  has(ds, /retryable/, '다시 시도 표시가 없다');
});

test('WEB-02 SCR-016은 후기 사진 API를 X-Requested-With와 함께 부르고, 422 사유를 d5 문구로 바꾼다', () => {
  const src = read('./ReviewModalsClient.tsx');
  const uploadBlock = /function uploadReviewPhoto[\s\S]*?\n}/.exec(src)?.[0] ?? src;
  has(uploadBlock, /\bcreateReviewImage\b/, 'uploadReviewPhoto 안에 createReviewImage가 없다');
  has(src, /'X-Requested-With': 'XMLHttpRequest'/, 'X-Requested-With 머리가 없다');
  has(src, /<ImageUploader[^>]*upload=\{uploadReviewPhoto\}/s, 'ImageUploader에 upload를 넘기지 않는다');
  has(src, /photoUploadFailure\(/, '422 사유 문구를 한 곳에서 고르지 않는다');
  for (const message of [
    'JPEG·PNG·WebP 사진만 올릴 수 있습니다',
    '한 장에 10MB까지 올릴 수 있습니다',
    '사진이 너무 작습니다. 짧은 변이 320px 이상인 사진을 올려 주세요',
    '올리지 못했습니다. 다시 시도해 주세요',
  ]) {
    assert.ok(src.includes(message) || read('../../../entities/review/model.ts').includes(message), `d5 문구가 없다: ${message}`);
  }
  has(src, /e\.status === 429/, '429 안내가 없다');
  has(src, /e\.status === 503/, '503 안내가 없다');
});

test('WEB-03 422 사유별 문구·재시도와 전송 막기를 순수 함수로 판정하고, 등록·고치기는 READY 사진만 images로 보낸다', () => {
  assert.deepEqual(review.photoUploadFailure('UNSUPPORTED_TYPE'), { message: 'JPEG·PNG·WebP 사진만 올릴 수 있습니다', retryable: false });
  assert.deepEqual(review.photoUploadFailure('TOO_LARGE'), { message: '한 장에 10MB까지 올릴 수 있습니다', retryable: false });
  assert.deepEqual(review.photoUploadFailure('TOO_SMALL'), { message: '사진이 너무 작습니다. 짧은 변이 320px 이상인 사진을 올려 주세요', retryable: false });
  assert.deepEqual(review.photoUploadFailure('MALWARE'), { message: '올리지 못했습니다. 다시 시도해 주세요', retryable: false });
  assert.equal(review.photoUploadFailure('NETWORK').retryable, true);
  assert.equal(review.photoUploadFailure(undefined).retryable, true);

  assert.equal(review.canSubmitWrite([]), true);
  assert.equal(review.canSubmitWrite([{ status: 'ready', imageId: 'a' }]), true);
  assert.equal(review.canSubmitWrite([{ status: 'uploading' }]), false);
  assert.equal(review.canSubmitWrite([{ status: 'error' }]), false);
  assert.equal(review.canSubmitWrite([{ status: 'ready' }]), false);
  assert.equal(review.canSubmitWrite([{ status: 'ready', imageId: 'a' }, { status: 'scanning' }]), false);

  const src = read('./ReviewModalsClient.tsx');
  has(src, /reviewImagePayload\(/, 'reviewImagePayload로 전송 본문을 만들지 않는다');
  has(src, /canSubmitWrite\(/, 'canSubmitWrite로 전송을 막지 않는다');
  has(src, /createEventReview\(eventId, \{ rating, body, images/, '등록 본문에 images가 없다');
  has(src, /updateReview\(editing\.id, \{ rating, body, images/, '고치기 본문에 images가 없다');
});

test('WEB-04 고치기에서는 기존 후기의 사진이 imageId·설명과 함께 사진 칸에 다시 보인다', () => {
  const src = read('./ReviewModalsClient.tsx');
  has(src, /editing\.photos/, '기존 사진을 쓰지 않는다');
  has(src, /editing\.photos\.map[\s\S]*imageId/, '기존 사진의 imageId를 되살리지 않는다');
  has(src, /caption/, '기존 사진 설명을 되살리지 않는다');
  // 모델이 imageId를 버리면 고치기에서 다시 붙일 수 없다(entities/review/model.test.mjs도 같은 것을 본다)
  const item = review.mapReview({ reviewId: 'r1', images: [{ imageId: 'i1', thumbnailUrl: 'https://img.test/t.webp', url: 'https://img.test/v.webp', alt: '무대' }] });
  assert.equal(item.photos[0].imageId, 'i1');
  assert.deepEqual(review.reviewImagePayload(item.photos), [{ imageId: 'i1', alt: '무대' }]);
});

test('WEB-05 사진 설명에 <img onerror>가 들어와도 alt 속성 값으로만 나가고 요소가 생기지 않는다', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const alt = review.photoAltText({ imageId: 'i1', caption: malicious }, 1, 3);
  const html = renderToStaticMarkup(createElement('img', { alt, src: 'https://img.test/v.webp' }));
  assert.match(html, /alt="&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.doesNotMatch(html, /<img src=x/);
  const web = read('./ReviewModalsClient.tsx');
  const ds = read('../../../../../../packages/ds/src/components/ImageUploader/ImageUploader.tsx');
  assert.equal(count(web, /dangerouslySetInnerHTML/g), 0);
  assert.equal(count(ds, /dangerouslySetInnerHTML|innerHTML/g), 0);
  has(web, /alt=\{/, '웹 사진 alt가 없다');
  has(ds, /alt=\{/, 'DS 사진 alt가 없다');
});


test('WEB-06 [IR-05] 검사 중 상태를 보이고, [다시 시도]는 원본 파일로 실제 업로드를 다시 부른다', async () => {
  const state = await import('../../../../../../packages/ds/src/components/ImageUploader/upload-state.ts');
  const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
  const failed = [{ id: 'i1', status: 'error', error: '올리지 못했습니다', retryable: true, file }];

  assert.equal(state.retryFile(failed, 'i1'), file);
  const scanning = state.beginUpload(failed, 'i1');
  assert.equal(scanning[0].status, 'scanning');
  assert.equal(scanning[0].error, undefined);
  assert.equal(scanning[0].retryable, undefined);

  const ready = state.finishUpload(scanning, 'i1', 'img-1');
  assert.equal(ready[0].status, 'ready');
  assert.equal(ready[0].imageId, 'img-1');

  const again = state.failUpload(scanning, 'i1', '다시 시도해 주세요', true);
  assert.deepEqual([again[0].status, again[0].error, again[0].retryable], ['error', '다시 시도해 주세요', true]);

  const ds = read('../../../../../../packages/ds/src/components/ImageUploader/ImageUploader.tsx');
  has(ds, /file\?: File/, '항목이 원본 File을 들지 않는다');
  has(ds, /beginUpload\(/, '검사 중(scanning) 상태로 바꾸지 않는다');
  has(ds, /retryFile\(/, '다시 시도할 원본 파일을 찾지 않는다');
  has(ds, /runUpload\(/, '다시 시도에서 업로드를 다시 부르지 않는다');
  has(ds, /onClick=\{\(\) => retry\(/, '다시 시도 버튼이 retry를 부르지 않는다');
});
