// 에디터 잇기의 서버 칸(ADR-0264 결정 12·13, BUILD_ORDER HOT-220): 도형 매개변수 arc의 관계 검사와 저장·팬 파일, 응답 geometryLocked
import { describe, expect, test } from 'vitest';
import { arcOk, type CheckedLayout, recheckLayout } from '../src/modules/catalog/domain/seatmap-import.js';
import { assignIndexes, fanFile, geometryChanges, layoutView, type LayoutDoc } from '../src/modules/catalog/domain/seatmap-layout.js';

const band = { cx: 500, cy: 0, innerRadius: 200, outerRadius: 400, startAngle: 30, endAngle: 150 };
const sq = (x: number, y: number, w = 100): [number, number][] => [
  [x, y],
  [x + w, y],
  [x + w, y + w],
  [x, y + w],
];

function layout(arc: Record<string, unknown> | undefined, kind = 'ARC_BAND'): CheckedLayout {
  return {
    canvas: { width: 1000, height: 800 },
    stage: [{ kind: 'SECTOR', points: [[400, 0], [600, 0], [500, 100]], arc: { cx: 500, cy: 0, innerRadius: 0, outerRadius: 100, startAngle: 0, endAngle: 180 } }],
    sections: [{ sectionId: 'A', name: 'A구역', tierId: 'R', shape: { kind: kind as 'ARC_BAND', points: sq(100, 300), ...(arc ? { arc: arc as never } : {}) }, seats: [{ seatId: 'a', row: '1', number: 1, x: 150, y: 350 }] }],
  };
}

describe('FE-T46 ⑩ 도형 매개변수 arc', () => {
  test('FE-T46 ⑩ 어긋난 arc는 SHAPE_PARAMS_INVALID이고 경계 바로 안쪽은 받는다', () => {
    expect(arcOk({ kind: 'ARC_BAND', arc: band })).toBe(true);
    expect(arcOk({ kind: 'ARC_BAND', arc: { ...band, innerRadius: 399 } })).toBe(true);
    expect(arcOk({ kind: 'ARC_BAND', arc: { ...band, innerRadius: 400 } })).toBe(false);
    expect(arcOk({ kind: 'ARC_BAND', arc: { ...band, endAngle: 31 } })).toBe(true);
    expect(arcOk({ kind: 'ARC_BAND', arc: { ...band, endAngle: 30 } })).toBe(false);
    expect(arcOk({ kind: 'SECTOR', arc: { ...band, innerRadius: 0, startAngle: 0, endAngle: 360 } })).toBe(true);
    expect(arcOk({ kind: 'SECTOR', arc: { ...band, innerRadius: 0, startAngle: 0, endAngle: 361 } })).toBe(false);
    expect(arcOk({ kind: 'RECT', arc: band })).toBe(false);
    expect(arcOk({ kind: 'POLYGON' })).toBe(true);
    expect(recheckLayout(layout(band))).toEqual([]);
    expect(recheckLayout(layout({ ...band, innerRadius: 500 }))).toEqual([{ line: 0, field: 'sections[0].shape.arc', code: 'SHAPE_PARAMS_INVALID' }]);
    expect(recheckLayout(layout(band, 'POLYGON'))).toEqual([{ line: 0, field: 'sections[0].shape.arc', code: 'SHAPE_PARAMS_INVALID' }]);
    const badStage = layout(band);
    badStage.stage = [{ kind: 'RECT', points: sq(400, 0), arc: band }];
    expect(recheckLayout(badStage)).toEqual([{ line: 0, field: 'stage[0].arc', code: 'SHAPE_PARAMS_INVALID' }]);
  });

  test('FE-T46 ⑩ arc는 저장 문서·응답에 그대로 있고 팬 파일에는 없으며 arc만 다른 저장은 도형 변경이다', () => {
    const l = layout(band);
    const doc: LayoutDoc = { canvas: l.canvas, stage: l.stage ?? [], sections: assignIndexes(l).sections, priceTiers: [{ tierId: 'R', name: 'R석', price: 1000 }] };
    expect(doc.sections[0]!.shape.arc).toEqual(band);
    const view = layoutView(doc, 3, { geometryLocked: false });
    expect(view.sections[0]!.shape.arc).toEqual(band);
    expect(view.stage[0]!.arc).toEqual({ cx: 500, cy: 0, innerRadius: 0, outerRadius: 100, startAngle: 0, endAngle: 180 });
    const file = JSON.stringify(fanFile(doc, 3));
    expect(file.includes('arc')).toBe(false);
    expect(file.includes('innerRadius')).toBe(false);
    const moved: LayoutDoc = { ...doc, sections: [{ ...doc.sections[0]!, shape: { ...doc.sections[0]!.shape, arc: { ...band, outerRadius: 401 } } }] };
    expect(geometryChanges(doc, moved)).toEqual(['SECTION_GEOMETRY']);
  });

  test('FE-T46 ⑫ 응답 geometryLocked는 넘긴 판정 값 그대로이고 fanFilePublished는 저장 응답에만 있다', () => {
    const l = layout(band);
    const doc: LayoutDoc = { canvas: l.canvas, stage: [], sections: assignIndexes(l).sections, priceTiers: [] };
    expect(layoutView(doc, 1, { geometryLocked: true })).toMatchObject({ layoutVersion: 1, geometryLocked: true });
    expect('fanFilePublished' in layoutView(doc, 1, { geometryLocked: false })).toBe(false);
    expect(layoutView(doc, 2, { geometryLocked: false, fanFilePublished: false }).fanFilePublished).toBe(false);
  });
});

