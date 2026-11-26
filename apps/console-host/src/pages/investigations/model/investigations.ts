// F-04-15 SCR-070 부정 거래 조사 사건 목록의 순수 모델(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.3~§6.7.8, docs/design/d3-screens.md SCR-070.
import type { ConsoleRole } from '@peaket/ds/ConsoleShell';

export type CaseFilter = 'ALL' | 'INVESTIGATING' | 'APPEAL_PENDING' | 'DECISION_PENDING' | 'OBJECTED' | 'ACTIONED' | 'CLEARED';

export interface InvestigationsOverview {
  eventId: string;
  snapshot: { version: number; frozenAt: string; invHash: string; late: boolean } | null;
  latestRun: { status: 'RUNNING' | 'DONE' | 'FAILED'; startedAt: string | null; finishedAt: string | null; clusterCount: number | null; autoRetriesLeft: number } | null;
  rerunAllowed: boolean;
  summary: { clusterCount: number; caseCount: number; byStatus: Record<string, number>; actionedTicketCount: number; restrictedAccountCount: number; appealAcceptedRatio: number | null };
  cancelDeadlineAt: string | null;
  sourceExpiresAt: string | null;
}

export interface ClusterRow {
  clusterId: string;
  generation: number;
  scoreBand: 'HIGH' | 'MEDIUM' | 'LOW';
  accountCount: number;
  purchaseCount: number;
  limitPerPerson: number;
  sharedAttributes: readonly string[];
  signals: readonly string[];
  caseId: string | null;
}

export interface CaseRow {
  caseId: string;
  status: string;
  reasonCategory: string;
  accountCount: number;
  ticketCount: number;
  assigneeId: string;
  appealDueAt: string | null;
  cancelDeadlineAt: string;
  transferLocked: boolean;
}

