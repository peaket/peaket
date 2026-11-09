// 통합 시험: 실제 Kafka 클라이언트로 닫힌 포트에 연결을 시도한다(ADR-0249 결정 4). 실제 클라이언트는 연결에 실패한 객체로 다시 연결하지 못하므로
// 시도마다 새 생산자를 만들고, 브로커가 없어도 시간 상한 안에서 실패로 끝나야 한다(리뷰에서 첫 시도가 81초를 끌었다).
import { describe, expect, test } from 'vitest';
import { createKafkaProducer } from '../src/stream-worker.js';
import { kafkaTelemetrySend } from '../src/telemetry-sink.js';

const value = Buffer.from('{}');

describe('kafkaTelemetrySend(실제 클라이언트, 닫힌 포트)', () => {
  test('연결시도마다_새생산자를만들고_시간상한안에실패하며_같은객체오류가나지않는다', async () => {
    let made = 0;
    const send = kafkaTelemetrySend(
      () => {
        made += 1;
        return createKafkaProducer({ kind: 'default', brokers: ['127.0.0.1:1'], clientId: `it-telemetry-closed-${made}` });
      },
      { connectTimeoutMs: 1_000, retryAfterMs: 0 },
    );
    const messages: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await expect(
        send('t', [{ key: null, value }]).catch((e: unknown) => {
          messages.push(String((e as Error).message));
          throw e;
        }),
      ).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(5_000);
    }
    expect(made).toBe(3);
    expect(messages.join(' ')).not.toContain('Connect has already been called');
    await send.disconnect(1_000);
  }, 30_000);
});
