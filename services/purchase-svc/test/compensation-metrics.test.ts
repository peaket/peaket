// 보상 지표 이름 충돌 재현 시험(BUILD_ORDER BAT-011, RV-01, P-T39 ③).
// 정본: docs/features/payment.md §3 '보상 세 걸음의 첫 구현', docs/observability.md, ADR-0354.
// BAT-425 배상금 지표(purchase_compensation_total)와 BAT-011 보상 세 걸음 지표가 한 registry에 함께 붙어야 한다.
// 새 보상 세 걸음 지표의 이름은 purchase_order_compensation_total이고, 기존 배상금 지표 이름은 그대로다.
import { PlatformMetrics } from '@peaket/platform';
import { expect, test } from 'vitest';
import { PromCompensationSignals } from '../src/modules/booking/adapters/prom-compensation-signals.js';
import { PromRefundAccountSignals } from '../src/modules/refund/adapters/prom-refund-signals.js';

test('RV-01_P-T39 ③_배상금_지표와_보상_세_걸음_지표를_한_registry에_등록해도_충돌하지_않는다', () => {
  const registry = new PlatformMetrics('purchase-svc-compensation-metrics-test').registry;
  // 서비스 조립과 같은 차례: 환불 모듈(BAT-425) 먼저, 보상 세 걸음(BAT-011) 다음
  expect(() => {
    new PromRefundAccountSignals().register(registry);
    new PromCompensationSignals().register(registry);
  }).not.toThrow();

  const names = registry.getMetricsAsArray().map((m) => m.name);
  expect(names).toContain('purchase_compensation_total');
  expect(names).toContain('purchase_order_compensation_total');
  expect(new Set(names).size).toBe(names.length);
});
