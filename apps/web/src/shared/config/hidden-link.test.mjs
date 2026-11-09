// 숨긴 링크의 주소(docs/features/bot-defense.md §7·§4.8, ADR-0249 결정 3). 경로 값은 저장소에 두지 않고 환경 값으로 받는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenLinkHref } from './hidden-link.ts';

const PATH = '/_t/synthetic-path-for-test';

test('[Q-T40] 설정한 경로가 있으면 회차를 싣고, 없으면 링크를 그리지 않는다', () => {
  assert.equal(hiddenLinkHref('e1', PATH), `${PATH}?e=e1`);
  assert.equal(hiddenLinkHref('e 1/2', PATH), `${PATH}?e=e%201%2F2`);
  assert.equal(hiddenLinkHref('e1', undefined), null);
  assert.equal(hiddenLinkHref('e1', ''), null);
});

test('[Q-T40] /_t/ 아래 한 칸이 아닌 값은 링크를 그리지 않는다', () => {
  for (const v of ['/events/1', '/_t/', '/_t/a/b', 'https://evil.example/_t/aaaaaaaa', '/_t/짧', '/_t/rum']) assert.equal(hiddenLinkHref('e1', v), null, v);
});

test('[Q-T40] 빌드 때는 환경 값이 있어도 그리지 않는다(값이 산출물에 박히지 않고 실행 때 읽는다)', () => {
  const saved = { path: process.env.PEAKET_HONEYPOT_PATH, phase: process.env.NEXT_PHASE };
  try {
    process.env.PEAKET_HONEYPOT_PATH = PATH;
    process.env.NEXT_PHASE = 'phase-production-build';
    assert.equal(hiddenLinkHref('e1'), null);
    delete process.env.NEXT_PHASE;
    assert.equal(hiddenLinkHref('e1'), `${PATH}?e=e1`);
  } finally {
    if (saved.path === undefined) delete process.env.PEAKET_HONEYPOT_PATH;
    else process.env.PEAKET_HONEYPOT_PATH = saved.path;
    if (saved.phase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = saved.phase;
  }
});
