// F-04-14 증거 묶음·외부 게시물 응용 서비스(동결 로컬, LCH-290·LCH-300).
// 정본: docs/features/forensic-replay.md §6.7.6~§6.7.8, docs/api/openapi.yaml 태그 investigations.
import { randomUUID } from 'node:crypto';
import type { ApprovalReauthVerifier } from '../../payouts/index.js';
import type { FraudCaseRecord, FraudClusterRecord } from '../domain/investigation.js';
import {
  BULK_EXPORT_ROWS,
  EVIDENCE_CAPTURE_MAX_BYTES,
  EVIDENCE_RETENTION_AFTER_HOLD_MS,
  EXPORT_DAILY_LIMIT,
  EXPORT_VOLUME_CHECK,
  authoritySelection,
  canonicalJson,
  complaintPacket,
  custodyRowHash,
  disposeAfterMs,
  holdChangeGuard,
  holdEndConfirmGuard,
  holdEndRequestGuard,
  maskCapture,
  manifestOf,
  promoterCsv,
  sha256Hex,
  validateExternalPost,
  verifyCustodyChain,
  type CustodyRecord,
  type DataRequestScope,
  type EvidenceBundleRecord,
  type EvidenceBundleStatus,
  type EvidenceExportKind,
  type EvidenceExportRecord,
  type EvidenceFileRecord,
  type EvidenceHoldReason,
  type ExternalPostRecord,
  type MaskRegion,
  type PromoterCase,
} from '../domain/fraud-evidence.js';
import type {
  EvidenceDataRequests,
  EvidenceInventory,
  EvidenceObjectStore,
  EvidenceSubmissionBuilder,
  ExternalPostCaptures,
  FraudAlerts,
  FraudCompensationCases,
  FraudEventInfo,
  FraudEvidenceStore,
  FraudInquiryReports,
  FraudSeatDirectory,
  IdempotentWrite,
  InvestigationAccessLog,
  InvestigationStore,
  MalwareScanner,
} from '../domain/ports.js';
import { asBareProblem, bareProblem } from './bare-problem.js';

