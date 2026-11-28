// 런북 제어 명령 CLI(F-02-7, 계획 6.2·6.6). draft → sign → run.
// 실제 KMS·S3는 deps 포트가 맡고, 이 파일은 묶음 모양·서명·사전 검증·감사 순서·전송만 한다.
import { parseArgs } from 'node:util';
import { canonicalizeRunbook, type Clock, parseRunbookControl, RUNBOOK_BUNDLE_VALID_MS, RUNBOOK_REASON_MAX, runbookApprovalOf, type RunbookControlBundle, type RunbookService, type RunbookSignature, uuidv7, verifyRunbookControl } from '@peaket/platform';
import { keyForSigner, type CommanderKeyLike, operatorKeysOf } from './keys.js';
import { isControlPreset, type ControlPreset, type RunbookAuditSink, type RunbookControlTransport } from '../domain/ports.js';
import { buildPreset, PresetError } from '../domain/presets.js';

export interface ControlCliDeps {
  readonly clock: Clock;
  readonly keys: ReadonlyMap<string, CommanderKeyLike> | null;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, content: string) => void;
  readonly print: (line: string) => void;
  readonly kmsSign: (keyId: string, message: Buffer) => Promise<Buffer>;
  readonly newCommandId?: () => string;
  readonly defaultSigningKey?: string;
  readonly control?: RunbookControlTransport;
  readonly audit?: RunbookAuditSink;
  readonly controlAddresses?: Partial<Record<RunbookService, readonly string[]>>;
  readonly allowSimulator?: boolean;
}

class ControlCliError extends Error {
  constructor(message: string, readonly code = 2) {
    super(message);
  }
}

