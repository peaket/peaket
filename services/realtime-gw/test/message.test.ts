// 좌석 Redis 샤드 Pub/Sub 메시지 해석 단위 시험(BUILD_ORDER HOT-090, BAT-052).
// 정본: docs/data.md §3 `s:{event:E}:sec:{section}` 행(글 `1 {seatEpoch} {sectionIndex} {sectionVersion} {changedAtMs} {seatOffset}:{state} …`),
// docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '메시지 해석'(판 1, seatEpoch·sectionVersion u32, changedAtMs 안전한 정수,
// sectionIndex는 채널의 구역과 같음, 좌석 하나 이상, seatOffset u16, state 0·1·2), §12 S-T42 ⑨. 경계는 양쪽을 다 둔다.
import { describe, expect, test } from 'vitest';
import { parseSeatDeltaMessage } from '../src/modules/stream/index.js';

const CH = 's:{event:ev-1}:sec:2';
const T = 1_795_000_000_123;

describe('S-T42 ⑨ 메시지 해석', () => {
  test('S-T42 ⑨ 맞는 글은 칸을 그대로 돌려준다(좌석은 받은 차례)', () => {
    expect(parseSeatDeltaMessage(CH, `1 7 2 11 ${T} 0:1 7:2 65535:0`)).toEqual({
      eventId: 'ev-1',
      sectionIndex: 2,
      seatEpoch: 7,
      sectionVersion: 11,
      changedAtMs: T,
      seats: [
        { offset: 0, state: 1 },
        { offset: 7, state: 2 },
        { offset: 65_535, state: 0 },
      ],
    });
  });

  test('S-T42 ⑨ u32·u16 경계: seatEpoch·sectionVersion 2^32 − 1과 seatOffset 65,535는 받고, 2^32와 65,536은 버린다', () => {
    expect(parseSeatDeltaMessage(CH, `1 4294967295 2 4294967295 ${T} 1:1`)).toMatchObject({ seatEpoch: 4_294_967_295, sectionVersion: 4_294_967_295 });
    expect(parseSeatDeltaMessage(CH, `1 4294967296 2 1 ${T} 1:1`)).toBeUndefined();
    expect(parseSeatDeltaMessage(CH, `1 1 2 4294967296 ${T} 1:1`)).toBeUndefined();
    expect(parseSeatDeltaMessage(CH, `1 1 2 1 ${T} 65536:1`)).toBeUndefined();
    expect(parseSeatDeltaMessage(CH, `1 0 2 0 0 0:0`)).toMatchObject({ seatEpoch: 0, sectionVersion: 0, changedAtMs: 0 });
  });

  test('S-T42 ⑨ changedAtMs는 안전한 정수만: 2^53 − 1은 받고, 2^53·소수·음수·지수 표기는 버린다', () => {
    expect(parseSeatDeltaMessage(CH, `1 1 2 1 9007199254740991 1:1`)?.changedAtMs).toBe(Number.MAX_SAFE_INTEGER);
    for (const v of ['9007199254740992', `${T}.5`, '-1', '1e12', '', 'x']) {
      expect(parseSeatDeltaMessage(CH, `1 1 2 1 ${v} 1:1`), v).toBeUndefined();
    }
  });

  test('S-T42 ⑨ 판·칸 수·state·채널과 다른 구역·좌석 없음은 버린다', () => {
    const bad = [
      `2 7 2 11 ${T} 1:1`, // 판 2
      `0 7 2 11 ${T} 1:1`, // 판 0
      `1 7 2 11 ${T}`, // 좌석 없음
      `1 7 2 11`, // 칸 모자람
      `1 7 2`,
      ``,
      `1 7 2 11 ${T} 1:3`, // state 3
      `1 7 2 11 ${T} 1:-1`,
      `1 7 2 11 ${T} 1:1 2:3`, // 둘째 좌석만 틀림
      `1 7 3 11 ${T} 1:1`, // 채널(2)과 다른 구역
      `1 7 2 11 ${T} 1`, // 좌석 칸 모양
      `1 7 2 11 ${T} 1:1:1`,
      `1 -7 2 11 ${T} 1:1`,
      `1 7.5 2 11 ${T} 1:1`,
      `1 7 2 11.0 ${T} 1:1`,
      `1  7 2 11 ${T} 1:1`, // 빈칸 둘
      `1 7 2 11 ${T} 1:1 `, // 끝 빈칸
    ];
    for (const t of bad) expect(parseSeatDeltaMessage(CH, t), JSON.stringify(t)).toBeUndefined();
  });

  test('S-T42 ⑨ 채널 이름이 구역 채널 모양이 아니면 버린다', () => {
    const text = `1 7 2 11 ${T} 1:1`;
    for (const ch of ['s:{event:ev-1}:sec:', 's:{event:ev-1}:secs:2', 's:{event:ev:1}:sec:2', 'x:{event:ev-1}:sec:2', 's:{event:ev-1}:sec:2:x']) {
      expect(parseSeatDeltaMessage(ch, text), ch).toBeUndefined();
    }
    expect(parseSeatDeltaMessage('s:{event:__proto__}:sec:2', text)?.eventId).toBe('__proto__');
  });
});
