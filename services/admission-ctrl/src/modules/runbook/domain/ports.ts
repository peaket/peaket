// 런북 제어 명령 CLI의 포트(F-02-7, 계획 6.2·6.6). 실제 KMS·S3는 어댑터가 맡고, CLI는 포트만 본다.
// 도메인 층은 프레임워크·플랫폼을 모른다(architecture §3.1): 서비스 이름도 여기서 닫는다.
export type RunbookControlService = 'purchase-svc' | 'admission-ctrl' | 'queue-svc' | 'payment-svc';

export interface RunbookControlRequest {
  readonly commandId: string;
  readonly scope: string;
  readonly kind: string;
  readonly version: number;
  readonly desiredStateJson: string;
  readonly canonicalBundle: Buffer;
  readonly signatures: readonly { readonly keyId: string; readonly signature: Buffer }[];
}

export interface RunbookControlAck {
  readonly appliedVersion: number;
  readonly podName: string;
  readonly appliedAtMs: number;
}

export interface RunbookControlTransport {
  send(address: string, request: RunbookControlRequest): Promise<RunbookControlAck>;
}

export interface RunbookAuditIntent {
  readonly type: 'intent';
  readonly commandId: string;
  readonly services: readonly string[];
  readonly canonicalBundle: string;
  readonly signatures: readonly { readonly keyId: string; readonly signature: string }[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly writtenAtMs: number;
}

export interface RunbookAuditResult {
  readonly type: 'result';
  readonly commandId: string;
  readonly outcome: 'APPLIED' | 'REJECTED' | 'PARTIAL' | 'TIMEOUT';
  readonly applied: readonly { readonly service: string; readonly address: string; readonly podName: string; readonly appliedVersion: number; readonly appliedAtMs: number }[];
  readonly failed: readonly { readonly service: string; readonly address: string; readonly reason: string }[];
  readonly postReviewRequired: boolean;
  readonly finishedAtMs: number;
}

export interface RunbookAuditSink {
  writeIntent(i: Omit<RunbookAuditIntent, 'type'>): Promise<void>;
  writeResult(r: Omit<RunbookAuditResult, 'type'>): Promise<void>;
  readResult(commandId: string): Promise<RunbookAuditResult | null>;
}

/** CLI 프리셋 이름(계획 6.2) */
export const CONTROL_PRESETS = [
  'sale-pause',
  'sale-resume',
  'admission-pause',
  'admission-resume',
  'automation-stop',
  'automation-resume',
  'pg-switch',
  'pg-switch-off',
  'entry-pause-release',
] as const;
export type ControlPreset = (typeof CONTROL_PRESETS)[number];

export const isControlPreset = (v: string | undefined): v is ControlPreset => (CONTROL_PRESETS as readonly string[]).includes(v ?? '');
