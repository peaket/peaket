// ops-svc internal /internal/v1/ops-alerts로 신선도 경보를 넘기는 어댑터(O-T20).
// purchase-svc가 쓰는 기존 경보 경로를 그대로 재사용한다. 내부 토큰이 없으면 401이므로 부르는 쪽이 경고를 남긴다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { ScannerFreshnessAlertSink, ScannerFreshnessResolution, ScannerOpsAlert, ScannerOpsAlertSink } from '../domain/ports.js';

export class HttpOpsAlertSink implements ScannerFreshnessAlertSink, ScannerOpsAlertSink {
  constructor(
    private readonly client: ExternalHttpClient,
    private readonly internalToken: string | undefined,
  ) {}

  async open(alert: ScannerOpsAlert): Promise<void> {
    await this.#post('/internal/v1/ops-alerts', {
      eventKey: alert.eventKey,
      kind: alert.kind,
      severity: alert.severity,
      source: alert.source,
      reason: alert.reason,
      detail: alert.detail,
      createdAt: new Date(alert.atMs).toISOString(),
    });
  }

  async resolve(resolution: ScannerFreshnessResolution): Promise<void> {
    await this.#post('/internal/v1/ops-alerts/resolutions', {
      eventKey: resolution.eventKey,
      kind: resolution.kind,
      reason: resolution.reason,
      resolvedAt: new Date(resolution.atMs).toISOString(),
    });
  }

  async #post(path: string, body: Record<string, unknown>): Promise<void> {
    const res = await this.client.request({
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ops-svc 경보 경로가 ${res.status}로 답했다`);
  }
}
