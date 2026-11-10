// 비공개 규칙 설정의 형식(docs/features/bot-defense.md §4.4, docs/security/secrets-and-keys.md '봇 탐지 규칙 매개변수', POL-006·POL-026).
// 공개 저장소에는 형식과 이름만 둔다. 기준값·가중치 값은 Secrets Manager에서 주입하고 코드에 쓰지 않는다.
// 오류 문구에는 칸의 이름만 싣는다(값을 싣지 않는다).
// 그림자 판(§10.4): 선택 칸 shadow는 적용 판과 같은 모양이고 판 번호가 달라야 한다. stage "LAUNCH"(출시 첫 판)면 그림자 판이 있어야 하고,
// 모든 강도·정렬 방식에서 적용 판의 BehaviorScore 가중치가 0, 그림자 판은 0보다 크며, 나머지 가중치·기준값·매개변수는 두 판이 같아야 읽는다(§10.1, B-T21 ①③).
import { z } from 'zod';
import { INTENSITIES, SCORER_NAMES } from './types.js';

/** 회차별 기기 공유 수의 원소 상한 [가정](bot-defense §3.2 tr:devshare). 저장소가 이 수를 넘겨 세지 않는다 */
export const DEV_SHARE_CAP = 20;

const positive = z.number().finite().positive();
const notNegative = z.number().finite().nonnegative();

const weights = z
  .object({
    HumanCheck: notNegative,
    DeviceTrust: notNegative,
    BehaviorScore: notNegative,
    NetworkScore: notNegative,
    AgeScore: notNegative,
    ConsistencyScore: notNegative,
  })
  .strict();

/** 가중치 합 검사의 여유. 소수 덧셈 오차로 합과 기준값이 같은 판이 거부되지 않게 한다 */
const WEIGHT_SUM_TOLERANCE = 1e-9;

// 가중치가 전부 0이거나 합이 기준값보다 작으면 어떤 요청도 기준에 닿지 못해 전원 ALLOW가 된다. 그런 판은 읽지 않는다
const profile = z
  .object({ threshold: positive, weights })
  .strict()
  .refine((p) => Object.values(p.weights).reduce((a, b) => a + b, 0) >= p.threshold - WEIGHT_SUM_TOLERANCE, { message: '가중치 합이 기준값에 닿지 못한다' });
const byShuffle = z.object({ ON: profile, OFF: profile, NONE: profile }).strict();

/** 낮은 끝이 높은 끝보다 작아야 한다(같으면 나눗셈이 0으로 나뉜다) */
const ordered = <T extends z.ZodRawShape>(shape: T, pairs: readonly (readonly [keyof z.output<z.ZodObject<T>>, keyof z.output<z.ZodObject<T>>])[]) =>
  z
    .object(shape)
    .strict()
    .refine((v) => pairs.every(([low, high]) => (v as Record<string, number>)[low as string]! < (v as Record<string, number>)[high as string]!), { message: '구간 끝값의 차례가 틀렸다' });

const unit = z.number().finite().min(0).max(1);

const params = z
  .object({
    device: ordered(
      {
        accountsFrom: notNegative,
        accountsAt: positive,
        sharedFrom: notNegative,
        sharedAt: positive,
        failuresFrom: notNegative,
        failuresAt: positive,
        /** pid 하나가 하루에 새로 등록할 수 있는 기기 수(기기 이력 오염을 막는다) */
        newDevicesPerDay: z.int().positive(),
      },
      [
        ['accountsFrom', 'accountsAt'],
        ['sharedFrom', 'sharedAt'],
        ['failuresFrom', 'failuresAt'],
      ],
      // 공유 수는 상한까지만 세므로 끝값이 상한을 넘으면 위험이 끝값에 닿지 못한다
    ).refine((d) => d.sharedAt <= DEV_SHARE_CAP, { message: '공유 수 끝값이 상한을 넘는다' }),
    behavior: ordered({ entropyLow: notNegative, entropyHigh: positive, intervalStdLow: notNegative, intervalStdHigh: positive, minPointerMoves: z.int().positive(), minWindowMs: z.int().positive() }, [
      ['entropyLow', 'entropyHigh'],
      ['intervalStdLow', 'intervalStdHigh'],
    ]),
    network: ordered({ hosting: unit, proxy: unit, entriesFrom: notNegative, entriesAt: positive }, [['entriesFrom', 'entriesAt']]),
    age: ordered({ cookieYoungMs: notNegative, cookieOldMs: positive, sessionYoungMs: notNegative, sessionOldMs: positive }, [
      ['cookieYoungMs', 'cookieOldMs'],
      ['sessionYoungMs', 'sessionOldMs'],
    ]),
    consistency: z.object({ mismatch: unit }).strict(),
  })
  .strict();

