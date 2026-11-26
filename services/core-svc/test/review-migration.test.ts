// MIG-01: F-07-10의 core-svc 마이그레이션 번호는 0052다(감독 조정, 2026-11-26).
// F-10-2가 0050_image_job.sql, F-10-1이 0051부터를 쓴다. 이 기능은 0050·0051을 만들지 않고,
// 0052_review_image.sql 한 파일에 review_image 표와 권한을 넣으며, 저널 idx 52의 when은 0047보다 커야 한다.
// 기준 트리에는 0052 파일이 없어 이 시험이 실패한다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const sqlFiles = () => readdirSync(dir).filter((f) => f.endsWith('.sql'));
const journal = () => JSON.parse(readFileSync(`${dir}meta/_journal.json`, 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };

describe('F-07-10 마이그레이션 번호', () => {
  test('MIG-01 core-svc 후기 사진 표는 0052_review_image.sql 하나이고 0050·0051을 쓰지 않는다', () => {
    const files = sqlFiles();
    expect(files).toContain('0052_review_image.sql');
    expect(files.filter((f) => f.startsWith('0050_') || f.startsWith('0051_'))).toEqual([]);

    const sql = readFileSync(`${dir}0052_review_image.sql`, 'utf8').toLowerCase();
    expect(sql).toContain('create table "review_image"');
    for (const column of ['review_id', 'account_id', 'status', 'reject_reason', 'alt_text', 'width', 'height', 'sort', 'thumb_key', 'view_key', 'attached_at', 'deleted_at']) {
      expect({ column, present: sql.includes(`"${column}"`) }).toEqual({ column, present: true });
    }
    expect(sql).toContain('core_app');
    expect(sql).toContain('core_maintenance');
  });

  test('MIG-01 다른 마이그레이션은 review_image 표를 만들지 않고, 저널 idx 52의 when은 0047보다 크다', () => {
    const others = sqlFiles().filter((f) => f !== '0052_review_image.sql');
    for (const f of others) {
      const sql = readFileSync(`${dir}${f}`, 'utf8').toLowerCase();
      expect({ file: f, createsReviewImage: sql.includes('create table "review_image"') }).toEqual({ file: f, createsReviewImage: false });
    }
    const e = journal().entries;
    const e47 = e.find((x) => x.tag === '0047_entry_closed_grant');
    const e52 = e.find((x) => x.tag === '0052_review_image');
    expect({ idx: e52?.idx, later: e52 !== undefined && e47 !== undefined && e52.when > e47.when }).toEqual({ idx: 52, later: true });
    expect(existsSync(`${dir}0052_review_image.sql`)).toBe(true);
  });
});
