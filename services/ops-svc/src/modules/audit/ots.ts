// 공개 타임스탬프(OpenTimestamps) 증명 파일의 직렬화 한 벌과 캘린더 호출(ADR-0348 결정 5, ADR-0075 결정 5).
// 공식 클라이언트(LGPL-3.0)는 의존성 라이선스 검사를 지나지 못해 쓰지 않고, 공식 python-opentimestamps와 같은 꼴을 여기서 쓴다.
// 완료 증명은 공식 클라이언트로 한 번 더 확인한다(tools/audit-verify/README.md).
//
// 파일 꼴(.ots, DetachedTimestampFile):
//   머리 31바이트 00 'OpenTimestamps' 00 00 'Proof' 00 bf 89 e2 e8 84 e8 92 94
//   ‖ 판 varuint(1) ‖ 해시 연산 0x08(SHA-256) ‖ 대상 다이제스트 32바이트(= 체크포인트 해시) ‖ 타임스탬프 직렬화(대상 다이제스트에서 시작).
// 타임스탬프 직렬화(Timestamp.serialize): 한 노드에서 증명(attestation)과 연산(op) 갈래를 정렬해 쓰고, 마지막 갈래 앞에만 0xff가 없다.
//   증명 = 0x00 ‖ 증명 꼬리표 8바이트 ‖ varbytes(내용). 대기 증명 꼬리표 83 df e3 0d 2e f9 0c 8e, 내용 = varbytes(캘린더 URI UTF-8).
//   비트코인 증명 꼬리표 05 88 96 0d 73 d7 19 01, 내용 = varuint(블록 높이).
//   연산 = 꼬리표 1바이트(0x08 sha256, 0x02 sha1, 0x03 ripemd160, 0x67 keccak256, 0xf0 append, 0xf1 prepend, 0xf2 reverse, 0xf3 hexlify)
//          ‖ (append·prepend만) varbytes(인자) ‖ 그 연산 결과에서 시작하는 타임스탬프 직렬화.
//   varuint는 LEB128(7비트씩, 윗비트가 이어짐), varbytes = varuint(길이) ‖ 바이트다.
// 찍기(공식 stamp와 같은 꼴): 대상 다이제스트 → append(16바이트 난수) → sha256 → [캘린더마다 POST <url>/digest 본문 32바이트, 응답 = 그 다이제스트에서 이어지는 타임스탬프 직렬화].
//   캘린더는 체크포인트 해시를 모른다(난수를 덧붙인 해시만 본다). 응답 상한 64KiB [가정], 캘린더마다 10초 [가정].
// 올리기(upgrade): 대기 증명이 붙은 노드의 값(commitment)으로 GET <대기 증명 URI>/timestamp/<commitment 16진>, 200이면 그 노드에 합친다(404는 아직).
//   대기 증명 URI가 설정한 캘린더 주소와 같을 때만 부른다(파일의 URI로 아무 곳이나 부르지 않는다. 묶음 주소(pool)가 아니라 캘린더 주소를 설정한다). 비트코인 증명이 하나라도 있으면 COMPLETE다.
import { createHash, randomBytes } from 'node:crypto';
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';

export const OTS_HEADER_MAGIC = Buffer.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
export const OTS_MAJOR_VERSION = 1;
export const OTS_PENDING_TAG = Buffer.from('83dfe30d2ef90c8e', 'hex');
export const OTS_BITCOIN_TAG = Buffer.from('0588960d73d71901', 'hex');
const OP_SHA256 = 0x08;
const OP_SHA1 = 0x02;
const OP_RIPEMD160 = 0x03;
const OP_KECCAK256 = 0x67;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;
const OP_REVERSE = 0xf2;
const OP_HEXLIFY = 0xf3;
/** 연산 결과·인자의 상한(공식 구현 MAX_RESULT_LENGTH·MAX_MSG_LENGTH) */
const MAX_MSG = 4096;
const RECURSION_LIMIT = 256;
/** 캘린더 응답 상한 64KiB [가정](ADR-0348 결정 5) */
export const OTS_RESPONSE_MAX_BYTES = 64 * 1024;
/** 캘린더마다 10초 [가정] */
export const OTS_CALENDAR_TIMEOUT_MS = 10_000;
/** 대기 증명을 다시 받는 간격 1시간 [가정] */
export const OTS_UPGRADE_INTERVAL_MS = 60 * 60_000;

