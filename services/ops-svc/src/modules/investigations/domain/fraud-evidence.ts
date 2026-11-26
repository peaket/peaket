// F-04-14 증거 묶음·외부 게시물·내보내기 도메인(동결 로컬, LCH-290·LCH-300).
// 정본: docs/features/forensic-replay.md §6.7.6~§6.7.8, docs/data.md external_post·evidence_bundle·
// evidence_custody_log·evidence_export, docs/security/secrets-and-keys.md '부정 예매 조사의 해시 판'.
// 순수 함수만 둔다: 시계·난수를 직접 쓰지 않고 받은 값만 쓴다.
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import sharp from 'sharp';
import type { FraudCaseRecord, FraudClusterRecord } from './investigation.js';
import { OBJECTION_WINDOW_MS } from './fraud-action.js';
import { problem } from './investigation.js';

export type EvidenceBundleStatus = 'BUILDING' | 'SEALED' | 'DISPOSED';
export type EvidenceHoldReason = 'OBJECTION' | 'DISPUTE' | 'INVESTIGATION';
export type EvidenceExportKind = 'AUTHORITY' | 'PROMOTER' | 'COMPLAINT';
export type CustodyAction = 'CREATED' | 'SEALED' | 'VIEWED' | 'EXPORTED' | 'HOLD_CHANGED' | 'HOLD_END_REQUESTED' | 'HOLD_ENDED' | 'DISPOSED';
export type ExternalPostSource = 'REPORT' | 'MANUAL';
export type ExternalPostScanStatus = 'PENDING' | 'CLEAN' | 'THREAT';

export const EVIDENCE_FORMAT = 'PEAKET-evidence-v1';
export const EVIDENCE_RETENTION_AFTER_HOLD_MS = 30 * 86_400_000;
export const EVIDENCE_OBJECTION_MAX_MS = 365 * 86_400_000;
export const EVIDENCE_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_CAPTURE_MAX_SIDE = 20_000;
export const EVIDENCE_CAPTURE_MAX_PIXELS = 40_000_000;
export const EVIDENCE_MASK_MAX_REGIONS = 20;
export const EXPORT_DAILY_LIMIT = 20;
export const EXPORT_VOLUME_CHECK = 5;
export const BULK_EXPORT_ROWS = 10_000;
export const COMPLAINT_STATEMENT = '기록을 보존하고 있으며 영장이나 공연법 제4조의3 요청을 받으면 정해진 절차로 냅니다';

export interface EvidenceFileRecord {
  name: string;
  sha256: string;
  sizeBytes: number;
}

export interface EvidenceBundleRecord {
  bundleId: string;
  caseId: string;
  eventId: string;
  status: EvidenceBundleStatus;
  snapshotHash: string;
  manifestSha256: string | null;
  queries: Record<string, unknown>;
  s3Prefix: string;
  holdReason: EvidenceHoldReason;
  holdEndRequestedBy: string | null;
  holdEndRequestedAtMs: number | null;
  holdEndBasis: string | null;
  holdEndConfirmedBy: string | null;
  holdEndedAtMs: number | null;
  createdBy: string | null;
  createdAtMs: number;
  files: EvidenceFileRecord[];
}

export interface CustodyRecord {
  bundleId?: string;
  seq: number;
  action: CustodyAction;
  actorId: string | null;
  reason: string | null;
  exportKind: EvidenceExportKind | null;
  dataRequestId: string | null;
  prevHash: string | null;
  rowHash: string;
  occurredAtMs: number;
}

export interface EvidenceRow {
  table: string;
  accountId: string;
  tsMs: number;
  values: Record<string, unknown>;
}

export interface DataRequestScope {
  dataRequestId: string;
  eventId: string;
  status: 'APPROVED';
  warrant: boolean;
  legalBasis: 'PERFORMANCE_ACT' | 'WARRANT' | 'OTHER';
  items: readonly ('PURCHASE' | 'ACCESS_LOG' | 'POST')[];
  fromMs: number;
  toMs: number;
  accountIds?: readonly string[];
}

export interface ExternalPostRecord {
  postId: string;
  eventId: string;
  url: string;
  site: string;
  capturedAtMs: number;
  postedAtMs: number | null;
  source: ExternalPostSource;
  reportCaseId: string | null;
  claimedSeats: string | null;
  maskRegions: readonly MaskRegion[];
  captureKey: string;
  captureSha256: string;
  scanStatus: ExternalPostScanStatus;
  matchedTicketIds: readonly string[];
  registeredBy: string;
  createdAtMs: number;
}

