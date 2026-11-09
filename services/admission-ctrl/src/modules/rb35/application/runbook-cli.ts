// RB-35 CLI `peaket-runbook draft → sign → run`(ADR-0062 결정 26, ADR-0239 결정 6·8). 비상 Job 안에서 돈다.
// 검증과 적용은 대상 서비스(리더)가 하고, 여기서는 같은 코드로 먼저 확인해 빨리 실패한 뒤 묶음을 전달한다.
import { parseArgs } from 'node:util';
import { type Clock, uuidv7 } from '@peaket/platform';
import { drandRoundAfter } from '@peaket/shuffle';
import { fixAtOf, type ShuffleGroup } from '../../batch/index.js';
import { BUNDLE_VALID_MS, bundleBytes, parseSigned, RB35_COMMANDS, RECOMMIT_MIN_LEAD_MS, type Rb35Command, type SignedBundle } from '../domain/bundle.js';
import type { Rb35Store } from '../domain/ports.js';
import { type CommanderKey, verifySigned } from '../domain/verify.js';

const USAGE = '쓰는 법: peaket-runbook draft <rb35.wait|rb35.emergency-shuffle|rb35.recommit> --event <회차 ID> --param group=<lobby|1> [--param extendSec=<30~600>] --reason "<사유>" [--command-id <UUIDv7>] --out <파일>\n       peaket-runbook sign --in <파일> --signer <운영자 ID> [--key <KMS 키 ARN>]\n       peaket-runbook run --in <파일>';

/** 종료 코드 */
export const EXIT = { ok: 0, usage: 2, verify: 3, timeout: 4, rejected: 5 } as const;

export interface RunbookDeps {
  store: Rb35Store;
  clock: Clock;
  /** 배포에 든 공개키 목록(없으면 run이 확인할 수 없어 실패한다) */
  keys: ReadonlyMap<string, CommanderKey> | null;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  print: (line: string) => void;
  /** KMS 비대칭 키로 정규화 바이트에 서명한다(ES256, DER) */
  kmsSign: (keyId: string, message: Buffer) => Promise<Buffer>;
  /** 없으면 UUIDv7 */
  newCommandId?: () => string;
  /** sign의 기본 KMS 키 */
  defaultSigningKey?: string;
  /** run이 결과를 기다리는 시간(기본 30초 [가정]) */
  waitResultMs?: number;
  /** 결과를 다시 보는 간격(기본 500ms) */
  pollMs?: number;
}

const DEFAULT_WAIT_RESULT_MS = 30_000;
/** 결과를 다시 보는 간격 500ms [가정] */
const DEFAULT_POLL_MS = 500;

class CliError extends Error {
  constructor(message: string, readonly code: number = EXIT.usage) {
    super(message);
  }
}

const groupOf = (raw: string | undefined): ShuffleGroup => {
  if (raw === 'lobby') return 'lobby';
  if (raw === '1') return 1;
  throw new CliError(`구간은 lobby나 1이다: ${raw ?? '(없음)'}`);
};

function readBundle(deps: RunbookDeps, path: string): SignedBundle {
  let v: unknown;
  try {
    v = JSON.parse(deps.readFile(path));
  } catch {
    throw new CliError(`파일을 읽지 못했다: ${path}`);
  }
  const s = parseSigned(v);
  if (!s) throw new CliError(`묶음 모양이 틀렸다: ${path}`);
  return s;
}

function paramsOf(list: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new CliError(`--param은 키=값이다: ${kv}`);
    out.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return out;
}

async function draft(args: string[], deps: RunbookDeps): Promise<number> {
  const [command, ...rest] = args;
  if (!command || !(RB35_COMMANDS as readonly string[]).includes(command)) throw new CliError(`알 수 없는 명령이다: ${command ?? '(없음)'}\n${USAGE}`);
  const { values } = parseArgs({ args: rest, options: { event: { type: 'string' }, param: { type: 'string', multiple: true }, reason: { type: 'string' }, 'command-id': { type: 'string' }, out: { type: 'string' } } });
  if (!values.event || !values.out || !values.reason) throw new CliError(`--event·--reason·--out이 필요하다\n${USAGE}`);
  const params = paramsOf(values.param ?? []);
  const group = groupOf(params.get('group'));
  const now = deps.clock.now();
  const expiresAt = now + BUNDLE_VALID_MS;
  const state = await deps.store.state(values.event, group);
  if (state.commit === null || state.round === null) throw new CliError(`공시 기록이 없다(${values.event} 구간 ${group}). 시드가 없으면 CLI로 풀 수 없다(RB-35, ADR-0239 결정 9)`);
  const body: Record<string, unknown> = { reason: values.reason, stop: state.stop, commit: state.commit, round: state.round };
  if (command === 'rb35.wait') body.extendSec = Number(params.get('extendSec'));
  if (command === 'rb35.recommit') {
    const schedule = await deps.store.scheduleOf(values.event);
    if (!schedule) throw new CliError(`일정이 없다: ${values.event}`);
    // 라운드는 목록 고정 뒤의 첫 라운드와, 묶음 만료 뒤의 첫 라운드 중 늦은 쪽(적용 때 아직 나오지 않게)
    body.newRound = Math.max(drandRoundAfter(fixAtOf(schedule, group)), drandRoundAfter(expiresAt, RECOMMIT_MIN_LEAD_MS));
  }
  const bundle = { v: 1, commandId: values['command-id'] ?? (deps.newCommandId?.() ?? uuidv7(deps.clock)), command: command as Rb35Command, params: body, target: { eventId: values.event, group }, issuedAt: now, expiresAt };
  const signed = parseSigned({ bundle, signatures: [] });
  if (!signed) throw new CliError('값이 규칙에 맞지 않는다(회차 ID, 사유 1~200자 한 줄, extendSec 30~600, 명령 ID UUIDv7)');
  deps.writeFile(values.out, `${JSON.stringify(signed, null, 2)}\n`);
  deps.print(`만들었다: ${values.out} (명령 ID ${signed.bundle.commandId}, 유효 5분). 이제 commander 두 명이 각자 sign 한다.`);
  return EXIT.ok;
}

