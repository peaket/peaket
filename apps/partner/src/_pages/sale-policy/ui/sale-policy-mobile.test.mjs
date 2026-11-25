// F-07-9 SCR-024 실제 API 판매 정책의 휴대폰 배치(I-01, AC-02). d5 §3.9: 규칙 편집·시뮬레이션·
// 명단 올리기는 태블릿·데스크톱에서만 하고, 휴대폰은 규칙 보기와 안내 카드만 한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./LiveSalePolicy.tsx', import.meta.url), 'utf8');

test('AC-02 규칙 표는 table-wrap 안에 있고, 휴대폰에는 규칙 카드 목록이 있다', () => {
  assert.match(source, /className="table-wrap[^"]*"[\s\S]{0,300}<table className="table dense">/);
  assert.match(source, /className="[^"]*\bmd:hidden\b[^"]*"[\s\S]{0,500}rules\.map/);
});

test('AC-02 규칙 편집·시뮬레이션 카드는 휴대폰에서 숨기고 안내 카드를 둔다', () => {
  assert.match(source, /import \{ BigScreenNotice \} from '@\/shared\/ui\/BigScreenNotice'/);
  assert.match(source, /<section[^>]*max-md:hidden[^>]*aria-labelledby="h-live-edit"/);
  assert.match(source, /<section[^>]*max-md:hidden[^>]*aria-labelledby="h-live-sim"/);
  assert.match(source, /규칙 편집과 시뮬레이션은 태블릿이나 데스크톱에서 합니다/);
});

test('AC-02 새 규칙·저장·명단 올리기는 휴대폰 조작으로 남기지 않는다', () => {
  assert.match(source, /max-md:hidden[\s\S]{0,200}새 규칙|새 규칙[\s\S]{0,200}max-md:hidden/);
  assert.match(source, /max-md:hidden[\s\S]{0,300}id="live-list-file"|id="live-list-file"[\s\S]{0,300}max-md:hidden/);
});

test('AC-02 불러오기·404·오류 상태는 폭과 무관하게 글로 남는다', () => {
  assert.match(source, /state === 'loading'/);
  assert.match(source, /state === 'notFound'/);
  assert.match(source, /state === 'error'/);
  assert.match(source, /role="alert"/);
});
