// 대기열 v0 대기 상태의 예상 대기와 거리별 폴링 간격(docs/features/queue-admission.md §4·§13, docs/frontend.md §5.1, ADR-0110, POL-007).
// 모듈 공개 파일만 본다. Redis 없이 도는 단위 시험이다.
import { describe, expect, test } from 'vitest';
import { ADMISSION_GRACE_MS, POLL_FAR_MS, POLL_MID_MS, POLL_NEAR_MS, etaSeconds, pollIntervalMs } from '../src/modules/queue/index.js';

/**
 * docs/frontend.md §5.1 nextDelayMs의 기본 간격(지터·실패·숨긴 탭 보정 전)을 그대로 옮긴 기준식이다.
 * v0 서버의 pollAfterMs는 이 식과 같아야 한다(§13 동작 2).
 */
function v1BaseDelayMs(aheadCount: number, servingRate: number): number {
  const eta = aheadCount / Math.max(servingRate, 0.001); // 초
  return eta <= 60 ? 500 : eta <= 300 ? 5000 : 20000; // 정본 0.5·5·20초(ADR-0110)
}

/** POL-007의 예상 대기 = 앞 인원 ÷ 속도의 올림. 앞 인원 0이면 0, 속도가 0 이하면 알 수 없어 null(polling.ts 계약) */
function referenceEta(ahead: number, rate: number): number | null {
  if (ahead === 0) return 0;
  if (rate <= 0) return null;
  return Math.ceil(ahead / rate);
}

const AHEADS = [0, 1, 2, 3, 7, 29, 30, 31, 59, 60, 61, 119, 120, 121, 149, 150, 151, 299, 300, 301, 599, 600, 601, 1_000, 6_000, 30_000, 100_000, 1_000_000];
const RATES = [-5, -0.5, 0, 0.0005, 0.001, 0.002, 0.1, 0.3, 1 / 3, 0.5, 0.7, 1, 2, 2.8, 3, 7, 10, 100, 1_000, 100_000];

describe('거리별 폴링 간격 상수(ADR-0110)', () => {
  test('ADR0110_거리별폴링간격상수는_0.5초_5초_20초다', () => {
    expect([POLL_NEAR_MS, POLL_MID_MS, POLL_FAR_MS]).toEqual([500, 5_000, 20_000]);
  });

  test('POL008_차례뒤입장유예는_정확히15분이다', () => {
    expect(ADMISSION_GRACE_MS).toBe(15 * 60 * 1000);
  });
});

describe('pollIntervalMs: 예상 대기(앞 인원 ÷ max(속도, 0.001)초)로 정하는 거리별 간격', () => {
  test('QT2_ADR0110_예상대기60초이하는500ms다', () => {
    expect(pollIntervalMs(0, 1)).toBe(500);
    expect(pollIntervalMs(1, 1)).toBe(500);
    expect(pollIntervalMs(59, 1)).toBe(500);
    // 경계: 정확히 60초는 가까운 구간이다
    expect(pollIntervalMs(60, 1)).toBe(500);
    expect(pollIntervalMs(120, 2)).toBe(500);
  });

  test('QT2_ADR0110_예상대기60초를넘고300초이하는5000ms다', () => {
    // 60초를 조금이라도 넘으면 중간 구간이다
    expect(pollIntervalMs(61, 1)).toBe(5_000);
    expect(pollIntervalMs(121, 2)).toBe(5_000);
    expect(pollIntervalMs(200, 1)).toBe(5_000);
    // 경계: 정확히 300초는 중간 구간이다
    expect(pollIntervalMs(300, 1)).toBe(5_000);
    expect(pollIntervalMs(600, 2)).toBe(5_000);
  });

  test('QT2_ADR0110_예상대기300초를넘으면20000ms다', () => {
    expect(pollIntervalMs(301, 1)).toBe(20_000);
    expect(pollIntervalMs(601, 2)).toBe(20_000);
    expect(pollIntervalMs(1_000_000, 1)).toBe(20_000);
  });

  test('ADR0110_속도가0이하면_앞인원이있으면20000ms이고없으면500ms다', () => {
    // 속도 0·음수는 0.001로 본다: 앞 인원 1명이면 1,000초라 먼 구간이다
    for (const rate of [0, -1, -0.5, -100_000]) {
      expect(pollIntervalMs(1, rate), `rate=${rate}`).toBe(20_000);
      expect(pollIntervalMs(1_000_000, rate), `rate=${rate}`).toBe(20_000);
      // 앞 인원 0이면 예상 대기 0초라 가까운 구간이다
      expect(pollIntervalMs(0, rate), `rate=${rate}`).toBe(500);
    }
  });

  test('ADR0110_속도하한0.001보다작은속도는_0.001로본다', () => {
    // 앞 인원 1명: 0.001로 보면 1,000초라 먼 구간이다. 0으로 나누거나 음수 예상 대기가 나오지 않는다
    expect(pollIntervalMs(1, 0.0005)).toBe(20_000);
    expect(pollIntervalMs(0, 0.0005)).toBe(500);
    // 속도가 정확히 0.001이면 그대로 쓴다
    expect(pollIntervalMs(0, 0.001)).toBe(500);
    expect(pollIntervalMs(1, 0.001)).toBe(20_000);
  });

  test('QT2_ADR0110_소수속도도같은경계를쓴다', () => {
    // 속도 0.5: 앞 30명이면 60초, 31명이면 62초, 150명이면 300초, 151명이면 302초
    expect(pollIntervalMs(30, 0.5)).toBe(500);
    expect(pollIntervalMs(31, 0.5)).toBe(5_000);
    expect(pollIntervalMs(150, 0.5)).toBe(5_000);
    expect(pollIntervalMs(151, 0.5)).toBe(20_000);
    // 속도 2.8(최근 10칸 평균이 소수인 경우): 168 ÷ 2.8은 부동소수로 60.00000000000001이다.
    // 브라우저 폴러와 같은 나눗셈을 써야 같은 답(5,000)이 나온다(곱셈으로 바꿔 비교하지 않는다)
    expect(pollIntervalMs(168, 2.8)).toBe(v1BaseDelayMs(168, 2.8));
    expect(pollIntervalMs(169, 2.8)).toBe(5_000);
  });

  test('QT2_ADR0110_큰값에서도경계가정확하다', () => {
    // 속도 100,000(admitPerSecond 상한): 앞 600만 명이 정확히 60초, 3,000만 명이 정확히 300초
    expect(pollIntervalMs(6_000_000, 100_000)).toBe(500);
    expect(pollIntervalMs(6_000_001, 100_000)).toBe(5_000);
    expect(pollIntervalMs(30_000_000, 100_000)).toBe(5_000);
    expect(pollIntervalMs(30_000_001, 100_000)).toBe(20_000);
    expect(pollIntervalMs(Number.MAX_SAFE_INTEGER, 100_000)).toBe(20_000);
  });

  test('QT2_ADR0110_v1브라우저폴러의기본간격식과_격자전체에서같다', () => {
    for (const ahead of AHEADS) {
      for (const rate of RATES) {
        expect(pollIntervalMs(ahead, rate), `ahead=${ahead} rate=${rate}`).toBe(v1BaseDelayMs(ahead, rate));
      }
    }
  });
});

