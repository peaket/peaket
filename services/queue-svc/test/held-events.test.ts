// 대기열 Redis 보류의 기한 규칙(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', docs/data.md §3 q:{held:<토픽>}, ADR-0214 결정 6).
// 보류 표시는 다시 처리할 때까지 두고(ADR-0142 '버리지 않는다'), 값만 개인정보 기한으로 지운다. 넣기·확인의 Lua는 test-int/held-events.int.test.ts가 실제 Valkey로 본다.
import type { HeldEventInput } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { HELD_VALUE_MAX_MS, heldExpiry } from '../src/consumers/held-events.js';

const NOW = Date.parse('2026-11-05T03:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const held = (topic: string, value: unknown): HeldEventInput => ({
  topic,
  partition: 0,
  offset: 7n,
  eventKey: null,
  businessKey: 'k',
  error: 'RangeError: 모양이 아니다',
  key: 'k',
  value: value === null ? null : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  headers: { traceparent: '00-abc' },
  timestamp: NOW,
});

describe('보류 기한', () => {
  test('ST-T19_탈퇴사건이아닌토픽은_값을보류표시와함께다시처리할때까지둔다(저절로지우지않는다)', () => {
    expect(heldExpiry(held('trade.seats', { eventId: 'ev-1' }), NOW)).toEqual({ keepValue: true, valueUntilMs: null });
    expect(heldExpiry(held('trade.seats', null), NOW)).toEqual({ keepValue: false, valueUntilMs: null });
  });

  test('[ASVS v5.0.0-14.2.4] ST-T19_탈퇴사건의값은min(purgeBy,withdrawnAt+5일,지금+7일)까지만두고_읽지못하거나이미지났으면값·머리없이위치만남긴다', () => {
    const topic = 'identity.accounts-withdrawn';
    const at = (v: unknown) => heldExpiry(held(topic, v), NOW);
    expect(at({ pids: ['p'], withdrawnAt: iso(NOW - DAY), purgeBy: iso(NOW + 2 * DAY) })).toEqual({ keepValue: true, valueUntilMs: NOW + 2 * DAY });
    // purgeBy가 탈퇴 + 5일보다 뒤인 잘못된 값이어도 법정 기한(탈퇴 + 5일)을 넘지 않는다
    expect(at({ withdrawnAt: iso(NOW - 4 * DAY), purgeBy: iso(NOW + 3 * DAY) })).toEqual({ keepValue: true, valueUntilMs: NOW + DAY });
    expect(at({ withdrawnAt: iso(NOW), purgeBy: iso(NOW + 9 * DAY) })).toEqual({ keepValue: true, valueUntilMs: NOW + 5 * DAY });
    expect(HELD_VALUE_MAX_MS).toBe(7 * DAY);
    expect(at({ withdrawnAt: iso(NOW + 3 * DAY), purgeBy: iso(NOW + 8 * DAY) }).valueUntilMs).toBe(NOW + 7 * DAY);
    for (const v of [null, '{', { pids: ['p'] }, { purgeBy: 'x', withdrawnAt: iso(NOW) }, { purgeBy: iso(NOW + DAY) }, { purgeBy: iso(NOW), withdrawnAt: iso(NOW - DAY) }, [1]]) {
      expect(at(v), JSON.stringify(v)).toEqual({ keepValue: false, valueUntilMs: null });
    }
  });
});
