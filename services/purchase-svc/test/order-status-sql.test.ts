// ADR-0113 결정 2의 CI 검사: 주문 전이 함수 파일(src/modules/booking/adapters/db/drizzle-orders.ts) 밖에서 purchase_order의 status를 바꾸는 SQL이 있으면 실패한다
// (docs/features/payment.md §3 '주문 저장소의 첫 구현': `purchase_order`를 바꾸는 `UPDATE`와 `ON CONFLICT … DO UPDATE`가 `status`를 쓰면서 전이 함수 파일 밖에 있으면 실패, BUILD_ORDER PRF-160).
// 검사 함수는 test/order-status-sql.ts에 있다. 먼저 검사 함수가 잡을 것과 잡지 않을 것을 보고, 그다음 서비스의 src·scripts·migrations 전체를 훑는다
// (test·test-int는 빼고. 매일 검사 시험이 일부러 어긋난 주문을 만드는 SQL이 거기 있다).
// 주석도 잡는다(결정, 까닭은 order-status-sql.ts 머리 주석).
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { findOrderStatusWrites, ORDER_STATUS_WRITER, orderStatusWritesOutside, type SourceFile } from './order-status-sql.js';

const SERVICE = fileURLToPath(new URL('..', import.meta.url));
/** 훑는 폴더(서비스 뿌리 기준). test·test-int는 넣지 않는다 */
const SCANNED = ['src', 'scripts', 'migrations'];
const SOURCE_EXT = /\.(?:[cm]?ts|[cm]?js|sql)$/;

