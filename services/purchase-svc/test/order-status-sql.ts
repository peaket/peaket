// 전이 함수 밖에서 purchase_order.status를 바꾸는 SQL을 찾는 검사(ADR-0113 결정 2의 CI 검사, docs/features/payment.md §3 '주문 저장소의 첫 구현',
// BUILD_ORDER PRF-160). test/order-status-sql.test.ts가 이 함수를 시험하고 services/purchase-svc의 src·scripts·migrations 전체에 돌린다(test·test-int 제외).
// 이 검사가 놓친 길은 DB의 상태 이력 지연 제약 트리거(order_status_has_event, 0003 마이그레이션)가 커밋 때 막는다.
//
// 잡는 꼴(대소문자·줄바꿈 무관):
//  ① 날 SQL UPDATE: `update [only] [스키마.]purchase_order [[as] 별칭] set … status …`(SET 절 = set부터 where·returning·from·;·백틱 앞까지).
//     표 자리에 `${purchaseOrder}`(Drizzle sql 틀에 표 객체를 끼움), `${sql.identifier('purchase_order')}`, 아래 '표를 가리키는 이름'도 같다.
//  ② Drizzle 빌더 UPDATE: `.update(purchaseOrder).set(… status …)`(set 인자 = .set( 부터 .where(·.returning(·.from(·; 앞까지)
//  ③ 날 SQL 덮어쓰기: `insert into purchase_order … on conflict … do update set … status …`
//  ④ Drizzle 빌더 덮어쓰기: `.insert(purchaseOrder) … .onConflictDoUpdate(… status …)`(같은 문장 안, ; 앞까지)
//  ⑤ 날 SQL MERGE: `merge into [only] [스키마.]purchase_order … when matched … then update set … status …`(문장 안 UPDATE SET 절 가운데 하나라도)
//  표를 가리키는 이름: purchaseOrder, 가져올 때 붙인 다른 이름(`purchaseOrder as X`), `const X = sql.identifier('purchase_order')`, `const X = purchaseOrder`.
// 잡지 않는 꼴: SELECT·DELETE·덮어쓰기 없는 INSERT, 다른 표(seat_sale 등)의 status, WHERE에만 status가 있는 purchase_order UPDATE,
//  order_event의 from_status·to_status, MERGE의 INSERT 칸에만 있는 status, 트리거 선언(`UPDATE OF status … ON purchase_order`).
// 주석도 잡는다(결정): 글자 그대로 훑고 주석을 가려내지 않는다. 주석을 벗기는 파서는 SQL 글 안의 `--`·`/* */`·URL의 `//`를 잘못 다룰 수 있고,
//  잡지 못하는 틈보다 주석 한 줄을 고쳐 쓰는 편이 싸다. 그 꼴을 주석에 적어야 하면 전이 함수 파일 안에 적는다.
// 한계: 변수에 담은 SQL 조각·set 객체(`.set(values)`)의 status, 문자열을 이어 붙여 만든 SQL, 다른 파일에서 다시 내보낸 이름은 잡지 못한다
//  (남는 길은 DB 트리거·매일 검사·코드 리뷰).

/** purchase_order.status를 바꿔도 되는 유일한 파일(서비스 뿌리 기준 상대 경로, / 구분) */
export const ORDER_STATUS_WRITER = 'src/modules/booking/adapters/db/drizzle-orders.ts';

export interface StatusWrite {
  /** 1부터 센 줄 번호(찾은 문장이 시작하는 줄) */
  line: number;
  /** 그 줄의 글(앞뒤 공백 없앰) */
  text: string;
}

