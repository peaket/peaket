// 조사용 가명의 라벨 키 링(docs/features/identity.md §9.1 '조사용 값의 첫 구현'·'조사용 가명 키 회전 이음의 첫 구현', docs/security/secrets-and-keys.md '조사용 가명 키', BUILD_ORDER BOT-045·BOT-046).
// 라벨마다 KMS GenerateMac으로 라벨 키를 받아 메모리에만 두고 5분 [가정]마다 다시 받는다. 받은 지 10분이 지나면 쓰지 않는다(칸을 비우고 까닭을 센다).
// 로컬·CI·demo는 라벨 키 값 자체를 설정으로 받을 수 있다(그 키는 늘 쓴다. demo는 클라우드 계정이 없어 KMS 키가 없다, BOT-045가 넘긴 것). 키 회전의 이음 기간에는 라벨마다 옛 판 라벨 키도 받아, 이음 끝까지 옛 판 값(prevRef)을 함께 준다.
import { type Clock } from '@peaket/platform';
import { INV_REF_KEY_TTL_MS, INV_REF_LABELS, invRef, type InvRefLabel, labelKeyMessage } from '../domain/inv-ref.js';
import type { InvRefBridge, InvRefBridges, InvRefs } from '../domain/ports.js';

/** GenerateMac을 부르는 것(main이 KMS 클라이언트를 넣는다, 시험은 대역) */
export interface LabelMacClient {
  mac(keyId: string, message: Uint8Array): Promise<Uint8Array>;
}

type KeySource = { version: number; kmsKeyId: string } | { version: number; key: Buffer };
/** 라벨 하나의 키. previous·bridgeUntil은 키 회전의 이음 기간에만(옛 판은 새 판보다 작다) */
export type LabelSource = KeySource & { label: InvRefLabel; previous?: KeySource; bridgeUntil?: number };
export type MissingReason = 'THROTTLED' | 'KMS_ERROR';

const ENV: Record<InvRefLabel, string> = { device: 'PEAKET_INV_REF_DEVICE', contact: 'PEAKET_INV_REF_CONTACT' };
export const KMS_ENDPOINT_ENV = 'PEAKET_KMS_ENDPOINT';
/** KMS 흉내 서버 주소를 받는 환경 */
const LOCAL_ENVS = ['local', 'ci'];
/** 라벨 키 값 설정을 받는 환경(본인확인 설정값 키와 같다, identity §5·§9.1). 운영·스테이징은 KMS 키만 */
const KEY_VALUE_ENVS = ['local', 'ci', 'demo'];
const THROTTLE_NAMES = ['ThrottlingException', 'LimitExceededException', 'TooManyRequestsException'];

interface Held {
  key: Buffer;
  /** 이때까지 쓴다(로컬 값은 끝이 없다) */
  until: number;
}
const slot = (label: InvRefLabel, version: number) => `${label}|${version}`;
const keyIdOf = (x: string) => x.slice(x.lastIndexOf('key/') >= 0 ? x.lastIndexOf('key/') + 4 : 0);

/** 설정의 키 하나(KMS 키 ID 또는 local·ci·demo의 라벨 키 값) */
function keySourceOf(env: Record<string, string | undefined>, prefix: string, version: number, valuesAllowed: boolean): KeySource | null {
  const kms = env[`${prefix}_KMS_KEY`];
  const raw = env[`${prefix}_KEY`];
  if (kms) return { version, kmsKeyId: kms };
  if (!raw) return null;
  if (!valuesAllowed) throw new Error(`${prefix}_KEY(라벨 키 값)는 ${KEY_VALUE_ENVS.join('·')}에서만 쓴다. 운영은 ${prefix}_KMS_KEY`);
  return { version, key: Buffer.from(raw, 'base64') };
}

export class InvRefKeyRing implements InvRefs {
  readonly #sources: LabelSource[];
  readonly #client: LabelMacClient | undefined;
  readonly #clock: Clock;
  readonly #held = new Map<string, Held>();
  /** 마지막으로 받지 못한 까닭(받은 적이 없으면 KMS_ERROR로 센다) */
  readonly #lastError = new Map<string, MissingReason>();
  #onMissing: (label: InvRefLabel, reason: MissingReason) => void;
  #onRefreshError: (label: InvRefLabel, reason: MissingReason, err: unknown) => void = () => {};

