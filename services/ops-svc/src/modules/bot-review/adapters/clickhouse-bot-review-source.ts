// 표본 후보 원장(ClickHouse 분석 저장소 bot_sample_review) 읽기 어댑터(FR-049, BAT-197).
// - 적재는 OPS-180·OPS-220 몫이다. 여기서는 읽기만 하고 쓰지 않는다(사용자 an_ops_reader, SELECT만).
// - SQL은 고정 문장이고 event_id·bundle·limit만 매개변수로 넘긴다. 사용자가 SQL·열 이름·정렬 열을 넘기지 못한다.
// - pid는 판정할 때만 읽고 저장하지 않는다(POL-006, 계획 G9).
// - 원장이 없거나 질의가 실패하면 BotReviewSourceFailure이고, 부르는 층이 503으로 바꾼다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import {
  BotReviewSourceFailure,
  SAMPLE_EVIDENCE_KINDS,
  TIMELINE_STEPS,
  type ReviewBatch,
  type ReviewKind,
  type SampleTimelineStep,
} from '../domain/bot-review.js';
import type { BotReviewCandidate, BotReviewSource } from '../domain/ports.js';

/** 읽기 사용자(docs/security/secrets-and-keys.md). 비밀은 Secret에서 온다 */
export const CLICKHOUSE_READER = 'an_ops_reader';

export interface ClickHouseBotReviewSourceOptions {
  readonly baseUrl: string;
  readonly user?: string;
  readonly password?: string;
  /** 쿼리 하나의 상한(ms). 분석 읽기라 5초 [가정] */
  readonly timeoutCapMs?: number;
  readonly fetch?: typeof fetch;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? Number.NaN));
const rowsOf = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)) : [];

export class ClickHouseBotReviewSource implements BotReviewSource {
  readonly #client: ExternalHttpClient;
  readonly #authorization: string | undefined;

  constructor(o: ClickHouseBotReviewSourceOptions) {
    this.#client = createExternalHttpClient({
      provider: 'analytics-clickhouse',
      baseUrl: o.baseUrl,
      timeoutCapMs: o.timeoutCapMs ?? 5_000,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    const user = o.user ?? CLICKHOUSE_READER;
    this.#authorization = `Basic ${Buffer.from(`${user}:${o.password ?? ''}`, 'utf8').toString('base64')}`;
  }

