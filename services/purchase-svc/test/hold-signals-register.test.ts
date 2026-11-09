// M1: 새 지표가 레지스트리에 등록되어 /metrics에 나온다(BUILD_ORDER HOT-070).
import { PlatformMetrics } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PromOrderSignals } from '../src/modules/booking/index.js';
import { PromSeatSignals } from '../src/modules/inventory/index.js';

describe('M1 HOT-070 지표 등록', () => {
  test('좌석 지표 여섯이 등록된다', async () => {
    const r = new PlatformMetrics('t').registry;
    new PromSeatSignals().register(r);
    const text = await r.metrics();
    for (const name of ['seat_hold_released_total', 'seat_hold_extended_total', 'seat_hold_freeze_total', 'seat_hold_freeze_batch_seconds', 'seat_payment_pause_read_total', 'seat_frozen_holds']) expect(text).toContain(name);
  });
  test('주문 뒤 표시 실패 지표가 등록된다', async () => {
    const r = new PlatformMetrics('t').registry;
    new PromOrderSignals().register(r);
    expect(await r.metrics()).toContain('purchase_order_hold_mark_failed_total');
  });
});
