// 좌석 계층 트리 목업(보드 SCR-022 왼쪽 '좌석 계층'의 네 모양). 피켓 아레나 > 1층 > 구역 > 열 > 좌석 묶음.
import type { EditorView } from './view';

export interface TreeNode {
  level: 1 | 2 | 3 | 4 | 5;
  label: string;
  /** 오른쪽 작은 글(좌석 수 등) */
  meta?: string;
  /** 펼침 여부(없으면 잎) */
  expanded?: boolean;
  selected?: boolean;
  bold?: boolean;
  /** 휠체어석 수(아이콘과 함께) 또는 true(아이콘만) */
  wc?: number | true;
  /** 경고 표시 글 */
  warn?: string;
  /** 같은 단계 형제 수와 순서 */
  setsize: number;
  posinset: number;
}

const root = (total: string): TreeNode[] => [
  { level: 1, label: '피켓 아레나', meta: total, expanded: true, bold: true, setsize: 1, posinset: 1 },
  { level: 2, label: '1층', meta: total, expanded: true, setsize: 1, posinset: 1 },
];

function zoneRow(label: string, meta: string, pos: number, size: number, extra: Partial<TreeNode> = {}): TreeNode {
  return { level: 3, label, meta, expanded: false, bold: true, setsize: size, posinset: pos, ...extra };
}

export function treeOf(v: EditorView): TreeNode[] {
  if (v.tree === 'base') {
    const size = v.newZone ? 8 : 7;
    const nodes: TreeNode[] = [
      ...root(v.total),
      { level: 3, label: '무대', meta: '사각형', bold: true, setsize: size, posinset: 1 },
      zoneRow('R1구역', 'R석 · 300', 2, size),
      zoneRow('R2구역', 'R석 · 300', 3, size),
      zoneRow('S1구역', 'S석 · 450', 4, size),
      zoneRow('S2구역', 'S석 · 450', 5, size, v.outInTree ? { warn: '도형 밖 3석' } : {}),
      zoneRow('A1구역', `A석 · ${v.a1Count}`, 6, size, { wc: 10, selected: v.a1Selected }),
      zoneRow('A2구역', 'A석 · 450', 7, size, { wc: 10 }),
    ];
    if (v.newZone) nodes.push({ level: 3, label: '새 구역', meta: 'A석 · 0', selected: true, warn: '도형 없음', setsize: size, posinset: 8 });
    return nodes;
  }
  if (v.tree === 'refine') {
    return [
      ...root('2,400석'),
      zoneRow('R1구역', 'R석 · 300', 1, 6, { expanded: true }),
      { level: 4, label: '1열~11열', meta: '220석', expanded: false, setsize: 3, posinset: 1 },
      { level: 4, label: '12열', meta: '20석', expanded: true, bold: true, setsize: 3, posinset: 2 },
      { level: 5, label: '1번~4번', expanded: false, setsize: 3, posinset: 1 },
      { level: 5, label: '5번~16번', meta: '12석 선택', expanded: false, selected: true, setsize: 3, posinset: 2 },
      { level: 5, label: '17번~20번', expanded: false, setsize: 3, posinset: 3 },
      { level: 4, label: '13열~15열', meta: '60석', expanded: false, setsize: 3, posinset: 3 },
      zoneRow('R2구역', 'R석 · 300', 2, 6),
      zoneRow('S1구역', 'S석 · 450', 3, 6),
      zoneRow('S2구역', 'S석 · 450', 4, 6),
      zoneRow('A1구역', 'A석 · 450', 5, 6, { wc: v.wcPerZone }),
      zoneRow('A2구역', 'A석 · 450', 6, 6, { wc: v.wcPerZone }),
    ];
  }
  if (v.tree === 'over') {
    return [
      ...root('2,400석'),
      zoneRow('R1구역', 'R석 · 300', 1, 6, { expanded: true, warn: '겹침 3석' }),
      { level: 4, label: '1열~11열', meta: '220석', expanded: false, setsize: 3, posinset: 1 },
      { level: 4, label: '12열', meta: '20석', expanded: true, bold: true, setsize: 3, posinset: 2 },
      { level: 5, label: '1번~6번', expanded: false, setsize: 5, posinset: 1 },
      { level: 5, label: '7번', selected: true, warn: '겹침', setsize: 5, posinset: 2 },
      { level: 5, label: '8번', warn: '겹침', setsize: 5, posinset: 3 },
      { level: 5, label: '9번', warn: '겹침', setsize: 5, posinset: 4 },
      { level: 5, label: '10번~20번', expanded: false, setsize: 5, posinset: 5 },
      { level: 4, label: '13열~15열', meta: '60석', expanded: false, setsize: 3, posinset: 3 },
      zoneRow('R2구역', 'R석 · 300', 2, 6),
      zoneRow('S1구역', 'S석 · 450', 3, 6),
      zoneRow('S2구역', 'S석 · 450', 4, 6),
      zoneRow('A1구역', 'A석 · 450', 5, 6),
      zoneRow('A2구역', 'A석 · 450', 6, 6),
    ];
  }
  return [
    ...root('2,400석'),
    zoneRow('R1구역', 'R석 · 300', 1, 6),
    zoneRow('R2구역', 'R석 · 300', 2, 6),
    zoneRow('S1구역', 'S석 · 450', 3, 6),
    zoneRow('S2구역', 'S석 · 450', 4, 6),
    zoneRow('A1구역', 'A석 · 450', 5, 6, { expanded: true, warn: '위치 확인' }),
    { level: 4, label: '1열~17열', meta: '425석', expanded: false, setsize: 2, posinset: 1 },
    { level: 4, label: '18열', meta: '25석', expanded: true, bold: true, setsize: 2, posinset: 2 },
    { level: 5, label: '1번~4번', expanded: false, wc: true, setsize: 6, posinset: 1 },
    { level: 5, label: '5번~8번', expanded: false, setsize: 6, posinset: 2 },
    { level: 5, label: '9번', selected: true, wc: true, warn: '위치 확인', setsize: 6, posinset: 3 },
    { level: 5, label: '10번', wc: true, warn: '위치 확인', setsize: 6, posinset: 4 },
    { level: 5, label: '11번~21번', expanded: false, setsize: 6, posinset: 5 },
    { level: 5, label: '22번~25번', expanded: false, wc: true, setsize: 6, posinset: 6 },
    zoneRow('A2구역', 'A석 · 450', 6, 6, { wc: 10 }),
  ];
}