const EXIT = { ok: 0, usage: 2, verify: 3, timeout: 4, rejected: 5, external: 6 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface SignedControlFile {
  bundle: RunbookControlBundle;
  signatures: { keyId: string; signature: string }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readJson(deps: ControlCliDeps, path: string): unknown {
  let v: unknown;
  try {
    v = JSON.parse(deps.readFile(path));
  } catch {
    throw new ControlCliError(`파일을 읽지 못했다: ${path}`, EXIT.usage);
  }
  return v;
}

function readControlFile(deps: ControlCliDeps, path: string): { raw: Record<string, unknown>; bundle: RunbookControlBundle; signatures: RunbookSignature[] } {
  const raw = readJson(deps, path);
  if (!isObject(raw) || !isObject(raw.bundle) || typeof raw.bundle.kind !== 'string' || !Array.isArray(raw.signatures)) {
    throw new ControlCliError(`런북 묶음 모양이 아니다: ${path}`, EXIT.usage);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(canonicalizeRunbook(raw.bundle), 'utf8');
  } catch {
    throw new ControlCliError(`런북 묶음 값이 규칙에 맞지 않는다: ${path}`, EXIT.usage);
  }
  const parsed = parseRunbookControl(bytes);
  if (!parsed.ok) throw new ControlCliError(`런북 묶음이 규칙에 맞지 않는다: ${parsed.reason}`, parsed.reason === 'not-canonical' ? EXIT.usage : EXIT.verify);
  const signatures: RunbookSignature[] = [];
  for (const s of raw.signatures as unknown[]) {
    if (!isObject(s) || typeof s.keyId !== 'string' || typeof s.signature !== 'string') throw new ControlCliError(`서명 모양이 틀렸다: ${path}`, EXIT.usage);
    signatures.push({ keyId: s.keyId, signature: Buffer.from(s.signature, 'base64') });
  }
  return { raw, bundle: parsed.bundle, signatures };
}

export function isControlFile(deps: ControlCliDeps, path: string | undefined): boolean {
  if (!path) return false;
  try {
    const v = JSON.parse(deps.readFile(path));
    return isObject(v) && isObject(v.bundle) && typeof v.bundle.kind === 'string';
  } catch {
    return false;
  }
}

function paramsOf(list: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new ControlCliError(`--param은 키=값이다: ${kv}`);
    out.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return out;
}

function draft(args: string[], deps: ControlCliDeps): number {
  const preset = args[0] as ControlPreset;
  if (!isControlPreset(preset)) throw new ControlCliError(`알 수 없는 프리셋이다: ${preset ?? '(없음)'}`);
  const { values } = parseArgs({
    args: args.slice(1),
    options: { event: { type: 'string' }, scope: { type: 'string' }, param: { type: 'string', multiple: true }, reason: { type: 'string' }, 'command-id': { type: 'string' }, out: { type: 'string' } },
  });
  if (!values.out || !values.reason) throw new ControlCliError('--reason·--out이 필요하다');
  if (values.reason.length === 0 || values.reason.length > RUNBOOK_REASON_MAX) throw new ControlCliError(`--reason은 1~${RUNBOOK_REASON_MAX}자다`);
  if (values.scope !== undefined && values.scope !== 'platform') throw new ControlCliError('--scope는 platform뿐이다');
  if (values.scope === 'platform' && values.event !== undefined) throw new ControlCliError('--event와 --scope platform은 함께 쓸 수 없다');
  const issuedAt = deps.clock.now();
  const built = buildPreset(preset, {
    ...(values.event !== undefined ? { eventId: values.event } : {}),
    platform: values.scope === 'platform',
    params: paramsOf(values.param ?? []),
    issuedAt,
    allowSimulator: deps.allowSimulator ?? false,
  });
  const commandId = values['command-id'] ?? deps.newCommandId?.() ?? uuidv7(deps.clock);
  const bundle: RunbookControlBundle = {
    v: 1,
    commandId,
    kind: built.kind,
    scope: built.scope,
    version: issuedAt,
    reason: values.reason,
    issuedAt,
    expiresAt: issuedAt + RUNBOOK_BUNDLE_VALID_MS,
    requests: built.requests,
  };
  const canonical = canonicalizeRunbook(bundle);
  const parsed = parseRunbookControl(Buffer.from(canonical, 'utf8'));
  if (!parsed.ok) throw new ControlCliError(`만든 묶음이 규칙에 맞지 않는다: ${parsed.reason}`);
  deps.writeFile(values.out, `${JSON.stringify({ bundle, signatures: [] }, null, 2)}\n`);
  deps.print(`만들었다: ${values.out} (명령 ID ${commandId}, 유효 5분). 서명할 사람이 각자 sign 한다.`);
  return EXIT.ok;
}

async function sign(args: string[], deps: ControlCliDeps): Promise<number> {
  const { values } = parseArgs({ args, options: { in: { type: 'string' }, signer: { type: 'string' }, key: { type: 'string' } } });
  if (!values.in || !values.signer) throw new ControlCliError('--in·--signer가 필요하다');
  const found = keyForSigner(deps.keys, values.signer);
  if (!found) throw new ControlCliError(`운영자 키를 찾지 못했다: ${values.signer}`, EXIT.verify);
  const { bundle, signatures } = readControlFile(deps, values.in);
  const bytes = Buffer.from(canonicalizeRunbook(bundle), 'utf8');
  const kmsKey = values.key ?? (found.key as CommanderKeyLike & { kmsKeyArn?: string }).kmsKeyArn ?? values.signer;
  let sig: Buffer;
  try {
    sig = await deps.kmsSign(kmsKey, bytes);
  } catch {
    throw new ControlCliError('KMS 서명에 실패했다', EXIT.external);
  }
  const keyId = found.key.id ?? found.mapKey;
  const next = [
    ...signatures.filter((s) => s.keyId !== keyId).map((s) => ({ keyId: s.keyId, signature: s.signature.toString('base64') })),
    { keyId, signature: sig.toString('base64') },
  ];
  deps.writeFile(values.in, `${JSON.stringify({ bundle, signatures: next }, null, 2)}\n`);
  deps.print(`서명했다: ${values.signer} (지금 ${next.length}명)`);
  return EXIT.ok;
}

async function run(args: string[], deps: ControlCliDeps): Promise<number> {
  const { values } = parseArgs({ args, options: { in: { type: 'string' } } });
  if (!values.in) throw new ControlCliError('--in이 필요하다');
  const { bundle, signatures } = readControlFile(deps, values.in);
  const keys = operatorKeysOf(deps.keys);
  if (!keys) throw new ControlCliError('공개키 목록이 없다(PEAKET_RUNBOOK_COMMANDER_KEYS)', EXIT.verify);
  const bytes = Buffer.from(canonicalizeRunbook(bundle), 'utf8');
  const services = Object.keys(bundle.requests) as RunbookService[];
  const first = services[0];
  if (!first) throw new ControlCliError('묶음에 받는 서비스가 없다', EXIT.verify);
  const verified = verifyRunbookControl({
    bundle,
    bytes,
    signatures,
    keys,
    service: first,
    request: { commandId: bundle.commandId, kind: bundle.kind, scope: bundle.scope, version: bundle.version, desiredStateJson: JSON.stringify(bundle.requests[first]) },
    nowMs: deps.clock.now(),
  });
  if (!verified.ok) {
    deps.print(`서명 확인 실패: ${verified.reason}`);
    return EXIT.verify;
  }
  if (!deps.audit) throw new ControlCliError('감사 sink가 없다', EXIT.external);
  let earlier;
  try {
    earlier = await deps.audit.readResult(bundle.commandId);
  } catch {
    throw new ControlCliError('감사 sink를 읽지 못했다', EXIT.external);
  }
  if (earlier) {
    deps.print(`이미 적용됐다: ${earlier.outcome} (명령 ID ${bundle.commandId})`);
    return EXIT.ok;
  }
  if (!deps.control) throw new ControlCliError('제어 전송 포트가 없다', EXIT.external);
  for (const service of services) {
    if (!deps.controlAddresses?.[service]?.length) throw new ControlCliError(`받는 쪽 주소가 없다: ${service}`, EXIT.external);
  }
  try {
    await deps.audit.writeIntent({
      commandId: bundle.commandId,
      services: [...services].sort(),
      canonicalBundle: bytes.toString('base64'),
      signatures: signatures.map((s) => ({ keyId: s.keyId, signature: s.signature.toString('base64') })),
      issuedAt: bundle.issuedAt,
      expiresAt: bundle.expiresAt,
      writtenAtMs: deps.clock.now(),
    });
  } catch {
    deps.print('감사 기록을 남기지 못해 보내지 않았다');
    return EXIT.external;
  }

  const applied: { service: string; address: string; podName: string; appliedVersion: number; appliedAtMs: number }[] = [];
  const failed: { service: string; address: string; reason: string }[] = [];
  for (const service of services) {
    const desiredStateJson = JSON.stringify(bundle.requests[service]);
    for (const address of deps.controlAddresses![service]!) {
      try {
        const ack = await deps.control.send(address, {
          commandId: bundle.commandId,
          scope: bundle.scope,
          kind: bundle.kind,
          version: bundle.version,
          desiredStateJson,
          canonicalBundle: bytes,
          signatures,
        });
        applied.push({ service, address, podName: ack.podName, appliedVersion: ack.appliedVersion, appliedAtMs: ack.appliedAtMs });
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        failed.push({ service, address, reason: code === 4 ? 'send-deadline' : 'send-failed' });
      }
    }
  }
  const outcome = failed.length === 0 ? 'APPLIED' : applied.length === 0 ? 'REJECTED' : 'PARTIAL';
  const postReviewRequired = runbookApprovalOf(bundle) === 'ONE_COMMANDER';
  try {
    await deps.audit.writeResult({
      commandId: bundle.commandId,
      outcome,
      applied,
      failed,
      postReviewRequired,
      finishedAtMs: deps.clock.now(),
    });
  } catch {
    deps.print(`결과를 남기지 못했다. 명령 ${bundle.commandId}은 적용됐을 수 있다.`);
    return EXIT.external;
  }
  for (const a of applied) deps.print(`적용됐다: ${a.service} ${a.address} (판 ${a.appliedVersion})`);
  for (const f of failed) deps.print(`실패: ${f.service} ${f.address} (${f.reason})`);
  if (postReviewRequired) deps.print('사후 검토 보고서 할 일이 생겼다(48시간).');
  if (outcome === 'APPLIED') return EXIT.ok;
  return outcome === 'PARTIAL' ? EXIT.timeout : EXIT.rejected;
}

/** control 갈래만 처리한다(호출자는 rb35 갈래와 구분해 부른다) */
export async function runControlCli(argv: string[], deps: ControlCliDeps): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    if (sub === 'draft') return draft(rest, deps);
    if (sub === 'sign') return await sign(rest, deps);
    if (sub === 'run') return await run(rest, deps);
    throw new ControlCliError(`알 수 없는 명령이다: ${sub ?? '(없음)'}`);
  } catch (e) {
    if (e instanceof ControlCliError) {
      deps.print(e.message);
      return e.code;
    }
    if (e instanceof PresetError) {
      deps.print(e.message);
      return e.code;
    }
    if (e instanceof TypeError) {
      deps.print(e.message);
      return EXIT.usage;
    }
    throw e;
  }
}

export { isControlPreset };
