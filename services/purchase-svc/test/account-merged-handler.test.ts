// identity.accounts-merged 소비자의 값 해석·키·멱등 위임 시험(F-07-2 IR-02, docs/data.md §4 경계 9, asyncapi AccountMerged).
// 같은 사건을 두 번 처리해도 저장소가 흡수 계정 PK로 한 행만 남기는지는 merged-account.int.test.ts가 실제 PostgreSQL로 본다.
import type { ConsumedMessage } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { AccountMergedHandler, ACCOUNTS_MERGED_TOPIC, type MergedAccountWriter } from '../src/modules/booking/index.js';

const MERGE_ID = '0192f0aa-aaaa-7000-8000-000000000001';
const PRIMARY = '0192f0aa-bbbb-7000-8000-000000000002';
const ABSORBED = '0192f0aa-cccc-7000-8000-000000000003';
const CONFIRMED_AT = '2026-11-24T03:00:00.000Z';

class RecordingWriter implements MergedAccountWriter {
  calls: { mergeId: string; primaryAccountId: string; mergedAccountId: string; confirmedAt: Date }[] = [];
  async record(i: { mergeId: string; primaryAccountId: string; mergedAccountId: string; confirmedAt: Date }): Promise<void> {
    this.calls.push(i);
  }
}

const message = (value: unknown, key: string | null = ABSORBED): ConsumedMessage => ({
  topic: ACCOUNTS_MERGED_TOPIC,
  partition: 0,
  offset: 1n,
  key,
  value: typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(JSON.stringify(value), 'utf8'),
  headers: {},
  timestamp: Date.parse(CONFIRMED_AT),
});

const payload = { mergeId: MERGE_ID, primaryAccountId: PRIMARY, mergedAccountId: ABSORBED, confirmedAt: CONFIRMED_AT };

describe('identity.accounts-merged 소비자', () => {
  test('AM-T1 정본 payload를 읽어 흡수 계정을 업무 키로 삼고, 확인 시각을 Date로 넘긴다', async () => {
    const writer = new RecordingWriter();
    const h = new AccountMergedHandler(writer);
    const r = h.decode(message(payload));
    expect(r.kind).toBe('event');
    if (r.kind !== 'event') throw new Error('event가 아니다');
    expect(h.keyOf(r)).toBe(ABSORBED);
    expect(r.event).toEqual({ mergeId: MERGE_ID, primaryAccountId: PRIMARY, mergedAccountId: ABSORBED, confirmedAt: new Date(CONFIRMED_AT) });
    await h.handle(r, message(payload));
    expect(writer.calls).toEqual([{ mergeId: MERGE_ID, primaryAccountId: PRIMARY, mergedAccountId: ABSORBED, confirmedAt: new Date(CONFIRMED_AT) }]);
  });

  test('AM-T2 같은 사건을 두 번 받아도 두 번 위임한다(한 행만 남기는 것은 저장소의 흡수 계정 PK 몫이다)', async () => {
    const writer = new RecordingWriter();
    const h = new AccountMergedHandler(writer);
    for (let i = 0; i < 2; i++) {
      const r = h.decode(message(payload));
      if (r.kind !== 'event') throw new Error('event가 아니다');
      await h.handle(r, message(payload));
    }
    expect(writer.calls).toHaveLength(2);
    expect(writer.calls[0]).toEqual(writer.calls[1]);
  });

  test('AM-T3 모양이 틀린 값은 보류 키로 돌려주고 처리에서 RangeError로 던진다', async () => {
    const writer = new RecordingWriter();
    const h = new AccountMergedHandler(writer);
    for (const [value, expectedKey] of [
      // JSON이 아니면 흡수 계정 ID를 읽을 수 없어 메시지 키로 보류한다
      ['not-json', `bad:${ABSORBED}`],
      [{ ...payload, confirmedAt: '어제' }, ABSORBED],
      [{ ...payload, mergedAccountId: undefined }, `bad:${ABSORBED}`],
      [null, `bad:${ABSORBED}`],
    ] as const) {
      const r = h.decode(message(value));
      expect(r.kind, String(value)).toBe('bad');
      if (r.kind !== 'bad') throw new Error('bad가 아니다');
      expect(r.key).toBe(expectedKey);
      await expect(h.handle(r, message(value))).rejects.toBeInstanceOf(RangeError);
    }
    expect(writer.calls).toHaveLength(0);
  });

  test('AM-T4 읽을 수 없는 값은 메시지 키로 보류한다', () => {
    const h = new AccountMergedHandler(new RecordingWriter());
    const r = h.decode(message('not-json', 'fallback-key'));
    expect(r.kind).toBe('bad');
    if (r.kind !== 'bad') throw new Error('bad가 아니다');
    expect(r.key).toBe('bad:fallback-key');
  });
});
