// 홈 피드 읽기 표의 마이그레이션 번호(HOT-305, MIG-01, 2026-11-26).
// 같은 갈래 F-10-2가 core-svc 0050_image_job.sql을 계획·시험까지 잡았으므로 F-10-1은 0051을 쓴다.
// 기준 트리에서는 0051 파일과 저널 항목이 없어 실패한다.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const journal = JSON.parse(readFileSync(`${dir}meta/_journal.json`, 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };

describe('홈 피드 마이그레이션 번호', () => {
  test('HOT-305 F-10-2의 0050을 비켜 F-10-1 홈 표는 0051이고 저널 idx 51이 0047보다 뒤다', () => {
    // F-10-2가 잡은 번호는 이 가지에서 만들지 않는다(다른 동결 가지의 계획·시험).
    expect(existsSync(`${dir}0050_image_job.sql`)).toBe(false);
    expect(existsSync(`${dir}0051_home_layout_read.sql`)).toBe(true);
    const e47 = journal.entries.find((x) => x.tag === '0047_entry_closed_grant');
    const e51 = journal.entries.find((x) => x.tag === '0051_home_layout_read');
    expect({ idx: e51?.idx, after47: e47 !== undefined && e51 !== undefined && e51.when > e47.when }).toEqual({ idx: 51, after47: true });
  });
});
