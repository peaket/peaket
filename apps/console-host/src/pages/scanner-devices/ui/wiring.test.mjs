// SCR-053 연결 화면이 ticket-svc 기기 API를 부르고 실제 QR을 그리는지 소스로 확인한다(컴포넌트 배선 시험).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('SCR053_ 기기 화면은 목록·등록·등록 코드·폐기 API와 QR을 쓴다', () => {
  const src = read('./ConnectedPage.tsx');
  for (const name of ['listOpsScannerDevices', 'createOpsScannerDevice', 'createOpsScannerDeviceEnrollmentCode', 'createOpsScannerDeviceRevocation']) {
    assert.match(src, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(src, /ensureConsoleApi/);
  assert.match(src, /QRCode\.toDataURL/);
  assert.match(src, /enrollmentUrl/);
  assert.match(src, /navigator\.clipboard\.writeText/);
  assert.match(src, /await createOpsScannerDeviceRevocation\(selected\.deviceId,/);
  assert.match(src, /const canAct = role === 'operator' \|\| role === 'commander'/);
  assert.match(src, /disabled=\{!canAct/);
});

test('SCR053_ 실제 경로는 연결 화면을 쓰고 디자인 보드는 ?state= 미리보기에만 남긴다', () => {
  const src = read('./Page.tsx');
  assert.match(src, /__PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>/);
});
