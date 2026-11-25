// F-04-13 ops 배경 정비 조립 시험(동결 로컬, LCH-270·LCH-280, FX-T12).
// 계획 §2.11·§4.2: FraudActions의 expireDue·notifyDeadlines·closeDueCases를 1분 [가정]마다 부른다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as investigations from '../src/modules/investigations/index.js';

const mod = investigations as unknown as Record<string, any>;

describe('F-04-13 ops 배경 정비', () => {
  test('FX-T12 72 조립된 1분 정비 작업은 FraudActions의 세 시계를 한 바퀴에 부른다', async () => {
    const start = mod.startFraudActionSweep;
    expect(start).toBeTypeOf('function');
    const calls: string[] = [];
    const actions = {
      expireDue: async () => {
        calls.push('expireDue');
        return 1;
      },
      notifyDeadlines: async () => {
        calls.push('notifyDeadlines');
        return 1;
      },
      closeDueCases: async () => {
        calls.push('closeDueCases');
        return 1;
      },
    };
    const sweep = start({ actions, intervalMs: 60_000 });
    expect(sweep.tick).toBeTypeOf('function');
    await sweep.tick();
    expect(calls).toEqual(['expireDue', 'notifyDeadlines', 'closeDueCases']);
    sweep.stop();
  });

  test('FX-T12 73 앱 조립은 1분 정비 작업을 실제로 켠다', () => {
    const source = [
      readFileSync(new URL('../src/app.module.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'),
    ].join('\n');
    expect(source).toMatch(/startFraudActionSweep/);
    expect(source).toMatch(/60_000|60 \* 1000|FRAUD_ACTION_SWEEP_MS/);
  });
});