  async population(q: { eventId: string; reviewKind: ReviewKind; bundle?: ReviewBatch }): Promise<number> {
    const bundle = bundleOf(q.reviewKind, q.bundle);
    const sql = `SELECT count() AS n FROM bot_sample_review WHERE event_id = {event_id:UUID}${bundle ? ' AND review_batch = {bundle:String}' : ''} FORMAT JSON`;
    const rows = await this.#query(sql, {
      event_id: q.eventId.toLowerCase(),
      ...(bundle ? { bundle } : {}),
    });
    return num(rows[0]?.n) || 0;
  }

  async candidates(q: { eventId: string; reviewKind: ReviewKind; bundle?: ReviewBatch; limit: number }): Promise<readonly BotReviewCandidate[]> {
    const bundle = bundleOf(q.reviewKind, q.bundle);
    const limit = Math.max(0, Math.min(10_000, Math.trunc(q.limit)));
    if (limit === 0) return [];
    const sql = `SELECT session_ref, verdict_event_key, pid, review_batch, applied_verdict,
        risk_band, behavior_summary_band, timeline, evidence_available,
        toUnixTimestamp64Milli(occurred_at) AS occurred_at_ms,
        toUnixTimestamp64Milli(open_at) AS open_at_ms
      FROM bot_sample_review
      WHERE event_id = {event_id:UUID}${bundle ? ' AND review_batch = {bundle:String}' : ''}
      ORDER BY rand()
      LIMIT {limit:UInt32}
      FORMAT JSON`;
    const rows = await this.#query(sql, {
      event_id: q.eventId.toLowerCase(),
      ...(bundle ? { bundle } : {}),
      limit,
    });
    return rows.flatMap((row): BotReviewCandidate[] => {
      const reviewBatch = row.review_batch === 'SHADOW_CHALLENGED' ? 'SHADOW_CHALLENGED' : row.review_batch === 'PASSED' ? 'PASSED' : undefined;
      const appliedVerdict = row.applied_verdict === 'CHALLENGE' ? 'CHALLENGE' : row.applied_verdict === 'ALLOW' ? 'ALLOW' : undefined;
      const sessionRef = text(row.session_ref);
      const verdictEventKey = text(row.verdict_event_key);
      const openAtMs = num(row.open_at_ms);
      if (!reviewBatch || !appliedVerdict || sessionRef === '' || verdictEventKey === '' || !Number.isFinite(openAtMs) || openAtMs <= 0) return [];
      return [
        {
          sessionRef,
          verdictEventKey,
          pid: text(row.pid),
          reviewBatch,
          appliedVerdict,
          riskBand: typeof row.risk_band === 'string' && row.risk_band !== '' ? row.risk_band : null,
          behaviorSummaryBand: typeof row.behavior_summary_band === 'string' && row.behavior_summary_band !== '' ? row.behavior_summary_band : null,
          timeline: timelineOf(row.timeline),
          evidenceAvailable: evidenceOf(row.evidence_available),
          occurredAtMs: num(row.occurred_at_ms),
          openAtMs,
        },
      ];
    });
  }

  async pidOf(q: { eventId: string; verdictEventKey: string }): Promise<string | undefined> {
    const sql = `SELECT pid FROM bot_sample_review
      WHERE event_id = {event_id:UUID} AND verdict_event_key = {verdict_event_key:UUID}
      LIMIT 1 FORMAT JSON`;
    const rows = await this.#query(sql, {
      event_id: q.eventId.toLowerCase(),
      verdict_event_key: q.verdictEventKey.toLowerCase(),
    });
    const pid = text(rows[0]?.pid);
    return pid === '' ? undefined : pid;
  }

  async #query(sql: string, params: Readonly<Record<string, string | number>>): Promise<Record<string, unknown>[]> {
    const query: Record<string, string> = {};
    for (const [name, value] of Object.entries(params)) query[`param_${name}`] = String(value);
    try {
      const res = await this.#client.request({
        method: 'POST',
        path: '/',
        query,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          ...(this.#authorization ? { authorization: this.#authorization } : {}),
        },
        body: sql,
      });
      if (!res.ok) throw new BotReviewSourceFailure(`clickhouse ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      return rowsOf(body.data);
    } catch (e) {
      if (e instanceof BotReviewSourceFailure) throw e;
      throw new BotReviewSourceFailure('clickhouse request failed');
    }
  }
}

/** PASSED_SAMPLE은 통과 세션 묶음만 읽는다. HUMAN_BASELINE은 두 묶음을 부르는 쪽이 나눠 묻는다 */
function bundleOf(reviewKind: ReviewKind, bundle: ReviewBatch | undefined): ReviewBatch | undefined {
  if (bundle !== undefined) return bundle;
  return reviewKind === 'PASSED_SAMPLE' ? 'PASSED' : undefined;
}

function timelineOf(raw: unknown): readonly SampleTimelineStep[] {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SampleTimelineStep[] => {
    if (typeof item !== 'object' || item === null) return [];
    const step = (item as Record<string, unknown>).step;
    const at = (item as Record<string, unknown>).atMs ?? (item as Record<string, unknown>).at_ms ?? (item as Record<string, unknown>).at;
    if (typeof step !== 'string' || !(TIMELINE_STEPS as readonly string[]).includes(step)) return [];
    const atMs = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : Number.NaN;
    return Number.isFinite(atMs) ? [{ step: step as SampleTimelineStep['step'], atMs }] : [];
  });
}

function evidenceOf(raw: unknown): readonly string[] {
  return Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string' && (SAMPLE_EVIDENCE_KINDS as readonly string[]).includes(v)).slice(0, 4)
    : [];
}
