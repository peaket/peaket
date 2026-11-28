// 받는 쪽의 런북 묶음 관문(F-02-7, 계획 6.5·R1~R13). 네 서비스가 같은 코드로 확인한다.
// 흐름: 설정 확인 → 정규화·모양 → 요청 대조·서명·역할·창 → 재생 예약 → 적용 → 확정/풀기.
import { type RunbookControlBundle, parseRunbookControl, type RunbookControlRequest, type RunbookOperatorKey, type RunbookRejectReason, type RunbookService, type RunbookSignature, verifyRunbookControl } from './runbook-bundle.js';
import type { RunbookReplayGuard } from './runbook-replay.js';

export const RUNBOOK_REJECTED_CODE = 16;
export const RUNBOOK_ALREADY_EXISTS_CODE = 6;
export const RUNBOOK_UNAVAILABLE_CODE = 14;

export interface RunbookSecurityEvent {
  readonly kind: 'runbook-bundle-rejected';
  readonly reason: RunbookRejectReason | 'in-flight';
  readonly service: string;
  readonly podName: string;
  readonly commandId: string;
  readonly kindName: string;
  readonly scope: string;
  readonly keyIds: readonly string[];
  readonly atMs: number;
}

export interface RunbookGateConfig {
  readonly keys?: ReadonlyMap<string, RunbookOperatorKey>;
  readonly service: RunbookService;
  readonly replay: RunbookReplayGuard;
  readonly security?: (e: RunbookSecurityEvent) => void;
  readonly nowMs?: () => number;
}

export interface RunbookProtoSignature {
  readonly key_id?: string;
  readonly signature?: Uint8Array | Buffer;
}

export interface RunbookProtoBundle {
  readonly canonical_bundle?: Uint8Array | Buffer;
  readonly signatures?: readonly RunbookProtoSignature[];
}

export interface RunbookGateOptions<T> {
  readonly config?: RunbookGateConfig;
  readonly bundle?: RunbookProtoBundle;
  readonly request: RunbookControlRequest;
  readonly service: RunbookService;
  readonly podName: string;
  readonly apply: () => Promise<T>;
}

const withCode = (reason: string, code: number): Error => Object.assign(new Error(reason), { code });

function emit(o: {
  config?: RunbookGateConfig;
  service: string;
  podName: string;
  reason: RunbookSecurityEvent['reason'];
  atMs: number;
  bundle?: RunbookControlBundle;
  commandId?: string;
  signatures: readonly RunbookSignature[];
}): void {
  if (!o.config?.security) return;
  const event: RunbookSecurityEvent = {
    kind: 'runbook-bundle-rejected',
    reason: o.reason,
    service: o.service,
    podName: o.podName,
    commandId: o.commandId ?? o.bundle?.commandId ?? '',
    kindName: o.bundle?.kind ?? '',
    scope: o.bundle?.scope ?? '',
    keyIds: [...new Set(o.signatures.map((s) => s.keyId).filter((k) => k !== ''))].sort(),
    atMs: o.atMs,
  };
  try {
    o.config.security(event);
  } catch {
    // 보안 이벤트 sink가 죽어도 명령 판정은 바꾸지 않는다(로그는 sink 몫)
  }
}

function signaturesOf(bundle: RunbookProtoBundle | undefined): { ok: true; signatures: RunbookSignature[] } | { ok: false } {
  const raw = bundle?.signatures;
  if (raw === undefined) return { ok: true, signatures: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const out: RunbookSignature[] = [];
  for (const s of raw) {
    if (typeof s?.key_id !== 'string' || s.key_id === '' || s.signature === undefined) return { ok: false };
    out.push({ keyId: s.key_id, signature: Buffer.from(s.signature) });
  }
  return { ok: true, signatures: out };
}

/**
 * 묶음이 있으면 관문을 통과한 뒤에만 apply를 부른다. 적용이 실패하면 재생 예약을 풀고,
 * 저장소 오류(code 없음)는 UNAVAILABLE(14)로 바꾼다. 검증 실패는 PERMISSION_DENIED(16),
 * 재생·충돌은 ALREADY_EXISTS(6), 동시 요청은 UNAVAILABLE(14)이다.
 */
export async function withRunbookControl<T>(o: RunbookGateOptions<T>): Promise<T> {
  const nowMs = o.config?.nowMs?.() ?? Date.now();
  if (!o.config?.keys) {
    emit({ config: o.config, service: o.service, podName: o.podName, reason: 'bundle-malformed', atMs: nowMs, signatures: [] });
    throw withCode('bundle-malformed', RUNBOOK_REJECTED_CODE);
  }
  const sigs = signaturesOf(o.bundle);
  if (!sigs.ok) {
    emit({ config: o.config, service: o.service, podName: o.podName, reason: 'bundle-malformed', atMs: nowMs, signatures: [] });
    throw withCode('bundle-malformed', RUNBOOK_REJECTED_CODE);
  }
  const bytes = o.bundle?.canonical_bundle;
  if (!bytes || bytes.length === 0) {
    emit({ config: o.config, service: o.service, podName: o.podName, reason: 'bundle-malformed', atMs: nowMs, signatures: sigs.signatures });
    throw withCode('bundle-malformed', RUNBOOK_REJECTED_CODE);
  }
  const parsed = parseRunbookControl(bytes);
  if (!parsed.ok) {
    emit({ config: o.config, service: o.service, podName: o.podName, reason: parsed.reason, atMs: nowMs, signatures: sigs.signatures });
    throw withCode(parsed.reason, RUNBOOK_REJECTED_CODE);
  }
  const verified = verifyRunbookControl({
    bundle: parsed.bundle,
    bytes: Buffer.from(bytes),
    signatures: sigs.signatures,
    keys: o.config.keys,
    service: o.service,
    request: o.request,
    nowMs,
  });
  if (!verified.ok) {
    emit({ config: o.config, service: o.service, podName: o.podName, reason: verified.reason, atMs: nowMs, bundle: parsed.bundle, commandId: o.request.commandId, signatures: sigs.signatures });
    throw withCode(verified.reason, RUNBOOK_REJECTED_CODE);
  }

  const verdict = o.config.replay.begin(parsed.bundle.commandId, verified.digest, parsed.bundle.expiresAt, nowMs);
  if (verdict === 'replayed' || verdict === 'conflict') {
    emit({ config: o.config, service: o.service, podName: o.podName, reason: verdict, atMs: nowMs, bundle: parsed.bundle, signatures: sigs.signatures });
    throw withCode(verdict, RUNBOOK_ALREADY_EXISTS_CODE);
  }
  if (verdict === 'in-flight') {
    emit({ config: o.config, service: o.service, podName: o.podName, reason: 'in-flight', atMs: nowMs, bundle: parsed.bundle, signatures: sigs.signatures });
    throw withCode('in-flight', RUNBOOK_UNAVAILABLE_CODE);
  }

  try {
    const result = await o.apply();
    o.config.replay.commit(parsed.bundle.commandId);
    return result;
  } catch (err) {
    o.config.replay.abort(parsed.bundle.commandId);
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') throw err;
    throw withCode('runbook-apply-unavailable', RUNBOOK_UNAVAILABLE_CODE);
  }
}
