// booking 모듈 지표 order_history_mismatch(PromOrderSignals.historyMismatch, BUILD_ORDER PRF-160, docs/observability.md '주문 상태와 상태 이력이 어긋나지 않는다',
// docs/features/payment.md §3 '주문 저장소의 첫 구현' 매일 검사). 이름표 없는 게이지이고 마지막 매일 검사에서 어긋난 주문 수다.
// test/seat-signals.test.ts(PromSeatSignals)와 같은 방식: 서비스 레지스트리(PlatformMetrics.registry, @peaket/platform Registry)에 붙인다.
import { PlatformMetrics, type Registry } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { type OrderSignals, PromOrderSignals } from '../src/modules/booking/index.js';

const NAME = 'order_history_mismatch';

/** 노출 글에서 이름이 name인 표본 줄(이름표가 있으면 그대로 남는다) */
async function sampleLines(registry: Registry, name: string): Promise<string[]> {
  return (await registry.metrics()).split('\n').filter((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
}

describe('PromOrderSignals(order_history_mismatch)', () => {
  test('ADR0113_register는 서비스 레지스트리에 붙이고 자신을 돌려주며, historyMismatch(n)는 이름표 없는 게이지 값 n으로 보인다(더하지 않고 바꾼다)', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromOrderSignals();
    expect(prom.register(metrics.registry)).toBe(prom);
    const s: OrderSignals = prom;
    s.historyMismatch(3);
    expect(await sampleLines(metrics.registry, NAME)).toEqual([`${NAME} 3`]);
    s.historyMismatch(2);
    expect(await sampleLines(metrics.registry, NAME)).toEqual([`${NAME} 2`]);
    // 어긋남이 없는 날은 0으로 내린다(경보가 풀린다)
    s.historyMismatch(0);
    expect(await sampleLines(metrics.registry, NAME)).toEqual([`${NAME} 0`]);
    const text = await metrics.registry.metrics();
    expect(text).toContain(`# TYPE ${NAME} gauge`);
    expect(text).toContain(`# HELP ${NAME} `);
  });

  test('ADR0113_붙이기 전에 불러도 던지지 않고, 두 번 만든 신호가 서로의 레지스트리를 더럽히지 않는다', async () => {
    const loose = new PromOrderSignals();
    expect(() => loose.historyMismatch(1)).not.toThrow();
    const a = new PlatformMetrics('purchase-svc');
    const b = new PlatformMetrics('purchase-svc');
    const sa = new PromOrderSignals().register(a.registry);
    new PromOrderSignals().register(b.registry);
    sa.historyMismatch(5);
    expect(await sampleLines(a.registry, NAME)).toEqual([`${NAME} 5`]);
    expect(await sampleLines(b.registry, NAME)).not.toContain(`${NAME} 5`);
  });
});
