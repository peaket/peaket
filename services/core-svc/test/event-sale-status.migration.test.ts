// F-07-12 RV-02 MIG: core 0055가 회차 판매 상태 사본(event_sale_state)을 만들고,
// search_document의 CHECK를 ALL_HELD까지 넓히며, 원천 함수와 적용 함수를 교체하는지 정적으로 본다.
// 실제 PostgreSQL 동작은 이번 지시(Docker 금지)로 미실행이고 test-int/partner-home.int.test.ts가 뒤에 맡는다.
// 정본: docs/data.md search_document·event_sale, ADR-0122, ADR-0271, EventSaleChanged(version).
// 기준 트리에는 0055_event_sale_state.sql이 없어 이 시험이 실패한다.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const fileName = '0055_event_sale_state.sql';
const file = `${dir}${fileName}`;
const journal = () => JSON.parse(readFileSync(`${dir}meta/_journal.json`, 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
const sql = () => readFileSync(file, 'utf8');
const noComments = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = (s: string) => noComments(s).toLowerCase().replace(/\s+/g, ' ').replace(/"/g, '');
const snapshot = (name: string) =>
  JSON.parse(readFileSync(`${dir}meta/${name}`, 'utf8')) as {
    id: string;
    prevId: string | null;
    tables: Record<
      string,
      {
        columns: Record<string, { type: string; notNull: boolean; default: unknown }>;
        indexes: Record<string, { columns: { expression: string }[] }>;
        foreignKeys: Record<string, { tableTo: string; onDelete: string }>;
        checkConstraints: Record<string, { value: string }>;
      }
    >;
  };

describe('F-07-12 RV-02 core 0055', () => {
  test('MIG-RV2-01 event_sale_state 표·CHECK·외래키·색인이 있다', () => {
    expect(existsSync(file), `${fileName}이 없다`).toBe(true);
    const s = flat(sql());
    expect(s).toMatch(/create table event_sale_state/);
    expect(s).toMatch(/event_id uuid primary key not null/);
    expect(s).toMatch(/production_id uuid not null/);
    expect(s).toMatch(/status text not null/);
    expect(s).toMatch(/version integer not null/);
    expect(s).toMatch(/changed_at timestamp with time zone not null/);
    expect(s).toMatch(/references event\(id\) on delete cascade/);
    expect(s).toMatch(/check \(event_sale_state\.status in \('upcoming', 'on_sale', 'all_held', 'sold_out', 'ended'\)\)/);
    expect(s).toMatch(/check \(event_sale_state\.version >= 1\)/);
    expect(s).toMatch(/create index event_sale_state_production_idx/);
  });

  test('MIG-RV2-02 search_document의 CHECK가 ALL_HELD를 받는다', () => {
    const s = flat(sql());
    expect(s).toMatch(/alter table search_document drop constraint search_document_sale_status_check/);
    expect(s).toMatch(/add constraint search_document_sale_status_check check \(sale_status in \('upcoming', 'on_sale', 'all_held', 'sold_out', 'ended'\)\)/);
  });

  test('MIG-RV2-03 원천 함수는 사본을 먼저 쓰고 사본이 없으면 시간으로 계산한다', () => {
    const s = flat(sql());
    expect(s).toMatch(/create or replace function search_document_source_at\(p_at timestamptz, p_ids uuid\[\] default null\)/);
    expect(s).toContain('event_sale_state');
    expect(s).toContain("'all_held'");
    // 사본이 없을 때의 기존 계산이 남아 있다(UPCOMING·ON_SALE·ENDED)
    expect(s).toMatch(/open_at <= p_at/);
    expect(s).toMatch(/starts_at - interval '24 hours' > p_at/);
    expect(s).toMatch(/open_at > p_at/);
  });

  test('MIG-RV2-04 적용 함수는 판 번호가 클 때만 쓰고 search_version·search_document를 한 함수에서 고친다', () => {
    const s = flat(sql());
    expect(s).toMatch(/create or replace function search_apply_event_sale\(p_event_id uuid, p_status text, p_version integer, p_changed_at timestamptz\)/);
    expect(s).toMatch(/returns text/);
    expect(s).toMatch(/security definer/);
    expect(s).toMatch(/set search_path = public, pg_temp/);
    expect(s).toMatch(/on conflict \(event_id\) do update/);
    expect(s).toMatch(/where event_sale_state\.version < excluded\.version/);
    expect(s).toMatch(/update search_version/);
    expect(s).toMatch(/update search_document/);
    expect(s).toContain('search_document_source_at');
    expect(s).toContain("'unknown'");
    expect(s).toContain("'stale'");
    expect(s).toContain("'applied'");
  });

  test('MIG-RV2-05 권한은 core_app 읽기·실행만 주고 PUBLIC·core_partner에는 주지 않는다', () => {
    const s = flat(sql());
    expect(s).toMatch(/revoke all on function search_apply_event_sale\(uuid, text, integer, timestamp with time zone\) from public/);
    expect(s).toMatch(/grant execute on function search_apply_event_sale\(uuid, text, integer, timestamp with time zone\) to core_app/);
    expect(s).toMatch(/grant select on event_sale_state to core_app/);
    expect(s).not.toMatch(/event_sale_state[^;]*to core_partner/);
    expect(s).not.toMatch(/grant (insert|update|delete)[^;]*on event_sale_state to core_app/);
  });

  test('MIG-RV2-06 저널 idx 55와 스냅숏이 새 표를 담는다', () => {
    const entries = journal().entries;
    const prev = entries.find((e) => e.idx === 54);
    const mine = entries.find((e) => e.idx === 55);
    expect(prev?.tag).toBe('0054_partner_home');
    expect(mine, '저널 idx 55가 없다').toBeDefined();
    expect(mine!.tag).toBe('0055_event_sale_state');
    expect(mine!.when).toBeGreaterThan(prev!.when);
    expect(existsSync(`${dir}meta/0055_snapshot.json`), '0055_snapshot.json이 없다').toBe(true);

    const before = snapshot('0054_snapshot.json');
    const after = snapshot('0055_snapshot.json');
    expect(after.prevId).toBe(before.id);
    const table = after.tables['public.event_sale_state'];
    expect(table, '스냅숏에 event_sale_state가 없다').toBeDefined();
    expect(table!.columns.event_id).toMatchObject({ type: 'uuid', notNull: true });
    expect(table!.columns.production_id).toMatchObject({ type: 'uuid', notNull: true });
    expect(table!.columns.status).toMatchObject({ type: 'text', notNull: true });
    expect(table!.columns.version).toMatchObject({ type: 'integer', notNull: true });
    expect(table!.columns.changed_at).toMatchObject({ type: 'timestamp with time zone', notNull: true });
    expect(Object.keys(table!.indexes)).toContain('event_sale_state_production_idx');
    expect(Object.values(table!.foreignKeys)).toEqual([expect.objectContaining({ tableTo: 'event', onDelete: 'cascade' })]);
    const checks = table!.checkConstraints;
    expect(Object.keys(checks)).toEqual(expect.arrayContaining(['event_sale_state_status_check', 'event_sale_state_version_check']));
    expect(checks.event_sale_state_status_check!.value.toLowerCase()).toContain('all_held');
    expect(checks.event_sale_state_version_check!.value.toLowerCase()).toMatch(/version"? >= 1/);
  });
});
