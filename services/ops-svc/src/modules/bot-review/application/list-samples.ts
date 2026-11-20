// 표본 카드 목록(GET /v1/ops/events/{eventId}/bot-review-samples, SCR-067).
// 기본은 아직 기록하지 않은 PENDING만 준다(status=RECORDED면 기록한 것만). 커서는 서버가 섞은 순서(ordinal)를 잇는다.
// HUMAN_BASELINE 카드는 위험 점수 범주·행동 요약 범주를 null로 준다(d5 §7.15).
import {
  DEFAULT_SAMPLE_LIMIT,
  isUuid,
  MAX_SAMPLE_LIMIT,
  notFound,
  retentionEnded,
  sampleView,
  SAMPLE_STATUSES,
  type OpsBotReviewSamplePage,
  type ReviewKind,
  type SampleStatus,
} from '../domain/bot-review.js';
import type { BotReviewStore } from '../domain/ports.js';

export interface ListSamplesInput {
  readonly eventId: string;
  readonly reviewKind: ReviewKind;
  readonly status?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** 목록 질의가 틀렸다(400). 받는 층이 Problem으로 바꾼다 */
export class BotReviewBadQuery extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotReviewBadQuery';
  }
}

export class ListBotReviewSamples {
  constructor(
    private readonly store: BotReviewStore,
    private readonly now: () => number,
  ) {}

  async run(input: ListSamplesInput): Promise<OpsBotReviewSamplePage> {
    if (!isUuid(input.eventId)) throw notFound();
    const status = statusOf(input.status);
    const limit = limitOf(input.limit);
    const afterOrdinal = cursorOf(input.cursor);
    const batch = await this.store.findBatch(input.eventId.toLowerCase(), input.reviewKind);
    // 배치가 아직 없으면 빈 페이지다. 진행 GET이 404로 '표본 없음'을 알린다
    if (!batch) return { items: [], nextCursor: null };
    if (this.now() > batch.retentionUntilMs) throw retentionEnded();
    const page = await this.store.listSamples({
      batchId: batch.batchId,
      status,
      ...(afterOrdinal !== undefined ? { afterOrdinal } : {}),
      limit,
    });
    return {
      items: page.items.map((s) => sampleView(s, input.reviewKind)),
      nextCursor: page.nextOrdinal === null ? null : encodeCursor(page.nextOrdinal),
    };
  }
}

function statusOf(raw: string | undefined): SampleStatus {
  if (raw === undefined || raw === '') return 'PENDING';
  if ((SAMPLE_STATUSES as readonly string[]).includes(raw)) return raw as SampleStatus;
  throw new BotReviewBadQuery('status는 PENDING·RECORDED 가운데 하나여야 합니다');
}

function limitOf(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_SAMPLE_LIMIT;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_SAMPLE_LIMIT) throw new BotReviewBadQuery('limit은 1~100이어야 합니다');
  return raw;
}

function cursorOf(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    if (!/^\d+$/.test(text)) throw new Error('cursor');
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('cursor');
    return value;
  } catch {
    throw new BotReviewBadQuery('커서가 올바르지 않습니다');
  }
}

function encodeCursor(ordinal: number): string {
  return Buffer.from(String(ordinal), 'utf8').toString('base64url');
}