describe('etaSeconds: 예상 대기(초) = 앞 인원 ÷ 차례 진행 속도의 올림(POL-007)', () => {
  test('POL007_예상대기는앞인원나누기속도의올림이다', () => {
    expect(etaSeconds(9, 3)).toBe(3);
    expect(etaSeconds(10, 3)).toBe(4);
    expect(etaSeconds(60, 1)).toBe(60);
    expect(etaSeconds(61, 1)).toBe(61);
    expect(etaSeconds(1, 0.5)).toBe(2);
    expect(etaSeconds(3, 2)).toBe(2);
    // 1초보다 짧아도 올림이라 1초다
    expect(etaSeconds(1, 100_000)).toBe(1);
  });

  test('POL007_앞인원이0이면_속도와상관없이0이다', () => {
    expect(etaSeconds(0, 5)).toBe(0);
    expect(etaSeconds(0, 0)).toBe(0);
    expect(etaSeconds(0, -1)).toBe(0);
  });

  test('POL007_속도가0이하면_알수없어null이다', () => {
    expect(etaSeconds(5, 0)).toBeNull();
    expect(etaSeconds(5, -1)).toBeNull();
    expect(etaSeconds(1, -0.0001)).toBeNull();
    expect(etaSeconds(1_000_000, 0)).toBeNull();
  });

  test('POL007_큰값과작은속도에서도올림이정확하다', () => {
    expect(etaSeconds(1_000_000, 1)).toBe(1_000_000);
    expect(etaSeconds(999_999, 100_000)).toBe(10);
    expect(etaSeconds(1_000_000, 100_000)).toBe(10);
    expect(etaSeconds(1_000_001, 100_000)).toBe(11);
    // 속도 하한(0.001)은 폴링 간격에만 쓴다. 예상 대기는 실제 속도로 나눈다
    expect(etaSeconds(1, 0.0005)).toBe(2_000);
    expect(etaSeconds(1, 0.001)).toBe(1_000);
  });

  test('POL007_기준식과_격자전체에서같다', () => {
    for (const ahead of AHEADS) {
      for (const rate of RATES) {
        expect(etaSeconds(ahead, rate), `ahead=${ahead} rate=${rate}`).toBe(referenceEta(ahead, rate));
      }
    }
  });

  test('QT2_ADR0110_예상대기와폴링간격은같은구간을가리킨다', () => {
    // 속도가 0보다 크면: 올림한 예상 대기가 60 이하 ⇔ 500, 300 이하 ⇔ 5,000(경계가 정수라 올림이 구간을 바꾸지 않는다)
    for (const ahead of AHEADS) {
      for (const rate of RATES.filter((r) => r > 0)) {
        const eta = etaSeconds(ahead, rate)!;
        const expected = eta <= 60 ? 500 : eta <= 300 ? 5_000 : 20_000;
        expect(pollIntervalMs(ahead, rate), `ahead=${ahead} rate=${rate} eta=${eta}`).toBe(expected);
      }
    }
  });
});