/** 훑는 폴더 아래 모든 소스 파일(서비스 뿌리 기준 상대 경로, / 구분) */
function sourceFiles(): SourceFile[] {
  return SCANNED.flatMap((dir) =>
    readdirSync(join(SERVICE, dir), { recursive: true, encoding: 'utf8' })
      .filter((p) => SOURCE_EXT.test(p))
      .map((p) => ({ path: `${dir}/${p.split(sep).join('/')}`, text: readFileSync(join(SERVICE, dir, p), 'utf8') })),
  ).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const lines = (s: string): number[] => findOrderStatusWrites(s).map((w) => w.line);

describe('findOrderStatusWrites: 잡아야 할 꼴', () => {
  test.each([
    ['날 SQL 한 줄(소문자, sql 틀)', 'await tx.execute(sql`update purchase_order set status = ${to}, event_seq = event_seq + 1 where id = ${id} and status = ${from} returning event_seq`);'],
    ['대문자·여러 줄, status가 SET 절 뒤쪽', "const q = `\nUPDATE purchase_order\n   SET event_seq = event_seq + 1,\n       status = 'FAILED'\n WHERE id = $1`;"],
    ['따옴표 친 표·열 이름과 별칭', 'sql`update "purchase_order" o set "status" = \'EXPIRED\' where o.id = ${id}`'],
    ['as 별칭', "sql`update purchase_order as po set status = 'EXPIRED' where po.id = ${id}`"],
    ['스키마 한정 표 이름', "pool.query('update public.purchase_order set status = $1 where id = $2', [s, id]);"],
    ['열 묶음 SET', 'sql`update purchase_order set (status, event_seq) = (${to}, event_seq + 1) where id = ${id}`'],
    ['sql 틀에 표 객체를 끼움', 'sql`update ${purchaseOrder} set ${purchaseOrder.status} = ${to} where ${purchaseOrder.id} = ${id}`'],
    ['Drizzle 빌더(여러 줄 체인)', "await tx\n  .update(purchaseOrder)\n  .set({ status: 'FAILED', eventSeq: sql`${purchaseOrder.eventSeq} + 1` })\n  .where(eq(purchaseOrder.id, id));"],
    ['Drizzle 빌더(줄인 속성 이름)', 'await db.update(schema.purchaseOrder).set({ status }).where(eq(schema.purchaseOrder.id, id));'],
    ['날 SQL 덮어쓰기(소문자)', 'sql`insert into purchase_order (id, status, amount) values (${id}, ${s}, ${a}) on conflict (id) do update set status = excluded.status`'],
    ['날 SQL 덮어쓰기(대문자·여러 줄, ON CONSTRAINT)', 'sql`\nINSERT INTO purchase_order (id, status)\nVALUES (${id}, ${s})\nON CONFLICT ON CONSTRAINT purchase_order_pkey\nDO UPDATE SET amount = excluded.amount,\n  status = excluded.status`'],
    ['Drizzle 빌더 덮어쓰기', 'await tx.insert(purchaseOrder).values(row).onConflictDoUpdate({ target: purchaseOrder.id, set: { status: row.status } });'],
    ['주석 속 글(결정: 주석도 잡는다)', "// 여기서 update purchase_order set status = 'FAILED'를 부른다"],
    ['MERGE의 WHEN MATCHED UPDATE SET', "sql`merge into purchase_order o using (select ${id}::uuid as id) s on o.id = s.id when matched then update set status = 'FAILED'`"],
    [
      'MERGE의 둘째 UPDATE SET에만 status(대문자·여러 줄)',
      'sql`\nMERGE INTO public.purchase_order AS t\nUSING src s ON t.id = s.id\nWHEN MATCHED AND s.late THEN UPDATE SET amount = s.amount\nWHEN MATCHED THEN UPDATE SET status = s.status`',
    ],
    ['sql.identifier로 끼운 표 이름', "sql`update ${sql.identifier('purchase_order')} set status = ${to} where id = ${id}`"],
    ['sql.identifier를 담은 이름', 'const T = sql.identifier("purchase_order");\nawait tx.execute(sql`update ${T} set status = ${s} where id = ${id}`);'],
    ['다른 이름으로 가져온 표의 Drizzle 빌더', "import { purchaseOrder as orders } from './schema.js';\nawait tx.update(orders).set({ status: 'FAILED' }).where(eq(orders.id, id));"],
    ['다른 이름으로 가져온 표를 sql 틀에 끼움', "import { orderItem, purchaseOrder as po } from '../schema.js';\nsql`update ${po} set ${po.status} = ${to}`"],
    ['다른 이름으로 가져온 표의 빌더 덮어쓰기', "import { purchaseOrder as O } from './schema.js';\nawait tx.insert(O).values(r).onConflictDoUpdate({ target: O.id, set: { status: r.status } });"],
  ])('ADR0113_%s를 잡는다 [ASVS v5.0.0-2.3.1]', (_name, source) => {
    expect(findOrderStatusWrites(source)).toHaveLength(1);
  });

  test('ADR0113_줄 번호는 그 문장이 시작하는 줄이고, 한 글의 여러 곳을 줄 차례로 모두 찾는다 [ASVS v5.0.0-2.3.1]', () => {
    const source = [
      "import { sql } from 'drizzle-orm';", // 1
      '', // 2
      'export async function a(tx) {', // 3
      '  await tx.execute(sql`', // 4
      '    update purchase_order', // 5
      "       set status = 'EXPIRED'", // 6
      '     where id = ${id}`);', // 7
      '}', // 8
      'export async function b(tx) {', // 9
      '  await tx', // 10
      '    .update(purchaseOrder)', // 11
      "    .set({ status: 'FAILED' })", // 12
      '    .where(eq(purchaseOrder.id, id));', // 13
      '}', // 14
    ].join('\n');
    expect(findOrderStatusWrites(source)).toEqual([
      { line: 5, text: 'update purchase_order' },
      { line: 11, text: '.update(purchaseOrder)' },
    ]);
    // 창 줄바꿈(CRLF)이어도 같은 줄이다
    expect(lines(source.replaceAll('\n', '\r\n'))).toEqual([5, 11]);
  });
});

describe('findOrderStatusWrites: 잡으면 안 되는 꼴', () => {
  test.each([
    ['purchase_order 읽기(SELECT … status)', "sql`select id, status from purchase_order where status = 'CREATED' and id = ${id}`"],
    ['다른 표의 status(update seat_sale set status)', "sql`update seat_sale s set status = 'SOLD', pending_until = null where s.order_id = ${id}`"],
    ['다른 표 Drizzle 빌더', "await tx.update(seatSale).set({ status: 'SOLD' }).where(eq(seatSale.orderId, id));"],
    ['WHERE에만 status가 있는 purchase_order UPDATE', "sql`update purchase_order set payment_event_seq = ${seq} where id = ${id} and status = 'RESERVED'`"],
    ['WHERE에만 status가 있는 Drizzle 빌더', "await tx.update(purchaseOrder).set({ paymentEventSeq: seq }).where(and(eq(purchaseOrder.id, id), eq(purchaseOrder.status, 'RESERVED')));"],
    ['덮어쓰기 없는 INSERT(주문 만들기)', "sql`insert into purchase_order (id, status, amount) values (${id}, 'CREATED', ${a})`"],
    ['ON CONFLICT DO NOTHING', "sql`insert into purchase_order (id, status) values (${id}, 'CREATED') on conflict (id) do nothing`"],
    ['DELETE(보존 삭제)', "sql`delete from purchase_order where status = 'EXPIRED' and id < ${bound}`"],
    ['이력 표의 from_status·to_status', 'sql`insert into order_event (order_id, seq, from_status, to_status, cause, actor) values (${id}, ${seq}, ${from}, ${to}, ${cause}, ${actor})`'],
    ['이름이 purchase_order로 시작하는 다른 표', "sql`update purchase_order_archive set status = 'X'`"],
    ['문장이 끝난 뒤 다른 표의 status(;로 끊는다)', "sql`update purchase_order set amount = 1; update seat_sale set status = 'SOLD'`"],
    ['sql 틀이 끝난 뒤 다른 곳의 status(백틱으로 끊는다)', 'await tx.execute(sql`update purchase_order set amount = ${a}`)\nconst status = order.status'],
    ['해시 update(createHash)', "createHash('sha256').update(input).digest(); const status = 'x';"],
    ['status라는 이름이 든 다른 열(orderStatus)', 'await tx.update(purchaseOrder).set({ orderStatusNote: n }).where(eq(purchaseOrder.id, id));'],
    ['MERGE의 UPDATE SET엔 없고 INSERT 칸에만 status', 'sql`merge into purchase_order t using src s on t.id = s.id when matched then update set amount = s.amount when not matched then insert (id, status) values (s.id, s.status)`'],
    ['sql.identifier로 끼운 다른 표', "sql`update ${sql.identifier('seat_sale')} set status = 'SOLD'`"],
    ['다른 표를 다른 이름으로 가져옴', "import { seatSale as sales } from './schema.js';\nawait tx.update(sales).set({ status: 'SOLD' });"],
    ['상태 이력 트리거 선언(UPDATE OF status … ON purchase_order)', 'CREATE CONSTRAINT TRIGGER "order_status_has_event" AFTER INSERT OR UPDATE OF "status", "event_seq" ON "purchase_order" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "order_status_has_event"();'],
  ])('ADR0113_%s는 잡지 않는다', (_name, source) => {
    expect(findOrderStatusWrites(source)).toEqual([]);
  });
});

describe('orderStatusWritesOutside: 전이 함수 파일만 허용', () => {
  const WRITE = "await tx.execute(sql`update purchase_order set status = ${to} where id = ${id} and status = ${from}`);";

  test('ADR0113_전이 함수 파일 안의 status 쓰기는 허용하고, 그 밖 파일(같은 모듈·스크립트·마이그레이션 SQL 포함)의 것은 경로·줄과 함께 잡는다 [ASVS v5.0.0-2.3.1]', () => {
    expect(ORDER_STATUS_WRITER).toBe('src/modules/booking/adapters/db/drizzle-orders.ts');
    const files: SourceFile[] = [
      { path: ORDER_STATUS_WRITER, text: WRITE },
      { path: 'src/modules/booking/adapters/db/other-orders.ts', text: `// 첫 줄\n${WRITE}` },
      { path: 'src/modules/booking/application/expire-orders.ts', text: WRITE },
      { path: 'src/modules/inventory/adapters/db/drizzle-seat-sales.ts', text: "sql`update seat_sale s set status = 'SOLD'`" },
      { path: 'scripts/fix-orders.mjs', text: "await client.query(`update purchase_order set status = 'FAILED' where id = $1`, [id]);" },
      { path: 'migrations/0009_backfill.sql', text: "-- 되돌림\nUPDATE purchase_order SET status = 'EXPIRED' WHERE status = 'CREATED';" },
    ];
    expect(orderStatusWritesOutside(files).map((w) => [w.path, w.line])).toEqual([
      ['src/modules/booking/adapters/db/other-orders.ts', 2],
      ['src/modules/booking/application/expire-orders.ts', 1],
      ['scripts/fix-orders.mjs', 1],
      ['migrations/0009_backfill.sql', 2],
    ]);
    expect(orderStatusWritesOutside([{ path: ORDER_STATUS_WRITER, text: WRITE }])).toEqual([]);
  });
});

describe('CI 검사: services/purchase-svc의 src·scripts·migrations 전체', () => {
  const files = sourceFiles();

  test('ADR0113_훑는 파일이 실제로 있다(전이 함수 파일·좌석 판매 저장소·마이그레이션 스크립트·주문 표 마이그레이션 SQL을 포함하고 시험 폴더는 없다, 허용 경로가 낡지 않았다)', () => {
    const paths = files.map((f) => f.path);
    expect(paths.length).toBeGreaterThan(20);
    expect(paths).toContain(ORDER_STATUS_WRITER);
    expect(paths).toContain('src/modules/inventory/adapters/db/drizzle-seat-sales.ts');
    expect(paths).toContain('scripts/migrate.mjs');
    expect(paths).toContain('migrations/0003_order_tables.sql');
    expect(paths.filter((p) => /^test(-int)?\//.test(p))).toEqual([]);
    // 좌석 판매 저장소에는 진짜 'update seat_sale s set status'가 있고, 검사가 잡지 않는다(실제 코드의 반례)
    const seatSales = files.find((f) => f.path === 'src/modules/inventory/adapters/db/drizzle-seat-sales.ts')!;
    expect(seatSales.text).toMatch(/update\s+seat_sale\s+s\s+set\s+status/i);
    expect(findOrderStatusWrites(seatSales.text)).toEqual([]);
  });

  test('ADR0113_전이 함수 파일 밖(src·scripts·migrations)에 purchase_order의 status를 바꾸는 SQL이 없다 [ASVS v5.0.0-2.3.1]', () => {
    const found = orderStatusWritesOutside(files);
    expect(found, found.map((w) => `${w.path}:${w.line} ${w.text}`).join('\n')).toEqual([]);
  });
});