const core = {
  /** 바뀔 때마다 하나씩 늘어나는 판 번호(판정 기록의 profileVersion) */
  version: z.int().positive(),
  intensities: z.object({ RELAXED: byShuffle, BASE: byShuffle, STRICT: byShuffle }).strict(),
  params,
};

/** 그림자 판: 적용 판과 같은 모양(판 번호, 강도 셋 × 정렬 방식 셋의 기준값·가중치, 점수기 매개변수) */
const shadowSet = z.object(core).strict();

const SHUFFLE_KEYS = ['ON', 'OFF', 'NONE'] as const;

/** 키 차례와 상관없이 같은 값인가(매개변수 견주기) */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

const ruleSet = z
  .object({ ...core, shadow: shadowSet.optional(), stage: z.literal('LAUNCH').optional() })
  .strict()
  .superRefine((r, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (r.shadow && r.shadow.version === r.version) issue(['shadow', 'version'], '그림자 판 번호가 적용 판과 같다');
    if (r.stage !== 'LAUNCH') return;
    const shadow = r.shadow;
    if (!shadow) {
      issue(['shadow'], '출시 첫 판에는 그림자 판이 있어야 한다');
      return;
    }
    for (const i of INTENSITIES) {
      for (const s of SHUFFLE_KEYS) {
        const active = r.intensities[i][s];
        const other = shadow.intensities[i][s];
        if (active.weights.BehaviorScore !== 0) issue(['intensities', i, s, 'weights', 'BehaviorScore'], '출시 첫 판의 적용 판 BehaviorScore 가중치는 0이다');
        if (!(other.weights.BehaviorScore > 0)) issue(['shadow', 'intensities', i, s, 'weights', 'BehaviorScore'], '출시 첫 판의 그림자 판 BehaviorScore 가중치는 0보다 크다');
        if (active.threshold !== other.threshold) issue(['shadow', 'intensities', i, s, 'threshold'], '출시 첫 판의 두 판 기준값이 다르다');
        for (const n of SCORER_NAMES) if (n !== 'BehaviorScore' && active.weights[n] !== other.weights[n]) issue(['shadow', 'intensities', i, s, 'weights', n], '출시 첫 판의 두 판 가중치가 다르다');
      }
    }
    if (canonical(r.params) !== canonical(shadow.params)) issue(['shadow', 'params'], '출시 첫 판의 두 판 매개변수가 다르다');
  });

export type RuleSet = z.output<typeof ruleSet>;
/** 그림자 판(§10.4) */
export type ShadowRuleSet = NonNullable<RuleSet['shadow']>;
export type Profile = z.output<typeof profile>;
export type ScorerParams = RuleSet['params'];

/** 형식이 틀리면 던진다. 문구에 값을 싣지 않는다 */
export function parseRuleSet(text: string): RuleSet {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('비공개 규칙 설정이 JSON이 아니다');
  }
  const r = ruleSet.safeParse(raw);
  if (!r.success) {
    const where = [...new Set(r.error.issues.map((i) => i.path.join('.') || '(맨 위)'))].slice(0, 10).join(', ');
    throw new Error(`비공개 규칙 설정의 형식이 틀렸다: ${where}`);
  }
  return r.data;
}
