// 좌석 화면의 브라우저 저장소 검사(ASVS v5.0.0-14.3.3, seat-hold §10, docs/frontend.md §3.12).
// 좌석 화면이 새로 두는 값은 구매 세션 홀드(sessionStorage)뿐이고, 자동 배정 희망 조건은 queue-room이 이미 정한 모양만 읽는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const seatsLive = readFileSync(new URL('../ui/SeatsLive.tsx', import.meta.url), 'utf8');

test('[ASVS v5.0.0-14.3.3] SCR-010 좌석 화면은 홀드와 자동 배정 희망 조건만 저장하고 개인정보·결제 값을 두지 않는다', () => {
  // 홀드는 구매 세션 자격이라 sessionStorage에 둔다(새로고침 때 결제 화면이 다시 읽는다)
  assert.match(seatsLive, /sessionStorage\.setItem\(holdKey\(eventId\), JSON\.stringify\(\{ holdId: h\.holdId, seatIds: h\.seatIds, expiresAt: h\.expiresAt \}\)\)/);
  // 자동 배정 희망 조건은 queue-room이 쓴 값을 읽고, 배정이 끝나면 지운다. 좌석 화면이 새로 쓰지는 않는다
  assert.match(seatsLive, /readWish\(eventId, localStorage\)/);
  assert.match(seatsLive, /localStorage\.removeItem\(`peaket\.autoassign\.\$\{eventId\}`\)/);
  assert.ok(!/localStorage\.setItem/.test(seatsLive), '좌석 화면은 localStorage에 새 값을 쓰지 않는다');
  // 쿠키·IndexedDB에 개인정보나 결제 값을 두지 않는다
  assert.ok(!/document\.cookie/.test(seatsLive));
  assert.ok(!/indexedDB/.test(seatsLive));
  // 저장하는 객체의 칸은 holdId·seatIds·expiresAt뿐이다
  const saved = /JSON\.stringify\(\{([^}]+)\}\)/.exec(seatsLive)?.[1] ?? '';
  assert.deepEqual(saved.split(',').map((s) => s.trim().split(':')[0]), ['holdId', 'seatIds', 'expiresAt']);
});