const DAY = 86_400_000;
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const active = (c: FraudCaseRecord) => c.members.filter((m) => m.removedAtMs === null);
const contentTypeOf = (key: string): string => (key.endsWith('.pdf') ? 'application/pdf' : key.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
const viewKeyOf = (postId: string): string => `captures/${postId}/view.png`;
const originalKeyOf = (postId: string, ext: 'png' | 'jpg' | 'pdf'): string => `captures/${postId}/original.${ext}`;

export interface EvidenceBundlesDeps {
  store: FraudEvidenceStore;
  cases: InvestigationStore;
  objects: EvidenceObjectStore;
  inventory: EvidenceInventory;
  dataRequests: EvidenceDataRequests;
  submission: EvidenceSubmissionBuilder;
  eventInfo: FraudEventInfo;
  captures: ExternalPostCaptures;
  scanner: MalwareScanner;
  seats: FraudSeatDirectory;
  inquiries: FraudInquiryReports;
  alerts: FraudAlerts;
  access: InvestigationAccessLog;
  now: () => number;
  reauth?: ApprovalReauthVerifier;
  audit?: { append(r: { recordType: string; recordId: string; payload: Record<string, unknown>; nowMs: number }): Promise<void> };
  disposer?: import('../domain/ports.js').EvidenceDisposer;
}

export interface ExternalPostForm {
  eventId: string;
  url: string;
  capturedAtMs: number;
  source: 'REPORT' | 'MANUAL';
  reportCaseId?: string;
  claimedSeats?: string;
  postedAtMs?: number;
  maskRegions?: readonly MaskRegion[];
  capture: { name: string; bytes: Uint8Array };
}

export class EvidenceBundles {
  readonly #known = new Set<string>();
  readonly #autoRetry = new Set<string>();
  readonly #checkedEvents = new Set<string>();

  constructor(private readonly d: EvidenceBundlesDeps) {}

  async autoCreate(i: { caseId: string; actorId: string | null }): Promise<void> {
    const c = await this.d.cases.getCase(i.caseId);
    if (!c || (c.status !== 'ACTIONED' && c.status !== 'OBJECTED' && c.status !== 'REVERSED')) return;
    await this.#autoCreateCase(c, i.actorId);
  }

  async create(actor: { accountId: string; role: string }, caseId: string, idem: IdempotentWrite, body: { reason: string }): Promise<Record<string, unknown>> {
    const found = await this.d.store.findByIdempotent(idem);
    if (found.kind === 'reused') throw bareProblem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
    if (found.kind === 'in_progress') throw bareProblem('idempotency-request-in-progress', 409, '같은 요청을 처리 중입니다');
    if (found.kind === 'replay') return found.result as Record<string, unknown>;
    const c = await this.d.cases.getCase(caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    if (c.status !== 'ACTIONED' && c.status !== 'OBJECTED' && c.status !== 'REVERSED') throw bareProblem('case-not-actioned', 409, '조치한 사건만 증거 묶음을 만들 수 있습니다');
    if (body.reason.trim() === '') throw bareProblem('invalid-body', 400, '사유가 필요합니다');
    const nowMs = this.d.now();
    const bundle = await this.#newBundle(c, actor.accountId, nowMs, body.reason);
    const view = this.#bundleView(bundle, [{ ...(await this.#createdCustody(bundle, actor.accountId, body.reason, nowMs)) }]);
    const out = await this.d.store.putBundle(bundle, this.#custodyInput(actor.accountId, body.reason, nowMs), { idem, result: view });
    this.#known.add(bundle.bundleId);
    await this.#audit('EVIDENCE_CREATED', { bundleId: bundle.bundleId, caseId }, nowMs);
    if (out.replayed) return (out.result as Record<string, unknown>) ?? view;
    return view;
  }

  async list(_actor: { accountId: string; role: string }, q: { eventId: string; cursor?: string; limit: number }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    const page = await this.d.store.listBundles(q);
    return { items: page.items.map((b) => this.#summaryView(b)), nextCursor: page.nextCursor };
  }

  async get(actor: { accountId: string; role: string }, bundleId: string): Promise<Record<string, unknown>> {
    const bundle = await this.d.store.getBundle(bundleId);
    if (!bundle) throw bareProblem('not-found', 404, '증거 묶음을 찾을 수 없습니다');
    if (bundle.status === 'DISPOSED') throw bareProblem('evidence-disposed', 410, '파기된 증거 묶음입니다');
    this.#known.add(bundle.bundleId);
    const row = await this.d.store.appendCustody(bundle.bundleId, this.#custodyInput(actor.accountId, null, this.d.now(), 'VIEWED'));
    const custody = await this.d.store.listCustody(bundle.bundleId);
    await this.d.access.record({
      accountId: actor.accountId,
      role: actor.role,
      action: 'EVIDENCE',
      caseId: bundle.caseId,
      eventId: bundle.eventId,
      rows: Math.max(1, bundle.files.length),
      outcome: 'ALLOWED',
    });
    await this.#audit('EVIDENCE_VIEWED', { bundleId: bundle.bundleId, caseId: bundle.caseId }, this.d.now());
    return this.#bundleView(bundle, custody.length > 0 ? custody : [row]);
  }

  async holdChange(actor: { accountId: string; role: string }, bundleId: string, idem: IdempotentWrite, body: { holdReason: EvidenceHoldReason; basis: string }): Promise<Record<string, unknown>> {
    const found = await this.d.store.findByIdempotent(idem);
    if (found.kind === 'reused') throw bareProblem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
    if (found.kind === 'in_progress') throw bareProblem('idempotency-request-in-progress', 409, '같은 요청을 처리 중입니다');
    if (found.kind === 'replay') return found.result as Record<string, unknown>;
    const bundle = await this.d.store.getBundle(bundleId);
    if (!bundle) throw bareProblem('not-found', 404, '증거 묶음을 찾을 수 없습니다');
    if (!body || typeof body.basis !== 'string') throw bareProblem('invalid-body', 400, '보존 이유와 근거가 필요합니다');
    try {
      holdChangeGuard({ bundle, holdReason: body.holdReason, basis: body.basis });
    } catch (e) {
      throw asBareProblem(e) as Error;
    }
    const nowMs = this.d.now();
    const next: EvidenceBundleRecord = { ...bundle, holdReason: body.holdReason };
    const input = this.#custodyInput(actor.accountId, body.basis, nowMs, 'HOLD_CHANGED');
    const view = this.#bundleView(next, await this.d.store.listCustody(bundleId));
    if (!(await this.#updateWithCustody(next, input, ['BUILDING', 'SEALED'], { idem, result: view }))) throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
    await this.#audit('EVIDENCE_HOLD_CHANGED', { bundleId, caseId: bundle.caseId, holdReason: body.holdReason }, nowMs);
    return this.#bundleView(next, await this.d.store.listCustody(bundleId));
  }

  async holdEndRequest(actor: { accountId: string; role: string }, bundleId: string, idem: IdempotentWrite, body: { basis: string }): Promise<Record<string, unknown>> {
    const found = await this.d.store.findByIdempotent(idem);
    if (found.kind === 'reused') throw bareProblem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
    if (found.kind === 'in_progress') throw bareProblem('idempotency-request-in-progress', 409, '같은 요청을 처리 중입니다');
    if (found.kind === 'replay') return found.result as Record<string, unknown>;
    const bundle = await this.d.store.getBundle(bundleId);
    if (!bundle) throw bareProblem('not-found', 404, '증거 묶음을 찾을 수 없습니다');
    if (!body || typeof body.basis !== 'string') throw bareProblem('invalid-body', 400, '근거가 필요합니다');
    try {
      holdEndRequestGuard({ bundle, requesterId: actor.accountId, basis: body.basis });
    } catch (e) {
      throw asBareProblem(e) as Error;
    }
    const nowMs = this.d.now();
    const next: EvidenceBundleRecord = { ...bundle, holdEndRequestedBy: actor.accountId, holdEndRequestedAtMs: nowMs, holdEndBasis: body.basis };
    const input = this.#custodyInput(actor.accountId, body.basis, nowMs, 'HOLD_END_REQUESTED');
    const view = this.#bundleView(next, await this.d.store.listCustody(bundleId));
    if (!(await this.#updateWithCustody(next, input, ['BUILDING', 'SEALED'], { idem, result: view }))) throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
    await this.#audit('EVIDENCE_HOLD_END_REQUESTED', { bundleId, caseId: bundle.caseId }, nowMs);
    return this.#bundleView(next, await this.d.store.listCustody(bundleId));
  }

  async holdEndConfirm(
    actor: { accountId: string; role: string; sessionId?: string },
    bundleId: string,
    idem: IdempotentWrite,
    reauthToken: string | undefined,
  ): Promise<{ bundleId: string; caseId: string; holdEndedAt: string; disposeAfter: string }> {
    const found = await this.d.store.findByIdempotent(idem);
    if (found.kind === 'reused') throw bareProblem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
    if (found.kind === 'in_progress') throw bareProblem('idempotency-request-in-progress', 409, '같은 요청을 처리 중입니다');
    if (found.kind === 'replay') return found.result as { bundleId: string; caseId: string; holdEndedAt: string; disposeAfter: string };
    const bundle = await this.d.store.getBundle(bundleId);
    if (!bundle) throw bareProblem('not-found', 404, '증거 묶음을 찾을 수 없습니다');
    try {
      holdEndConfirmGuard({ bundle, confirmerId: actor.accountId, role: actor.role });
    } catch (e) {
      throw asBareProblem(e) as Error;
    }
    if (!this.d.reauth || !reauthToken) throw bareProblem('reauth-required', 403, '재인증이 필요합니다');
    let verified: { accountId: string };
    try {
      verified = await this.d.reauth.verify(reauthToken, { sessionId: actor.sessionId ?? '', act: 'APPROVAL' });
    } catch {
      throw bareProblem('reauth-required', 403, '재인증이 필요합니다');
    }
    if (verified.accountId !== actor.accountId) throw bareProblem('reauth-required', 403, '재인증이 필요합니다');
    const nowMs = this.d.now();
    const next: EvidenceBundleRecord = { ...bundle, holdEndConfirmedBy: actor.accountId, holdEndedAtMs: nowMs };
    const result = { bundleId, caseId: bundle.caseId, holdEndedAt: new Date(nowMs).toISOString(), disposeAfter: new Date(nowMs + EVIDENCE_RETENTION_AFTER_HOLD_MS).toISOString() };
    if (!(await this.#updateWithCustody(next, this.#custodyInput(actor.accountId, bundle.holdEndBasis, nowMs, 'HOLD_ENDED'), ['BUILDING', 'SEALED'], { idem, result }))) throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
    await this.#audit('EVIDENCE_HOLD_ENDED', { bundleId, caseId: bundle.caseId }, nowMs);
    return result;
  }

  async export(actor: { accountId: string; role: string }, bundleId: string, idem: IdempotentWrite, body: { kind: EvidenceExportKind; dataRequestId?: string; reason: string }): Promise<Record<string, unknown>> {
    const found = await this.d.store.findByIdempotent(idem);
    if (found.kind === 'reused') throw bareProblem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
    if (found.kind === 'in_progress') throw bareProblem('idempotency-request-in-progress', 409, '같은 요청을 처리 중입니다');
    if (found.kind === 'replay') return found.result as Record<string, unknown>;
    if (!body || (body.kind !== 'AUTHORITY' && body.kind !== 'PROMOTER' && body.kind !== 'COMPLAINT')) throw bareProblem('invalid-body', 400, '내보내기 양식이 올바르지 않습니다');
    if (typeof body.reason !== 'string' || body.reason.trim() === '') throw bareProblem('invalid-body', 400, '사유가 필요합니다');
    const bundle = await this.d.store.getBundle(bundleId);
    if (!bundle) throw bareProblem('not-found', 404, '증거 묶음을 찾을 수 없습니다');
    if (bundle.status === 'DISPOSED') throw bareProblem('evidence-disposed', 410, '파기된 증거 묶음입니다');
    if (bundle.status !== 'SEALED') throw bareProblem('evidence-not-sealed', 409, '봉인한 증거 묶음만 내보낼 수 있습니다');
    if (!(await this.#verifyBundle(bundle))) throw bareProblem('evidence-integrity-mismatch', 409, '증거 묶음의 해시가 맞지 않습니다');
    const since = this.d.now() - (this.d.now() % DAY);
    const count = await this.d.store.exportCountSince(actor.accountId, since);
    if (count >= EXPORT_DAILY_LIMIT) {
      await this.d.access.record({ accountId: actor.accountId, role: actor.role, action: 'EVIDENCE_EXPORT', eventId: bundle.eventId, caseId: bundle.caseId, rows: 0, detail: { reason: 'export-rate-limited' }, outcome: 'DENIED' });
      throw bareProblem('export-rate-limited', 429, '내보내기 하루 한도를 넘었습니다');
    }
    const nowMs = this.d.now();
    const detail: Record<string, unknown> = {};
    if (count > EXPORT_VOLUME_CHECK) detail.volumeCheck = 'INV_EXPORT_VOLUME';
    const postsPage = await this.d.store.listPosts({ eventId: bundle.eventId, limit: 1000 });
    const posts = postsPage.items;

    if (body.kind === 'AUTHORITY') {
      if (!body.dataRequestId) throw bareProblem('data-request-required', 422, '접수된 기관 요청 번호가 필요합니다');
      const scope = await this.d.dataRequests.approvedScope({ dataRequestId: body.dataRequestId, eventId: bundle.eventId });
      if (!scope) throw bareProblem('data-request-not-found', 404, '기관 요청을 찾을 수 없습니다');
      if (scope.eventId !== bundle.eventId) throw bareProblem('data-request-event-mismatch', 409, '기관 요청의 회차가 다릅니다');
      if (scope.status !== 'APPROVED') throw bareProblem('data-request-not-approved', 409, '승인된 기관 요청이 아닙니다');
      const c = await this.d.cases.getCase(bundle.caseId);
      const accountIds = scope.accountIds ?? (c ? active(c).map((m) => m.accountId) : []);
      const snapshot = c ? await this.d.cases.latestSnapshot(c.eventId) : null;
      const inventory = await this.d.inventory.read({
        eventId: bundle.eventId,
        accountIds,
        fromMs: scope.fromMs,
        toMs: scope.toMs,
        snapshotVersions: snapshot ? [snapshot.version] : [],
      });
      const selection = authoritySelection({ rows: inventory.files.flatMap((f) => f.rows), scope });
      const built = await this.d.submission.build({ scope, rows: selection.selected, posts });
      if (built.sha256 !== sha256Hex(built.bytes) || built.rows !== selection.selected.length) throw bareProblem('dependency-unavailable', 503, '제출 파일을 확인하지 못했습니다');
      const attached = await this.d.dataRequests.attachSubmission({
        dataRequestId: scope.dataRequestId,
        document: { mediaType: built.mediaType, bytes: built.bytes, sha256: built.sha256, rows: built.rows },
      });
      const exportId = randomUUID();
      const record: EvidenceExportRecord = {
        exportId,
        bundleId,
        kind: 'AUTHORITY',
        dataRequestId: scope.dataRequestId,
        documentId: attached.documentId,
        sha256: built.sha256,
        rows: built.rows,
        reason: body.reason,
        actorId: actor.accountId,
        createdAtMs: nowMs,
      };
      await this.d.store.putExport(record, this.#custodyInput(actor.accountId, body.reason, nowMs, 'EXPORTED', 'AUTHORITY', undefined, scope.dataRequestId), { idem, result: this.#exportView(record) });
      await this.#ensureExportCustody(bundleId, this.#custodyInput(actor.accountId, body.reason, nowMs, 'EXPORTED', 'AUTHORITY', undefined, scope.dataRequestId));
      await this.#audit('EVIDENCE_EXPORTED', { bundleId, caseId: bundle.caseId, kind: 'AUTHORITY', rows: built.rows }, nowMs);
      detail.dataRequestId = scope.dataRequestId;
      if (built.rows > BULK_EXPORT_ROWS) detail.bulk = true;
      await this.d.access.record({ accountId: actor.accountId, role: actor.role, action: 'EVIDENCE_EXPORT', eventId: bundle.eventId, caseId: bundle.caseId, rows: built.rows, detail, outcome: 'ALLOWED' });
      return this.#exportView(record);
    }

    if (body.kind === 'PROMOTER') {
      const closed = await this.d.store.listClosedCases(bundle.eventId);
      const event = await this.d.eventInfo.get(bundle.eventId);
      if (!event) throw bareProblem('not-found', 404, '회차를 찾을 수 없습니다');
      const csv = promoterCsv({ eventName: event.eventName, cases: closed as unknown as PromoterCase[] });
      const bytes = Buffer.from(csv, 'utf8');
      const sha = sha256Hex(bytes);
      const rows = closed.length;
      const exportId = randomUUID();
      const result = { kind: 'PROMOTER', exportId, rows, sha256: sha, csv };
      await this.d.store.putExport(
        { exportId, bundleId, kind: 'PROMOTER', dataRequestId: null, documentId: null, sha256: sha, rows, reason: body.reason, actorId: actor.accountId, createdAtMs: nowMs },
        this.#custodyInput(actor.accountId, body.reason, nowMs, 'EXPORTED', 'PROMOTER'),
        { idem, result },
      );
      await this.#ensureExportCustody(bundleId, this.#custodyInput(actor.accountId, body.reason, nowMs, 'EXPORTED', 'PROMOTER'));
      await this.#audit('EVIDENCE_EXPORTED', { bundleId, caseId: bundle.caseId, kind: 'PROMOTER', rows }, nowMs);
      if (rows > BULK_EXPORT_ROWS) detail.bulk = true;
      await this.d.access.record({ accountId: actor.accountId, role: actor.role, action: 'EVIDENCE_EXPORT', eventId: bundle.eventId, caseId: bundle.caseId, rows, detail, outcome: 'ALLOWED' });
      return result;
    }

    const c = await this.d.cases.getCase(bundle.caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    const cluster = (await this.d.cases.getCluster(c.clusterId)) ?? ({
      clusterId: c.clusterId,
      eventId: c.eventId,
      generation: 1,
      scoreBand: 'HIGH',
      accountCount: active(c).length,
      purchaseCount: active(c).reduce((n, m) => n + m.ticketCount, 0),
      limitPerPerson: 4,
      sharedAttributes: [],
      signals: [],
      snapshotVersion: 1,
      createdAtMs: c.createdAtMs,
      members: [],
    } as FraudClusterRecord);
    const event = await this.d.eventInfo.get(bundle.eventId);
    if (!event) throw bareProblem('not-found', 404, '회차를 찾을 수 없습니다');
    const packet = complaintPacket({ caseRecord: c, cluster, event, posts, manifestSha256: bundle.manifestSha256 ?? '' });
    const bytes = Buffer.from(canonicalJson(packet), 'utf8');
    const sha = sha256Hex(bytes);
    const exportId = randomUUID();
    await this.d.store.putExport(
      { exportId, bundleId, kind: 'COMPLAINT', dataRequestId: null, documentId: null, sha256: sha, rows: 1, reason: body.reason, actorId: actor.accountId, createdAtMs: nowMs },
      this.#custodyInput(actor.accountId, body.reason, nowMs, 'EXPORTED', 'COMPLAINT'),
      { idem, result: packet },
    );
    await this.#ensureExportCustody(bundleId, this.#custodyInput(actor.accountId, body.reason, nowMs, 'EXPORTED', 'COMPLAINT'));
    await this.#audit('EVIDENCE_EXPORTED', { bundleId, caseId: bundle.caseId, kind: 'COMPLAINT', rows: 1 }, nowMs);
    await this.d.access.record({ accountId: actor.accountId, role: actor.role, action: 'EVIDENCE_EXPORT', eventId: bundle.eventId, caseId: bundle.caseId, rows: 1, detail, outcome: 'ALLOWED' });
    return packet;
  }

  async verifyDue(_nowMs: number): Promise<{ checked: number; mismatched: number }> {
    const bundles = await this.#allBundles();
    let checked = 0;
    let mismatched = 0;
    for (const bundle of bundles) {
      if (bundle.status !== 'SEALED') continue;
      checked += 1;
      if (!(await this.#verifyBundle(bundle))) mismatched += 1;
    }
    return { checked, mismatched };
  }

  async disposeDue(nowMs: number): Promise<number> {
    const due = await this.d.store.listDueForDispose(nowMs, 1000);
    let n = 0;
    for (const bundle of due) {
      try {
        if (this.d.disposer) await this.d.disposer.dispose(bundle.s3Prefix);
        else if (this.d.objects.dispose) await this.d.objects.dispose(bundle.s3Prefix);
        else throw new Error('파기 포트가 없다');
      } catch {
        await this.d.alerts.raise({ eventId: bundle.eventId, version: 1, severity: 'SEV2', kind: 'EVIDENCE_DISPOSE_FAILED' });
        continue;
      }
      const next: EvidenceBundleRecord = { ...bundle, status: 'DISPOSED' };
      const input = this.#custodyInput(null, '보존 기간 만료', nowMs, 'DISPOSED');
      try {
        const ok = await this.#updateWithCustody(next, input, ['SEALED']);
        if (!ok) {
          await this.d.alerts.raise({ eventId: bundle.eventId, version: 1, severity: 'SEV2', kind: 'EVIDENCE_DISPOSE_FAILED' });
          continue;
        }
      } catch {
        await this.d.alerts.raise({ eventId: bundle.eventId, version: 1, severity: 'SEV2', kind: 'EVIDENCE_DISPOSE_FAILED' });
        continue;
      }
      await this.#audit('EVIDENCE_DISPOSED', { bundleId: bundle.bundleId, caseId: bundle.caseId }, nowMs);
      n += 1;
    }
    return n;
  }

  async buildDue(_nowMs: number): Promise<number> {
    for (const caseId of [...this.#autoRetry]) {
      try {
        await this.autoCreate({ caseId, actorId: null });
        this.#autoRetry.delete(caseId);
      } catch {
        // 다음 정비에 다시 시도한다
      }
    }
    const due = await this.d.store.listDueForBuild(this.d.now(), 1000);
    let n = 0;
    for (const bundle of due) {
      if (await this.#build(bundle)) n += 1;
    }
    return n;
  }

  async #build(bundle: EvidenceBundleRecord): Promise<boolean> {
    const c = await this.d.cases.getCase(bundle.caseId);
    if (!c) return false;
    let inventory: Awaited<ReturnType<EvidenceInventory['read']>>;
    try {
      const snapshot = await this.d.cases.latestSnapshot(c.eventId);
      inventory = await this.d.inventory.read({
        eventId: c.eventId,
        accountIds: active(c).map((m) => m.accountId),
        fromMs: Math.min(c.createdAtMs, snapshot?.frozenAtMs ?? c.createdAtMs),
        toMs: this.d.now(),
        snapshotVersions: snapshot ? [snapshot.version] : [],
      });
    } catch {
      return false;
    }
    const cluster = await this.d.cases.getCluster(c.clusterId);
    const posts = await this.d.store.listPosts({ eventId: c.eventId, limit: 1000 });
    const files: { name: string; bytes: Uint8Array }[] = [];
    for (const f of inventory.files) files.push({ name: `records/${f.table}.arrow`, bytes: f.arrow });
    const caseForBundle = {
      caseId: c.caseId,
      eventId: c.eventId,
      clusterId: c.clusterId,
      status: c.status,
      reasonCategory: c.reasonCategory,
      cancelDeadlineAtMs: c.cancelDeadlineAtMs,
      appealDueAtMs: c.appealDueAtMs,
      approvalId: c.approvalId,
      outcomeLabel: c.outcomeLabel,
      version: c.version,
      createdAtMs: c.createdAtMs,
      closedAtMs: c.closedAtMs,
      members: c.members.map((m) => ({
        ticketCount: m.ticketCount,
        signals: m.signals,
        addedBy: m.addedBy,
        removedAtMs: m.removedAtMs,
        appealResult: m.appealResult,
        objectionResult: m.objectionResult,
        lockExpiresAtMs: m.lockExpiresAtMs,
      })),
      events: c.events.map((e) => ({ seq: e.seq, kind: e.kind, occurredAtMs: e.occurredAtMs })),
    };
    files.push({ name: 'case.json', bytes: Buffer.from(canonicalJson(caseForBundle), 'utf8') });
    files.push({ name: 'cluster.json', bytes: Buffer.from(canonicalJson(cluster ?? { clusterId: c.clusterId }), 'utf8') });
    files.push({ name: 'snapshots.json', bytes: Buffer.from(canonicalJson(inventory.snapshots), 'utf8') });
    files.push({ name: 'queries.json', bytes: Buffer.from(canonicalJson({ files: inventory.files.map((f) => ({ table: f.table, sql: f.sql })) }), 'utf8') });
    for (const p of posts.items) {
      const capture = await this.d.captures.get(p.captureKey);
      if (capture) {
        const ext = p.captureKey.endsWith('.pdf') ? 'pdf' : p.captureKey.endsWith('.jpg') ? 'jpg' : 'png';
        files.push({ name: `posts/${p.postId}/original.${ext}`, bytes: capture });
      }
      files.push({ name: `posts/${p.postId}.json`, bytes: Buffer.from(canonicalJson(p), 'utf8') });
    }
    const manifest = manifestOf({ caseId: c.caseId, eventId: c.eventId, createdAtMs: bundle.createdAtMs, files });
    for (const f of files) {
      const result = await this.d.objects.putOnce(`${bundle.s3Prefix}${f.name}`, f.bytes, 'application/octet-stream');
      if (result === 'DIFFERENT') {
        await this.d.alerts.raise({ eventId: bundle.eventId, version: 1, severity: 'SEV2', kind: 'EVIDENCE_OBJECT_CONFLICT' });
        return false;
      }
    }
    const manifestPut = await this.d.objects.putOnce(`${bundle.s3Prefix}manifest.json`, manifest.bytes, 'application/json');
    if (manifestPut === 'DIFFERENT') {
      await this.d.alerts.raise({ eventId: bundle.eventId, version: 1, severity: 'SEV2', kind: 'EVIDENCE_OBJECT_CONFLICT' });
      return false;
    }
    const listed: EvidenceFileRecord[] = [...manifest.files, { name: 'manifest.json', sha256: manifest.manifestSha256, sizeBytes: manifest.bytes.byteLength }].sort((a, b) => (a.name < b.name ? -1 : 1));
    const next: EvidenceBundleRecord = {
      ...bundle,
      status: 'SEALED',
      manifestSha256: manifest.manifestSha256,
      files: listed,
      queries: { files: inventory.files.map((f) => ({ table: f.table, sql: f.sql })), snapshots: inventory.snapshots.map((s) => s.version) },
    };
    if (!(await this.d.store.updateBundle(next, ['BUILDING']))) return false;
    await this.d.store.appendCustody(bundle.bundleId, this.#custodyInput(null, `manifest:${manifest.manifestSha256}`, this.d.now(), 'SEALED'));
    await this.#audit('EVIDENCE_SEALED', { bundleId: bundle.bundleId, caseId: bundle.caseId, manifestSha256: manifest.manifestSha256 }, this.d.now());
    this.#known.add(bundle.bundleId);
    return true;
  }

  async #verifyBundle(bundle: EvidenceBundleRecord): Promise<boolean> {
    const custody = await this.d.store.listCustody(bundle.bundleId);
    if (!verifyCustodyChain(custody).ok) {
      await this.d.alerts.raise({ eventId: bundle.eventId, version: 1, severity: 'SEV2', kind: 'EVIDENCE_CUSTODY_MISMATCH' });
      return false;
    }
    if (bundle.status !== 'SEALED') return false;
    for (const f of bundle.files) {
      const bytes = await this.d.objects.get(`${bundle.s3Prefix}${f.name}`);
      if (!bytes || sha256Hex(bytes) !== f.sha256 || bytes.byteLength !== f.sizeBytes) {
        await this.d.alerts.raise({ eventId: bundle.eventId, version: 1, severity: 'SEV2', kind: 'EVIDENCE_INTEGRITY_MISMATCH' });
        return false;
      }
    }
    return true;
  }

  async #allBundles(): Promise<EvidenceBundleRecord[]> {
    if (this.d.store.listAllBundles) return this.d.store.listAllBundles(1000);
    const out: EvidenceBundleRecord[] = [];
    for (const id of this.#known) {
      const b = await this.d.store.getBundle(id);
      if (b) out.push(b);
    }
    return out;
  }

  async #findBundleForCase(c: FraudCaseRecord): Promise<EvidenceBundleRecord | null> {
    const page = await this.d.store.listBundles({ eventId: c.eventId, limit: 1000 });
    return page.items.find((b) => b.caseId === c.caseId) ?? null;
  }

  async #autoCreateCase(c: FraudCaseRecord, actorId: string | null): Promise<void> {
    if (this.#known.has(c.caseId)) return;
    if (this.#checkedEvents.has(c.eventId)) {
      // 같은 회차를 이미 훑었으면 저장소에 묶음이 없다는 뜻이다. 그래도 다른 경로가 만들었을 수 있어 한 번 더 본다.
      const found = await this.#findBundleForCase(c);
      if (found) {
        this.#known.add(c.caseId);
        return;
      }
    } else {
      const found = await this.#findBundleForCase(c);
      this.#checkedEvents.add(c.eventId);
      if (found) {
        this.#known.add(c.caseId);
        return;
      }
    }
    try {
      const bundle = await this.#newBundle(c, actorId, this.d.now(), '조치한 사건의 자동 증거 묶음');
      await this.d.store.putBundle(bundle, this.#custodyInput(actorId, '조치한 사건의 자동 증거 묶음', this.d.now()));
      this.#known.add(c.caseId);
      this.#known.add(bundle.bundleId);
      this.#autoRetry.delete(c.caseId);
    } catch (e) {
      this.#autoRetry.add(c.caseId);
      throw e;
    }
  }

  async #newBundle(c: FraudCaseRecord, actorId: string | null, nowMs: number, reason: string): Promise<EvidenceBundleRecord> {
    const snapshot = await this.d.cases.latestSnapshot(c.eventId);
    const bundleId = randomUUID();
    return {
      bundleId,
      caseId: c.caseId,
      eventId: c.eventId,
      status: 'BUILDING',
      snapshotHash: snapshot?.invHash ?? '0'.repeat(64),
      manifestSha256: null,
      queries: {},
      s3Prefix: `evidence/${c.caseId}/${bundleId}/`,
      holdReason: 'OBJECTION',
      holdEndRequestedBy: null,
      holdEndRequestedAtMs: null,
      holdEndBasis: null,
      holdEndConfirmedBy: null,
      holdEndedAtMs: null,
      createdBy: actorId,
      createdAtMs: nowMs,
      files: [],
    };
  }

  async #updateWithCustody(
    next: EvidenceBundleRecord,
    custody: Omit<CustodyRecord, 'seq' | 'prevHash' | 'rowHash'>,
    expected: readonly EvidenceBundleStatus[],
    o?: { idem?: IdempotentWrite; result?: unknown },
  ): Promise<boolean> {
    if (this.d.store.updateBundleWithCustody) return this.d.store.updateBundleWithCustody(next, custody, expected, o);
    if (!(await this.d.store.updateBundle(next, expected))) return false;
    await this.d.store.appendCustody(next.bundleId, custody);
    return true;
  }

  async #audit(action: string, payload: Record<string, unknown>, nowMs: number): Promise<void> {
    try {
      await this.d.audit?.append({ recordType: 'ADMIN_DATA_ACCESS', recordId: String(payload.caseId ?? payload.bundleId ?? ''), payload: { action, ...payload }, nowMs });
    } catch {
      // 감사 기록 실패는 관리 연속성 기록과 별개다. 정비가 다음에 다시 남긴다.
    }
  }

  #custodyInput(
    actorId: string | null,
    reason: string | null,
    occurredAtMs: number,
    action: CustodyRecord['action'] = 'CREATED',
    exportKind: CustodyRecord['exportKind'] = null,
    _unused?: unknown,
    dataRequestId: string | null = null,
  ): Omit<CustodyRecord, 'seq' | 'prevHash' | 'rowHash'> {
    return { action, actorId, reason, exportKind, dataRequestId, occurredAtMs };
  }

  /** 제품 저장소는 putExport가 같은 트랜잭션에 EXPORTED를 넣는다. 시험 저장소처럼 빠진 경우만 덧붙인다. */
  async #ensureExportCustody(bundleId: string, input: Omit<CustodyRecord, 'seq' | 'prevHash' | 'rowHash'>): Promise<void> {
    const rows = await this.d.store.listCustody(bundleId);
    const last = rows.at(-1);
    if (last?.action === 'EXPORTED' && last.exportKind === input.exportKind && last.dataRequestId === input.dataRequestId && last.reason === input.reason) return;
    await this.d.store.appendCustody(bundleId, input);
  }

  async #createdCustody(bundle: EvidenceBundleRecord, actorId: string | null, reason: string | null, nowMs: number): Promise<CustodyRecord> {
    return { ...bundle, seq: 1, ...this.#custodyInput(actorId, reason, nowMs), prevHash: null, rowHash: custodyRowHash({ bundleId: bundle.bundleId, seq: 1, ...this.#custodyInput(actorId, reason, nowMs), prevHash: null }) };
  }

  #summaryView(b: EvidenceBundleRecord): Record<string, unknown> {
    return {
      bundleId: b.bundleId,
      caseId: b.caseId,
      status: b.status,
      manifestSha256: b.manifestSha256,
      holdReason: b.holdReason,
      holdEndedAt: iso(b.holdEndedAtMs),
      createdAt: iso(b.createdAtMs),
    };
  }

  #bundleView(b: EvidenceBundleRecord, custody: readonly CustodyRecord[]): Record<string, unknown> {
    return {
      bundleId: b.bundleId,
      caseId: b.caseId,
      status: b.status,
      snapshotHash: b.snapshotHash,
      manifestSha256: b.manifestSha256,
      s3Prefix: b.s3Prefix,
      files: b.files.map((f) => ({ name: f.name, sha256: f.sha256, sizeBytes: f.sizeBytes })),
      holdReason: b.holdReason,
      holdEndRequest:
        b.holdEndConfirmedBy !== null || b.holdEndRequestedBy === null
          ? null
          : { requestedBy: b.holdEndRequestedBy, requestedAt: iso(b.holdEndRequestedAtMs), basis: b.holdEndBasis },
      holdEndedAt: iso(b.holdEndedAtMs),
      custody: custody.map((r) => ({ seq: r.seq, action: r.action, actorId: r.actorId, reason: r.reason, occurredAt: iso(r.occurredAtMs) })),
      createdAt: iso(b.createdAtMs),
    };
  }

  #exportView(e: EvidenceExportRecord): Record<string, unknown> {
    return {
      exportId: e.exportId,
      kind: e.kind,
      dataRequestId: e.dataRequestId,
      documentId: e.documentId,
      sha256: e.sha256,
      rows: e.rows,
      createdAt: iso(e.createdAtMs),
    };
  }
}

export class ExternalPosts {
  constructor(private readonly d: EvidenceBundlesDeps) {}

  async register(actor: { accountId: string; role: string }, idem: IdempotentWrite, form: ExternalPostForm): Promise<Record<string, unknown>> {
    const found = await this.d.store.findByIdempotent(idem);
    if (found.kind === 'reused') throw bareProblem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
    if (found.kind === 'in_progress') throw bareProblem('idempotency-request-in-progress', 409, '같은 요청을 처리 중입니다');
    if (found.kind === 'replay') return found.result as Record<string, unknown>;
    if (!Number.isFinite(form.capturedAtMs)) throw bareProblem('invalid-body', 400, '수집 시각이 올바르지 않습니다');
    if (form.capture.bytes.byteLength > EVIDENCE_CAPTURE_MAX_BYTES) throw bareProblem('external-post-capture-too-large', 413, '화면 캡처는 10MB까지 올릴 수 있습니다');
    const valid = (() => {
      try {
        return validateExternalPost({ url: form.url, source: form.source, capture: form.capture, ...(form.maskRegions ? { maskRegions: form.maskRegions } : {}) });
      } catch (e) {
        throw asBareProblem(e) as Error;
      }
    })();
    if (form.source === 'REPORT') {
      if (!form.reportCaseId) throw bareProblem('external-post-source-invalid', 422, '신고 건이 필요합니다');
      const report = await this.d.inquiries.publicPost({ reportCaseId: form.reportCaseId, eventId: form.eventId });
      if (!report || report.inquiryType !== 'RESALE_POST_REPORT') throw bareProblem('external-post-source-invalid', 422, '되팔이 게시물 신고 건만 등록할 수 있습니다');
    }
    const postId = randomUUID();
    const key = originalKeyOf(postId, valid.extension);
    await this.d.captures.putQuarantine(key, form.capture.bytes, valid.mediaType);
    const matched = form.claimedSeats
      ? await this.d.seats.match({ eventId: form.eventId, claimedSeats: form.claimedSeats }).catch(() => [])
      : [];
    const nowMs = this.d.now();
    const post: ExternalPostRecord = {
      postId,
      eventId: form.eventId,
      url: valid.url,
      site: valid.site,
      capturedAtMs: form.capturedAtMs,
      postedAtMs: form.postedAtMs ?? null,
      source: form.source,
      reportCaseId: form.reportCaseId ?? null,
      claimedSeats: form.claimedSeats ?? null,
      maskRegions: form.maskRegions ?? [],
      captureKey: key,
      captureSha256: sha256Hex(form.capture.bytes),
      scanStatus: 'PENDING',
      matchedTicketIds: matched.map((m) => m.ticketId),
      registeredBy: actor.accountId,
      createdAtMs: nowMs,
    };
    const view = this.#postView(post);
    const out = await this.d.store.putPost(post, { idem, result: view });
    if (out.replayed) return (out.result as Record<string, unknown>) ?? view;
    await this.d.access.record({ accountId: actor.accountId, role: actor.role, action: 'EXTERNAL_POST', eventId: form.eventId, rows: 1, detail: { operation: 'REGISTER', postId }, outcome: 'ALLOWED' });
    if (matched.length > 0) await this.#postMatched(post, matched);
    return view;
  }

  async list(actor: { accountId: string; role: string }, q: { eventId: string; cursor?: string; limit: number }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    const page = await this.d.store.listPosts(q);
    await this.d.access.record({ accountId: actor.accountId, role: actor.role, action: 'EXTERNAL_POST', eventId: q.eventId, rows: page.items.length, detail: { operation: 'LIST' }, outcome: 'ALLOWED' });
    return { items: page.items.map((p) => this.#postView(p)), nextCursor: page.nextCursor };
  }

  async view(actor: { accountId: string; role: string }, postId: string): Promise<{ bytes: Uint8Array; contentType: 'image/png' }> {
    const post = await this.d.store.getPost(postId);
    if (!post) throw bareProblem('not-found', 404, '외부 게시물을 찾을 수 없습니다');
    if (post.scanStatus === 'PENDING') throw bareProblem('external-post-scan-pending', 409, '악성 코드 검사가 아직 끝나지 않았습니다');
    if (post.scanStatus !== 'CLEAN' || post.captureKey.endsWith('.pdf')) throw bareProblem('external-post-view-unavailable', 409, '보기용 사본을 만들 수 없는 게시물입니다');
    const bytes = await this.d.captures.get(viewKeyOf(postId));
    if (!bytes) throw bareProblem('external-post-view-unavailable', 409, '보기용 사본이 아직 없습니다');
    await this.d.access.record({ accountId: actor.accountId, role: actor.role, action: 'EXTERNAL_POST', eventId: post.eventId, rows: 1, detail: { operation: 'VIEW', postId }, outcome: 'ALLOWED' });
    return { bytes, contentType: 'image/png' };
  }

  async scanDue(_nowMs: number): Promise<number> {
    const pending = await this.d.store.listPendingScans(1000);
    let n = 0;
    for (const post of pending) {
      const bytes = await this.d.captures.get(post.captureKey);
      if (!bytes) continue;
      const result = await this.d.scanner.scan({ key: post.captureKey, bytes });
      if (result === 'PENDING') continue;
      if (result === 'THREAT') {
        await this.d.store.updatePost({ ...post, scanStatus: 'THREAT' });
        await this.d.alerts.raise({ eventId: post.eventId, version: 1, severity: 'SEV2', kind: 'EXTERNAL_POST_THREAT' });
        n += 1;
        continue;
      }
      await this.d.captures.promote(post.captureKey, bytes, contentTypeOf(post.captureKey));
      const mediaType = post.captureKey.endsWith('.pdf') ? 'application/pdf' : post.captureKey.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
      if (mediaType !== 'application/pdf') {
        const masked = await maskCapture({ bytes, mediaType, regions: post.maskRegions });
        if (masked) await this.d.captures.putView(viewKeyOf(post.postId), masked);
      }
      await this.d.store.updatePost({ ...post, scanStatus: 'CLEAN' });
      n += 1;
    }
    return n;
  }

  async disposeDue(nowMs: number): Promise<number> {
    const rows = await this.d.store.listUnusedPostsForDisposal(nowMs, 1000);
    let n = 0;
    for (const post of rows) {
      if (post.matchedTicketIds.length > 0) continue;
      const event = await this.d.eventInfo.get(post.eventId);
      if (!event || nowMs < event.showAtMs + 30 * DAY) continue;
      try {
        if (this.d.disposer?.disposeCapture) await this.d.disposer.disposeCapture(`captures/${post.postId}/`);
        else if (this.d.disposer) await this.d.disposer.dispose(`captures/${post.postId}/`);
        else await this.d.captures.dispose(`captures/${post.postId}/`);
        n += 1;
      } catch {
        await this.d.alerts.raise({ eventId: post.eventId, version: 1, severity: 'SEV2', kind: 'EXTERNAL_POST_DISPOSE_FAILED' });
      }
    }
    return n;
  }

  async postSeatTicketIds(eventId: string): Promise<readonly string[]> {
    const page = await this.d.store.listPosts({ eventId, limit: 1000 });
    return [...new Set(page.items.flatMap((p) => p.matchedTicketIds))];
  }

  async #postMatched(post: ExternalPostRecord, matched: readonly { ticketId: string; accountId: string; seatLabel: string }[]): Promise<void> {
    const accounts = [...new Set(matched.map((m) => m.accountId))];
    const open = await this.d.cases.listCases({ eventId: post.eventId, status: ['INVESTIGATING', 'APPEAL_PENDING', 'DECISION_PENDING', 'ACTIONED', 'OBJECTED'], limit: 1000 });
    for (const c of open.items) {
      if (!active(c).some((m) => accounts.includes(m.accountId))) continue;
      if (c.events.some((e) => e.kind === 'POST_MATCHED' && e.detail?.postId === post.postId)) continue;
      const event = {
        seq: (c.events.at(-1)?.seq ?? 0) + 1,
        kind: 'POST_MATCHED',
        actorId: post.registeredBy,
        note: null,
        detail: { postId: post.postId, ticketIds: matched.map((m) => m.ticketId), signal: 'POST_MATCH' },
        occurredAtMs: this.d.now(),
      };
      await this.d.cases.updateCase({ ...c, version: c.version + 1, events: [...c.events, event] }, c.version, [event], {}).catch(() => undefined);
    }
  }

  #postView(p: ExternalPostRecord): Record<string, unknown> {
    return {
      postId: p.postId,
      eventId: p.eventId,
      url: p.url,
      site: p.site,
      capturedAt: iso(p.capturedAtMs),
      postedAt: iso(p.postedAtMs),
      maskRegions: p.maskRegions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
      source: p.source,
      captureSha256: p.captureSha256,
      scanStatus: p.scanStatus,
      matchedTicketCount: p.matchedTicketIds.length,
      viewAvailable: p.scanStatus === 'CLEAN' && !p.captureKey.endsWith('.pdf'),
      registeredBy: p.registeredBy,
      createdAt: iso(p.createdAtMs),
    };
  }
}

export function startEvidenceSweep(o: { evidence: EvidenceBundles; posts: ExternalPosts; intervalMs: number; now?: () => number }): { tick(): Promise<void>; stop(): void } {
  const timer = setInterval(() => void tick(), o.intervalMs);
  timer.unref?.();
  async function tick(): Promise<void> {
    const now = o.now?.() ?? Date.now();
    const steps: (() => Promise<unknown>)[] = [
      () => o.evidence.buildDue(now),
      () => o.evidence.verifyDue(now),
      () => o.evidence.disposeDue(now),
      () => o.posts.scanDue(now),
      () => o.posts.disposeDue(now),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch {
        // 한 단계의 일시 오류가 다음 단계와 프로세스를 멈추지 않게 한다(IR-07).
      }
    }
  }
  return { tick, stop: () => clearInterval(timer) };
}

export { disposeAfterMs, complaintPacket, promoterCsv, authoritySelection, maskCapture, validateExternalPost, custodyRowHash, verifyCustodyChain, sha256Hex, canonicalJson };
export type { DataRequestScope, EvidenceBundleRecord, EvidenceExportRecord, ExternalPostRecord, MaskRegion, FraudCompensationCases };