export interface EvidenceExportRecord {
  exportId: string;
  bundleId: string;
  kind: EvidenceExportKind;
  dataRequestId: string | null;
  documentId: string | null;
  sha256: string;
  rows: number;
  reason: string;
  actorId: string;
  createdAtMs: number;
}

export interface MaskRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PromoterCase {
  caseId: string;
  reasonCategory: string;
  status: string;
  cancelActionCount?: number;
  restrictActionCount?: number;
  cancelledTicketCount?: number;
  resoldAtFaceValueCount?: number;
  appealAcceptedCount?: number;
  appealJudgedCount?: number;
  events?: readonly { kind: string; detail?: Record<string, unknown> | null }[];
  members?: readonly { objectionResult?: string; appealResult?: string }[];
}

const DAY = 86_400_000;
const hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const utf8 = (s: string): Uint8Array => Buffer.from(s, 'utf8');

export function sha256Hex(bytes: Uint8Array | string): string {
  return hex(typeof bytes === 'string' ? utf8(bytes) : bytes);
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value) ?? '';
}

export function manifestOf(o: {
  caseId: string;
  eventId: string;
  createdAtMs: number;
  files: readonly { name: string; bytes: Uint8Array }[];
}): { bytes: Uint8Array; manifestSha256: string; files: EvidenceFileRecord[] } {
  const files = [...o.files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => ({ name: f.name, sha256: sha256Hex(f.bytes), sizeBytes: f.bytes.byteLength }));
  const body = canonicalJson({
    format: EVIDENCE_FORMAT,
    algorithm: 'sha256',
    caseId: o.caseId,
    eventId: o.eventId,
    createdAt: new Date(o.createdAtMs).toISOString(),
    files,
  });
  const bytes = utf8(body);
  return { bytes, manifestSha256: sha256Hex(bytes), files };
}

export function custodyRowHash(o: Omit<CustodyRecord, 'rowHash' | 'prevHash'> & { prevHash: string | null }): string {
  const body = canonicalJson({
    bundleId: o.bundleId,
    seq: o.seq,
    action: o.action,
    actorId: o.actorId,
    reason: o.reason,
    exportKind: o.exportKind,
    dataRequestId: o.dataRequestId,
    occurredAt: new Date(o.occurredAtMs).toISOString(),
  });
  return sha256Hex(`${o.prevHash ?? ''}${body}`);
}

export function verifyCustodyChain(rows: readonly CustodyRecord[]): { ok: boolean; brokenSeq: number | null } {
  let prev: string | null = null;
  for (const row of rows) {
    const expected = custodyRowHash({
      ...(row.bundleId ? { bundleId: row.bundleId } : {}),
      seq: row.seq,
      action: row.action,
      actorId: row.actorId,
      reason: row.reason,
      exportKind: row.exportKind,
      dataRequestId: row.dataRequestId,
      occurredAtMs: row.occurredAtMs,
      prevHash: prev,
    });
    if (row.prevHash !== prev || row.rowHash !== expected) return { ok: false, brokenSeq: row.seq };
    prev = row.rowHash;
  }
  return { ok: true, brokenSeq: null };
}

export function disposeAfterMs(o: { createdAtMs: number; holdReason: EvidenceHoldReason; holdEndedAtMs: number | null }): number {
  if (o.holdReason === 'OBJECTION') return o.createdAtMs + EVIDENCE_OBJECTION_MAX_MS;
  if (o.holdEndedAtMs === null) throw problem('hold-end-required', 409, '보존 끝을 확인하기 전에는 파기 시각을 정할 수 없습니다');
  return o.holdEndedAtMs + EVIDENCE_RETENTION_AFTER_HOLD_MS;
}

export function holdChangeGuard(o: { bundle: EvidenceBundleRecord; holdReason: EvidenceHoldReason; basis: string }): void {
  if (o.bundle.status === 'DISPOSED') throw problem('evidence-disposed', 410, '파기된 증거 묶음입니다');
  if (o.holdReason !== 'DISPUTE' && o.holdReason !== 'INVESTIGATION') throw problem('invalid-body', 400, '보존 이유는 DISPUTE·INVESTIGATION만 고를 수 있습니다');
  if (o.basis.trim().length < 5 || o.basis.length > 500) throw problem('invalid-body', 400, '근거는 5~500자입니다');
  if (o.bundle.holdReason !== 'OBJECTION') throw problem('precondition-failed', 409, '이미 보존 이유를 바꿨습니다');
}

