// GAT-360 관제 입장 탭의 실제 값 해석(F-05-8). 서버가 준 값만 옮기고 모르는 칸은 버린다.
// - 입장 시작·마감: ops-svc GET /v1/ops/events/{eventId}/readiness의 stage·schedule.
// - 스캐너 신선도: GET /v1/ops/alerts의 sourceKind `scanner-freshness:<deviceId>`(SEV2, ticket-svc O-T20).
// - 중복 입장 급증: 같은 목록의 sourceKind `duplicate-surge:<eventId>` 또는 detail.kind DUPLICATE_SURGE(SEV3).
// 값이 없거나 늦으면 화면이 '세지 못함'/'늦음'과 까닭을 보인다.
export interface EntrySchedule {
  stage: string | null;
  entryOpensAt: string | null;
  entryClosedAt: string | null;
  unavailable?: string;
}

export type EntryStage = 'before' | 'open' | 'closed' | 'unknown';

export interface EntryAlert {
  kind: 'SCANNER_STALE' | 'DUPLICATE_SURGE';
  severity: string;
  title: string;
  startsAt: string | null;
  deviceName: string | null;
  gateZone: string | null;
  ageMs: number | null;
  thresholdMs: number | null;
  count: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isoOf = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** readiness 응답 → 입장 일정. 값이 없으면 unavailable에 그 까닭을 남긴다(화면은 '세지 못함') */
export function entryScheduleOf(raw: unknown): EntrySchedule {
  if (!isRecord(raw)) return { stage: null, entryOpensAt: null, entryClosedAt: null, unavailable: '회차 단계를 읽지 못했습니다' };
  const stage = textOf(raw.stage);
  const schedule = isRecord(raw.schedule) ? raw.schedule : undefined;
  const entryOpensAt = schedule ? isoOf(schedule.entryOpensAt) : null;
  const entryClosedAt = schedule ? isoOf(schedule.entryClosedAt) : null;
  if (!stage) return { stage: null, entryOpensAt, entryClosedAt, unavailable: '회차 단계를 읽지 못했습니다' };
  if (!schedule || !entryOpensAt) return { stage, entryOpensAt, entryClosedAt, unavailable: '입장 시작 시각을 읽지 못했습니다' };
  return { stage, entryOpensAt, entryClosedAt };
}

/** 입장 창 안인가. 시작과 같으면 열림, 마감과 같으면 닫힘(경계 포함) */
export function entryStageOf(s: EntrySchedule, nowMs: number): EntryStage {
  if (!s.entryOpensAt) return 'unknown';
  const opens = Date.parse(s.entryOpensAt);
  if (!Number.isFinite(opens)) return 'unknown';
  if (nowMs < opens) return 'before';
  if (s.entryClosedAt) {
    const closed = Date.parse(s.entryClosedAt);
    if (Number.isFinite(closed) && nowMs >= closed) return 'closed';
  }
  return 'open';
}

/** 경보 목록 응답 → 입장 탭이 보는 두 종류만. 풀린 경보는 뺀다 */
export function entryAlertsOf(raw: unknown): EntryAlert[] {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return [];
  const out: EntryAlert[] = [];
  for (const item of raw.items) {
    if (!isRecord(item) || item.status === 'resolved') continue;
    const sourceKind = textOf(item.sourceKind) ?? '';
    const detail = isRecord(item.detail) ? item.detail : undefined;
    const kind = sourceKind.startsWith('scanner-freshness:')
      ? 'SCANNER_STALE'
      : sourceKind.startsWith('duplicate-surge:') || detail?.kind === 'DUPLICATE_SURGE'
        ? 'DUPLICATE_SURGE'
        : null;
    if (kind === null) continue;
    out.push({
      kind,
      severity: textOf(item.severity) ?? '',
      title: textOf(item.title) ?? '',
      startsAt: isoOf(item.startsAt),
      deviceName: textOf(detail?.deviceName),
      gateZone: textOf(detail?.gateZone),
      ageMs: numOf(detail?.ageMs),
      thresholdMs: numOf(detail?.thresholdMs ?? detail?.threshold),
      count: numOf(detail?.count),
    });
  }
  return out;
}

/** 'n분 m초 전'과 기준 초과 표시. 값이 없으면 '세지 못함' */
export function staleText(ageMs: number | undefined, thresholdMs = 120_000): { late: boolean; text: string } {
  if (ageMs === undefined || !Number.isFinite(ageMs) || ageMs < 0) return { late: false, text: '세지 못함' };
  const minutes = Math.floor(ageMs / 60_000);
  const seconds = Math.floor((ageMs % 60_000) / 1_000);
  const late = ageMs > thresholdMs;
  const base = `${minutes}분 ${seconds}초 전`;
  return late ? { late: true, text: `${base} · 기준 ${Math.floor(thresholdMs / 60_000)}분 초과` } : { late: false, text: base };
}
