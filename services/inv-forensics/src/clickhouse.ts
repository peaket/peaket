// 조사 저장소 ClickHouse 읽기(docs/features/forensic-replay.md §6.7.1·§6.7.2, F-04-11).
// 읽기 사용자는 inv_reader다. 질의는 고정 문장이고 회차·범위만 매개변수로 넘긴다(ASVS v5.0.0-1.2.4·15.2.2).
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { RULE_VERSION, type ClusterInput, type ClusterLink, type ClusterRequest, type ClusterStep, type ExternalPost } from './cluster.js';
import { HASH_COLUMNS, type Row, type SnapshotTable } from './snapshot.js';

const SORT_KEYS: Record<SnapshotTable, readonly string[]> = {
  inv_request: ['event_id', 'request_id'],
  inv_step: ['event_id', 'source_key'],
  inv_behavior: ['event_id', 'event_key'],
  inv_link: ['event_id', 'kind', 'value', 'account_id', 'pid', 'journey_id'],
};
const DATE_COLUMNS = new Set(['ts', 'ingested_at', 'first_seen_at', 'last_seen_at']);

export interface ClickHouseReaderOptions {
  baseUrl: string;
  user: string;
  password?: string;
  timeoutCapMs?: number;
  fetch?: typeof fetch;
}

export class ClickHouseReader {
  readonly #client: ExternalHttpClient;
  readonly #auth: Record<string, string>;

  constructor(o: ClickHouseReaderOptions) {
    this.#client = createExternalHttpClient({
      provider: 'clickhouse',
      baseUrl: o.baseUrl,
      timeoutCapMs: o.timeoutCapMs ?? 60_000,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    this.#auth = { 'x-clickhouse-user': o.user, 'x-clickhouse-key': o.password ?? '' };
  }

  async rows<T = Record<string, unknown>>(sql: string, params: Readonly<Record<string, string>> = {}): Promise<T[]> {
    const query = Object.fromEntries(Object.entries(params).map(([k, v]) => [`param_${k}`, v]));
    const res = await this.#client.request({
      method: 'POST',
      path: '/',
      query,
      headers: { ...this.#auth, 'content-type': 'text/plain; charset=utf-8' },
      body: `${sql} FORMAT JSON`,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.split('\n')[0]?.slice(0, 300) ?? ''}`);
    return (JSON.parse(text) as { data: T[] }).data;
  }
}

/** 판 범위의 표 넷을 읽는다. DateTime64 칸은 toUnixTimestamp64Milli로 정수 밀리초가 된다 */
export async function loadSnapshotTables(
  reader: ClickHouseReader,
  o: { eventId: string; from: number | null; to: number },
): Promise<Record<SnapshotTable, Row[]>> {
  const out = {} as Record<SnapshotTable, Row[]>;
  for (const table of Object.keys(HASH_COLUMNS) as SnapshotTable[]) {
    // 안쪽에서 밀리초로 바꾼 칸 이름을 ts_ms처럼 다르게 두어 WHERE의 원래 칸을 가리지 않게 한다.
    const inner = HASH_COLUMNS[table].map((c) => (DATE_COLUMNS.has(c) ? `toUnixTimestamp64Milli(${c}) AS ${c}_ms` : c)).join(', ');
    const outer = HASH_COLUMNS[table].map((c) => (DATE_COLUMNS.has(c) ? `${c}_ms AS ${c}` : c)).join(', ');
    const where = ['event_id = {eventId:String}', 'ingested_at <= fromUnixTimestamp64Milli({toMs:Int64})'];
    const params: Record<string, string> = { eventId: o.eventId, toMs: String(o.to) };
    if (o.from !== null) {
      where.push('ingested_at > fromUnixTimestamp64Milli({fromMs:Int64})');
      params.fromMs = String(o.from);
    }
    out[table] = await reader.rows<Row>(
      `SELECT ${outer} FROM (SELECT ${inner} FROM inv.${table} FINAL WHERE ${where.join(' AND ')}) ORDER BY ${SORT_KEYS[table].join(', ')}`,
      params,
    );
  }
  return out;
}

/** 후보 계산 입력을 읽는다. 행동 요약(inv_behavior)은 읽지 않는다(ADR-0173 결정 5) */
export async function loadClusterInput(
  reader: ClickHouseReader,
  o: {
    eventId: string;
    saleStartMs: number;
    limitPerPerson: number;
    snapshotVersion: number;
    ruleVersion?: string;
    posts?: readonly ExternalPost[];
  },
): Promise<ClusterInput> {
  const eventId = o.eventId;
  const rawLinks = await reader.rows<{ kind: ClusterLink['kind']; value: string; account_id: string; journey_id: string; first_seen_at: number }>(
    `SELECT kind, value, account_id, journey_id, toUnixTimestamp64Milli(first_seen_at) AS first_seen_at
       FROM inv.inv_link FINAL
      WHERE event_id = {eventId:String} AND account_id != ''
        AND kind IN ('DEVICE', 'CONTACT', 'PAYMENT_METHOD', 'IDENTITY_CONFLICT')
      ORDER BY kind, value, account_id`,
    { eventId },
  );
  const rawRequests = await reader.rows<{ account_id: string; ip: string; net_class: string; asn: number; ts: number }>(
    `SELECT account_id, IPv6NumToString(ip) AS ip, net_class, asn, toUnixTimestamp64Milli(ts) AS ts
       FROM inv.inv_request FINAL
      WHERE event_id = {eventId:String} AND account_id != ''
      ORDER BY ts, account_id`,
    { eventId },
  );
  const rawSteps = await reader.rows<{
    account_id: string;
    journey_id: string;
    step: string;
    ts: number;
    queue_entry_id: string;
    seat_ids: string[];
  }>(
    `SELECT account_id, journey_id, step, toUnixTimestamp64Milli(ts) AS ts, queue_entry_id, seat_ids
       FROM inv.inv_step FINAL
      WHERE event_id = {eventId:String}
      ORDER BY ts, source_key`,
    { eventId },
  );
  const links: ClusterLink[] = rawLinks.map((r) => ({
    kind: r.kind,
    value: r.value,
    accountId: r.account_id,
    journeyId: r.journey_id,
    firstSeenAt: Number(r.first_seen_at),
  }));
  const requests: ClusterRequest[] = rawRequests.map((r) => ({
    accountId: r.account_id,
    ip: r.ip,
    netClass: r.net_class,
    asn: Number(r.asn),
    ts: Number(r.ts),
  }));
  const steps: ClusterStep[] = rawSteps.map((r) => ({
    accountId: r.account_id,
    journeyId: r.journey_id,
    step: r.step,
    ts: Number(r.ts),
    queueEntryId: r.queue_entry_id,
    seatIds: r.seat_ids ?? [],
  }));
  return {
    eventId,
    snapshotVersion: o.snapshotVersion,
    ruleVersion: o.ruleVersion ?? RULE_VERSION,
    limitPerPerson: o.limitPerPerson,
    saleStartMs: o.saleStartMs,
    links,
    requests,
    steps,
    posts: o.posts ?? [],
  };
}

/** 적재 진행 표시의 가장 늦은 적재 시각(밀리초). 없으면 0 */
export async function ingestProgressAt(reader: ClickHouseReader): Promise<number> {
  const rows = await reader.rows<{ at: number | string | null }>(
    'SELECT toUnixTimestamp64Milli(max(ingested_at)) AS at FROM inv.inv_ingest_progress',
  );
  const at = rows[0]?.at;
  return at === null || at === undefined ? 0 : Number(at);
}