export function holdEndRequestGuard(o: { bundle: EvidenceBundleRecord; requesterId: string; basis: string }): void {
  if (o.bundle.status === 'DISPOSED') throw problem('evidence-disposed', 410, '파기된 증거 묶음입니다');
  if (o.bundle.holdReason === 'OBJECTION') throw problem('hold-reason-invalid', 422, '이의 기간은 시스템이 끝냅니다');
  if (o.bundle.holdEndRequestedBy !== null) throw problem('hold-end-pending', 409, '보존 끝 확인을 기다리는 요청이 있습니다');
  if (o.basis.trim().length < 5 || o.basis.length > 500) throw problem('invalid-body', 400, '근거는 5~500자입니다');
}

export function holdEndConfirmGuard(o: { bundle: EvidenceBundleRecord; confirmerId: string; role: string }): void {
  if (o.bundle.status === 'DISPOSED') throw problem('evidence-disposed', 410, '파기된 증거 묶음입니다');
  if (o.role !== 'commander') throw problem('fraud-approver-ineligible', 403, '보존 끝은 commander만 확인할 수 있습니다');
  if (o.bundle.holdEndRequestedBy === null) throw problem('hold-end-pending', 409, '기다리는 보존 끝 요청이 없습니다');
  if (o.bundle.holdEndRequestedBy === o.confirmerId) throw problem('fraud-approver-ineligible', 403, '요청자 본인은 확인할 수 없습니다');
}

const ITEM_TABLE: Record<string, 'PURCHASE' | 'ACCESS_LOG' | 'POST'> = {
  inv_step: 'PURCHASE',
  inv_request: 'ACCESS_LOG',
  external_post: 'POST',
};

/** 승인 범위의 행만 고른다. 영장이 없으면 연결·행동·TLS·봇 라벨·의견·결제 수단 값을 뺀다. */
export function authoritySelection(o: { rows: readonly EvidenceRow[]; scope: DataRequestScope }): { selected: EvidenceRow[]; excluded: number } {
  const items = new Set(o.scope.items);
  const accounts = o.scope.accountIds ? new Set(o.scope.accountIds) : null;
  const selected: EvidenceRow[] = [];
  for (const row of o.rows) {
    const item = ITEM_TABLE[row.table];
    const inScope =
      (item !== undefined && items.has(item) && row.tsMs >= o.scope.fromMs && row.tsMs <= o.scope.toMs && (accounts === null || accounts.has(row.accountId))) ||
      (o.scope.warrant && (row.table === 'inv_link' || row.table === 'inv_behavior') && row.tsMs >= o.scope.fromMs && row.tsMs <= o.scope.toMs && (accounts === null || accounts.has(row.accountId)));
    if (!inScope) continue;
    const values = { ...row.values };
    if (!o.scope.warrant) {
      if (row.table === 'inv_request') {
        delete values.ja4;
        delete values.edge_bot_labels;
        delete values.investigator_opinion;
      }
      if (row.table === 'inv_step') {
        delete values.payment_method_ref;
        delete values.card_bin;
        delete values.pid;
      }
    }
    selected.push({ ...row, values });
  }
  selected.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : a.tsMs - b.tsMs || (a.accountId < b.accountId ? -1 : 1)));
  return { selected, excluded: o.rows.length - selected.length };
}

const csvCell = (value: string | number): string => {
  const s = String(value);
  return /^[=+\-@\t]/.test(s) ? `'${s}` : s;
};

const suppressed = (n: number): string => (n > 0 && n < 5 ? '5건 미만' : String(n));

