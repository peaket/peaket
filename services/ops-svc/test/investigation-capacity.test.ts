// F-04-19 조사 갈래 용량 외삽 시험(동결 로컬, LCH-340).
// 정본: docs/features/forensic-replay.md §7.2·§8(FX-T22), docs/planning/02 §3.1 원칙 5.
// 실제 1/10 측정은 미실행이다. 이 시험은 외삽 함수·전제·[추정]/미측정 표기만 고정한다.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const MODULE_PATH = '../src/modules/investigations/domain/capacity.ts';

async function load(rel: string): Promise<Record<string, any> | null> {
  const url = new URL(rel, import.meta.url);
  if (!existsSync(fileURLToPath(url))) return null;
  return (await import(/* @vite-ignore */ url.href)) as Record<string, any>;
}
const moduleOf = async () => {
  const mod = await load(MODULE_PATH);
  expect(mod, `${MODULE_PATH}가 아직 없다`).not.toBeNull();
  return mod;
};

const measurement = (o: Record<string, unknown> = {}) => ({ id: 'cluster', measuredMs: 100, rows: 100_000, targetMs: 1_000, ...o });

describe('F-04-19 조사 갈래 용량 외삽', () => {
  test('FX-T22 ① [추정] 1/10 측정값×10을 목표와 견주고 실측 아님을 표시한다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const pass = m.extrapolateCapacity(measurement());
    expect(pass).toMatchObject({
      id: 'cluster',
      basis: 'MEASURED_EXTRAPOLATION',
      label: '[추정]',
      measuredMs: 100,
      extrapolatedMs: 1_000,
      targetMs: 1_000,
      ratio: 1,
      verdict: 'PASS_ESTIMATE',
    });
    expect(pass.assumptions).toEqual(['선형 비례', '1/10 규모 측정값 × 10', '실측 아님']);

    const fail = m.extrapolateCapacity(measurement({ measuredMs: 100.1 }));
    expect(fail.extrapolatedMs).toBe(1_001);
    expect(fail.verdict).toBe('FAIL_ESTIMATE');
    expect(fail.ratio).toBeCloseTo(1.001, 10);

    const justPass = m.extrapolateCapacity(measurement({ measuredMs: 200, targetMs: 2_000 }));
    expect(justPass.verdict).toBe('PASS_ESTIMATE');
    const justFail = m.extrapolateCapacity(measurement({ measuredMs: 200, targetMs: 1_999 }));
    expect(justFail.verdict).toBe('FAIL_ESTIMATE');

    const factor2 = m.extrapolateCapacity(measurement({ measuredMs: 100 }), { factor: 2 });
    expect(factor2.extrapolatedMs).toBe(200);
    expect(factor2.basis).toBe('MEASURED_EXTRAPOLATION');
  });

  test('FX-T22 ② 미측정은 0으로 합격하지 않고 UNMEASURED·미측정으로 남는다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const none = m.extrapolateCapacity(measurement({ measuredMs: null }));
    expect(none).toMatchObject({
      basis: 'UNMEASURED',
      label: '미측정',
      measuredMs: null,
      extrapolatedMs: null,
      ratio: null,
      verdict: 'UNMEASURED',
    });
    expect(none.assumptions).toEqual(['선형 비례', '1/10 규모 측정값 × 10', '실측 아님']);

    const list = m.capacityEstimates([
      measurement({ id: 'snapshot', measuredMs: null }),
      measurement({ id: 'cluster', measuredMs: 100 }),
      measurement({ id: 'replay-file', measuredMs: null }),
    ]);
    expect(list.map((x: any) => x.id)).toEqual(['snapshot', 'cluster', 'replay-file']);
    expect(list.map((x: any) => x.verdict)).toEqual(['UNMEASURED', 'PASS_ESTIMATE', 'UNMEASURED']);
    expect(list.every((x: any) => x.extrapolatedMs !== 0)).toBe(true);
  });

  test('FX-T22 ③ 잘못된 입력은 RangeError다', async () => {
    const m = await moduleOf();
    if (!m) return;
    expect(() => m.extrapolateCapacity(measurement({ rows: 0 }))).toThrow(RangeError);
    expect(() => m.extrapolateCapacity(measurement({ targetMs: 0 }))).toThrow(RangeError);
    expect(() => m.extrapolateCapacity(measurement(), { factor: 0 })).toThrow(RangeError);
    expect(() => m.extrapolateCapacity(measurement({ measuredMs: Number.NaN }))).toThrow(RangeError);
    expect(() => m.extrapolateCapacity(measurement({ measuredMs: -1 }))).toThrow(RangeError);
    expect(() => m.extrapolateCapacity(measurement(), { factor: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
