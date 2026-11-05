// 시험 기록(NDJSON) 읽기(docs/verification.md §2.5 '기록', [ASVS v5.0.0-2.1.1]·[ASVS v5.0.0-2.2.1]).
import { describe, expect, it } from 'vitest';
import { RecordFormatError, parseRecords } from '../src/records.js';

const EVENT = '0195f3a0-0000-7000-8000-00000000e001';
const entry = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: 'queue_entry',
    event_id: EVENT,
    account_ref: 'acct-1',
    request_id: 'req-1',
    result: 'ok',
    seq: 7,
    generation: 1,
    started_at: '2026-11-02T10:00:00.000+09:00',
    ended_at: '2026-11-02T10:00:00.120+09:00',
    ...o,
  });

describe('시험 기록 읽기', () => {
  it('네 종류를 읽어 종류별로 나눈다', () => {
    const text = [
      entry(),
      entry({ kind: 'queue_admit', request_id: 'req-2' }),
      JSON.stringify({ kind: 'queue_serving', event_id: EVENT, serving: 100, observed_at: '2026-11-02T10:00:01Z' }),
      JSON.stringify({ kind: 'pg_charge', pg: 'SIMULATOR', payment_ref: 'tsim_1', order_ref: 'o-000001', amount: 5000, status: 'DONE', approved_at: '2026-11-02T10:00:00.000+09:00', canceled_amount: 0 }),
      '',
    ].join('\n');
    const r = parseRecords(text);
    expect(r.queue_entry).toHaveLength(1);
    expect(r.queue_admit[0]).toMatchObject({ request_id: 'req-2', seq: 7 });
    expect(r.queue_serving[0]).toEqual({ event_id: EVENT, serving: 100, observed_at: '2026-11-02T10:00:01Z' });
    expect(r.pg_charge[0]).toMatchObject({ pg: 'SIMULATOR', amount: 5000 });
  });

  it('결과를 모르거나 실패한 요청은 순번이 없어도 된다', () => {
    const r = parseRecords([entry({ result: 'unknown', seq: null, generation: null }), entry({ result: 'fail', seq: undefined, generation: undefined })].join('\n'));
    expect(r.queue_entry.map((e) => e.seq)).toEqual([null, null]);
  });

  it.each([
    ['모르는 종류', JSON.stringify({ kind: 'seat_hold' }), /종류/],
    ['객체 기본 이름 종류(새 맥락 리뷰 5)', JSON.stringify({ kind: 'toString', pg: 'TOSS' }), /종류/],
    ['__proto__ 종류', '{"kind":"__proto__"}', /종류/],
    ['모르는 칸', entry({ extra: 1 }), /extra/],
    ['결과 값', entry({ result: 'timeout' }), /result/],
    ['성공인데 순번 없음', entry({ seq: null }), /seq/],
    ['시각 오프셋 없음', entry({ started_at: '2026-11-02T10:00:00' }), /started_at/],
    ['끝이 시작보다 앞', entry({ ended_at: '2026-11-02T09:59:59+09:00' }), /ended_at/],
    ['UUID 아님', entry({ event_id: 'e1' }), /event_id/],
    ['음수 순번', entry({ seq: -1 }), /seq/],
    ['취소 금액이 금액보다 큼', JSON.stringify({ kind: 'pg_charge', pg: 'TOSS', payment_ref: 'p', order_ref: 'o', amount: 10, status: 'DONE', approved_at: null, canceled_amount: 11 }), /canceled_amount/],
    ['모르는 결제사', JSON.stringify({ kind: 'pg_charge', pg: 'KAKAO', payment_ref: 'p', order_ref: 'o', amount: 10, status: 'DONE', approved_at: null, canceled_amount: 0 }), /pg/],
    ['JSON 아님', '{', /JSON/],
  ])('%s은 줄 번호와 함께 거절한다', (_name, line, msg) => {
    try {
      parseRecords(`${entry()}\n${line}\n`);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RecordFormatError);
      expect((e as RecordFormatError).line).toBe(2);
      expect((e as Error).message).toMatch(msg);
    }
  });
});
