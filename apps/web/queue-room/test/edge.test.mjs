// CloudFront Function(시청자 요청) 경로 PoC 시험(docs/infra.md §4, docs/frontend.md §5.1, HOT-370).
// 실제 AWS 배포는 계정이 생기는 HOT-012·BAT-185 몫이고, 여기서는 함수 코드의 경로 판정만 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const code = readFileSync(new URL('../edge/queue-room-viewer-request.js', import.meta.url), 'utf8');
const { handler } = new Function(`${code}; return { handler };`)();

const call = (uri, querystring = {}) => handler({ request: { uri, querystring } }).uri;

test('HOT-370 대기실 경로를 로케일 셸로 바꾼다', () => {
  assert.equal(call('/queue/evt-1'), '/_q/shell.ko.html');
  assert.equal(call('/queue/evt-1/'), '/_q/shell.ko.html');
  assert.equal(call('/en/queue/evt-1'), '/_q/shell.en.html');
  assert.equal(call('/ja/queue/evt-1/'), '/_q/shell.ja.html');
  assert.equal(call('/zh/queue/evt-1'), '/_q/shell.zh.html');
  assert.equal(call('/shop/md-lumen/queue'), '/_q/shell.ko.html');
  assert.equal(call('/shop/md-lumen/queue/'), '/_q/shell.ko.html');
});

test('HOT-370 대기실 경로가 아니면 URI를 건드리지 않는다', () => {
  for (const uri of ['/', '/events/evt-1', '/_q/shell.ko.html', '/_q/assets/queue-room.abc.js', '/queue/evt-1/extra', '/en/events/evt-1', '/shop/md-lumen']) {
    assert.equal(call(uri), uri, uri);
  }
});

test('HOT-370 쿼리 문자열은 함수가 바꾸지 않는다', () => {
  const qs = { theme: { value: 'dark' } };
  const request = handler({ request: { uri: '/queue/evt-1', querystring: qs } });
  assert.deepEqual(request.querystring, qs);
  assert.equal(request.uri, '/_q/shell.ko.html');
});
