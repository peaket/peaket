// ops-svc 내부 받기 대역 서버(F-07-7 시험, ADR-0370 결정 5·8, ADR-0341 결정 7).
// payment-svc가 보내는 감사 기록(POST /internal/v1/ops/audit-records), 운영 경보(POST /internal/v1/ops-alerts), CS 건(POST /internal/v1/cs-cases)을 받는다.
// 받는 본문의 바깥 모양은 ops-svc의 지금 계약과 같게 검사한다(audit-intake.ts AuditRecordIntakeBody, internal-alerts.controller.ts AlertBody, cs-cases).
// ops 쪽의 PAYOUT_ACCOUNT_CHANGED 칸 검사(목록 밖 칸 400)는 ops-svc 시험(audit-intake-payout-account.test.ts J-T40 ⑦)이 본다.
import { createServer, type Server } from 'node:http';

/** up: 받음, 503: 일시 실패, refuse: 202 accepted:false(거절), 400·422: 거절(계획 §5.1 (파) (마)) */
export type OpsFakeMode = 'up' | '503' | 'refuse' | '400' | '422';

export interface OpsAuditRecord {
  eventKey: string;
  recordType: string;
  recordId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface OpsAlert {
  eventKey: string;
  kind: string;
  severity: string;
  source: string;
  reason: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

const AUDIT_KEYS = ['eventKey', 'recordType', 'recordId', 'payload', 'occurredAt'];
const ALERT_KEYS = ['eventKey', 'kind', 'severity', 'source', 'reason', 'detail', 'createdAt'];
/** ops z.iso.datetime()처럼 UTC Z 꼴만 받는다(TR-16) */
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CASE_KEYS = ['eventKey', 'kind', 'sourceId', 'category', 'followUp', 'hold', 'createdAt', 'dueBaseAt', 'detail'];

export class OpsIntakeFake {
  mode: OpsFakeMode = 'up';
  /** 받은(2xx로 답한) 감사 기록 */
  readonly audits: OpsAuditRecord[] = [];
  readonly alerts: OpsAlert[] = [];
  readonly cases: Record<string, unknown>[] = [];
  /** up이 아닌 모드로 답한 횟수(경로별) */
  readonly refused = new Map<string, number>();
  /** 모양이 틀려 400으로 답한 본문 */
  readonly malformed: unknown[] = [];
  readonly tokens: (string | undefined)[] = [];
  #server: Server | undefined;
  #url = '';

  get url(): string {
    if (!this.#url) throw new Error('대역 서버를 먼저 띄운다(start)');
    return this.#url;
  }

  reset(): void {
    this.mode = 'up';
    this.audits.length = 0;
    this.alerts.length = 0;
    this.cases.length = 0;
    this.refused.clear();
    this.malformed.length = 0;
    this.tokens.length = 0;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        this.tokens.push(typeof req.headers['x-peaket-internal-token'] === 'string' ? req.headers['x-peaket-internal-token'] : undefined);
        const send = (status: number, value: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        if (this.mode !== 'up') {
          this.refused.set(path, (this.refused.get(path) ?? 0) + 1);
          if (this.mode === '503') return send(503, { type: 'unavailable' });
          if (this.mode === '400') return send(400, { type: 'invalid-body' });
          if (this.mode === '422') return send(422, { type: 'invalid-query' });
          return send(202, path === '/internal/v1/ops/audit-records' ? { accepted: false, seq: 0 } : { accepted: false });
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          return send(400, { type: 'invalid-body' });
        }
        if (path === '/internal/v1/ops/audit-records') {
          const ok =
            Object.keys(body).every((k) => AUDIT_KEYS.includes(k)) &&
            typeof body.eventKey === 'string' &&
            typeof body.recordType === 'string' &&
            typeof body.recordId === 'string' &&
            typeof body.payload === 'object' &&
            body.payload !== null &&
            typeof body.occurredAt === 'string';
          if (!ok) {
            this.malformed.push(body);
            return send(400, { type: 'invalid-body' });
          }
          this.audits.push({ eventKey: String(body.eventKey), recordType: String(body.recordType), recordId: String(body.recordId), payload: body.payload as Record<string, unknown>, occurredAt: String(body.occurredAt) });
          return send(202, { accepted: true, seq: this.audits.length });
        }
        if (path === '/internal/v1/ops-alerts') {
          const ok =
            Object.keys(body).every((k) => ALERT_KEYS.includes(k)) &&
            typeof body.eventKey === 'string' &&
            typeof body.kind === 'string' &&
            (body.severity === 'SEV1' || body.severity === 'SEV2' || body.severity === 'SEV3' || body.severity === 'SEV4') &&
            typeof body.source === 'string' &&
            body.source !== '' &&
            typeof body.reason === 'string' &&
            body.reason !== '' &&
            typeof body.eventKey === 'string' &&
            body.eventKey !== '' &&
            typeof body.createdAt === 'string' &&
            ISO_Z.test(body.createdAt);
          if (!ok) {
            this.malformed.push(body);
            return send(202, { accepted: false });
          }
          this.alerts.push({ eventKey: String(body.eventKey), kind: String(body.kind), severity: String(body.severity), source: String(body.source), reason: String(body.reason), ...(typeof body.detail === 'object' && body.detail !== null ? { detail: body.detail as Record<string, unknown> } : {}), createdAt: String(body.createdAt) });
          return send(202, { accepted: true, alertId: '00000000-0000-4000-8000-000000000001' });
        }
        if (path === '/internal/v1/cs-cases') {
          // ops-svc CaseRequestedBody(.strict)에 선택 칸 detail(1~2,000자)만 더한 닫힌 모양(F-07-7 계획 §5.1 (타) 결정 2·(파) (가))
          const detailOk = body.detail === undefined || (typeof body.detail === 'string' && body.detail.length >= 1 && body.detail.length <= 2_000);
          const ok =
            Object.keys(body).every((k) => CASE_KEYS.includes(k)) &&
            typeof body.eventKey === 'string' &&
            typeof body.kind === 'string' &&
            typeof body.sourceId === 'string' &&
            typeof body.category === 'string' &&
            typeof body.createdAt === 'string' &&
            detailOk;
          // 진짜 ops처럼 어긋난 본문은 202 accepted:false(R-T48 ③, 계획 §5.1 (파) (가))
          if (!ok) {
            this.malformed.push(body);
            return send(202, { accepted: false });
          }
          this.cases.push(body);
          return send(202, { accepted: true, caseId: `case-${this.cases.length}` });
        }
        return send(404, { type: 'not-found' });
      });
    });
    // real-time: payment 어댑터(HttpSettlementCaseNotice·HttpOpsAlerts·HttpOpsAuditRecords)의 실제 HTTP 경계를 보려고 127.0.0.1에 포트를 연다 F-07-7
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('대역 서버 주소를 읽지 못했다');
    this.#url = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const s = this.#server;
    this.#server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
  }
}
