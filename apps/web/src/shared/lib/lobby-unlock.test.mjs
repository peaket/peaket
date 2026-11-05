// 로비 참가 퍼뜨리기(docs/features/queue-admission.md §2, 소유자 결정 2026-10-30, ADR-0161 결정 1):
// [로비 입장]은 로비 개방 + u32be(SHA-256("PEAKET-lobby-open-v1" ‖ 회차 ID ‖ deviceId)[0..4]) mod (lobbySpreadSec × 1000) 밀리초에 열린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LOBBY_SPREAD_SEC, lobbyUnlockDelayMs } from './lobby-unlock.ts';

const ref = (eventId, deviceId, spread = 60) =>
  createHash('sha256').update(`PEAKET-lobby-open-v1${eventId}${deviceId}`, 'utf8').digest().readUInt32BE(0) % (spread * 1000);

test('식이 정본과 같다(노드 SHA-256으로 따로 센 값과 견준다)', async () => {
  assert.equal(LOBBY_SPREAD_SEC, 60);
  const cases = [
    ['0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01', 'AAAAAAAAAAAAAAAAAAAAAA'],
    ['0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01', 'zZ9_-zZ9_-zZ9_-zZ9_-zZ'],
    ['0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e02', 'AAAAAAAAAAAAAAAAAAAAAA'],
  ];
  for (const [e, d] of cases) {
    const ms = await lobbyUnlockDelayMs(e, d);
    assert.equal(ms, ref(e, d), `${e} ${d}`);
    assert.ok(ms >= 0 && ms < 60_000);
  }
  assert.notEqual(await lobbyUnlockDelayMs(cases[0][0], cases[0][1]), await lobbyUnlockDelayMs(cases[1][0], cases[1][1]));
});

test('같은 기기·회차는 늘 같은 값이다(새로고침해도 빨라지지 않는다)', async () => {
  const a = await lobbyUnlockDelayMs('e1', 'd1');
  assert.equal(await lobbyUnlockDelayMs('e1', 'd1'), a);
});

test('기기 ID가 없으면(저장소를 못 씀) 이 페이지에서만 쓰는 값으로 0~60초 안의 한 시각을 고른다', async () => {
  const ms = await lobbyUnlockDelayMs('e1', undefined);
  assert.ok(ms >= 0 && ms < 60_000);
});

test('보안 맥락이 아니어서 crypto.subtle이 없거나 계산이 실패하면 퍼뜨림 끝(가장 늦은 시각)에 연다(서버보다 일찍 열지 않는다)', async () => {
  assert.equal(await lobbyUnlockDelayMs('e1', 'd1', 60, null), 59_999);
  assert.equal(await lobbyUnlockDelayMs('e1', undefined, 60, null), 59_999, '기기 ID가 없어도 crypto.randomUUID(보안 맥락 전용)를 부르지 않는다');
  const failing = { digest: () => Promise.reject(new Error('NotSupportedError')) };
  assert.equal(await lobbyUnlockDelayMs('e1', 'd1', 30, failing), 29_999);
});
