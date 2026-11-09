// 비공개 규칙 설정의 형식(docs/features/bot-defense.md §4.4, docs/security/secrets-and-keys.md '봇 탐지 규칙 매개변수', POL-006·POL-026).
// 공개 저장소에는 형식과 이름만 둔다. 기준값·가중치 값은 Secrets Manager에서 주입하고 코드에 쓰지 않는다.
// 오류 문구에는 칸의 이름만 싣는다(값을 싣지 않는다).
import { z } from 'zod';

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
    ),
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

const ruleSet = z
  .object({
    /** 바뀔 때마다 하나씩 늘어나는 판 번호(판정 기록의 profileVersion) */
    version: z.int().positive(),
    intensities: z.object({ RELAXED: byShuffle, BASE: byShuffle, STRICT: byShuffle }).strict(),
    params,
  })
  .strict();

export type RuleSet = z.output<typeof ruleSet>;
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
