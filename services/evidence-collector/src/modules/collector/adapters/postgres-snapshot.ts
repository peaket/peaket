// 어댑터: PostgreSQL 순간 상태 뜨기(docs/observability.md §5 '진단 증거' 뜨는 것, 시험 D-T51 ①⑤⑥).
// - 수집마다 연결 하나를 열고 닫는다(연결 시간 초과 5초 [가정], 앱 이름 evidence-collector). 접속 계정은 pg_monitor 역할만 받은 사용자다(INF-020)
// - 읽기 전용 트랜잭션 하나에 statement_timeout 5초 [가정]를 건다. 질의마다 저장점을 두어 하나가 실패해도 나머지를 뜬다(partial)
// - 자기 세션은 뺀다. 클라이언트 주소 칸(client_addr·client_hostname·client_port)은 뜨지 않는다
// - 오류는 종류 이름만 남긴다(접속 주소·비밀번호가 섞인 오류 글은 버린다)
import pg from 'pg';
import { errorCode, type EvidenceTarget, type Snapshot, type SnapshotError, type SnapshotFile, type SnapshotSource } from '../domain/snapshot.js';

/** 연결 시간 초과(ms, [가정]) */
export const PG_CONNECT_TIMEOUT_MS = 5_000;
/** 질의 시간 상한(ms, [가정]) */
export const PG_STATEMENT_TIMEOUT_MS = 5_000;
const APPLICATION_NAME = 'evidence-collector';

/** 유휴 아닌 세션(자기 세션 뺌). 클라이언트 주소는 뜨지 않는다 */
const ACTIVITY_SQL = `select pid, state, wait_event_type, wait_event, backend_type, usename, application_name,
  backend_start, xact_start, query_start, state_change, query_id, query
from pg_stat_activity
where pid <> pg_backend_pid() and state is distinct from 'idle'
order by pid`;
/** 막힌 세션과 그 세션을 막는 쪽 */
const BLOCKING_SQL = `select pid, pg_blocking_pids(pid) as blocked_by, wait_event_type, wait_event, state
from pg_stat_activity
where pid <> pg_backend_pid() and cardinality(pg_blocking_pids(pid)) > 0
order by pid`;
/** 복제 슬롯과 그 슬롯이 붙잡은 WAL 양(바이트) */
const SLOTS_SQL = `select slot_name, slot_type, plugin, database, temporary, active, active_pid, wal_status, restart_lsn, confirmed_flush_lsn,
  case when restart_lsn is null then null else pg_wal_lsn_diff(case when pg_is_in_recovery() then pg_last_wal_receive_lsn() else pg_current_wal_lsn() end, restart_lsn) end as retained_wal_bytes
from pg_replication_slots
order by slot_name`;

const QUERIES: ReadonlyArray<{ file: string; sql: string }> = [
  { file: 'pg-activity.json', sql: ACTIVITY_SQL },
  { file: 'pg-blocking.json', sql: BLOCKING_SQL },
  { file: 'pg-replication-slots.json', sql: SLOTS_SQL },
];

const encoder = new TextEncoder();

export class PostgresSnapshotSource implements SnapshotSource {
  async snapshot(target: EvidenceTarget): Promise<Snapshot> {
    const client = new pg.Client({ connectionString: target.url, connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS, application_name: APPLICATION_NAME });
    // 연결이 끊겨 나는 오류 사건이 프로세스를 멈추지 않게 받는다(질의 쪽이 실패로 받는다)
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (err) {
      const code = errorCode(err, 'connect_failed');
      await client.end().catch(() => {});
      return { connected: false, files: [], errors: QUERIES.map((q) => ({ file: q.file, code })) };
    }
    const files: SnapshotFile[] = [];
    const errors: SnapshotError[] = [];
    try {
      await client.query('begin read only');
      await client.query("select set_config('statement_timeout', $1, true)", [String(PG_STATEMENT_TIMEOUT_MS)]);
      for (const q of QUERIES) {
        try {
          await client.query('savepoint evidence_q');
          const r = await client.query(q.sql);
          await client.query('release savepoint evidence_q');
          files.push({ name: q.file, body: encoder.encode(JSON.stringify(r.rows, null, 2)), contentType: 'application/json' });
        } catch (err) {
          errors.push({ file: q.file, code: errorCode(err, 'query_failed') });
          await client.query('rollback to savepoint evidence_q').catch(() => {});
        }
      }
      await client.query('commit').catch(() => {});
    } catch (err) {
      // 트랜잭션을 열지 못했다: 아직 뜨지 못한 것은 모두 그 오류로 적는다
      const code = errorCode(err, 'transaction_failed');
      for (const q of QUERIES) if (!files.some((f) => f.name === q.file) && !errors.some((e) => e.file === q.file)) errors.push({ file: q.file, code });
    } finally {
      await client.end().catch(() => {});
    }
    return { connected: true, files, errors };
  }
}
