// 보존 파기 시험(docs/streaming.md §6.4·§10 ST-T24, docs/data.md '부정 예매 사후 조사의 표', ADR-0173 결정 7, F-04-10).
import { describe, expect, test } from 'vitest';
import { INV_TABLES } from '../src/records.js';
import { partitionsToPurge, purgeExpired, retainUntilUpdate, type PurgeLogLine } from '../src/purge.js';

const NOW = Date.parse('2026-12-20T00:00:00.000Z');

describe('ST-T24 조사 저장소 보존', () => {
  test('ST-T24 ① 보존이 지난 회차는 표마다 파티션이 지워지고 INV_PARTITION_PURGE 사건이 남는다', async () => {
    const exec: string[] = [];
    const ch = {
      async rows<T>(sql: string): Promise<T[]> {
        // 표마다 지난 회차 하나와 아직 남는 회차 하나를 돌려준다
        if (sql.includes('inv.inv_request')) return [{ event_id: 'ev-old', rows: '3', until: '2026-11-30T00:00:00.000Z' }] as T[];
        if (sql.includes('inv.inv_step')) return [{ event_id: 'ev-old', rows: '7', until: '2026-11-30T00:00:00.000Z' }] as T[];
        if (sql.includes('inv.inv_behavior')) return [{ event_id: 'ev-old', rows: '2', until: '2026-11-30T00:00:00.000Z' }] as T[];
        return [{ event_id: 'ev-old', rows: '4', until: '2026-11-30T00:00:00.000Z' }] as T[];
      },
      async exec(sql: string) {
        exec.push(sql);
      },
    };
    const logs: PurgeLogLine[] = [];
    const result = await purgeExpired({ clickhouse: ch, now: NOW, log: (l) => logs.push(l) });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ eventId: 'ev-old', result: 'DROPPED' });
    expect(exec).toHaveLength(4);
    for (const t of INV_TABLES) expect(exec).toContain(`ALTER TABLE ${t} DROP PARTITION 'ev-old'`);
    expect(logs).toHaveLength(4);
    expect(logs.map((l) => [l.table, l.rows, l.result])).toEqual([
      ['inv.inv_request', 3, 'DROPPED'],
      ['inv.inv_step', 7, 'DROPPED'],
      ['inv.inv_behavior', 2, 'DROPPED'],
      ['inv.inv_link', 4, 'DROPPED'],
    ]);
    expect(logs[0]).toMatchObject({ kind: 'ops_event', opsEvent: 'INV_PARTITION_PURGE', eventId: 'ev-old' });
  });

  test('ST-T24 ② 공연 날짜가 바뀐 회차는 새 retain_until을 따르고 아직 남는다', async () => {
    const ch = {
      async rows<T>(sql: string): Promise<T[]> {
        // 두 회차: 지난 것과 날짜가 바뀌어 보존이 늘어난 것
        if (sql.includes('inv.inv_request')) {
          return [
            { event_id: 'ev-old', rows: '1', until: '2026-11-30T00:00:00.000Z' },
            { event_id: 'ev-moved', rows: '5', until: '2027-01-30T00:00:00.000Z' },
          ] as T[];
        }
        return [] as T[];
      },
      async exec() {},
    };
    const due = await partitionsToPurge(ch, NOW);
    expect(due.map((d) => d.eventId)).toEqual(['ev-old']);
    for (const t of INV_TABLES) {
      expect(retainUntilUpdate(t, 'ev-moved', '2027-01-01')).toBe(`ALTER TABLE ${t} UPDATE retain_until = '2027-01-31T00:00:00.000Z' WHERE event_id = 'ev-moved'`);
    }
  });

  test('ST-T24 ⑦ 파기 결과는 ops_event 줄로 남고 다른 표를 건드리지 않는다', async () => {
    const exec: string[] = [];
    const logs: PurgeLogLine[] = [];
    const ch = {
      async rows<T>(): Promise<T[]> {
        return [{ event_id: 'ev-old', rows: '0', until: '2026-11-01T00:00:00.000Z' }] as T[];
      },
      async exec(sql: string) {
        exec.push(sql);
      },
    };
    await purgeExpired({ clickhouse: ch, now: NOW, log: (l) => logs.push(l) });
    expect(exec.every((s) => INV_TABLES.some((t) => s.startsWith(`ALTER TABLE ${t} DROP PARTITION`)))).toBe(true);
    expect(logs.every((l) => l.opsEvent === 'INV_PARTITION_PURGE' && l.at === new Date(NOW).toISOString())).toBe(true);
    // 보존 끝과 같은 시각은 아직 남긴다
    const same = await partitionsToPurge({ async rows<T>() { return [{ event_id: 'ev-edge', rows: '1', until: new Date(NOW).toISOString() }] as T[]; } }, NOW);
    expect(same).toEqual([]);
  });
});
