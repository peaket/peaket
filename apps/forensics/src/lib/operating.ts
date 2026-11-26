// F-04-16 운영 빌드의 원천 해석·배지·격리 상태. 정본: docs/features/forensic-replay.md §2.1·§2.2·§4.2·§6.8,
// docs/design/d5 §7.17, docs/frontend.md §5.14.1·§5.19. 운영 빌드는 연 길(?case=·?export=)만 원천을 정하고 ?source=를 읽지 않는다.
import type { EventRow } from './forensics/events.ts';
import type { SourceSpec } from './source-spec.ts';
import { investigationSpec } from './source-specs/investigation.ts';
import { researchSpec } from './source-specs/research.ts';

export type BuildMode = 'demo' | 'operating';
export type OpenedSource = 'INVESTIGATION' | 'RESEARCH';

export interface OpenTarget {
  source: OpenedSource;
  sourceLabel: 'investigation' | 'research';
  eventId: string;
  caseId: string | null;
  exportId: string | null;
}

export type OpenResult =
  | { ok: true; target: OpenTarget }
  | { ok: false; code: 'open-path' | 'both-branches' | 'event-id' | 'case-id' | 'export-id'; message: string };

export interface ReplayRowView {
  sessionNo: number;
  kind: number;
  seat: number;
  section: number;
  result: number;
  member: boolean;
  postSeat: boolean;
  atMs: number;
}

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function param(search: string | URLSearchParams, key: string): string | null {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  return p.get(key);
}

export function resolveOpen(search: string | URLSearchParams): OpenResult {
  const eventId = param(search, 'event');
  const caseId = param(search, 'case');
  const exportId = param(search, 'export');
  if (caseId !== null && exportId !== null) {
    return { ok: false, code: 'both-branches', message: '조사 원천과 연구 원천은 한 화면에서 열 수 없습니다' };
  }
  if (caseId === null && exportId === null) {
    return { ok: false, code: 'open-path', message: '사건 작업대나 연구 메뉴에서 연 주소로만 열 수 있습니다' };
  }
  if (eventId === null || !EVENT_ID.test(eventId)) {
    return { ok: false, code: 'event-id', message: '회차 ID가 없거나 꼴에 맞지 않습니다' };
  }
  if (caseId !== null) {
    if (!UUID.test(caseId)) return { ok: false, code: 'case-id', message: '사건 ID는 계약의 UUID 꼴이어야 합니다' };
    return { ok: true, target: { source: 'INVESTIGATION', sourceLabel: 'investigation', eventId, caseId, exportId: null } };
  }
  if (!UUID.test(exportId!)) return { ok: false, code: 'export-id', message: '내보내기 ID는 계약의 UUID 꼴이어야 합니다' };
  return { ok: true, target: { source: 'RESEARCH', sourceLabel: 'research', eventId, caseId: null, exportId } };
}

export function operatingBadge(t: OpenTarget): '조사' | '연구' {
  return t.source === 'INVESTIGATION' ? '조사' : '연구';
}

export function operatingSpec(t: OpenTarget): SourceSpec {
  const event = `회차 ${t.eventId}`;
  if (t.source === 'RESEARCH') return { ...researchSpec, event };
  return { ...investigationSpec, event, caseLabel: `사건 ${t.caseId}`, consolePath: `/investigations/${t.caseId}` };
}

export function consolePathFor(t: OpenTarget): string {
  return t.source === 'INVESTIGATION' ? `/investigations/${t.caseId}` : '/dashboard';
}

export function isolationLabel(crossOriginIsolated: boolean): '공유 메모리 켜짐' | '복사 방식' {
  return crossOriginIsolated ? '공유 메모리 켜짐' : '복사 방식';
}

export function replayRowView(row: EventRow, _t: OpenTarget): ReplayRowView {
  return {
    sessionNo: row.session ?? 0,
    kind: row.kind,
    seat: row.seat ?? 0xffffffff,
    section: row.section ?? 0,
    result: row.result ?? 0,
    member: (row.member ?? 0) !== 0,
    postSeat: (row.post_seat ?? 0) !== 0,
    atMs: row.t_ms,
  };
}
