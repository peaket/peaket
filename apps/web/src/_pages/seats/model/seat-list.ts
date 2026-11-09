// 접근성 좌석 목록의 값(CMP-022, docs/frontend.md §5.2 '접근성 목록', ADR-0227). 구역 → 열 → 좌석을 펼친 만큼만 한 줄로 늘어놓고,
// ARIA 트리 키(↑↓ 이동, → 펼치기, ← 접기, Home·End, 글자로 찾기)를 값으로 푼다. 화면(SeatList)은 이 결과를 그리기만 한다.

/** 좌석맵 Worker의 LIST_STATES와 같은 차례(좌석맵 패키지를 이 파일에 들이지 않으려고 글자로 둔다. 어긋나면 시험이 잡는다) */
export const LIST_STATE_NAMES = ['available', 'held-by-others', 'mine', 'sold', 'unavailable'] as const;
export type ListStateName = (typeof LIST_STATE_NAMES)[number];

const STATE_LABEL: Record<ListStateName, string> = {
  available: '예매 가능',
  'held-by-others': '다른 분 선택',
  mine: '내 선택',
  sold: '판매됨·선택 불가',
  unavailable: '판매 제외',
};

const SECTION_STATUS_LABEL = { plenty: '많음', few: '적음', soldout: '매진' } as const;

export interface ListSection {
  section: number;
  name: string;
  status: keyof typeof SECTION_STATUS_LABEL;
}

/** 목록이 연 구역(Worker의 sectionState) */
export interface OpenSection {
  section: number;
  baseIndex: number;
  states: Uint8Array;
  seats: { seatId: string[]; row: string[]; number: string[]; tier: number[]; wheelchair: number[] };
  tiers: string[];
}

export interface ListRow {
  row: string;
  offsets: number[];
}

interface Base {
  id: string;
  level: 1 | 2 | 3;
  setsize: number;
  posinset: number;
  parent: string | null;
}
export interface SectionNode extends Base {
  kind: 'section';
  section: number;
  name: string;
  status: ListSection['status'];
  expanded: boolean;
}
export interface RowNode extends Base {
  kind: 'row';
  row: string;
  available: number;
  expanded: boolean;
}
export interface SeatNode extends Base {
  kind: 'seat';
  offset: number;
}
export type ListNode = SectionNode | RowNode | SeatNode;

export type ListAction = { type: 'focus' | 'open' | 'close' | 'activate'; id: string };

/** 구역의 좌석을 열로 묶는다(파일의 차례를 그대로 쓴다) */
export function rowsOf(o: OpenSection): ListRow[] {
  const byRow = new Map<string, number[]>();
  o.seats.row.forEach((row, offset) => {
    const list = byRow.get(row);
    if (list) list.push(offset);
    else byRow.set(row, [offset]);
  });
  return [...byRow].map(([row, offsets]) => ({ row, offsets }));
}

export const stateName = (o: OpenSection, offset: number): ListStateName => LIST_STATE_NAMES[o.states[offset]!] ?? 'unavailable';

/** 고르거나 풀 수 있는 좌석인가(지도의 canSelect와 같다) */
export const seatSelectable = (s: ListStateName): boolean => s === 'available' || s === 'mine';

/** 펼친 만큼만 한 줄로. 트리의 위치(aria-level·setsize·posinset)를 노드에 싣는다. 가상 스크롤이라 보이는 줄만 DOM에 있어서다 */
export function flatten(sections: readonly ListSection[], open: OpenSection | null, rows: readonly ListRow[], openRows: ReadonlySet<string>): ListNode[] {
  const out: ListNode[] = [];
  sections.forEach((s, i) => {
    const expanded = open?.section === s.section;
    const sectionId = `s:${s.section}`;
    out.push({ kind: 'section', id: sectionId, level: 1, setsize: sections.length, posinset: i + 1, parent: null, section: s.section, name: s.name, status: s.status, expanded });
    if (!expanded || !open) return;
    rows.forEach((r, ri) => {
      const rowOpen = openRows.has(r.row);
      const rowId = `r:${r.row}`;
      const available = r.offsets.filter((x) => stateName(open, x) === 'available').length;
      out.push({ kind: 'row', id: rowId, level: 2, setsize: rows.length, posinset: ri + 1, parent: sectionId, row: r.row, available, expanded: rowOpen });
      if (!rowOpen) return;
      r.offsets.forEach((offset, si) => out.push({ kind: 'seat', id: `k:${offset}`, level: 3, setsize: r.offsets.length, posinset: si + 1, parent: rowId, offset }));
    });
  });
  return out;
}

