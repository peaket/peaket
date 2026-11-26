// F-05-11 구현 재리뷰 IR-01·02·03·13의 배선 시험: 릴레이 진입점·Avro 실제 바이트·지표 상태·부하 시나리오의 호출을 본다.
// 동작 시험은 test/transfer-f0511.test.ts(T8·T9)와 test-int/transfer-f0511.int.test.ts가 맡는다.
import { readFileSync } from 'node:fs';
import { createAvroEncoder, decodeConfluent } from '@peaket/platform/avro';
import { avroSchemas, localSchemaIds } from '@peaket/contracts/avro';
import { describe, expect, test } from 'vitest';
import { ticketEventCodec } from '../src/modules/ticket/adapters/ticket-event-codec.js';
import { ticketEventOf } from '../src/modules/ticket/domain/transfer-events.js';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json')) as { scripts?: Record<string, string> };

describe('F-05-11 Outbox 릴레이·Avro·지표 배선(IR-01·02·03·13)', () => {
  test('IR-01 ticket Outbox 릴레이 진입점이 Kafka 발행기·Lease·종료 신호와 함께 있다', () => {
    const relay = read('../src/relay.ts');
    const app = read('../src/relay-app.ts');
    expect(app).toContain('startOutboxRelayProcess');
    expect(app).toContain('kafkaOutboxPublisher');
    expect(app).toContain('inClusterLeaseApi');
    expect(relay).toContain('startTicketRelay');
    expect(relay).toContain('SIGTERM');
    expect(relay).toContain('SIGINT');
    expect(pkg.scripts?.relay, 'package.json relay 스크립트가 없다').toContain('dist/relay.js');
  });

  test('IR-02 실제 TicketEvent Avro가 Confluent 매직 0·스키마 ID 24로 인코딩된다', () => {
    const codec = ticketEventCodec(
      createAvroEncoder({ schemaIds: localSchemaIds, schemas: avroSchemas, produces: [{ topic: 'trade.tickets', record: 'peaket.trade.TicketEvent' }] }),
    );
    const bytes = codec.encode(
      ticketEventOf({
        type: 'TRANSFER_OFFERED',
        offerId: '0193f2c0-0000-7000-8000-000000511001',
        ticketId: '0193f2c0-0000-7000-8000-000000511002',
        eventId: '0193f2c0-0000-7000-8000-000000511003',
        orderId: '0193f2c0-0000-7000-8000-000000511004',
        accountId: '0193f2c0-0000-7000-8000-000000511005',
        occurredAtMs: 1_795_348_800_000,
      }),
    );
    const decoded = decodeConfluent(bytes);
    expect(decoded.schemaId).toBe(24);
    expect(decoded.payload.length).toBeGreaterThan(0);
    // JSON 대역이면 매직 0 뒤에 '{'가 온다. Avro 바이트는 그렇지 않다
    expect(String.fromCharCode(bytes[4]!)).not.toBe('{');
    for (const path of ['../src/start.ts', '../src/relay.ts']) expect(read(path), path).toContain('ticketEventCodec');
  });

  test('IR-03 탈퇴 PENDING 나이를 저장·계산하고 24시간 SEV2 경보를 낸다', () => {
    const start = read('../src/start.ts');
    expect(start).toContain('pendingWithdrawalSeconds');
    expect(start).toMatch(/86_400|24 \* 60 \* 60/);
    expect(start).toContain('SEV2');
    // Outbox 지연 지표는 core URL 유무와 상관없이 도는 지표 틱에서 갱신한다
    expect(start).toContain('updateTransferMetrics');
    const tick = start.indexOf('setInterval(updateTransferMetrics');
    const coreCondition = start.indexOf('if (transferNotices)');
    expect(tick, '지표 틱이 없다').toBeGreaterThan(-1);
    expect(coreCondition, 'core URL 조건이 없다').toBeGreaterThan(-1);
    expect(tick, '지표 틱이 core URL 조건 안에 있다').toBeLessThan(coreCondition);
  });

  test('IR-13 R-T5 시나리오가 주석이 아니라 여러 표·여러 사건의 여섯 갈래를 실제 호출한다', () => {
    const source = read('../../../loadtest/scenarios/transfer-race.js');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/TICKET_IDS\.split\(/);
    expect(code).toMatch(/EVENT_IDS\.split\(/);
    expect(code).toMatch(/i % 6/);
    expect(code).toContain('/returns');
    expect(code).toContain('/internal/v1/event-refunds');
    expect(code).toContain('acceptance');
    expect(code).toContain('rejection');
    expect(code).toContain('withdrawal');
    expect(code).toContain('setup');
    expect(code).toContain('TRANSFER_RACE_ITERATIONS');
    expect(code).not.toContain('returns:');
  });
});