describe('FE-T38 내보내기 왕복(seatmap-worker 읽개, ADR-0264 결정 41)', () => {
  const HEADER = 'section,row,number,x,y,tier,wheelchair,gate,shape';
  test('FE-T38 ② CSV 읽개는 내보내기가 붙인 수식 방지 작은따옴표 하나를 벗겨 등급 +R·게이트 @G·구역 =A가 그대로 돌아온다 [ASVS v5.0.0-5.4.1]', async () => {
    const { parseSeatmapFile } = await import('../src/seatmap-worker/parse.js');
    const csv = `${HEADER}\n'=A,1,1,10,10,'+R,,'@G,"0 0;100 0;100 100"\n'=A,1,2,20,10,'-S,,,\nB,1,1,50,50,'x,,,"40 40;90 40;90 90"\n`;
    const r = parseSeatmapFile(new TextEncoder().encode(csv), 'CSV');
    if (r.status !== 'PARSED') throw new Error(JSON.stringify(r.errors));
    expect(r.errors).toEqual([]);
    const [a, b] = r.layout.sections;
    expect(a!.name).toBe('=A');
    expect(a!.seats.map((x) => [x.tierId, x.gateZone ?? null])).toEqual([
      ['+R', '@G'],
      ['-S', null],
    ]);
    // 작은따옴표 다음이 수식 글자가 아니면 그대로 둔다
    expect(b!.seats[0]!.tierId).toBe("'x");
  });

  test('FE-T38 ① JSON 읽개는 도형의 arc를 결과에 넘긴다(다시 가져와도 손잡이 값이 남는다)', async () => {
    const { parseSeatmapFile } = await import('../src/seatmap-worker/parse.js');
    const layout = { canvas: { width: 1000, height: 800 }, stage: [{ kind: 'SECTOR', points: [[400, 0], [600, 0], [500, 100]], arc: { cx: 500, cy: 0, innerRadius: 0, outerRadius: 100, startAngle: 0, endAngle: 180 } }], sections: [{ sectionId: 'A', name: 'A', shape: { kind: 'ARC_BAND', points: sq(100, 300), arc: band }, seats: [] }] };
    const r = parseSeatmapFile(new TextEncoder().encode(JSON.stringify(layout)), 'JSON');
    if (r.status !== 'PARSED') throw new Error(JSON.stringify(r.errors));
    expect(r.layout.sections[0]!.shape.arc).toEqual(band);
    expect(r.layout.stage[0]!.arc).toEqual(layout.stage[0]!.arc);
  });
});