  constructor(o: { sources: LabelSource[]; client?: LabelMacClient; clock: Clock; onMissing?: (label: InvRefLabel, reason: MissingReason) => void }) {
    const labels = o.sources.map((s) => s.label);
    if (new Set(labels).size !== labels.length) throw new Error('라벨마다 라벨 키 설정 하나다');
    const all: KeySource[] = [];
    for (const s of o.sources) {
      const keys: KeySource[] = [s, ...(s.previous ? [s.previous] : [])];
      for (const k of keys) {
        if (!(Number.isInteger(k.version) && k.version > 0)) throw new Error(`${s.label} 라벨 키 판은 양의 정수다`);
        if ('key' in k && k.key.length !== 32) throw new Error(`${s.label} 라벨 키는 32바이트다`);
        if ('kmsKeyId' in k && (k.kmsKeyId.startsWith('alias/') || k.kmsKeyId.includes(':alias/'))) throw new Error('KMS 별칭은 받지 않는다(키 ID나 키 ARN)');
      }
      if (s.previous && s.previous.version >= s.version) throw new Error(`${s.label} 옛 판(${s.previous.version})은 새 판(${s.version})보다 작아야 한다`);
      if (s.previous && !(typeof s.bridgeUntil === 'number' && Number.isFinite(s.bridgeUntil))) throw new Error(`${s.label} 옛 판이 있으면 이음 기간 끝(BRIDGE_UNTIL)이 있어야 한다`);
      all.push(...keys);
    }
    if (all.some((k) => 'kmsKeyId' in k) && !o.client) throw new Error('KMS 라벨 키에는 GenerateMac 클라이언트가 있어야 한다');
    // 라벨끼리, 판끼리 다른 KMS 키다(같으면 값이 이어진다). 키 ID와 키 ARN을 섞어 줘도 알아보게 'key/' 뒤를 견준다
    const kmsIds = all.flatMap((k) => ('kmsKeyId' in k ? [keyIdOf(k.kmsKeyId)] : []));
    if (new Set(kmsIds).size !== kmsIds.length) throw new Error('라벨마다, 판마다 다른 KMS 키여야 한다');
    this.#sources = o.sources;
    this.#client = o.client;
    this.#clock = o.clock;
    this.#onMissing = o.onMissing ?? (() => {});
    for (const s of o.sources) for (const k of [s, ...(s.previous ? [s.previous] : [])]) if ('key' in k) this.#held.set(slot(s.label, k.version), { key: Buffer.from(k.key), until: Number.POSITIVE_INFINITY });
  }

