// 핫패스 구간 진단 지표(BAT-027, HOT-462, docs/observability.md §3·§8).
// 라벨은 service·stage·outcome 고정 목록뿐이고, 계측이 던져도 요청을 막지 않는지 본다.
import { Registry } from '@prometheus-io/client';
import { describe, expect, test } from 'vitest';
import { HotPathMetrics, timeHotPath, timeHotPathSync } from '../src/index.js';

const registry = () => new Registry();

const sample = (text: string, line: string): number | undefined => {
  const l = text.split('\n').find((x) => x.startsWith(line));
  return l === undefined ? undefined : Number(l.slice(l.lastIndexOf(' ') + 1));
};

describe('HotPathMetrics(핫패스 구간 진단)', () => {
  test('BAT027_ register는 두 지표를 붙이고 service·stage·outcome 이름표만 쓴다', async () => {
    const r = registry();
    const m = new HotPathMetrics('purchase-svc');
    expect(m.register(r)).toBe(m);
    m.observe('hold.lua', 0.012);
    m.outcome('conflict');

    const text = await r.metrics();
    expect(text).toContain('# TYPE hot_path_stage_seconds histogram');
    expect(text).toContain('# TYPE hot_path_outcomes_total counter');
    expect(sample(text, 'hot_path_stage_seconds_count{service="purchase-svc",stage="hold.lua"}')).toBe(1);
    expect(sample(text, 'hot_path_outcomes_total{service="purchase-svc",outcome="conflict"}')).toBe(1);
    expect(text).not.toMatch(/account|order|seat|event/i);
  });

  test('BAT027_ 같은 레지스트리에 두 번 붙여도 한 번만 붙고, 시작 함수는 두 번 불러도 한 번만 관측한다', async () => {
    const r = registry();
    const m = new HotPathMetrics('queue-svc').register(r).register(r);
    const done = m.start('queue.entry.preempt');
    done();
    done();

    const text = await r.metrics();
    expect(sample(text, 'hot_path_stage_seconds_count{service="queue-svc",stage="queue.entry.preempt"}')).toBe(1);
    expect(text.match(/# TYPE hot_path_stage_seconds/g)).toHaveLength(1);
  });

  test('BAT027_ timeHotPath는 성공·실패 모두 구간을 남기고 원래 오류를 그대로 던진다', async () => {
    const r = registry();
    const m = new HotPathMetrics('payment-svc').register(r);

    await expect(timeHotPath(m, 'payment.confirm.read', async () => 'ok')).resolves.toBe('ok');
    await expect(
      timeHotPath(m, 'payment.confirm.gateway', async () => {
        throw new Error('결제사 오류');
      }),
    ).rejects.toThrow('결제사 오류');
    expect(timeHotPathSync(m, 'payment.confirm.mark', () => 7)).toBe(7);

    const text = await r.metrics();
    expect(sample(text, 'hot_path_stage_seconds_count{service="payment-svc",stage="payment.confirm.read"}')).toBe(1);
    expect(sample(text, 'hot_path_stage_seconds_count{service="payment-svc",stage="payment.confirm.gateway"}')).toBe(1);
    expect(sample(text, 'hot_path_stage_seconds_count{service="payment-svc",stage="payment.confirm.mark"}')).toBe(1);
  });

  test('BAT027_ 계측을 넘기지 않으면 원래 함수만 부르고 지표를 만들지 않는다', async () => {
    await expect(timeHotPath(undefined, 'hold.total', async () => 1)).resolves.toBe(1);
    expect(timeHotPathSync(undefined, 'hold.attempts', () => 2)).toBe(2);
  });
});
