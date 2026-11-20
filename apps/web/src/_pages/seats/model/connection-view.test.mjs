// 좌석 실시간 화면의 순수 함수(FE-T11, docs/frontend.md §4.4.1·§5.2·§5.10, BAT-182).
// 소켓 주소·입장 토큰 만료·연결 배너를 화면 없이 본다. 4401의 까닭별 화면은 connection-machine·SeatsLive 시험이 맡는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admissionExpiryMs, connectionBanner, streamUrl } from './live.ts';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (payload) => `${b64url({ alg: 'none' })}.${b64url(payload)}.x`;

test('FE-T11 좌석 델타 소켓 주소는 같은 출처의 http→ws, https→wss이고 회차 ID를 주소 조각으로 부호화한다', () => {
  assert.equal(streamUrl('https://api.peaket.example', 'evt-1'), 'wss://api.peaket.example/v1/events/evt-1/seats/stream');
  assert.equal(streamUrl('http://127.0.0.1:4010', 'evt-1'), 'ws://127.0.0.1:4010/v1/events/evt-1/seats/stream');
  // 쿼리·조각을 붙이지 않고, 회차 ID는 한 조각으로 부호화한다
  assert.equal(streamUrl('https://api.peaket.example', 'a/b c?d#e'), 'wss://api.peaket.example/v1/events/a%2Fb%20c%3Fd%23e/seats/stream');
});

test('FE-T11 입장 토큰 만료는 exp(초)×1,000이고, 없거나 틀리면 Infinity다', () => {
  assert.equal(admissionExpiryMs(token({ exp: 1_700_000_000 })), 1_700_000_000_000);
  assert.equal(admissionExpiryMs(token({ jti: 'no-exp' })), Number.POSITIVE_INFINITY);
  assert.equal(admissionExpiryMs('not-a-token'), Number.POSITIVE_INFINITY);
  assert.equal(admissionExpiryMs(`${b64url({})}.%%%.x`), Number.POSITIVE_INFINITY);
  assert.equal(admissionExpiryMs(token({ exp: 0 })), Number.POSITIVE_INFINITY);
  assert.equal(admissionExpiryMs(token({ exp: '1700000000' })), Number.POSITIVE_INFINITY);
});

test('FE-T11 연결 배너는 다시 붙는 중과 Degraded(1,000ms 묶음)에만 서고, 연결·끝 화면에는 없다', () => {
  assert.deepEqual(connectionBanner('reconnecting', false), { tone: 'warning', title: '실시간 연결 복구 중' });
  assert.deepEqual(connectionBanner('live', true), { tone: 'warning', title: '실시간 반영이 느려졌습니다' });
  // BatchInterval 100으로 돌아오면 지운다
  assert.equal(connectionBanner('live', false), null);
  assert.equal(connectionBanner('connecting', false), null);
  assert.equal(connectionBanner('connecting', true), null);
  assert.equal(connectionBanner('ended', false), null);
  assert.equal(connectionBanner('invalid', true), null);
});
