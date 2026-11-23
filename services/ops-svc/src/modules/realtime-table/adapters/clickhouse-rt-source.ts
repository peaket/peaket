// 관제 실시간 표 읽기 어댑터(ClickHouse rt 매개변수 뷰 셋과 회차 기준 자료, docs/streaming.md §4.3, ADR-0073·0086, F-04-1).
// - 사용자는 an_rt_reader(rt 뷰와 bronze.brz_ref_seat_map만 읽는다, analytics §11). 설정 프로필의 force_primary_key = 1은 배포 몫이다.
// - 조회마다 max_execution_time = 1초 [가정](streaming §4.3)을 URL 설정으로 보내고, HTTP 상한도 짧게(1.5초) 둔다.
//   (프로필이 readonly=1이면 설정을 바꿀 수 없으니 프로필에 같은 값을 두거나 readonly=2로 둔다, 배포 몫)
// - SQL은 고정 문장이고 회차 ID·시각만 매개변수(param_*)로 넘긴다. 사용자가 SQL·열 이름을 넘기지 못한다.
// - 64비트 정수는 FORMAT JSON에서 글자로 오므로 숫자로 바꾼다. 시각은 유닉스 초·밀리초로 받아 시간대에 기대지 않는다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { RtSourceFailure, type BucketRow, type CumulativeRow, type FreshnessRow, type SeatMapRow } from '../domain/realtime-table.js';
import type { RtQuerySource, SeatMapSource } from '../domain/ports.js';

/** ops-svc 실시간 표 읽기 사용자(docs/features/analytics.md §11). 비밀은 Secret에서 온다 */
export const RT_CLICKHOUSE_READER = 'an_rt_reader';
/** 조회 하나의 서버 실행 상한(초) */
export const RT_MAX_EXECUTION_SECONDS = 1;
/** HTTP 상한(ms): 서버 상한 1초 + 전송 여유 */
export const RT_HTTP_TIMEOUT_MS = 1_500;

export interface ClickHouseRtSourceOptions {
  readonly baseUrl: string;
  readonly user?: string;
  readonly password?: string;
  readonly timeoutCapMs?: number;
  readonly fetch?: typeof fetch;
}

const SQL = {
  cumulative: 'SELECT metric, dim, value FROM rt.v_cumulative(event_id = {event_id:String}) FORMAT JSON',
  buckets:
    'SELECT metric, dim, toUnixTimestamp(second) AS second_s, value FROM rt.v_bucket(event_id = {event_id:String}, from_ts = {from_ts:DateTime64(3)}) FORMAT JSON',
  freshness: 'SELECT topic, kafka_partition, toUnixTimestamp64Milli(last_produced_at) AS last_ms, pulses_2s FROM rt.v_freshness FORMAT JSON',
  seatMap: 'SELECT layout_version, section_id, tier_id, seat_count FROM bronze.brz_ref_seat_map WHERE event_id = {event_id:String} FORMAT JSON',
} as const;

const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);
const rowsOf = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];

/** DateTime64(3) 매개변수 글자(유닉스 초.밀리초. 시간대와 상관없이 같은 시각이다) */
export const dateTime64Param = (ms: number): string => (Math.floor(ms) / 1_000).toFixed(3);

export class ClickHouseRtSource implements RtQuerySource, SeatMapSource {
  readonly #client: ExternalHttpClient;
  readonly #authorization: string;

  constructor(o: ClickHouseRtSourceOptions) {
    this.#client = createExternalHttpClient({
      provider: 'rt-clickhouse',
      baseUrl: o.baseUrl,
      timeoutCapMs: o.timeoutCapMs ?? RT_HTTP_TIMEOUT_MS,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    const user = o.user ?? RT_CLICKHOUSE_READER;
    this.#authorization = `Basic ${Buffer.from(`${user}:${o.password ?? ''}`, 'utf8').toString('base64')}`;
  }

  async cumulative(eventId: string): Promise<readonly CumulativeRow[]> {
    const rows = await this.#query(SQL.cumulative, { event_id: eventId });
    return rows.flatMap((r): CumulativeRow[] => {
      const value = num(r.value);
      return typeof r.metric === 'string' && Number.isFinite(value) ? [{ metric: r.metric, dim: text(r.dim), value }] : [];
    });
  }

  async buckets(eventId: string, fromMs: number): Promise<readonly BucketRow[]> {
    const rows = await this.#query(SQL.buckets, { event_id: eventId, from_ts: dateTime64Param(fromMs) });
    return rows.flatMap((r): BucketRow[] => {
      const second = num(r.second_s);
      const value = num(r.value);
      return typeof r.metric === 'string' && Number.isFinite(second) && Number.isFinite(value) ? [{ metric: r.metric, dim: text(r.dim), secondMs: second * 1_000, value }] : [];
    });
  }

  async freshness(): Promise<readonly FreshnessRow[]> {
    const rows = await this.#query(SQL.freshness, {});
    return rows.flatMap((r): FreshnessRow[] => {
      const partition = num(r.kafka_partition);
      const last = num(r.last_ms);
      const pulses = num(r.pulses_2s);
      return typeof r.topic === 'string' && Number.isInteger(partition) && Number.isFinite(last)
        ? [{ topic: r.topic, partition, lastProducedAtMs: last, pulses2s: Number.isFinite(pulses) ? pulses : 0 }]
        : [];
    });
  }

  async seatMap(eventId: string): Promise<readonly SeatMapRow[]> {
    const rows = await this.#query(SQL.seatMap, { event_id: eventId });
    return rows.flatMap((r): SeatMapRow[] => {
      const seatCount = num(r.seat_count);
      const version = typeof r.layout_version === 'number' || typeof r.layout_version === 'string' ? r.layout_version : undefined;
      return version !== undefined && Number.isFinite(seatCount) ? [{ layoutVersion: version, sectionId: text(r.section_id), tierId: text(r.tier_id), seatCount }] : [];
    });
  }

  async #query(sql: string, params: Readonly<Record<string, string>>): Promise<Record<string, unknown>[]> {
    const query: Record<string, string> = { max_execution_time: String(RT_MAX_EXECUTION_SECONDS) };
    for (const [name, value] of Object.entries(params)) query[`param_${name}`] = value;
    try {
      const res = await this.#client.request({
        method: 'POST',
        path: '/',
        query,
        headers: { 'content-type': 'text/plain; charset=utf-8', authorization: this.#authorization },
        body: sql,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new RtSourceFailure(`clickhouse ${res.status}`);
      }
      const body = (await res.json()) as { data?: unknown };
      return rowsOf(body.data);
    } catch (e) {
      if (e instanceof RtSourceFailure) throw e;
      throw new RtSourceFailure('clickhouse request failed');
    }
  }
}
