// MIG-01: F-07-12의 core-svc 마이그레이션은 0054다(F-07-11 0053 다음, F-10-2 0050·F-10-1 0051을 쓰지 않는다).
// 0054는 production.version(정수, 기본 1, >= 1 CHECK)을 더한다. 저널 idx 54의 when은 0053보다 커야 한다.
// 기준 트리에는 0054 파일이 없어 이 시험이 실패한다.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const fileName = '0054_partner_home.sql';
const file = `${dir}${fileName}`;
const journal = () => JSON.parse(readFileSync(`${dir}meta/_journal.json`, 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
const sql = () => readFileSync(file, 'utf8');
const flat = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/"/g, '');

describe('F-07-12 AC-07 core 0054', () => {
  test('MIG-01 0054는 production.version을 기본 1, 1 이상 CHECK로 더한다', () => {
    expect(existsSync(file), `${fileName}이 없다`).toBe(true);
    const s = flat(sql());
    expect(s).toMatch(/alter table (public\.)?production add column (if not exists )?version integer not null default 1/);
    expect(s).toMatch(/check \(version >= 1\)|check \(production_version_check\)|version >= 1/);
    // 다른 표·다른 기능의 몫을 건드리지 않는다
    expect(s).not.toMatch(/create table/);
    expect(s).not.toMatch(/image|seatmap|review|settlement|payout/);
  });

  test('MIG-01 저널 idx 54·tag·when이 0053 뒤에 있고 스냅숏이 있다', () => {
    const entries = journal().entries;
    const prev = entries.find((e) => e.idx === 53);
    const mine = entries.find((e) => e.idx === 54);
    expect(prev?.tag).toBe('0053_compliance_notice');
    expect(mine, '저널 idx 54가 없다').toBeDefined();
    expect(mine!.tag).toBe('0054_partner_home');
    expect(mine!.when).toBeGreaterThan(prev!.when);
    expect(existsSync(`${dir}meta/0054_snapshot.json`), '0054_snapshot.json이 없다').toBe(true);
  });
});
