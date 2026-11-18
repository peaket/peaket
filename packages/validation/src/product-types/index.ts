// @peaket/validation/product-types: 상품 유형별 속성 스키마(Zod, 입력 모양을 검사하는 라이브러리) 판 묶음(ADR-0101, ADR-0300 결정 1, V-T46).
// core-svc shop(파트너 상품 만들기·고치기, 주문 옵션 검사, 매일 속성 검증 잡)과 화면이 같은 함수를 쓴다.
// zod만 가져오고 계약 생성 스키마는 가져오지 않는다. 서비스는 빌드한 dist(default 조건)를, 화면은 원본을 쓴다.
// - 모든 유형이 같이 쓰는 칸: perAccountLimit(계정당 최대 수량, 1~99 정수 또는 null), options(옵션 0~10개 [가정],
//   옵션마다 이름 1~30자와 고를 값 1~50개, 값은 1~50자, 이름·값 겹침 없음)
// - MERCH 판 1은 이 둘만, PARKING 판 1은 vehicleNotice(차량 안내, 선택, 1~200자 [가정])를 더한다. 모르는 칸은 거절한다(strict)
// - 판 번호는 정수로 견준다(문자열로 견주지 않는다)
import { z } from 'zod';

/** 옵션 수 상한 [가정](ADR-0300 결정 1) */
export const PRODUCT_OPTIONS_MAX = 10;
/** 옵션 이름 길이 상한(글자) */
export const PRODUCT_OPTION_NAME_MAX = 30;
/** 옵션 하나의 고를 값 수 상한 */
export const PRODUCT_OPTION_VALUES_MAX = 50;
/** 고를 값 길이 상한(글자) */
export const PRODUCT_OPTION_VALUE_MAX = 50;
/** 계정당 최대 수량의 범위(정수) */
export const PER_ACCOUNT_LIMIT_MIN = 1;
export const PER_ACCOUNT_LIMIT_MAX = 99;
/** 주차권 차량 안내 길이 상한 [가정] */
export const VEHICLE_NOTICE_MAX = 200;

const chars = (s: string): number => [...s].length;
const text = (max: number) => z.string().refine((s) => chars(s) >= 1 && chars(s) <= max, { message: `1~${max}자` });

const optionSchema = z
  .object({
    name: text(PRODUCT_OPTION_NAME_MAX),
    values: z
      .array(text(PRODUCT_OPTION_VALUE_MAX))
      .min(1)
      .max(PRODUCT_OPTION_VALUES_MAX)
      .refine((v) => new Set(v).size === v.length, { message: '고를 값이 겹칩니다' }),
  })
  .strict();

const common = {
  perAccountLimit: z.number().int().min(PER_ACCOUNT_LIMIT_MIN).max(PER_ACCOUNT_LIMIT_MAX).nullable().optional(),
  options: z
    .array(optionSchema)
    .max(PRODUCT_OPTIONS_MAX)
    .refine((v) => new Set(v.map((o) => o.name)).size === v.length, { message: '옵션 이름이 겹칩니다' })
    .optional(),
};

/** 상품 옵션 하나(이름과 고를 값) */
export interface ProductOption {
  readonly name: string;
  readonly values: readonly string[];
}

/** 유형 스키마를 통과한 속성에서 주문이 읽는 공통 칸 */
export interface ProductCommonAttributes {
  readonly perAccountLimit: number | null;
  readonly options: readonly ProductOption[];
}

/** 유형 코드 → 판 번호 → 스키마. 새 판은 아래에 더하고 옛 판은 지우지 않는다(속성 검증 잡이 그 행의 판으로 다시 검사한다) */
const SCHEMAS: Readonly<Record<string, Readonly<Record<number, z.ZodType<Record<string, unknown>>>>>> = {
  MERCH: { 1: z.object({ ...common }).strict() },
  PARKING: { 1: z.object({ ...common, vehicleNotice: text(VEHICLE_NOTICE_MAX).optional() }).strict() },
};

/** 스키마 묶음이 아는 유형 코드(product_type 표의 행과 함께 배포한다) */
export const PRODUCT_TYPE_CODES: readonly string[] = Object.keys(SCHEMAS);

/** 그 유형·판의 스키마. 모르는 유형·판이면 undefined */
export function productAttributeSchema(type: string, version: number): z.ZodType<Record<string, unknown>> | undefined {
  if (!Number.isInteger(version)) return undefined;
  const byVersion = Object.hasOwn(SCHEMAS, type) ? SCHEMAS[type] : undefined;
  return byVersion && Object.hasOwn(byVersion, version) ? byVersion[version] : undefined;
}

/** 그 유형의 가장 높은 판(숫자로 견준다). 모르는 유형이면 undefined */
export function latestProductSchemaVersion(type: string): number | undefined {
  const byVersion = Object.hasOwn(SCHEMAS, type) ? SCHEMAS[type] : undefined;
  if (!byVersion) return undefined;
  const versions = Object.keys(byVersion).map(Number);
  return versions.length === 0 ? undefined : Math.max(...versions);
}

export type ProductAttributesCheck =
  | { readonly ok: true; readonly attributes: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'unknown-schema' | 'invalid'; readonly paths: readonly string[] };

/**
 * 속성을 그 유형·판의 스키마로 검사한다. 실패하면 틀린 칸의 경로(값은 싣지 않는다)를 돌려준다.
 * 던지지 않는다.
 */
export function checkProductAttributes(type: string, version: number, attributes: unknown): ProductAttributesCheck {
  const schema = productAttributeSchema(type, version);
  if (!schema) return { ok: false, reason: 'unknown-schema', paths: [] };
  const r = schema.safeParse(attributes);
  if (r.success) return { ok: true, attributes: r.data };
  return { ok: false, reason: 'invalid', paths: [...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))] };
}

/** 검사를 통과한 속성에서 공통 칸을 읽는다(없으면 한도 없음·옵션 없음) */
export function commonAttributesOf(attributes: Record<string, unknown>): ProductCommonAttributes {
  const limit = attributes.perAccountLimit;
  const options = Array.isArray(attributes.options) ? (attributes.options as ProductOption[]) : [];
  return { perAccountLimit: typeof limit === 'number' ? limit : null, options };
}

/**
 * 고른 옵션(이름 → 값)이 상품 옵션에 맞는가. 옵션이 있는 상품은 모든 옵션을 고른다(ADR-0300 결정 4).
 * 상품에 없는 옵션 이름, 고를 값 밖의 값, 빠진 옵션이면 false
 */
export function optionsMatch(productOptions: readonly ProductOption[], chosen: Readonly<Record<string, string>> | undefined): boolean {
  const picked = chosen ?? {};
  const names = Object.keys(picked);
  if (names.length !== productOptions.length) return false;
  for (const o of productOptions) {
    if (!Object.hasOwn(picked, o.name)) return false;
    if (!o.values.includes(picked[o.name]!)) return false;
  }
  return true;
}
