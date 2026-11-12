// 좌석맵 템플릿 정적 카탈로그·목표 좌석 수 배분 시험(ADR-0066, ADR-0264 결정 17).
import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { StaticTemplateCatalog } from '../src/modules/catalog/adapters/static-template-catalog.js';
import { splitCapacity, summaryOf, templateLayout, variantProblem } from '../src/modules/catalog/domain/seatmap-templates.js';

const catalog = StaticTemplateCatalog.load(fileURLToPath(new URL('../seed/seatmap-templates/', import.meta.url)));

describe('S-T40 ① 템플릿 목록·하나', () => {
  test('목록은 공개된 템플릿 10종이고 코드·이름·변형·개략도 주소가 있다', () => {
    const items = catalog.list();
    expect(items).toHaveLength(10);
    expect(new Set(items.map((x) => x.code)).size).toBe(10);
    for (const x of items) {
      expect(x.name.length).toBeGreaterThan(0);
      expect(x.schematicUrl).toMatch(/^https:\/\/partner\.peaket\.example\/seatmap-templates\/[a-z-]+\.svg$/);
      expect(x.sectionCount).toBeGreaterThanOrEqual(4);
    }
  });

  test('하나는 도형·구역별 fillRule·등급 기본값을 주며 좌석 좌표가 없다', () => {
    const t = catalog.get(catalog.list()[0]!.templateId)!;
    const layout = templateLayout(t, t.defaultCapacity)!;
    expect(layout.templateVenueId).toBe(t.templateId);
    expect(layout.sections.every((s) => (s.seats ?? []).length === 0)).toBe(true);
    expect(layout.sections.every((s) => typeof (s.fillRule as { targetCount?: unknown }).targetCount === 'number')).toBe(true);
    expect(layout.priceTiers?.map((x) => x.tierId)).toEqual(['R', 'S', 'A']);
    expect(summaryOf(t).sectionCount).toBe(t.sections.length);
  });
});

describe('S-T40 ② 목표 좌석 수 배분·변형', () => {
  test('구역별 목표 수 합은 목표와 같고 큰 구역이 더 많이 받는다', () => {
    const t = catalog.get(catalog.list()[0]!.templateId)!;
    for (const target of [1000, 1234, 12000]) {
      const split = splitCapacity(t.sections, target)!;
      expect([...split.values()].reduce((n, x) => n + x, 0)).toBe(target);
      const layout = templateLayout(t, target)!;
      const counts = layout.sections.map((s) => (s.fillRule as { targetCount: number }).targetCount);
      expect(counts.reduce((n, x) => n + x, 0)).toBe(target);
    }
    expect(splitCapacity(t.sections, t.sections.length - 1)).toBeUndefined();
  });

  test('나머지는 소수부가 큰 구역부터 준다', () => {
    const sections = [
      { sectionId: 'a', name: 'A', shape: { kind: 'POLYGON', points: [[0, 0], [1, 0], [1, 1]] }, fillRule: {}, defaultCapacity: 600 },
      { sectionId: 'b', name: 'B', shape: { kind: 'POLYGON', points: [[0, 0], [1, 0], [1, 1]] }, fillRule: {}, defaultCapacity: 400 },
    ] as const;
    const split = splitCapacity(sections as never, 1001)!;
    expect([...split.values()]).toEqual([600, 401]);
  });

  test('변형은 목록에 있는 키·형·범위만 받는다', () => {
    const t = catalog.list().find((x) => x.code === 'ARENA-END')!;
    const def = catalog.get(t.templateId)!;
    expect(variantProblem(def, { thrustCm: 0 })).toBeUndefined();
    expect(variantProblem(def, { nope: 1 })).toContain('VARIANT_UNKNOWN');
    expect(variantProblem(def, { thrustCm: -1 })).toContain('VARIANT_RANGE');
    expect(variantProblem(def, { thrustCm: 'x' as never })).toContain('VARIANT_RANGE');
  });
});
