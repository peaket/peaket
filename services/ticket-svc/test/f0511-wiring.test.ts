// F-05-11 구현 리뷰 IR-01·02·03·13의 배선 시험: 릴레이 진입점·Avro 코덱·지표·부하 시나리오가 실제 파일에 있는지 본다.
// 동작 시험은 test/transfer-f0511.test.ts(T8·T9)와 test-int/transfer-f0511.int.test.ts가 맡는다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json')) as { scripts?: Record<string, string> };

describe('F-05-11 Outbox 릴레이·Avro·지표 배선(IR-01·02·03·13)', () => {
  test('IR-01 ticket Outbox 릴레이 진입점이 Kafka 발행기·Lease·종료 신호와 함께 있다', () => {
    const relay = read('../src/relay.ts');
    expect(relay).toContain('startOutboxRelayProcess');
    expect(relay).toContain('kafkaOutboxPublisher');
    expect(relay).toContain('loadOutboxRelayProcessConfig');
    expect(relay).toContain('SIGTERM');
    expect(relay).toContain('SIGINT');
    expect(pkg.scripts?.relay, 'package.json relay 스크립트가 없다').toContain('dist/relay.js');
  });

  test('IR-02 start·relay가 공용 Avro 인코더로 TicketEvent를 싣는다', () => {
    for (const path of ['../src/start.ts', '../src/relay.ts']) {
      const src = read(path);
      expect(src, path).toContain('createAvroEncoder');
      expect(src, path).toContain('readSchemaIdsFile');
      expect(src, path).toContain('ticketEventCodec');
    }
  });

  test('IR-03 알림·Outbox 지표가 start에 있다', () => {
    const start = read('../src/start.ts');
    for (const metric of ['ticket_transfer_notices_total', 'ticket_transfer_outbox_lag_seconds', 'ticket_transfer_withdrawal_pending_seconds']) {
      expect(start, metric).toContain(metric);
    }
  });

  test('IR-13 R-T5 1,000회 k6 시나리오가 있다', () => {
    const race = read('../../../loadtest/scenarios/transfer-race.js');
    expect(race).toContain('1000');
    expect(race).toContain('acceptance');
    expect(race).toContain('returns');
    expect(race).toContain('eventCancel');
  });
});