export class OtsFormatError extends Error {
  constructor(why: string) {
    super(`ots-format:${why}`);
    this.name = 'OtsFormatError';
  }
}

export interface OtsOp {
  readonly tag: number;
  readonly arg?: Buffer;
}

export interface OtsAttestation {
  readonly tag: Buffer;
  /** 꼬리표 뒤 varbytes의 내용(원문) */
  readonly payload: Buffer;
}

export interface OtsTimestamp {
  readonly msg: Buffer;
  readonly attestations: OtsAttestation[];
  /** 연산 키(꼬리표·인자 16진) → 갈래 */
  readonly ops: Map<string, { readonly op: OtsOp; readonly stamp: OtsTimestamp }>;
}

const opKey = (op: OtsOp): string => `${op.tag.toString(16).padStart(2, '0')}:${op.arg ? op.arg.toString('hex') : ''}`;
const newStamp = (msg: Buffer): OtsTimestamp => ({ msg, attestations: [], ops: new Map() });

/** 연산을 적용한다. 지원하지 않거나 결과가 너무 길면 던진다 */
export function applyOp(op: OtsOp, msg: Buffer): Buffer {
  let out: Buffer;
  switch (op.tag) {
    case OP_SHA256:
      out = createHash('sha256').update(msg).digest();
      break;
    case OP_SHA1:
      out = createHash('sha1').update(msg).digest();
      break;
    case OP_RIPEMD160:
      out = createHash('ripemd160').update(msg).digest();
      break;
    case OP_APPEND:
      out = Buffer.concat([msg, op.arg ?? Buffer.alloc(0)]);
      break;
    case OP_PREPEND:
      out = Buffer.concat([op.arg ?? Buffer.alloc(0), msg]);
      break;
    case OP_REVERSE:
      out = Buffer.from(msg).reverse();
      break;
    case OP_HEXLIFY:
      out = Buffer.from(msg.toString('hex'), 'ascii');
      break;
    case OP_KECCAK256:
      // node:crypto에 keccak256(SHA3 이전 꼴)이 없다. 지원하지 않는 연산으로 보고 그 응답을 버린다
      throw new OtsFormatError('keccak256-unsupported');
    default:
      throw new OtsFormatError(`op-${op.tag}`);
  }
  if (out.length > MAX_MSG) throw new OtsFormatError('msg-too-long');
  return out;
}

// ---- 바이트 읽기·쓰기 ----

