// inv 표·사용자 DDL 시험(docs/data.md '부정 예매 사후 조사의 표', docs/streaming.md §6.4 ST-T24, F-04-10).
// [ASVS v5.0.0-13.2.2] 최소 권한.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const read = (name: string) => readFileSync(fileURLToPath(new URL(`../../../data/clickhouse/inv/${name}`, import.meta.url)), 'utf8');
const tables = read('0001_inv_tables.sql');
const users = read('0002_inv_users.sql');

const TABLES: Record<string, string> = {
  'inv.inv_request': '(event_id, request_id)',
  'inv.inv_step': '(event_id, source_key)',
  'inv.inv_behavior': '(event_id, event_key)',
  'inv.inv_link': '(event_id, kind, value, account_id, pid, journey_id)',
};

describe('ST-T24 inv 표 넷과 권한', () => {
  test('ST-T24 ④ 표 넷은 회차 파티션·retain_until·TTL 보조를 갖는다', () => {
    for (const [name, order] of Object.entries(TABLES)) {
      const at = tables.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
      expect(at, name).toBeGreaterThanOrEqual(0);
      const body = tables.slice(at, tables.indexOf(';', at));
      expect(body).toContain('ENGINE = ReplicatedReplacingMergeTree(ingest_rank)');
      expect(body).toContain('PARTITION BY event_id');
      expect(body).toContain(`ORDER BY ${order}`);
      expect(body).toContain('retain_until');
      expect(body).toContain('ingested_at');
      expect(body).toContain('TTL toDate(retain_until) + INTERVAL 30 DAY DELETE');
    }
    // 표마다 정본의 칸이 있다
    expect(tables).toContain('request_id');
    expect(tables).toContain('edge_bot_labels');
    expect(tables).toContain('source_key');
    expect(tables).toContain('payment_method_ref');
    expect(tables).toContain('pointer_entropy');
    expect(tables).toContain('first_seen_at');
    expect(tables).toContain('inv.inv_ingest_progress');
    expect(tables).toContain('ingest_rank');
  });

  test('ST-T24 ③ 표 넷과 사용자의 권한이 최소 권한이다', () => {
    const sql = users.replace(/\s+/g, ' ');
    expect(sql).toContain('CREATE USER IF NOT EXISTS inv_ingest');
    expect(sql).toContain('CREATE USER IF NOT EXISTS inv_reader');
    expect(sql).toContain('CREATE USER IF NOT EXISTS inv_purger');
    expect(sql).toContain("CREATE SETTINGS PROFILE IF NOT EXISTS inv_reader_profile SETTINGS readonly = 1, max_execution_time = 60, max_memory_usage = 4294967296");
    expect(sql).toContain('GRANT INSERT ON inv.* TO inv_ingest');
    expect(sql).toContain('GRANT SELECT ON inv.* TO inv_reader');
    expect(sql).toContain('GRANT ALTER TABLE ON inv.* TO inv_purger');
    expect(sql).not.toMatch(/GRANT ALL/);
    expect(sql).not.toContain('ON *.*');
    expect(sql).not.toContain('GRANT SELECT ON inv.* TO inv_ingest');
    expect(sql).not.toContain('GRANT INSERT ON inv.* TO inv_reader');
    expect(sql).not.toContain('GRANT SELECT ON inv.* TO inv_purger');
    expect(sql).not.toContain('GRANT INSERT ON inv.* TO inv_purger');
  });
});
