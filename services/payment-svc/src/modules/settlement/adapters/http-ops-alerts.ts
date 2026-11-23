// 정산 운영 경보 요청을 ops-svc 운영 경보 받기(POST /internal/v1/ops-alerts)로 보낸다(F-07-7 계획 I-13·I-15, ADR-0370 결정 8).
// 본문 { eventKey, kind, severity, source, reason, createdAt(UTC Z) }. source는 대상(이체 ID·파트너 ID·묶음 ID·동기화 이름)이고 계좌번호·예금주명은 싣지 않는다.
// 거절(202 accepted:false·400·422)은 OpsIntakeRefused, 일시 실패는 SettlementProblem 503. ops 주소가 없으면 UnavailableOpsAlerts(늘 503).
import type { Clock } from '@peaket/platform';
import type { SettlementAlertSink } from '../domain/ports.js';
import { SettlementProblem } from '../domain/settlement.js';
import { OpsIntakeHttp } from './ops-intake-http.js';

export class HttpOpsAlerts implements SettlementAlertSink {
  readonly #http: OpsIntakeHttp;
  constructor(baseUrl: string, internalToken?: string, o: { clock?: Clock; fetch?: typeof fetch } = {}) {
    this.#http = new OpsIntakeHttp(baseUrl, internalToken, o);
  }

  async send(o: { eventKey: string; kind: string; severity: 'SEV2' | 'SEV3'; sourceId: string; reason: string; createdAt: Date }): Promise<void> {
    await this.#http.post('/internal/v1/ops-alerts', { eventKey: o.eventKey, kind: o.kind, severity: o.severity, source: o.sourceId, reason: o.reason, createdAt: o.createdAt.toISOString() }, '운영 경보');
  }
}

export class UnavailableOpsAlerts implements SettlementAlertSink {
  async send(): Promise<void> {
    throw new SettlementProblem('dependency-unavailable', 503, '운영 경보를 보낼 ops 주소가 없습니다');
  }
}