class Reader {
  #at = 0;
  constructor(private readonly buf: Buffer) {}
  get done(): boolean {
    return this.#at >= this.buf.length;
  }
  byte(): number {
    if (this.#at >= this.buf.length) throw new OtsFormatError('truncated');
    return this.buf[this.#at++]!;
  }
  bytes(n: number): Buffer {
    if (n < 0 || this.#at + n > this.buf.length) throw new OtsFormatError('truncated');
    const out = this.buf.subarray(this.#at, this.#at + n);
    this.#at += n;
    return Buffer.from(out);
  }
  varuint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 49) throw new OtsFormatError('varuint-too-big');
    }
    if (!Number.isSafeInteger(value)) throw new OtsFormatError('varuint-too-big');
    return value;
  }
  varbytes(max: number): Buffer {
    const n = this.varuint();
    if (n > max) throw new OtsFormatError('varbytes-too-long');
    return this.bytes(n);
  }
}

export function varuint(n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('varuint는 0 이상의 안전한 정수다');
  const out: number[] = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Buffer.from(out);
}

const varbytes = (b: Buffer): Buffer => Buffer.concat([varuint(b.length), b]);

// ---- 타임스탬프 읽기·쓰기 ----

function readOp(r: Reader, tag: number): OtsOp {
  if (tag === OP_APPEND || tag === OP_PREPEND) return { tag, arg: r.varbytes(MAX_MSG) };
  if ([OP_SHA256, OP_SHA1, OP_RIPEMD160, OP_KECCAK256, OP_REVERSE, OP_HEXLIFY].includes(tag)) return { tag };
  throw new OtsFormatError(`op-${tag}`);
}

function readAttestation(r: Reader): OtsAttestation {
  const tag = r.bytes(8);
  const payload = r.varbytes(8192);
  return { tag, payload };
}

/** msg에서 시작하는 타임스탬프 직렬화를 읽는다 */
function readTimestamp(r: Reader, msg: Buffer, depth: number): OtsTimestamp {
  if (depth > RECURSION_LIMIT) throw new OtsFormatError('recursion');
  const stamp = newStamp(msg);
  const one = (tag: number): void => {
    if (tag === 0x00) {
      stamp.attestations.push(readAttestation(r));
      return;
    }
    const op = readOp(r, tag);
    const result = applyOp(op, msg);
    const child = readTimestamp(r, result, depth + 1);
    const key = opKey(op);
    const had = stamp.ops.get(key);
    if (had) mergeTimestamp(had.stamp, child);
    else stamp.ops.set(key, { op, stamp: child });
  };
  let tag = r.byte();
  while (tag === 0xff) {
    one(r.byte());
    tag = r.byte();
  }
  one(tag);
  return stamp;
}

const cmpBuf = (a: Buffer, b: Buffer): number => Buffer.compare(a, b);
const attKey = (a: OtsAttestation): Buffer => Buffer.concat([a.tag, a.payload]);

function writeTimestamp(stamp: OtsTimestamp, out: Buffer[]): void {
  const atts = [...stamp.attestations].sort((a, b) => cmpBuf(attKey(a), attKey(b)));
  const ops = [...stamp.ops.values()].sort((a, b) => a.op.tag - b.op.tag || cmpBuf(a.op.arg ?? Buffer.alloc(0), b.op.arg ?? Buffer.alloc(0)));
  if (atts.length === 0 && ops.length === 0) throw new OtsFormatError('empty-timestamp');
  const writeAtt = (a: OtsAttestation) => out.push(Buffer.from([0x00]), a.tag, varbytes(a.payload));
  const writeOp = (o: { op: OtsOp; stamp: OtsTimestamp }) => {
    out.push(Buffer.from([o.op.tag]));
    if (o.op.arg) out.push(varbytes(o.op.arg));
    writeTimestamp(o.stamp, out);
  };
  // 공식 Timestamp.serialize와 같은 차례: 증명(마지막 것 빼고 0xff 앞), 연산이 없으면 마지막 증명은 0xff 없이
  for (const a of atts.slice(0, -1)) {
    out.push(Buffer.from([0xff]));
    writeAtt(a);
  }
  if (atts.length > 0) {
    if (ops.length > 0) out.push(Buffer.from([0xff]));
    writeAtt(atts[atts.length - 1]!);
  }
  for (const o of ops.slice(0, -1)) {
    out.push(Buffer.from([0xff]));
    writeOp(o);
  }
  if (ops.length > 0) writeOp(ops[ops.length - 1]!);
}

/** 두 타임스탬프를 합친다(같은 msg). 증명은 겹치지 않게 더하고 같은 연산 갈래는 안에서 합친다 */
export function mergeTimestamp(into: OtsTimestamp, other: OtsTimestamp): void {
  if (!into.msg.equals(other.msg)) throw new OtsFormatError('merge-msg');
  for (const a of other.attestations) if (!into.attestations.some((x) => attKey(x).equals(attKey(a)))) into.attestations.push(a);
  for (const [key, o] of other.ops) {
    const had = into.ops.get(key);
    if (had) mergeTimestamp(had.stamp, o.stamp);
    else into.ops.set(key, o);
  }
}

/** msg에서 시작하는 타임스탬프 직렬화 바이트를 읽는다(캘린더 응답). 남는 바이트가 있으면 틀린 꼴이다 */
export function parseTimestampBytes(bytes: Uint8Array, msg: Buffer): OtsTimestamp {
  const r = new Reader(Buffer.from(bytes));
  const stamp = readTimestamp(r, msg, 0);
  if (!r.done) throw new OtsFormatError('trailing-bytes');
  return stamp;
}

export function serializeTimestamp(stamp: OtsTimestamp): Buffer {
  const out: Buffer[] = [];
  writeTimestamp(stamp, out);
  return Buffer.concat(out);
}

export interface OtsFile {
  readonly digest: Buffer;
  readonly timestamp: OtsTimestamp;
}

/** .ots 파일 바이트 */
export function serializeOtsFile(f: OtsFile): Buffer {
  if (f.digest.length !== 32) throw new OtsFormatError('digest-length');
  return Buffer.concat([OTS_HEADER_MAGIC, varuint(OTS_MAJOR_VERSION), Buffer.from([OP_SHA256]), f.digest, serializeTimestamp(f.timestamp)]);
}

/** .ots 파일의 머리만 읽는다(판·연산·대상 다이제스트). 검증 도구와 같은 범위다 */
export function parseOtsHeader(bytes: Uint8Array): { readonly version: number; readonly hashOp: number; readonly digest: Buffer } {
  const r = new Reader(Buffer.from(bytes));
  if (!r.bytes(OTS_HEADER_MAGIC.length).equals(OTS_HEADER_MAGIC)) throw new OtsFormatError('magic');
  const version = r.varuint();
  if (version !== OTS_MAJOR_VERSION) throw new OtsFormatError('version');
  const hashOp = r.byte();
  if (hashOp !== OP_SHA256) throw new OtsFormatError('hash-op');
  return { version, hashOp, digest: r.bytes(32) };
}

/** .ots 파일 전체를 읽는다 */
export function parseOtsFile(bytes: Uint8Array): OtsFile {
  const buf = Buffer.from(bytes);
  const head = parseOtsHeader(buf);
  const r = new Reader(buf.subarray(OTS_HEADER_MAGIC.length + varuint(head.version).length + 1 + 32));
  const timestamp = readTimestamp(r, head.digest, 0);
  if (!r.done) throw new OtsFormatError('trailing-bytes');
  return { digest: head.digest, timestamp };
}

/** 대기 증명의 캘린더 URI(내용 = varbytes(URI)) */
export function pendingUri(a: OtsAttestation): string | undefined {
  if (!a.tag.equals(OTS_PENDING_TAG)) return undefined;
  try {
    const r = new Reader(a.payload);
    const uri = r.varbytes(1000).toString('utf8');
    return r.done ? uri : undefined;
  } catch {
    return undefined;
  }
}

/** 대기 증명 하나 */
export function pendingAttestation(uri: string): OtsAttestation {
  return { tag: OTS_PENDING_TAG, payload: varbytes(Buffer.from(uri, 'utf8')) };
}

/** 비트코인 블록 헤더 증명 하나(시험용 가짜 캘린더가 쓴다) */
export function bitcoinAttestation(height: number): OtsAttestation {
  return { tag: OTS_BITCOIN_TAG, payload: varuint(height) };
}

function* walk(stamp: OtsTimestamp): Generator<OtsTimestamp> {
  yield stamp;
  for (const o of stamp.ops.values()) yield* walk(o.stamp);
}

/** 비트코인 증명이 하나라도 있는가(COMPLETE) */
export function hasBitcoinAttestation(stamp: OtsTimestamp): boolean {
  for (const s of walk(stamp)) if (s.attestations.some((a) => a.tag.equals(OTS_BITCOIN_TAG))) return true;
  return false;
}

// ---- 캘린더 ----

/** 공개 타임스탬프 캘린더 하나 */
export interface OpenTimestampsCalendar {
  /** 캘린더 주소(설정 값). 대기 증명 URI의 출처 대조에 쓴다 */
  readonly url: string;
  /** 다이제스트(32바이트)를 보내 그 다이제스트에서 이어지는 타임스탬프 직렬화를 받는다 */
  submit(digest: Buffer): Promise<Buffer>;
  /** 대기 증명 값(commitment)의 완료 경로. 아직이면 undefined */
  upgrade(uri: string, commitment: Buffer): Promise<Buffer | undefined>;
}

const readLimited = async (res: Response): Promise<Buffer> => {
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > OTS_RESPONSE_MAX_BYTES) throw new OtsFormatError('response-too-large');
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > OTS_RESPONSE_MAX_BYTES) throw new OtsFormatError('response-too-large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

/** HTTPS 캘린더(공식 캘린더 API). 공용 외부 호출 클라이언트(createExternalHttpClient)로 부르고, local·ci는 http 흉내 서버도 받는다(설정이 거른다) */
export class HttpOpenTimestampsCalendar implements OpenTimestampsCalendar {
  readonly url: string;
  readonly #client: Pick<ExternalHttpClient, 'request'>;

  constructor(url: string, o: { fetch?: typeof fetch; timeoutMs?: number; client?: Pick<ExternalHttpClient, 'request'> } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.#client =
      o.client ?? createExternalHttpClient({ provider: 'ots-calendar', baseUrl: this.url, timeoutCapMs: o.timeoutMs ?? OTS_CALENDAR_TIMEOUT_MS, ...(o.fetch ? { fetch: o.fetch } : {}) });
  }

  async submit(digest: Buffer): Promise<Buffer> {
    const res = await this.#client.request({
      method: 'POST',
      path: '/digest',
      body: new Uint8Array(digest),
      headers: { accept: 'application/vnd.opentimestamps.v1', 'content-type': 'application/octet-stream', 'user-agent': 'peaket-audit-anchor' },
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`ots-calendar-${res.status}`);
    }
    return readLimited(res);
  }

  async upgrade(uri: string, commitment: Buffer): Promise<Buffer | undefined> {
    // 대기 증명의 URI가 이 캘린더 주소와 같을 때만 부른다(파일의 URI로 다른 곳을 부르지 않는다)
    if (uri.replace(/\/+$/, '') !== this.url) return undefined;
    const res = await this.#client.request({
      method: 'GET',
      path: '/timestamp/{commitment}',
      params: { commitment: commitment.toString('hex') },
      headers: { accept: 'application/vnd.opentimestamps.v1', 'user-agent': 'peaket-audit-anchor' },
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`ots-calendar-${res.status}`);
    }
    return readLimited(res);
  }
}

