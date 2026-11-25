// F-07-9 SCR-023 실제 API 상품 만들기·고치기의 휴대폰 배치(I-02, AC-03). d5 §3.9: 상품 만들기·게시는
// 태블릿·데스크톱에서만 하고, 휴대폰은 안내 카드와 목록으로 돌아가는 길만 둔다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./live/ProductFormLive.tsx', import.meta.url), 'utf8');

test('AC-03 휴대폰에는 안내 카드와 상품 목록 링크만 보인다', () => {
  assert.match(source, /import \{ BigScreenNotice \} from '@\/shared\/ui\/BigScreenNotice'/);
  assert.match(source, /className="[^"]*\bmd:hidden\b[^"]*"[\s\S]{0,500}BigScreenNotice/);
  assert.match(source, /상품 만들기·게시는 태블릿이나 데스크톱에서 합니다/);
  assert.match(source, /listHref/);
  assert.match(source, /상품 목록 보기/);
});

test('AC-03 입력 폼은 휴대폰에서 숨긴다', () => {
  assert.match(source, /<form[^>]*max-md:hidden/);
});
