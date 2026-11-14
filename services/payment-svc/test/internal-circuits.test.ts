// 결제사 서킷 상태 내부 HTTP(BAT-425 GAT-130 잔여, R-592) 단위 시험.
import { describe, expect, test } from 'vitest';
import { InternalCircuitsController } from '../src/modules/payment/inbound/internal-circuits.controller.js';

describe('GET /internal/v1/circuits [BAT-425]', () => {
  test('등록부가 없으면 모두 closed, 있으면 채널별 상태를 답한다', async () => {
    expect(await new InternalCircuitsController(() => undefined).list()).toEqual({
      items: [
        { pg: 'TOSS', state: 'closed' },
        { pg: 'PORTONE', state: 'closed' },
        { pg: 'SIMULATOR', state: 'closed' },
      ],
    });
    const states = new Map<string, 'open' | 'half_open' | 'closed'>([
      ['TOSS', 'open'],
      ['PORTONE', 'half_open'],
    ]);
    const source = { of: (pg: 'TOSS' | 'PORTONE' | 'SIMULATOR') => ({ state: () => states.get(pg) ?? 'closed' }) } as never;
    expect((await new InternalCircuitsController(() => source).list()).items).toEqual([
      { pg: 'TOSS', state: 'open' },
      { pg: 'PORTONE', state: 'half_open' },
      { pg: 'SIMULATOR', state: 'closed' },
    ]);
  });
});