/**
 * 시험·로컬용 가짜 캘린더. 받은 다이제스트에 대기 증명을 붙여 돌려주고, complete()를 부른 뒤의 upgrade는 sha256 한 번과 비트코인 증명을 준다.
 * fail이 참이면 submit·upgrade가 던진다(캘린더 장애 흉내).
 */
export class MemoryOpenTimestampsCalendar implements OpenTimestampsCalendar {
  fail = false;
  readonly submitted: Buffer[] = [];
  #height: number | undefined;

  constructor(readonly url = 'https://calendar.test.peaket.invalid') {}

  complete(height = 900_000): void {
    this.#height = height;
  }

  async submit(digest: Buffer): Promise<Buffer> {
    if (this.fail) throw new Error('ots-calendar-down');
    this.submitted.push(Buffer.from(digest));
    return serializeTimestamp({ msg: digest, attestations: [pendingAttestation(this.url)], ops: new Map() });
  }

  async upgrade(uri: string, commitment: Buffer): Promise<Buffer | undefined> {
    if (this.fail) throw new Error('ots-calendar-down');
    if (uri !== this.url || this.#height === undefined) return undefined;
    const op: OtsOp = { tag: OP_SHA256 };
    const child = newStamp(applyOp(op, commitment));
    child.attestations.push(bitcoinAttestation(this.#height));
    const stamp = newStamp(commitment);
    stamp.ops.set(opKey(op), { op, stamp: child });
    return serializeTimestamp(stamp);
  }
}

export interface StampResult {
  /** .ots 바이트(받은 캘린더가 하나도 없으면 undefined) */
  readonly proof?: Buffer;
  readonly accepted: readonly string[];
  readonly failed: readonly { readonly url: string; readonly error: string }[];
}

const errName = (e: unknown): string => (e instanceof Error ? (e.name === 'Error' ? e.message.slice(0, 60) : e.name) : 'error');

/** 체크포인트 해시(32바이트)를 캘린더 여럿에 찍어 대기 증명 파일을 만든다. 캘린더는 나란히 부른다 */
export async function stampDigest(digest: Buffer, calendars: readonly OpenTimestampsCalendar[], nonce: Buffer = randomBytes(16)): Promise<StampResult> {
  if (digest.length !== 32) throw new OtsFormatError('digest-length');
  if (nonce.length !== 16) throw new OtsFormatError('nonce-length');
  const root = newStamp(digest);
  const append: OtsOp = { tag: OP_APPEND, arg: Buffer.from(nonce) };
  const appended = newStamp(applyOp(append, digest));
  const sha: OtsOp = { tag: OP_SHA256 };
  const merkle = newStamp(applyOp(sha, appended.msg));
  appended.ops.set(opKey(sha), { op: sha, stamp: merkle });
  root.ops.set(opKey(append), { op: append, stamp: appended });
  const results = await Promise.all(
    calendars.map(async (c) => {
      try {
        const bytes = await c.submit(merkle.msg);
        return { url: c.url, stamp: parseTimestampBytes(bytes, merkle.msg) };
      } catch (e) {
        return { url: c.url, error: errName(e) };
      }
    }),
  );
  const accepted: string[] = [];
  const failed: { url: string; error: string }[] = [];
  for (const r of results) {
    if ('stamp' in r && r.stamp) {
      mergeTimestamp(merkle, r.stamp);
      accepted.push(r.url);
    } else failed.push({ url: r.url, error: (r as { error: string }).error });
  }
  if (accepted.length === 0) return { accepted, failed };
  return { proof: serializeOtsFile({ digest, timestamp: root }), accepted, failed };
}

const normUrl = (u: string): string => u.replace(/\/+$/, '');

export interface UpgradeResult {
  readonly proof: Buffer;
  readonly complete: boolean;
  /** 이번에 완료 경로를 받은 대기 증명 수 */
  readonly upgraded: number;
  readonly errors: readonly string[];
}

/** 대기 증명을 캘린더에서 다시 받아 합친다. 설정한 캘린더 주소와 같은 URI만 부른다 */
export async function upgradeProof(proof: Uint8Array, calendars: readonly OpenTimestampsCalendar[]): Promise<UpgradeResult> {
  const file = parseOtsFile(proof);
  const byUrl = new Map<string, OpenTimestampsCalendar>();
  for (const c of calendars) byUrl.set(normUrl(c.url), c);
  let upgraded = 0;
  const errors: string[] = [];
  const nodes = [...walk(file.timestamp)];
  for (const node of nodes) {
    for (const a of [...node.attestations]) {
      const uri = pendingUri(a);
      if (!uri) continue;
      const cal = byUrl.get(normUrl(uri));
      if (!cal) continue;
      try {
        const bytes = await cal.upgrade(uri, node.msg);
        if (!bytes) continue;
        const got = parseTimestampBytes(bytes, node.msg);
        if (!hasBitcoinAttestation(got)) continue;
        mergeTimestamp(node, got);
        upgraded += 1;
      } catch (e) {
        errors.push(errName(e));
      }
    }
  }
  return { proof: serializeOtsFile(file), complete: hasBitcoinAttestation(file.timestamp), upgraded, errors };
}
