// F025-PREVIEW ④의 10,000 색인 pay를 세는 어댑터가 파이프라인 한 번으로 읽는지 고정한다(F-02-5, ADR-0365 결정 11).
// 통합 시험은 실제 Valkey에서 1초 예산을 보고, 이 단위 시험은 순차 HGET으로 되돌아가지 않게 모양을 잠근다.
import { randomUUID } from 'node:crypto';
import type { HotRedis } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { RedisPurchaseSessionCounter } from '../src/modules/inventory/adapters/redis-preview-counters.js';

const EVENT = randomUUID();
const MEMBERS = Array.from({ length: 10_000 }, (_, i) => `jti-${i}`);

describe('F025-PREVIEW ④ 10,000 세션 pay 읽기', () => {
  test('파이프라인이 있으면 HGET 10,000개를 한 번에 보내고 세션당 명령을 따로 보내지 않는다', async () => {
    const calls: string[][] = [];
    const pipelines: { key: string; args: readonly string[] }[][] = [];
    const redis = {
      async command(args: string[]): Promise<unknown> {
        calls.push(args);
        return MEMBERS;
      },
      async pipeline(commands: readonly { key: string; args: readonly string[] }[]) {
        pipelines.push([...commands]);
        return commands.map((_, i) => (i % 10 === 0 ? '1' : null));
      },
      async close(): Promise<void> {},
    };

    const result = await new RedisPurchaseSessionCounter(redis as unknown as HotRedis).count(EVENT);

    expect(result).toEqual({ sessions: 10_000, paying: 1_000 });
    expect(calls.map((c) => c[0])).toEqual(['ZRANGE']);
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]).toHaveLength(10_000);
    expect(pipelines[0]![0]!.args).toEqual(['HGET', `s:session:{${MEMBERS[0]}}`, 'pay']);
  });
});
