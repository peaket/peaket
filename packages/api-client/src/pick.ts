// 요청용 스키마의 칸만 고르기(docs/api/guidelines.md §1 '요청은 닫고 응답은 연다', BUILD_ORDER BAS-041).
// 읽은 응답(열림, 칸이 늘 수 있다)을 고쳐 PUT·PATCH로 다시 보낼 때, 요청용 스키마(<이름>Input, 닫힘)에 없는 칸을 빼서
// 정의 밖 칸으로 400이 나지 않게 한다. 값은 검사하지 않는다(서버가 검사한다).
// 객체·배열·선택·null 허용·기본값 안으로 들어간다. 합집합(union)·레코드·교집합 안은 고르지 않고 그대로 둔다(요청 본문은 allOf로 잇지 않고,
// 지금 If-Match 본문에는 그런 구조가 없다). Zod 판이 둘이어도 맞게 instanceof 대신 스키마 정의의 종류(_zod.def.type)로 가른다
import type { z } from 'zod';

interface Def {
  type: string;
  innerType?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
}
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

function inner(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (let i = 0; i < 16; i++) {
    const d = defOf(s);
    if ((d.type === 'optional' || d.type === 'nullable' || d.type === 'default' || d.type === 'prefault') && d.innerType) s = d.innerType;
    else return s;
  }
  return s;
}

export function pickRequestFields<S extends z.ZodType>(schema: S, value: unknown): z.input<S> {
  const s = inner(schema);
  const d = defOf(s);
  if (d.type === 'object' && d.shape && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(d.shape)) {
      if (Object.hasOwn(value, k)) out[k] = pickRequestFields(sub, (value as Record<string, unknown>)[k]);
    }
    return out as z.input<S>;
  }
  if (d.type === 'array' && d.element && Array.isArray(value)) return value.map((x) => pickRequestFields(d.element!, x)) as z.input<S>;
  return value as z.input<S>;
}
