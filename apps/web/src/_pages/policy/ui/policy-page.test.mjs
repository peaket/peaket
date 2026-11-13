// LCH-180·LCH-185 정책 문서 화면이 링크 주소·표 이름을 그대로 그리는지 소스로 확인한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./PolicyPage.tsx', import.meta.url), 'utf8');

test('LCH-180·LCH-185 본문 링크는 문서 모델의 주소를 쓰고 표는 이름을 붙인다', () => {
  assert.match(source, /<Link className="link-more" href=\{block\.href\}>/);
  assert.match(source, /<table className="table dense" aria-labelledby=\{block\.labelledBy\}>/);
  assert.match(source, /<caption className="sr-only">\{block\.caption\}<\/caption>/);
});
