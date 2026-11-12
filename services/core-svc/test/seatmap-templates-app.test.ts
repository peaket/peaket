// 템플릿에서 만들기 유스케이스 시험(ADR-0264 결정 17): 이미 좌석이 있으면 replace 확인, 변형·목표 오류, 저장 위임.
import { describe, expect, test } from 'vitest';
import { SeatmapTemplates } from '../src/modules/catalog/application/seatmap-templates.js';
import type { TemplateCatalog, TemplateDefinition } from '../src/modules/catalog/domain/seatmap-templates.js';

const template: TemplateDefinition = {
  templateId: 'a0000000-0000-4000-8000-0000000000a2',
  code: 'ARENA-END',
  name: '시험 아레나',
  family: 'ARENA',
  defaultCapacity: 1000,
  levelCount: 1,
  summary: '시험',
  variants: [{ key: 'thrustCm', label: '돌출', kind: 'NUMBER', min: 0, max: 100, defaultValue: 0 }],
  schematicUrl: '/seatmap-templates/arena-end.svg',
  version: 1,
  canvas: { width: 8000, height: 6000 },
  stage: [{ kind: 'RECT', points: [[3000, 200], [5000, 200], [5000, 800], [3000, 800]] }],
  sections: [
    { sectionId: 's1', name: 'A', shape: { kind: 'POLYGON', points: [[0, 1000], [3000, 1000], [3000, 3000], [0, 3000]] }, fillRule: { method: 'COUNT' }, defaultCapacity: 600 },
    { sectionId: 's2', name: 'B', shape: { kind: 'POLYGON', points: [[4000, 1000], [7000, 1000], [7000, 3000], [4000, 3000]] }, fillRule: { method: 'COUNT' }, defaultCapacity: 400 },
  ],
  priceTiers: [{ tierId: 'R', name: 'R석', price: 100000 }],
};
const catalog: TemplateCatalog = { list: () => [], get: (id) => (id === template.templateId ? template : undefined) };
const who = { tenantId: 't', accountId: 'a' };

function deps(seats: number, current: 'none' | 'not-found' = 'none') {
  const calls: unknown[] = [];
  const store = {
    current: async () =>
      current === 'not-found'
        ? 'not-found'
        : seats > 0
          ? {
              version: 3,
              doc: {
                canvas: template.canvas,
                stage: [],
                sections: [
                  {
                    sectionId: 's1',
                    name: 'A',
                    shape: template.sections[0]!.shape,
                    seats: Array.from({ length: seats }, (_, i) => ({ seatId: `x${i}`, index: i, row: '1', number: i + 1, x: 0, y: 0 })),
                  },
                ],
                priceTiers: [],
              },
            }
          : undefined,
  };
  const layouts = {
    save: async (q: unknown) => {
      calls.push(q);
      return { layoutVersion: 4, geometryLocked: false, priceTiers: [], canvas: template.canvas, stage: [], sections: [] };
    },
  };
  return { calls, app: new SeatmapTemplates(catalog, store as never, layouts as never) };
}

describe('템플릿에서 만들기', () => {
  test('좌석이 없으면 저장에 위임하고 목표 수가 구역별 fillRule에 들어간다', async () => {
    const { calls, app } = deps(0);
    const out = await app.create({ productionId: 'p', who, role: 'partner_admin', templateId: template.templateId, targetCapacity: 1000, replace: false });
    expect(out.layoutVersion).toBe(4);
    const q = calls[0] as { ifMatch: string; body: { sections: { fillRule: { targetCount: number } }[] } };
    expect(q.ifMatch).toBe('"0"');
    expect(q.body.sections.map((s) => s.fillRule.targetCount)).toEqual([600, 400]);
  });

  test('좌석이 있으면 replace가 아닐 때 409 replace-required, replace면 저장한다', async () => {
    const { calls, app } = deps(3);
    await expect(app.create({ productionId: 'p', who, role: 'partner_admin', templateId: template.templateId, targetCapacity: 1000, replace: false })).rejects.toMatchObject({
      type: expect.stringContaining('seatmap-replace-required'),
      status: 409,
    });
    expect(calls).toHaveLength(0);
    await app.create({ productionId: 'p', who, role: 'partner_admin', templateId: template.templateId, targetCapacity: 1000, replace: true });
    expect((calls[0] as { ifMatch: string }).ifMatch).toBe('"3"');
  });

  test('없는 템플릿·범위 밖 변형·너무 작은 목표는 404·422다', async () => {
    const { app } = deps(0);
    await expect(app.create({ productionId: 'p', who, role: 'partner_admin', templateId: 'nope', targetCapacity: 1000, replace: false })).rejects.toMatchObject({ status: 404 });
    await expect(app.create({ productionId: 'p', who, role: 'partner_admin', templateId: template.templateId, targetCapacity: 1000, variant: { thrustCm: 999 }, replace: false })).rejects.toMatchObject({ status: 422 });
    await expect(app.create({ productionId: 'p', who, role: 'partner_admin', templateId: template.templateId, targetCapacity: 1, replace: false })).rejects.toMatchObject({ status: 422 });
  });
});
