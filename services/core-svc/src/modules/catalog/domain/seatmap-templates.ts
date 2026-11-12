// 좌석맵 템플릿 카탈로그(ADR-0066, ADR-0264 결정 15~17). 배포 때 넣는 정적 JSON 파일을 읽고,
// 목표 좌석 수를 구역 비율로 나눠 템플릿에서 만들기 본문(SeatMapLayoutInput)을 만든다. 순수 함수만 둔다.
import type { LayoutShape } from './seatmap-import.js';
import type { LayoutInput } from './seatmap-layout.js';

export const TEMPLATE_CODES = ['ARENA-END', 'ARENA-THRUST', 'ARENA-CENTER', 'DOME', 'STADIUM', 'THEATER-L', 'THEATER-M', 'THEATER-S', 'HALL', 'FLAT'] as const;
export type TemplateCode = (typeof TEMPLATE_CODES)[number];
export type TemplateFamily = 'ARENA' | 'DOME' | 'STADIUM' | 'THEATER' | 'HALL' | 'FLAT';

export interface TemplateVariant {
  key: string;
  label: string;
  kind: 'CHOICE' | 'NUMBER' | 'BOOLEAN';
  options?: string[];
  min?: number;
  max?: number;
  defaultValue?: unknown;
}

export interface TemplateSection {
  sectionId: string;
  name: string;
  level?: string;
  tierId?: string;
  shape: LayoutShape;
  /** 기본 채우기 규칙. targetCount는 만들 때 목표 좌석 수 배분으로 바꾼다 */
  fillRule: Record<string, unknown>;
  /** 비율 배분에 쓰는 기본 좌석 수(없으면 1) */
  defaultCapacity: number;
}

export interface TemplateDefinition {
  templateId: string;
  code: TemplateCode;
  name: string;
  family: TemplateFamily;
  defaultCapacity: number;
  levelCount: number;
  summary: string;
  variants: TemplateVariant[];
  schematicUrl: string;
  version: number;
  canvas: { width: number; height: number };
  stage: LayoutShape[];
  sections: TemplateSection[];
  /** 등급 기본값(템플릿에서 만들 때 함께 넣는다) */
  priceTiers?: { tierId: string; name: string; price: number }[];
}

export interface TemplateSummary {
  templateId: string;
  code: TemplateCode;
  name: string;
  family: TemplateFamily;
  defaultCapacity: number;
  levelCount: number;
  sectionCount: number;
  summary: string;
  variants: TemplateVariant[];
  schematicUrl: string;
  version: number;
}

export interface TemplateCatalog {
  list(): TemplateSummary[];
  get(templateId: string): TemplateDefinition | undefined;
}

export const summaryOf = (t: TemplateDefinition): TemplateSummary => ({
  templateId: t.templateId,
  code: t.code,
  name: t.name,
  family: t.family,
  defaultCapacity: t.defaultCapacity,
  levelCount: t.levelCount,
  sectionCount: t.sections.length,
  summary: t.summary,
  variants: t.variants,
  schematicUrl: t.schematicUrl,
  version: t.version,
});

/** 고른 변형이 템플릿 범위 안인가. 틀리면 오류 코드, 맞으면 undefined */
export function variantProblem(t: TemplateDefinition, variant: Record<string, unknown> | undefined): string | undefined {
  const given = variant ?? {};
  const known = new Map(t.variants.map((v) => [v.key, v]));
  for (const [k, v] of Object.entries(given)) {
    const def = known.get(k);
    if (!def) return `VARIANT_UNKNOWN:${k}`;
    if (def.kind === 'BOOLEAN' && typeof v !== 'boolean') return `VARIANT_TYPE:${k}`;
    if (def.kind === 'NUMBER' && !(typeof v === 'number' && Number.isInteger(v) && (def.min === undefined || v >= def.min) && (def.max === undefined || v <= def.max))) return `VARIANT_RANGE:${k}`;
    if (def.kind === 'CHOICE' && (typeof v !== 'string' || !(def.options ?? []).includes(v))) return `VARIANT_CHOICE:${k}`;
  }
  for (const def of t.variants) {
    if (def.defaultValue !== undefined && given[def.key] === undefined) given[def.key] = def.defaultValue;
  }
  return undefined;
}

/**
 * 목표 좌석 수를 구역 기본 좌석 수 비율로 나눈다(내림 뒤 나머지는 소수부가 큰 구역부터 1석씩, 같으면 기본 좌석 수가 큰 구역부터).
 * 구역마다 최소 1석을 먼저 주므로 목표가 구역 수보다 작으면 만들 수 없다(422)
 */
export function splitCapacity(sections: readonly TemplateSection[], target: number): Map<string, number> | undefined {
  if (sections.length === 0 || target < sections.length) return undefined;
  const weights = sections.map((s) => (Number.isFinite(s.defaultCapacity) && s.defaultCapacity > 0 ? s.defaultCapacity : 1));
  const total = weights.reduce((n, w) => n + w, 0);
  const base = new Map<string, number>();
  let left = target;
  for (const s of sections) {
    base.set(s.sectionId, 1);
    left--;
  }
  const raw = sections.map((s, i) => (left * weights[i]!) / total);
  const add = raw.map((r) => Math.floor(r));
  let used = add.reduce((n, x) => n + x, 0);
  for (let i = 0; i < sections.length; i++) base.set(sections[i]!.sectionId, base.get(sections[i]!.sectionId)! + add[i]!);
  const order = sections
    .map((s, i) => ({ s, i, frac: raw[i]! - add[i]!, weight: weights[i]! }))
    .sort((a, b) => b.frac - a.frac || b.weight - a.weight || a.i - b.i);
  for (let k = 0; used < left; k = (k + 1) % order.length) {
    base.set(order[k]!.s.sectionId, base.get(order[k]!.s.sectionId)! + 1);
    used++;
  }
  return base;
}

/** 템플릿에서 만들기 본문. 좌석은 없고 구역마다 목표 수가 든 fillRule이 있다 */
export function templateLayout(t: TemplateDefinition, target: number): LayoutInput | undefined {
  const split = splitCapacity(t.sections, target);
  if (!split) return undefined;
  return {
    layoutVersion: 0,
    templateVenueId: t.templateId,
    canvas: { width: t.canvas.width, height: t.canvas.height },
    stage: t.stage,
    sections: t.sections.map((s) => ({
      sectionId: s.sectionId,
      name: s.name,
      ...(s.level !== undefined ? { level: s.level } : {}),
      ...(s.tierId !== undefined ? { tierId: s.tierId } : {}),
      shape: s.shape,
      fillRule: { ...s.fillRule, targetCount: split.get(s.sectionId)! },
      seats: [],
    })),
    priceTiers: t.priceTiers ?? [],
  };
}
