// 로비의 숨긴 링크 주소(docs/features/bot-defense.md §7·§4.8, ADR-0249 결정 3). 경로 값은 저장소에 없고 빌드 환경 값으로 받는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenLinkHref } from '../src/live/hidden-link.ts';

const PATH = '/_t/synthetic-path-for-test';

test('[Q-T40] 설정한 경로가 있으면 회차를 싣고, 없거나 틀리면 링크를 그리지 않는다', () => {
  assert.equal(hiddenLinkHref('e1', PATH), `${PATH}?e=e1`);
  assert.equal(hiddenLinkHref('e1', ''), null);
  assert.equal(hiddenLinkHref('e1', undefined), null);
  for (const v of ['/_t/a/b', '//evil.example/_t/aaaaaaaa', '/_t/rum']) assert.equal(hiddenLinkHref('e1', v), null, v);
});