const STATUS = /\bstatus\b/i;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
/** sql 틀 안의 sql.identifier('purchase_order')(따옴표 셋 가운데 하나) */
const IDENTIFIER_TABLE = String.raw`sql\.identifier\(\s*(?:'purchase_order'|"purchase_order"|\x60purchase_order\x60)\s*\)`;
/** MERGE 문장 안의 UPDATE SET 절(다음 WHEN·RETURNING 앞까지) */
const MERGE_UPDATE = /\bupdate\s+set\b([\s\S]*?)(?=\bwhen\b|\breturning\b|$)/gi;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 그 글에서 purchase_order 표를 가리키는 이름들(purchaseOrder와 그 다른 이름) */
function tableNamesOf(source: string): string[] {
  const names = new Set(['purchaseOrder']);
  for (const m of source.matchAll(new RegExp(String.raw`\bpurchaseOrder\s+as\s+(${IDENT})`, 'g'))) names.add(m[1]!);
  for (const m of source.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*(?:${IDENTIFIER_TABLE}|(?:\w+\.)*purchaseOrder\b(?!\.))`, 'g'))) names.add(m[1]!);
  return [...names];
}

/** 그 글의 이름으로 만든 잡는 꼴(①~⑤). 캡처 1은 status를 찾아볼 곳이다 */
function patternsOf(source: string): { writes: RegExp[]; merge: RegExp } {
  const names = tableNamesOf(source).map(escapeRe).join('|');
  /** 표 자리: [스키마.]purchase_order(따옴표 가능), 또는 sql 틀에 끼운 ${이름}·${schema.이름}·${sql.identifier('purchase_order')} */
  const table = String.raw`(?:(?:"?[a-z_]\w*"?\.)?"?purchase_order"?(?!\w)|\$\{\s*(?:(?:\w+\.)*(?:${names})|${IDENTIFIER_TABLE})\s*\})`;
  /** 빌더 인자: 이름·schema.이름 */
  const builder = String.raw`\(\s*(?:\w+\.)*(?:${names})\s*\)`;
  return {
    writes: [
      // ① 날 SQL UPDATE … SET 절
      new RegExp(String.raw`\bupdate\s+(?:only\s+)?${table}(?:\s+(?:as\s+)?(?!set\b)"?[a-z_]\w*"?)?\s+set\b([\s\S]*?)(?=\bwhere\b|\breturning\b|\bfrom\b|;|\x60|$)`, 'gi'),
      // ② Drizzle 빌더 .update(이름).set(…)
      new RegExp(String.raw`\.update${builder}\s*\.set\(([\s\S]*?)(?=\.where\(|\.returning\(|\.from\(|;|$)`, 'gi'),
      // ③ 날 SQL INSERT … ON CONFLICT … DO UPDATE SET 절
      new RegExp(String.raw`\binsert\s+into\s+${table}[^;\x60]*?\bon\s+conflict\b[^;\x60]*?\bdo\s+update\s+set\b([\s\S]*?)(?=\bwhere\b|\breturning\b|;|\x60|$)`, 'gi'),
      // ④ Drizzle 빌더 .insert(이름) … .onConflictDoUpdate(…)
      new RegExp(String.raw`\.insert${builder}[^;]*?\.onConflictDoUpdate\(([\s\S]*?)(?=\.returning\(|;|$)`, 'gi'),
    ],
    // ⑤ 날 SQL MERGE 문장 전체(; ·백틱 앞까지). 안의 UPDATE SET 절은 MERGE_UPDATE로 본다
    merge: new RegExp(String.raw`\bmerge\s+into\s+(?:only\s+)?${table}[\s\S]*?(?=;|\x60|$)`, 'gi'),
  };
}

/** 글 하나에서 purchase_order.status를 바꾸는 SQL이 시작하는 줄들(줄 차례, 같은 줄은 한 번) */
export function findOrderStatusWrites(source: string): StatusWrite[] {
  const lines = source.split(/\r?\n/);
  const found = new Set<number>();
  const lineAt = (index: number): number => source.slice(0, index).split('\n').length;
  const { writes, merge } = patternsOf(source);
  for (const re of writes) {
    for (const m of source.matchAll(re)) if (STATUS.test(m[1] ?? '')) found.add(lineAt(m.index));
  }
  for (const m of source.matchAll(merge)) {
    if ([...m[0].matchAll(MERGE_UPDATE)].some((u) => STATUS.test(u[1] ?? ''))) found.add(lineAt(m.index));
  }
  return [...found].sort((a, b) => a - b).map((line) => ({ line, text: (lines[line - 1] ?? '').trim() }));
}

export interface SourceFile {
  /** 서비스 뿌리 기준 상대 경로(/ 구분) */
  path: string;
  text: string;
}

/** 전이 함수 파일 밖에서 찾은 것들(파일 경로·줄). 비어야 통과다 */
export function orderStatusWritesOutside(files: readonly SourceFile[]): (StatusWrite & { path: string })[] {
  return files.filter((f) => f.path !== ORDER_STATUS_WRITER).flatMap((f) => findOrderStatusWrites(f.text).map((w) => ({ path: f.path, ...w })));
}