  /**
   * 설정에서 만든다. client는 KMS 키가 하나라도 있을 때 쓴다(main이 kmsMacClient로 만든다). 라벨마다 `PEAKET_INV_REF_<라벨>_KMS_KEY`(local·ci·demo는 `…_KEY`)와 판 `…_KEY_VERSION`,
   * 이음 기간이면 옛 판 `…_PREVIOUS_KMS_KEY`(`…_PREVIOUS_KEY`)·`…_PREVIOUS_KEY_VERSION`과 이음 끝 `…_BRIDGE_UNTIL`(ISO 시각)
   */
  static fromEnv(
    env: Record<string, string | undefined>,
    clock: Clock,
    client?: (endpoint: string | undefined) => LabelMacClient,
    /** 받을 라벨(relay는 contact만) */
    labels: readonly InvRefLabel[] = INV_REF_LABELS,
    /** 옛 판 키도 받는가(relay는 받지 않는다: EMAIL 다시 계산은 새 판 키만 쓴다) */
    o: { previous?: boolean } = {},
  ): { ring: InvRefKeyRing; warnings: string[] } {
    const peaketEnv = env.PEAKET_ENV ?? 'prod';
    const local = LOCAL_ENVS.includes(peaketEnv);
    const values = KEY_VALUE_ENVS.includes(peaketEnv);
    const endpoint = env[KMS_ENDPOINT_ENV];
    if (endpoint && !local) throw new Error(`${KMS_ENDPOINT_ENV}는 ${LOCAL_ENVS.join('·')}에서만 쓴다(지금 ${peaketEnv})`);
    const sources: LabelSource[] = [];
    const warnings: string[] = [];
    for (const label of labels) {
      const p = ENV[label];
      const current = keySourceOf(env, p, Number(env[`${p}_KEY_VERSION`] ?? '1'), values);
      if (!current) {
        warnings.push(`${p}_KMS_KEY·${p}_KEY가 없어 ${label} 조사용 가명 칸을 늘 비운다(identity §9.1)`);
        continue;
      }
      const previous = o.previous === false ? null : keySourceOf(env, `${p}_PREVIOUS`, Number(env[`${p}_PREVIOUS_KEY_VERSION`] ?? '0'), values);
      const untilRaw = env[`${p}_BRIDGE_UNTIL`];
      const until = untilRaw ? Date.parse(untilRaw) : undefined;
      if (untilRaw && Number.isNaN(until)) throw new Error(`${p}_BRIDGE_UNTIL이 ISO 시각이 아니다: ${untilRaw}`);
      sources.push({ label, ...current, ...(previous ? { previous, ...(until !== undefined ? { bridgeUntil: until } : {}) } : {}) });
    }
    const needsKms = sources.some((s) => 'kmsKeyId' in s || (s.previous && 'kmsKeyId' in s.previous));
    return { ring: new InvRefKeyRing({ sources, clock, ...(needsKms && client ? { client: client(endpoint) } : {}) }), warnings };
  }

  /**
   * 키 없이 설정의 이음(옛 판과 이음 끝)만 읽는다. 라벨 키를 받지 않는 프로세스(relay의 옛 판 지우기)가 쓴다
   */
  static bridgesFromEnv(env: Record<string, string | undefined>): InvRefBridges {
    const out = new Map<InvRefLabel, InvRefBridge>();
    for (const label of INV_REF_LABELS) {
      const p = ENV[label];
      const v = Number(env[`${p}_PREVIOUS_KEY_VERSION`] ?? '');
      const until = Date.parse(env[`${p}_BRIDGE_UNTIL`] ?? '');
      if (!(Number.isInteger(v) && v > 0 && !Number.isNaN(until))) continue;
      const writeVersion = Number(env[`${p}_KEY_VERSION`] ?? '1');
      // 옛 판이 지금 판보다 작지 않으면 지금 판 행을 지울 수 있다: 시작하지 않는다(새 맥락 리뷰 중간 4)
      if (!(v < writeVersion)) throw new Error(`${label} 옛 판(${v})은 지금 판(${writeVersion})보다 작아야 한다`);
      out.set(label, { prevVersion: v, until, writeVersion });
    }
    return { bridgeOf: (label) => out.get(label) ?? null };
  }

  /** 비울 때 세는 곳을 단다(main이 지표에 잇는다) */
  onMissing(f: (label: InvRefLabel, reason: MissingReason) => void): this {
    this.#onMissing = f;
    return this;
  }

  /** 다시 받지 못했을 때 부른다(main이 경고 로그로 잇는다. 권한 거부 같은 설정 오류가 조용한 때에도 보이게) */
  onRefreshError(f: (label: InvRefLabel, reason: MissingReason, err: unknown) => void): this {
    this.#onRefreshError = f;
    return this;
  }