/** ARIA 트리 패턴의 키. 처리할 것이 없으면 null */
export function navigate(nodes: readonly ListNode[], activeId: string | null, key: string): ListAction | null {
  const first = nodes[0];
  if (!first) return null;
  const i = nodes.findIndex((n) => n.id === activeId);
  if (i < 0) return { type: 'focus', id: first.id };
  const n = nodes[i]!;
  const focus = (t: ListNode | undefined): ListAction | null => (t ? { type: 'focus', id: t.id } : null);
  switch (key) {
    case 'ArrowDown':
      return focus(nodes[i + 1]);
    case 'ArrowUp':
      return focus(nodes[i - 1]);
    case 'Home':
      return focus(first);
    case 'End':
      return focus(nodes[nodes.length - 1]);
    case 'ArrowRight': {
      if (n.kind === 'seat') return null;
      if (!n.expanded) return { type: 'open', id: n.id };
      const child = nodes[i + 1];
      return child && child.level === n.level + 1 ? focus(child) : null;
    }
    case 'ArrowLeft':
      if (n.kind !== 'seat' && n.expanded) return { type: 'close', id: n.id };
      return n.parent ? { type: 'focus', id: n.parent } : null;
    case 'Enter':
    case ' ':
      return { type: 'activate', id: n.id };
    default:
      return null;
  }
}

function typeText(n: ListNode, open: OpenSection | null): string {
  if (n.kind === 'section') return n.name;
  if (n.kind === 'row') return `${n.row}열`;
  return `${open?.seats.number[n.offset] ?? ''}번`;
}

/** 글자로 찾기: 지금 줄의 다음부터 한 바퀴, 입력으로 시작하는 줄 */
export function typeahead(nodes: readonly ListNode[], open: OpenSection | null, activeId: string | null, text: string): string | null {
  const q = text.toLocaleLowerCase('ko-KR');
  if (!q) return null;
  const from = nodes.findIndex((n) => n.id === activeId);
  for (let step = 1; step <= nodes.length; step++) {
    const n = nodes[(from + step + nodes.length) % nodes.length]!;
    if (typeText(n, open).toLocaleLowerCase('ko-KR').startsWith(q)) return n.id;
  }
  return null;
}

export const sectionName = (n: SectionNode): string => `${n.name}, 남은 좌석 ${SECTION_STATUS_LABEL[n.status]}`;
export const rowName = (n: RowNode): string => `${n.row}열, 남은 좌석 ${n.available}석`;

/** 좌석의 표시 이름(지도에서 고른 좌석과 같은 글자) */
export const seatLabel = (sectionTitle: string, o: OpenSection, offset: number): string => `${sectionTitle} ${o.seats.row[offset]}열 ${o.seats.number[offset]}번`;

/** 줄에 보이는 글: "12번, 예매 가능, R석 ₩150,000". 낭독 이름이 이 글을 그대로 담아 말로 조작할 때도 찾을 수 있다(WCAG 2.5.3) */
export function seatRowText(o: OpenSection, offset: number, tierName: string | undefined, price: number | undefined, wheelchair: boolean): string {
  const tier = [tierName, typeof price === 'number' ? `₩${price.toLocaleString('ko-KR')}` : undefined].filter(Boolean).join(' ');
  return [`${o.seats.number[offset]}번`, STATE_LABEL[stateName(o, offset)], tier, wheelchair ? '휠체어석' : ''].filter(Boolean).join(', ');
}

/** 낭독 이름: "A구역 3열 12번, 예매 가능, R석 ₩150,000"(CMP-022). 등급 이름이나 가격을 아직 모르면 뺀다 */
export const seatName = (sectionTitle: string, o: OpenSection, offset: number, tierName: string | undefined, price: number | undefined, wheelchair: boolean): string =>
  `${sectionTitle} ${o.seats.row[offset]}열 ${seatRowText(o, offset, tierName, price, wheelchair)}`;