async function sign(args: string[], deps: RunbookDeps): Promise<number> {
  const { values } = parseArgs({ args, options: { in: { type: 'string' }, signer: { type: 'string' }, key: { type: 'string' } } });
  if (!values.in || !values.signer) throw new CliError(`--in·--signer가 필요하다\n${USAGE}`);
  const keyId = values.key ?? deps.defaultSigningKey;
  if (!keyId) throw new CliError('서명 키가 없다(--key나 PEAKET_RUNBOOK_SIGNING_KEY)');
  const s = readBundle(deps, values.in);
  const b = s.bundle;
  // 서명하는 사람이 무엇에 서명하는지 본다
  deps.print(`서명할 내용: ${b.command}, 회차 ${b.target.eventId}, 구간 ${b.target.group}, 사유 "${b.params.reason}", 멈춤 ${b.params.stop ?? '(없음)'}, 커밋 ${b.params.commit}, 라운드 ${b.params.round}${b.params.newRound !== undefined ? `, 새 라운드 ${b.params.newRound}` : ''}${b.params.extendSec !== undefined ? `, 더 기다릴 시간 ${b.params.extendSec}초` : ''}`);
  const sig = await deps.kmsSign(keyId, bundleBytes(b));
  const signatures = [...s.signatures.filter((x) => x.signer !== values.signer), { signer: values.signer, sig: sig.toString('base64') }];
  deps.writeFile(values.in, `${JSON.stringify({ ...s, signatures }, null, 2)}\n`);
  deps.print(`서명했다: ${values.signer} (지금 ${signatures.length}명)`);
  return EXIT.ok;
}

async function run(args: string[], deps: RunbookDeps): Promise<number> {
  const { values } = parseArgs({ args, options: { in: { type: 'string' } } });
  if (!values.in) throw new CliError(`--in이 필요하다\n${USAGE}`);
  const s = readBundle(deps, values.in);
  const { commandId, target } = s.bundle;
  if (!deps.keys) throw new CliError('공개키 목록이 없다(PEAKET_RUNBOOK_COMMANDER_KEYS)', EXIT.verify);
  // 이미 끝난 명령이면 결과만 알려 준다(전파 실패 뒤 같은 명령 ID로 다시 보낸 경우)
  const earlier = await deps.store.result(target.eventId, commandId);
  if (earlier !== null) return report(deps, commandId, earlier);
  const v = verifySigned(s, deps.keys, deps.clock.now());
  if (!v.ok) throw new CliError(`서명 확인 실패: ${v.reason}`, EXIT.verify);
  const raw = JSON.stringify(s);
  if (!(await deps.store.deposit(target.eventId, target.group, commandId, raw))) throw new CliError(`같은 구간에 처리 중인 다른 명령이 있다(${target.eventId} 구간 ${target.group})`, EXIT.rejected);
  deps.print(`전달했다(명령 ID ${commandId}). 리더의 결과를 기다린다.`);
  const waitMs = deps.waitResultMs ?? DEFAULT_WAIT_RESULT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  for (let waited = 0; ; waited += pollMs) {
    const r = await deps.store.result(target.eventId, commandId);
    if (r !== null) return report(deps, commandId, r);
    if (waited >= waitMs) break;
    await new Promise((d) => setTimeout(d, pollMs));
  }
  deps.print(`결과를 받지 못했다(명령 ID ${commandId}). 같은 파일로 다시 실행하면 결과를 다시 본다.`);
  return EXIT.timeout;
}

function report(deps: RunbookDeps, commandId: string, result: string): number {
  if (result === 'applied') {
    deps.print(`적용됐다: applied (명령 ID ${commandId})`);
    return EXIT.ok;
  }
  deps.print(`거절됐다: ${result} (명령 ID ${commandId})`);
  return EXIT.rejected;
}

/** 종료 코드를 돌려준다(시험에서 그대로 본다) */
export async function runRunbookCli(argv: string[], deps: RunbookDeps): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    if (sub === 'draft') return await draft(rest, deps);
    if (sub === 'sign') return await sign(rest, deps);
    if (sub === 'run') return await run(rest, deps);
    throw new CliError(USAGE);
  } catch (e) {
    if (e instanceof CliError) {
      deps.print(e.message);
      return e.code;
    }
    if (e instanceof TypeError && 'code' in e) {
      deps.print(`${(e as Error).message}\n${USAGE}`);
      return EXIT.usage;
    }
    throw e;
  }
}