  /** KMS 라벨 키를 모두 다시 받는다(이음 기간이 지난 옛 판은 받지 않는다). 받지 못한 키는 까닭만 적고 들고 있던 키는 수명까지 둔다 */
  async refresh(): Promise<void> {
    const now = this.#clock.now();
    const jobs = this.#sources.flatMap((s) => [
      { label: s.label, k: s as KeySource },
      ...(s.previous && (s.bridgeUntil ?? 0) > now ? [{ label: s.label, k: s.previous }] : []),
    ]);
    await Promise.all(
      jobs.map(async ({ label, k }) => {
        if (!('kmsKeyId' in k)) return;
        const id = slot(label, k.version);
        try {
          const key = Buffer.from(await this.#client!.mac(k.kmsKeyId, labelKeyMessage(label)));
          if (key.length !== 32) throw new Error('라벨 키가 32바이트가 아니다');
          this.#held.set(id, { key, until: this.#clock.now() + INV_REF_KEY_TTL_MS });
          this.#lastError.delete(id);
        } catch (e) {
          const reason = THROTTLE_NAMES.includes((e as { name?: string }).name ?? '') ? 'THROTTLED' : 'KMS_ERROR';
          this.#lastError.set(id, reason);
          this.#onRefreshError(label, reason, e);
        }
      }),
    );
  }

  /**
   * 지금 받고 그 뒤 5분 [가정]마다 다시 받는다. ready는 첫 받기가 끝나거나 waitMs가 지나면 풀린다(뜰 때 라벨 키를 먼저 받되 KMS가 느려도 시작을 막지 않는다,
   * docs/security/secrets-and-keys.md '호출량'). stop은 다시 받기를 멈춘다
   */
  start(o: { everyMs?: number; waitMs?: number } = {}): { stop: () => void; ready: Promise<void> } {
    const kms = this.#sources.some((s) => 'kmsKeyId' in s || (s.previous && 'kmsKeyId' in s.previous));
    if (!kms) return { stop: () => {}, ready: Promise.resolve() };
    const first = this.refresh();
    const h = setInterval(() => void this.refresh(), o.everyMs ?? INV_REF_KEY_TTL_MS / 2);
    h.unref?.();
    let t: ReturnType<typeof setTimeout> | undefined;
    const ready = Promise.race([first, new Promise<void>((r) => (t = setTimeout(r, o.waitMs ?? 2_000)))]).finally(() => clearTimeout(t));
    return { stop: () => clearInterval(h), ready };
  }

  /** 지금 쓰는(새) 판의 값. 라벨 키가 없으면 비우고 센다 */
  ref(label: InvRefLabel, value: string): string | undefined {
    const s = this.#sources.find((x) => x.label === label);
    if (!s) return undefined;
    const h = this.#held.get(slot(label, s.version));
    if (!h || h.until <= this.#clock.now()) {
      this.#onMissing(label, this.#lastError.get(slot(label, s.version)) ?? 'KMS_ERROR');
      return undefined;
    }
    return invRef(h.key, s.version, value);
  }

  /** 이음 기간에만: 옛 판의 값(대응을 남기는 데만 쓴다. 없으면 undefined이고 세지 않는다) */
  prevRef(label: InvRefLabel, value: string): string | undefined {
    const s = this.#sources.find((x) => x.label === label);
    if (!s?.previous) return undefined;
    const id = slot(label, s.previous.version);
    if ((s.bridgeUntil ?? 0) <= this.#clock.now()) {
      // 이음이 끝났다: 옛 판 키를 메모리에서도 지운다(다시 받지도 않는다)
      this.#held.delete(id);
      return undefined;
    }
    const h = this.#held.get(id);
    if (!h || h.until <= this.#clock.now()) {
      // 이음 기간인데 옛 판 키가 없으면 대응을 잃으므로 센다(새 맥락 리뷰 중간 3)
      this.#onMissing(label, this.#lastError.get(id) ?? 'KMS_ERROR');
      return undefined;
    }
    return invRef(h.key, s.previous.version, value);
  }

  /** 그 라벨의 지금 판(없으면 null) */
  writeVersion(label: InvRefLabel): number | null {
    return this.#sources.find((x) => x.label === label)?.version ?? null;
  }

  /** 그 라벨의 이음(옛 판과 이음 끝). 이음이 없으면 null. 이음 끝이 지나도 설정이 남아 있으면 준다(옛 판 지우기가 쓴다) */
  bridgeOf(label: InvRefLabel): { prevVersion: number; until: number } | null {
    const s = this.#sources.find((x) => x.label === label);
    return s?.previous && s.bridgeUntil !== undefined ? { prevVersion: s.previous.version, until: s.bridgeUntil } : null;
  }

  toJSON(): string {
    return '[InvRefKeyRing]';
  }
}