export function promoterCsv(o: { eventName: string; cases: readonly PromoterCase[] }): string {
  const cases = o.cases;
  const sum = (f: (c: PromoterCase) => number): number => cases.reduce((n, c) => n + f(c), 0);
  const acceptedResults = (c: PromoterCase): number =>
    (c.events ?? []).reduce((n, e) => {
      if (e.kind !== 'ACTION_EXECUTED') return n;
      const results = Array.isArray(e.detail?.results) ? (e.detail!.results as { outcome?: string }[]) : [];
      return n + results.filter((x) => x.outcome === 'ACCEPTED').length;
    }, 0);
  const cancelActions = (c: PromoterCase): number =>
    c.cancelActionCount ?? (c.events ?? []).filter((e) => e.kind === 'ACTION_EXECUTED' && acceptedResults(c) > 0).length;
  const cancelled = (c: PromoterCase): number => c.cancelledTicketCount ?? acceptedResults(c);
  const appealAccepted = (c: PromoterCase): number =>
    c.appealAcceptedCount ?? (c.members ?? []).filter((m) => m.objectionResult === 'ACCEPTED' || m.appealResult === 'ACCEPTED').length;
  const appealJudged = (c: PromoterCase): number =>
    c.appealJudgedCount ?? (c.members ?? []).filter((m) => m.objectionResult === 'ACCEPTED' || m.objectionResult === 'REJECTED' || m.appealResult === 'ACCEPTED' || m.appealResult === 'REJECTED').length;

  const counts = new Map<string, number>();
  for (const c of cases) counts.set(c.reasonCategory, (counts.get(c.reasonCategory) ?? 0) + 1);
  let other = 0;
  const visible: { category: string; count: number }[] = [];
  for (const [category, count] of counts) {
    if (count >= 5) visible.push({ category, count });
    else other += count;
  }
  const rows: { metric: string; value: string }[] = [];
  rows.push({ metric: 'closed_case_count', value: suppressed(cases.length) });
  rows.push({ metric: 'cancel_action_count', value: suppressed(sum(cancelActions)) });
  rows.push({ metric: 'restrict_action_count', value: suppressed(sum((c) => c.restrictActionCount ?? 0)) });
  rows.push({ metric: 'cancelled_ticket_count', value: suppressed(sum(cancelled)) });
  rows.push({ metric: 'resold_at_face_value_count', value: suppressed(sum((c) => c.resoldAtFaceValueCount ?? 0)) });
  if (other > 0) {
    // 2차 가림: OTHER를 가렸는데 전체 합계에서 빼면 그 값이 드러나므로, 가장 작은 보이는 칸도 함께 가린다.
    visible.sort((a, b) => a.count - b.count || (a.category < b.category ? -1 : 1));
    const hidden = visible.shift();
    if (hidden) rows.push({ metric: `reason_${hidden.category}`, value: '5건 미만' });
    for (const v of visible) rows.push({ metric: `reason_${v.category}`, value: suppressed(v.count) });
    rows.push({ metric: 'reason_OTHER', value: suppressed(other) });
  } else {
    for (const v of visible.sort((a, b) => (a.category < b.category ? -1 : 1))) rows.push({ metric: `reason_${v.category}`, value: String(v.count) });
  }
  const judged = sum(appealJudged);
  const ratio = judged >= 5 ? Number((sum(appealAccepted) / judged).toFixed(2)) : null;
  rows.push({ metric: 'appeal_accepted_ratio', value: ratio === null ? '' : String(ratio) });

  // 첫 데이터 줄은 회차 이름이다(수식 삽입 방어를 이 줄에서도 본다). 나머지는 metric,value 꼴이다.
  return ['metric,value', csvCell(o.eventName), ...rows.map((r) => `${r.metric},${csvCell(r.value)}`)].join('\n');
}

const BYPASSED: Record<string, string[]> = {
  MACRO_BOT: ['봇 판정'],
  QUEUE_BYPASS: ['대기열'],
  CAPTCHA_BYPASS: ['사람 확인'],
  ACCOUNT_LENDING: ['본인 확인'],
  LIMIT_EVASION: ['1인 매수 한도'],
};

export function complaintPacket(o: {
  caseRecord: FraudCaseRecord;
  cluster: FraudClusterRecord;
  event: { eventName: string; showAtMs: number; salesOpenedAtMs: number };
  posts: readonly ExternalPostRecord[];
  manifestSha256: string;
}): Record<string, unknown> {
  const category = o.caseRecord.reasonCategory;
  const resalePosts = o.posts.map((p) => ({
    url: p.url,
    postedAt: new Date(p.postedAtMs ?? p.capturedAtMs).toISOString(),
    captureSha256: p.captureSha256,
  }));
  return {
    caseNumber: o.caseRecord.caseId,
    eventName: o.event.eventName,
    showAt: new Date(o.event.showAtMs).toISOString(),
    salesOpenedAt: new Date(o.event.salesOpenedAtMs).toISOString(),
    reasonCategories: [category],
    bypassedControls: BYPASSED[category] ?? ['부정 예매 방지'],
    purchasedCount: o.cluster.purchaseCount,
    limitPerPerson: o.cluster.limitPerPerson,
    accountCount: o.cluster.accountCount,
    resaleEvidence: resalePosts.length > 0,
    resalePosts,
    bundleManifestSha256: o.manifestSha256,
    statement: COMPLAINT_STATEMENT,
  };
}

const MAGIC: Record<string, readonly number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d],
};

const extensionOf = (name: string): string | null => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
};

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean => magic.every((b, i) => bytes[i] === b);

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1]!;
    i += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (i + 2 > buf.length) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > buf.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (i + 7 > buf.length) return null;
      return { height: buf.readUInt16BE(i + 3), width: buf.readUInt16BE(i + 5) };
    }
    i += len;
  }
  return null;
}

