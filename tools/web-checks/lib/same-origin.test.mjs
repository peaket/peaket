// 같은 출처 검사 틀(ADR-0217 결정 1): 운영 배포처럼 대기실 경로·/_q/*는 대기실 빌드, 좌석맵 파일은 정적 원본(가짜 API), 그 밖은 소비자 웹 앱 서버
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFor } from './same-origin.mjs';

test('경로 나눔: 대기실 셸 경로와 /_q/ 자산은 대기실, 좌석맵 파일은 정적 원본, 그 밖은 소비자 웹', () => {
  for (const p of ['/queue/e1', '/queue/e1/', '/en/queue/e1', '/shop/md-1/queue', '/_q/assets/queue-room.abc.js', '/_q/seat-preload.json', '/_q/shell.ko.html']) assert.equal(routeFor(p), 'queue-room', p);
  for (const p of ['/v1/events/e1/seatmap-layouts/1.json']) assert.equal(routeFor(p), 'static', p);
  for (const p of ['/', '/events/e1', '/queue/e1/verify', '/login', '/_next/static/chunks/a.js', '/v1/events/e1', '/queue']) assert.equal(routeFor(p), 'web', p);
});
