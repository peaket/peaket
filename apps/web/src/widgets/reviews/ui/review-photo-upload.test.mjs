// SCR-016 쓰기 모달의 사진 칸이 실제 업로드 경로를 쓰는지 소스로 확인한다(화면 배선 시험, F-07-10).
// 정본: docs/design/d5-screen-blueprint.md §5.16(사진 칸·상태 표), POL-042 ⑥, openapi POST /v1/review-images·ReviewWrite.images.
// 브라우저에서의 실제 누름은 웨이브 끝 브라우저 확인(F-08-7)이 맡고, 여기서는 API 이름·상태·문구·전송 본문을 못 박는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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
  has(ds, /imageId: out\.imageId/, '응답의 imageId를 항목에 쓰지 않는다');
});

test('WEB-02 SCR-016은 후기 사진 API를 X-Requested-With와 함께 부르고, 422 사유를 d5 문구로 바꾼다', () => {
  const src = read('./ReviewModalsClient.tsx');
  has(src, /\bcreateReviewImage\b/, 'createReviewImage 호출이 없다');
  has(src, /'X-Requested-With': 'XMLHttpRequest'/, 'X-Requested-With 머리가 없다');
  has(src, /uploadReviewPhoto/, 'uploadReviewPhoto가 없다');
  has(src, /<ImageUploader[^>]*upload=\{uploadReviewPhoto\}/s, 'ImageUploader에 upload를 넘기지 않는다');
  for (const message of [
    'JPEG, PNG, WebP 이미지만 올릴 수 있습니다',
    '한 장에 10MB까지 올릴 수 있습니다',
    '사진이 너무 작습니다. 짧은 변이 320px 이상인 사진을 올려 주세요',
    '올리지 못했습니다. 다시 시도해 주세요',
  ]) {
    assert.ok(src.includes(message), `d5 문구가 없다: ${message}`);
  }
  has(src, /e\.status === 429/, '429 안내가 없다');
  has(src, /e\.status === 503/, '503 안내가 없다');
});

test('WEB-03 등록·고치기는 READY 사진의 imageId와 설명만 images로 보내고, 올리는 중·오류면 보내지 않는다', () => {
  const src = read('./ReviewModalsClient.tsx');
  has(src, /\.filter\([^)]*imageId/, 'imageId가 있는 사진만 고르지 않는다');
  has(src, /alt:\s*.*caption/, '사진 설명을 alt로 옮기지 않는다');
  has(src, /createEventReview\(eventId, \{ rating, body, images/, '등록 본문에 images가 없다');
  has(src, /updateReview\(editing\.id, \{ rating, body, images/, '고치기 본문에 images가 없다');
  has(src, /status === 'uploading'|status === "uploading"/, '올리는 중 막기가 없다');
  has(src, /status === 'error'|status === "error"/, '오류 막기가 없다');
  has(src, /사진 올리기를 마쳐 주세요|사진을 아직 올리는 중입니다/, '사진 미완 안내가 없다');
});

test('WEB-04 고치기에서는 기존 후기의 사진이 설명과 함께 사진 칸에 다시 보인다', () => {
  const src = read('./ReviewModalsClient.tsx');
  has(src, /editing\.photos/, '기존 사진을 쓰지 않는다');
  has(src, /imageId:\s*\w+\.id|imageId:\s*photo/, '기존 사진 ID를 되살리지 않는다');
  has(src, /caption:/, '기존 사진 설명을 되살리지 않는다');
});

test('WEB-05 새 사진 화면은 HTML을 직접 넣지 않고 사진 설명을 alt·글자로만 쓴다', () => {
  const web = read('./ReviewModalsClient.tsx');
  const ds = read('../../../../../../packages/ds/src/components/ImageUploader/ImageUploader.tsx');
  assert.equal(count(web, /dangerouslySetInnerHTML/g), 0);
  assert.equal(count(ds, /dangerouslySetInnerHTML|innerHTML/g), 0);
  has(web, /alt=\{/, '웹 사진 alt가 없다');
  has(ds, /alt=\{/, 'DS 사진 alt가 없다');
});
