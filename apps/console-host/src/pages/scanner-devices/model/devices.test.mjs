// SCR-053 화면 모델 시험(등록 코드·상태·날짜·필터). node --test가 .ts를 타입 지우기로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrollmentCodeNotice,
  enrollmentUrl,
  filterDevices,
  formatKstDate,
  formatKstDateTime,
  lastSeenSummary,
  mapDeviceList,
  promoterLabel,
  relativeLastSeen,
  statusLabel,
  statusTone,
} from './devices.ts';

test('SCR053_ 목록 응답을 화면 행으로 바꾸고 없는 값은 안전한 기본값으로 둔다', () => {
  const page = mapDeviceList({
    items: [
      { deviceId: 'd1', name: '동문-01', promoterId: 'p1', status: 'ACTIVE', credentialType: 'DEVICE_KEY', lastSeenAt: '2026-11-14T03:00:00Z' },
      { name: 'id 없음' },
      { deviceId: 'd2', status: 'REVOKED' },
    ],
    nextCursor: 'c1',
  });
  assert.deepEqual(page.items.map((d) => [d.deviceId, d.name, d.status, d.credentialType]), [
    ['d1', '동문-01', 'ACTIVE', 'DEVICE_KEY'],
    ['d2', '이름 없음', 'REVOKED', 'DEVICE_KEY'],
  ]);
  assert.equal(page.nextCursor, 'c1');
});

test('SCR053_ 상태 이름·색과 파트너 대체 표기', () => {
  assert.equal(statusLabel('ACTIVE'), '사용 중');
  assert.equal(statusLabel('REVOKED'), '폐기됨');
  assert.equal(statusLabel('RETIRED'), '퇴역');
  assert.equal(statusTone('ACTIVE'), 'success');
  assert.equal(statusTone('REVOKED'), 'danger');
  assert.equal(statusTone('RETIRED'), 'outline');
  assert.equal(promoterLabel('0190f3a1-7c2e-7a00-8000-000000000301'), '파트너 0190f3a1');
  assert.equal(promoterLabel(''), '배정 없음');
});

test('SCR053_ KST 날짜·시각과 마지막 연락', () => {
  assert.equal(formatKstDate('2026-10-15T05:20:00Z'), '10/15(목)');
  assert.equal(formatKstDateTime('2026-10-15T05:20:00Z'), '10/15(목) 14:20 KST');
  assert.equal(formatKstDate(undefined), '—');
  const now = Date.parse('2026-11-14T03:00:00Z');
  assert.equal(relativeLastSeen('2026-11-14T02:59:51Z', now), '9초 전');
  assert.equal(relativeLastSeen('2026-11-14T02:54:00Z', now), '6분 전');
  assert.equal(relativeLastSeen(undefined, now), '—');
  assert.deepEqual(lastSeenSummary('2026-11-14T02:59:51Z', now), { relative: '9초 전', absolute: '11/14(토) 11:59 KST', never: false });
  assert.deepEqual(lastSeenSummary(undefined, now), { relative: '아직 없음', absolute: '—', never: true });
});

test('SCR053_ 등록 코드 QR 주소와 만료 안내', () => {
  assert.equal(enrollmentUrl('KDTW-BMQX-HLRP', 'https://scanner.peaket.example/'), 'https://scanner.peaket.example/enroll#code=KDTW-BMQX-HLRP');
  const now = Date.parse('2026-10-15T09:05:00Z');
  assert.equal(enrollmentCodeNotice('2026-10-15T09:14:00Z', now), '18:14 KST까지 10분 동안 한 번 쓸 수 있습니다');
  assert.equal(enrollmentCodeNotice('2026-10-15T09:00:00Z', now), '등록 코드가 만료되었습니다. 새 코드를 만드세요');
});

test('SCR053_ 파트너·상태 필터', () => {
  const rows = mapDeviceList({
    items: [
      { deviceId: 'a', promoterId: 'p1', status: 'ACTIVE' },
      { deviceId: 'b', promoterId: 'p1', status: 'REVOKED' },
      { deviceId: 'c', promoterId: 'p2', status: 'ACTIVE' },
    ],
  }).items;
  assert.deepEqual(filterDevices(rows, { promoterId: 'p1' }).map((d) => d.deviceId), ['a', 'b']);
  assert.deepEqual(filterDevices(rows, { status: 'ACTIVE' }).map((d) => d.deviceId), ['a', 'c']);
  assert.deepEqual(filterDevices(rows, { promoterId: 'p1', status: 'ACTIVE' }).map((d) => d.deviceId), ['a']);
});