export function validateExternalPost(o: {
  url: string;
  source: ExternalPostSource;
  capture: { name: string; bytes: Uint8Array };
  maskRegions?: readonly MaskRegion[];
}): { url: string; site: string; mediaType: 'image/png' | 'image/jpeg' | 'application/pdf'; extension: 'png' | 'jpg' | 'pdf'; width: number | null; height: number | null } {
  let parsed: URL;
  try {
    parsed = new URL(o.url);
  } catch {
    throw problem('external-post-source-invalid', 422, '게시물 주소가 올바르지 않습니다');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '' || parsed.hostname === '' || o.url.length > 2048) {
    throw problem('external-post-source-invalid', 422, '게시물 주소는 http·https만 받습니다');
  }
  const ext = extensionOf(o.capture.name);
  if (ext === null || !(ext in MAGIC)) throw problem('external-post-capture-type-invalid', 415, 'PNG·JPEG·PDF 캡처만 받습니다');
  const mediaType = ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : 'application/pdf';
  if (o.capture.bytes.byteLength > EVIDENCE_CAPTURE_MAX_BYTES) throw problem('external-post-capture-too-large', 413, '화면 캡처는 10MB까지 올릴 수 있습니다');
  if (!startsWith(o.capture.bytes, MAGIC[ext]!)) throw problem('external-post-capture-type-invalid', 415, '확장자와 파일 내용이 맞지 않습니다');
  let width: number | null = null;
  let height: number | null = null;
  if (ext === 'png' || ext === 'jpg') {
    const size = ext === 'png' ? pngSize(o.capture.bytes) : jpegSize(o.capture.bytes);
    if (size) {
      width = size.width;
      height = size.height;
      if (width > EVIDENCE_CAPTURE_MAX_SIDE || height > EVIDENCE_CAPTURE_MAX_SIDE || width * height > EVIDENCE_CAPTURE_MAX_PIXELS) {
        throw problem('external-post-capture-pixel-too-large', 422, '화면 캡처의 화소가 너무 많습니다');
      }
    }
  }
  if (o.maskRegions && !maskRegionsValid(o.maskRegions)) throw problem('invalid-body', 400, '가릴 자리가 올바르지 않습니다');
  return { url: o.url, site: parsed.hostname, mediaType, extension: ext as 'png' | 'jpg' | 'pdf', width, height };
}

export function maskRegionsValid(regions: readonly MaskRegion[]): boolean {
  if (regions.length > EVIDENCE_MASK_MAX_REGIONS) return false;
  return regions.every((r) => {
    const numbers = [r.x, r.y, r.w, r.h];
    if (!numbers.every((n) => Number.isFinite(n))) return false;
    return r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 1.000_000_1 && r.y + r.h <= 1.000_000_1;
  });
}

/** 보기용 사본은 sharp로 다시 쓴 PNG다. 상자를 검게 칠하고 EXIF·XMP·ICC를 포함한 메타데이터를 버린다. PDF는 만들지 않는다. */
export async function maskCapture(o: {
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg' | 'application/pdf';
  regions: readonly MaskRegion[];
}): Promise<Uint8Array | undefined> {
  if (o.mediaType === 'application/pdf') return undefined;
  if (!maskRegionsValid(o.regions)) throw problem('invalid-body', 400, '가릴 자리가 올바르지 않습니다');
  const { data, info } = await sharp(Buffer.from(o.bytes), { failOn: 'none' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const out = Buffer.from(data);
  for (const r of o.regions) {
    const left = Math.max(0, Math.floor(r.x * width));
    const top = Math.max(0, Math.floor(r.y * height));
    const right = Math.min(width, Math.ceil((r.x + r.w) * width));
    const bottom = Math.min(height, Math.ceil((r.y + r.h) * height));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const i = (y * width + x) * channels;
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        if (channels > 3) out[i + 3] = 255;
      }
    }
  }
  return sharp(out, { raw: { width, height, channels } }).png({ compressionLevel: 9 }).toBuffer();
}

export function objectionCompensationOf(
  grants: readonly { ticketId: string; result: 'SAME_SEAT' | 'SAME_TIER' | 'NO_SEAT' | 'ENTRY_STARTED' }[],
): readonly { ticketId: string; reason: 'NO_SEAT' | 'ENTRY_STARTED' }[] {
  return grants
    .filter((g): g is { ticketId: string; result: 'NO_SEAT' | 'ENTRY_STARTED' } => g.result === 'NO_SEAT' || g.result === 'ENTRY_STARTED')
    .map((g) => ({ ticketId: g.ticketId, reason: g.result }));
}

export { OBJECTION_WINDOW_MS, DAY };