export interface MaskRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExternalPostFormInput {
  eventId: string;
  url: string;
  capturedAt: string;
  postedAt?: string;
  source: 'REPORT' | 'MANUAL';
  reportCaseId?: string;
  claimedSeats?: string;
  capture: { name: string; type: string; sizeBytes: number; bytes?: Uint8Array };
  maskRegions?: readonly MaskRegion[];
  checks: readonly boolean[];
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null;

export function mapOverview(raw: Record<string, unknown>, eventId: string): InvestigationsOverview {
  const s = isObj(raw.snapshot) ? raw.snapshot : null;
  const r = isObj(raw.latestRun) ? raw.latestRun : null;
  const sum = isObj(raw.summary) ? raw.summary : {};
  return {
    eventId: str(raw.eventId, eventId),
    snapshot: s ? { version: num(s.version), frozenAt: str(s.frozenAt), invHash: str(s.invHash), late: s.late === true } : null,
    latestRun: r ? { status: r.status === 'DONE' || r.status === 'FAILED' ? r.status : 'RUNNING', startedAt: typeof r.startedAt === 'string' ? r.startedAt : null, finishedAt: typeof r.finishedAt === 'string' ? r.finishedAt : null, clusterCount: typeof r.clusterCount === 'number' ? r.clusterCount : null, autoRetriesLeft: num(r.autoRetriesLeft) } : null,
    rerunAllowed: raw.rerunAllowed === true,
    summary: {
      clusterCount: num(sum.clusterCount),
      caseCount: num(sum.caseCount),
      byStatus: isObj(sum.byStatus) ? Object.fromEntries(Object.entries(sum.byStatus).map(([k, v]) => [k, num(v)])) : {},
      actionedTicketCount: num(sum.actionedTicketCount),
      restrictedAccountCount: num(sum.restrictedAccountCount),
      appealAcceptedRatio: typeof sum.appealAcceptedRatio === 'number' ? sum.appealAcceptedRatio : null,
    },
    cancelDeadlineAt: typeof raw.cancelDeadlineAt === 'string' ? raw.cancelDeadlineAt : null,
    sourceExpiresAt: typeof raw.sourceExpiresAt === 'string' ? raw.sourceExpiresAt : null,
  };
}

export function mapCluster(raw: Record<string, unknown>): ClusterRow {
  return {
    clusterId: str(raw.clusterId),
    generation: num(raw.generation, 1),
    scoreBand: raw.scoreBand === 'MEDIUM' || raw.scoreBand === 'LOW' ? raw.scoreBand : 'HIGH',
    accountCount: num(raw.accountCount, 1),
    purchaseCount: num(raw.purchaseCount),
    limitPerPerson: num(raw.limitPerPerson, 1),
    sharedAttributes: arr(raw.sharedAttributes),
    signals: arr(raw.signals),
    caseId: typeof raw.caseId === 'string' ? raw.caseId : null,
  };
}

export function mapCase(raw: Record<string, unknown>): CaseRow {
  return {
    caseId: str(raw.caseId),
    status: str(raw.status, 'INVESTIGATING'),
    reasonCategory: str(raw.reasonCategory),
    accountCount: num(raw.accountCount),
    ticketCount: num(raw.ticketCount),
    assigneeId: str(raw.assigneeId),
    appealDueAt: typeof raw.appealDueAt === 'string' ? raw.appealDueAt : null,
    cancelDeadlineAt: str(raw.cancelDeadlineAt),
    transferLocked: raw.transferLocked === true,
  };
}

export function filterCases(rows: readonly CaseRow[], filter: CaseFilter): CaseRow[] {
  return filter === 'ALL' ? [...rows] : rows.filter((r) => r.status === filter);
}

export function caseFilterLabel(filter: CaseFilter): string {
  return { ALL: '전체', INVESTIGATING: '조사 중', APPEAL_PENDING: '소명 대기', DECISION_PENDING: '결정 대기', OBJECTED: '이의 접수', ACTIONED: '조치됨', CLEARED: '정상 종료' }[filter];
}

export function canRerun(o: InvestigationsOverview): boolean {
  return o.rerunAllowed && o.latestRun?.status === 'FAILED' && o.latestRun.autoRetriesLeft === 0;
}

export function candidateRetryText(left: number): string {
  return `자동으로 ${left}번 더 다시 시도합니다. 끝나면 [다시 돌리기]가 보입니다`;
}

export function createCaseBody(clusterId: string, reasonCategory: string): { clusterId: string; reasonCategory: string } {
  return { clusterId: clusterId.trim(), reasonCategory: reasonCategory.trim() };
}

export function postUrlDisplay(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '주소 형식이 아닙니다';
    return `${u.host}${u.pathname}${u.search}`;
  } catch {
    return '주소 형식이 아닙니다';
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function maskRegionOfDrag(start: { x: number; y: number }, end: { x: number; y: number }, size: { width: number; height: number }): MaskRegion | null {
  if (size.width <= 0 || size.height <= 0) return null;
  const x1 = clamp(Math.min(start.x, end.x) / size.width, 0, 1);
  const x2 = clamp(Math.max(start.x, end.x) / size.width, 0, 1);
  const y1 = clamp(Math.min(start.y, end.y) / size.height, 0, 1);
  const y2 = clamp(Math.max(start.y, end.y) / size.height, 0, 1);
  if (x2 - x1 === 0 || y2 - y1 === 0) return null;
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  return { x: round(x1), y: round(y1), w: round(x2 - x1), h: round(y2 - y1) };
}

export function maskRegionsValid(regions: readonly MaskRegion[]): boolean {
  if (regions.length > 20) return false;
  return regions.every((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h) && r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 1 && r.y + r.h <= 1);
}

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const starts = (b: Uint8Array | undefined, sig: readonly number[]) => b !== undefined && b.length >= sig.length && sig.every((v, i) => b[i] === v);

function captureIssue(c: ExternalPostFormInput['capture']): string | undefined {
  const lower = c.name.toLowerCase();
  const png = lower.endsWith('.png') || c.type === 'image/png';
  const jpg = lower.endsWith('.jpg') || lower.endsWith('.jpeg') || c.type === 'image/jpeg';
  const pdf = lower.endsWith('.pdf') || c.type === 'application/pdf';
  if (!png && !jpg && !pdf) return 'PNG·JPEG·PDF 파일만 올릴 수 있습니다';
  if (png && !starts(c.bytes, PNG)) return 'PNG·JPEG·PDF 파일만 올릴 수 있습니다';
  if (jpg && !starts(c.bytes, JPEG)) return 'PNG·JPEG·PDF 파일만 올릴 수 있습니다';
  if (pdf && !starts(c.bytes, PDF)) return 'PNG·JPEG·PDF 파일만 올릴 수 있습니다';
  const size = typeof c.sizeBytes === 'number' ? c.sizeBytes : c.bytes?.length ?? 0;
  if (size > 10 * 1024 * 1024) return '캡처는 10MB까지 올릴 수 있습니다';
  return undefined;
}

export function externalPostIssues(input: ExternalPostFormInput): string[] {
  const issues: string[] = [];
  if (!input.checks.every(Boolean)) issues.push('등록 전 확인 칸 셋을 모두 체크해 주세요');
  let url: URL | undefined;
  try {
    url = new URL(input.url);
  } catch {
    issues.push('http·https 주소만 받습니다');
  }
  if (url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') issues.push('http·https 주소만 받습니다');
    if (input.url.length > 2048) issues.push('주소는 2,048자까지 쓸 수 있습니다');
    if (url.username || url.password) issues.push('사용자 정보가 든 주소는 받지 않습니다');
  }
  if (!input.capturedAt) issues.push('수집 시각을 적어 주세요');
  if (input.source === 'REPORT' && !input.reportCaseId) issues.push('신고 출처는 CS 처리함 건 번호가 필요합니다');
  const cap = captureIssue(input.capture);
  if (cap) issues.push(cap);
  if (input.maskRegions && !maskRegionsValid(input.maskRegions)) issues.push('가릴 자리는 20개까지, 캡처 안의 0~1 비율이어야 합니다');
  return issues;
}

export function externalPostFormData(input: ExternalPostFormInput): FormData {
  const f = new FormData();
  f.set('eventId', input.eventId);
  f.set('url', input.url);
  f.set('capturedAt', input.capturedAt);
  if (input.postedAt) f.set('postedAt', input.postedAt);
  f.set('source', input.source);
  if (input.reportCaseId) f.set('reportCaseId', input.reportCaseId);
  if (input.claimedSeats) f.set('claimedSeats', input.claimedSeats);
  if (input.maskRegions) f.set('maskRegions', JSON.stringify(input.maskRegions));
  f.set('capture', new Blob([(input.capture.bytes ?? new Uint8Array()) as unknown as BlobPart], { type: input.capture.type }), input.capture.name);
  return f;
}

export function externalPostSummary(p: Record<string, unknown>): { urlText: string; sourceLabel: string; scanLabel: string; viewAvailable: boolean; matchedTicketCount: number; capturedAt: string; claimedSeats: string } {
  const status = str(p.scanStatus, 'PENDING');
  const view = p.viewAvailable === true;
  return {
    urlText: postUrlDisplay(str(p.url)),
    sourceLabel: p.source === 'REPORT' ? '신고' : '직접 찾음',
    scanLabel: status === 'CLEAN' ? (view ? '검사 · 위협 없음' : '보기용 사본 없음(PDF)') : status === 'THREAT' ? '검사 · 위협' : '검사 중',
    viewAvailable: view,
    matchedTicketCount: num(p.matchedTicketCount),
    capturedAt: str(p.capturedAt),
    claimedSeats: str(p.claimedSeats),
  };
}

export function investigationsProblem(e: unknown): { kind: 'forbidden' | 'config' | 'expired' | 'conflict' | 'error'; message: string; reload: boolean; code?: string } {
  const o = isObj(e) ? e : {};
  const status = typeof o.status === 'number' ? o.status : 0;
  const code = typeof o.code === 'string' ? o.code : typeof o.type === 'string' ? o.type : undefined;
  if (status === 403) return { kind: 'forbidden', message: '조사 화면을 볼 권한이 없습니다(부정 거래 조사관 지정 필요)', reload: false, ...(code ? { code } : {}) };
  if (status === 410) return { kind: 'expired', message: '이 회차의 조사 원천이 만료되었습니다', reload: false, ...(code ? { code } : {}) };
  if (status === 409) return { kind: 'conflict', message: code === 'fraud-case-exists' ? '이 묶음에는 이미 사건이 있습니다' : '다른 조사관이 먼저 고쳤습니다', reload: true, ...(code ? { code } : {}) };
  if (status === 503) return { kind: 'error', message: '잠시 뒤 다시 시도해 주세요', reload: true, ...(code ? { code } : {}) };
  return { kind: 'error', message: '조사 정보를 불러오지 못했습니다', reload: true, ...(code ? { code } : {}) };
}

export function isInvestigator(role: string, designations: readonly string[]): boolean {
  return (role === 'commander' || role === 'cs_lead') && designations.includes('FRAUD_INVESTIGATOR');
}

export const CONSOLE_ROLE = (r: string): ConsoleRole => r as ConsoleRole;
