// 조사용 가명의 계산식과 라벨 키 링(docs/security/secrets-and-keys.md '조사용 가명 키', docs/features/identity.md §9.1, docs/features/bot-defense.md §3.2·§4.9, ADR-0171 결정 4, ADR-0251).
// invRef(라벨, 값) = "k" + 판 + "." + base64url(HMAC-SHA256(라벨 키, 값)). 라벨 키는 KMS GenerateMac(그 라벨의 키, "PEAKET-inv-ref-v1|" + 라벨)이다.
// 라벨마다 라벨 키를 받아 메모리에만 두고 5분 [가정]마다 다시 받는다. 받은 지 10분이 지나면 쓰지 않는다(칸을 비우고 까닭을 센다). 요청 처리 중에는 KMS를 부르지 않는다.
// 로컬·CI·demo는 라벨 키 값 자체를 설정으로 받을 수 있다(그 키는 늘 쓴다. demo는 클라우드 계정이 없어 KMS 키가 없다). 키 회전의 이음 기간에는 라벨마다 옛 판 라벨 키도 받아, 이음 끝까지 옛 판 값(prevRef)을 함께 준다.
// identity-svc와 trust-svc의 기기 가명이 같은 값이어야 하므로(B-T16) 이 파일 하나를 함께 쓴다. KMS SDK는 여기서 부르지 않는다(필요한 서비스의 시작 파일이 넣는다).
import { createHmac } from 'node:crypto';
import { Gauge, type Registry } from '@prometheus-io/client';
import type { Clock } from './clock.js';

/** 라벨 키를 믿는 시간 [가정]. 받은 지 이만큼 지나면 쓰지 않는다 */
export const INV_REF_KEY_TTL_MS = 10 * 60_000;
/** 받지 못한 라벨 키를 다시 받는 간격 [가정]. 뒤에는 정기 받기로 돌아간다(KMS 요청이 늘지 않게) */
export const INV_REF_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000];
/** 다시 받기 간격에 더하는 흔들림의 비율 [가정](파드가 한꺼번에 부르지 않게) */
const RETRY_JITTER = 0.2;
/** 지문을 만드는 고정 문구. 두 서비스가 같은 라벨 키를 받았는지 값을 드러내지 않고 견준다 */
const FINGERPRINT_INPUT = 'PEAKET-inv-ref-fingerprint-v1';
/** 지문의 길이(판 접두어 포함) */
const FINGERPRINT_LENGTH = 8;

/** 라벨 키를 받을 때 KMS에 MAC할 글 */
export const labelKeyMessage = (label: string): Uint8Array => Buffer.from(`PEAKET-inv-ref-v1|${label}`, 'utf8');

export function invRef(labelKey: Uint8Array, version: number, value: string): string {
  return `k${version}.${createHmac('sha256', labelKey).update(value, 'utf8').digest('base64url')}`;
}

/** GenerateMac을 부르는 것(시작 파일이 KMS 클라이언트를 넣는다, 시험은 대역) */
export interface LabelMacClient {
  mac(keyId: string, message: Uint8Array): Promise<Uint8Array>;
}

type KeySource = { version: number; kmsKeyId: string } | { version: number; key: Buffer };
/** 라벨 하나의 키. previous·bridgeUntil은 키 회전의 이음 기간에만(옛 판은 새 판보다 작다) */
export type LabelSource<L extends string = string> = KeySource & { label: L; previous?: KeySource; bridgeUntil?: number };
/** NO_KEY: 운영·스테이징에 그 라벨의 키 설정이 없다 */
export type MissingReason = 'THROTTLED' | 'KMS_ERROR' | 'NO_KEY';
type Job<L extends string> = { label: L; k: KeySource };

export const KMS_ENDPOINT_ENV = 'PEAKET_KMS_ENDPOINT';
/** KMS 흉내 서버 주소를 받는 환경 */
const LOCAL_ENVS = ['local', 'ci'];
/** 라벨 키 값 설정을 받는 환경. 운영·스테이징은 KMS 키만 */
const KEY_VALUE_ENVS = ['local', 'ci', 'demo'];
const THROTTLE_NAMES = ['ThrottlingException', 'LimitExceededException', 'TooManyRequestsException'];

interface Held {
  key: Buffer;
  /** 이때까지 쓴다(로컬 값은 끝이 없다) */
  until: number;
}
const slot = (label: string, version: number) => `${label}|${version}`;
const keyIdOf = (x: string) => x.slice(x.lastIndexOf('key/') >= 0 ? x.lastIndexOf('key/') + 4 : 0);

/** 라벨의 환경 변수 앞머리 */
export const invRefEnvPrefix = (label: string): string => `PEAKET_INV_REF_${label.toUpperCase()}`;

/** 설정의 키 하나(KMS 키 ID 또는 local·ci·demo의 라벨 키 값) */
function keySourceOf(env: Record<string, string | undefined>, prefix: string, version: number, valuesAllowed: boolean): KeySource | null {
  const kms = env[`${prefix}_KMS_KEY`];
  const raw = env[`${prefix}_KEY`];
  if (kms) return { version, kmsKeyId: kms };
  if (!raw) return null;
  if (!valuesAllowed) throw new Error(`${prefix}_KEY(라벨 키 값)는 ${KEY_VALUE_ENVS.join('·')}에서만 쓴다. 운영은 ${prefix}_KMS_KEY`);
  return { version, key: Buffer.from(raw, 'base64') };
}

/**
 * 설정에서 라벨 키의 출처를 읽는다. 라벨마다 `PEAKET_INV_REF_<라벨>_KMS_KEY`(local·ci·demo는 `…_KEY`)와 판 `…_KEY_VERSION`,
 * 이음 기간이면 옛 판 `…_PREVIOUS_KMS_KEY`(`…_PREVIOUS_KEY`)·`…_PREVIOUS_KEY_VERSION`과 이음 끝 `…_BRIDGE_UNTIL`(ISO 시각)을 읽는다. previous가 false면 옛 판을 읽지 않는다
 */
export function invRefSourcesFromEnv<L extends string>(
  env: Record<string, string | undefined>,
  labels: readonly L[],
  o: { previous?: boolean } = {},
): { sources: LabelSource<L>[]; warnings: string[]; endpoint: string | undefined; needsKms: boolean; countUnconfigured: boolean } {
  const peaketEnv = env.PEAKET_ENV ?? 'prod';
  const local = LOCAL_ENVS.includes(peaketEnv);
  const values = KEY_VALUE_ENVS.includes(peaketEnv);
  const endpoint = env[KMS_ENDPOINT_ENV];
  if (endpoint && !local) throw new Error(`${KMS_ENDPOINT_ENV}는 ${LOCAL_ENVS.join('·')}에서만 쓴다(지금 ${peaketEnv})`);
  const sources: LabelSource<L>[] = [];
  const warnings: string[] = [];
  for (const label of labels) {
    const p = invRefEnvPrefix(label);
    const current = keySourceOf(env, p, Number(env[`${p}_KEY_VERSION`] ?? '1'), values);
    if (!current) {
      warnings.push(`${p}_KMS_KEY·${p}_KEY가 없어 ${label} 조사용 가명 칸을 늘 비운다`);
      continue;
    }
    const previous = o.previous === false ? null : keySourceOf(env, `${p}_PREVIOUS`, Number(env[`${p}_PREVIOUS_KEY_VERSION`] ?? '0'), values);
    const untilRaw = env[`${p}_BRIDGE_UNTIL`];
    const until = untilRaw ? Date.parse(untilRaw) : undefined;
    if (untilRaw && Number.isNaN(until)) throw new Error(`${p}_BRIDGE_UNTIL이 ISO 시각이 아니다: ${untilRaw}`);
    sources.push({ label, ...current, ...(previous ? { previous, ...(until !== undefined ? { bridgeUntil: until } : {}) } : {}) });
  }
  const needsKms = sources.some((s) => 'kmsKeyId' in s || (s.previous && 'kmsKeyId' in s.previous));
  // 운영·스테이징에 키 설정이 없으면 칸이 늘 빈다. 시작은 막지 않고 지표로 드러낸다(부가 신호 때문에 서비스를 멈추지 않는다)
  return { sources, warnings, endpoint, needsKms, countUnconfigured: !values };
}

export class InvRefKeyRing<L extends string = string> {
  readonly #sources: LabelSource<L>[];
  readonly #client: LabelMacClient | undefined;
  readonly #clock: Clock;
  readonly #held = new Map<string, Held>();
  /** 마지막으로 받지 못한 까닭(받은 적이 없으면 KMS_ERROR로 센다) */
  readonly #lastError = new Map<string, MissingReason>();
  #onMissing: (label: L, reason: MissingReason) => void;
  #onRefreshError: (label: L, reason: MissingReason, err: unknown) => void = () => {};
  #onFingerprint: ((label: L, version: number, fingerprint: string) => void) | undefined;
  /** 판마다 마지막으로 알린 지문(같은 키를 다시 받아도 또 알리지 않는다) */
  readonly #fingerprints = new Map<string, string>();
  readonly #countUnconfigured: boolean;

  constructor(o: { sources: LabelSource<L>[]; client?: LabelMacClient; clock: Clock; onMissing?: (label: L, reason: MissingReason) => void; countUnconfigured?: boolean }) {
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
    this.#countUnconfigured = o.countUnconfigured === true;
    for (const s of o.sources) for (const k of [s, ...(s.previous ? [s.previous] : [])]) if ('key' in k) this.#held.set(slot(s.label, k.version), { key: Buffer.from(k.key), until: Number.POSITIVE_INFINITY });
  }

  /** 비울 때 세는 곳을 단다(시작 파일이 지표에 잇는다) */
  onMissing(f: (label: L, reason: MissingReason) => void): this {
    this.#onMissing = f;
    return this;
  }

  /** 다시 받지 못했을 때 부른다(시작 파일이 경고 로그로 잇는다. 권한 거부 같은 설정 오류가 조용한 때에도 보이게) */
  onRefreshError(f: (label: L, reason: MissingReason, err: unknown) => void): this {
    this.#onRefreshError = f;
    return this;
  }

  /**
   * 라벨 키의 지문을 알릴 곳을 단다(시작 파일이 시작 로그와 정보 지표에 잇는다). 이미 가진 키는 바로 알린다. 지문은 고정 문구의 invRef 앞 8자이고 키 값이 아니다.
   * 두 서비스의 지문이 다르면 키가 다르다는 뜻이다(B-T16, 배포 조건은 ADR-0251)
   */
  onFingerprint(f: (label: L, version: number, fingerprint: string) => void): this {
    this.#onFingerprint = f;
    this.#fingerprints.clear();
    for (const s of this.#sources) {
      for (const k of [s, ...(s.previous ? [s.previous] : [])]) {
        const h = this.#held.get(slot(s.label, k.version));
        if (h && h.until > this.#clock.now()) this.#tellFingerprint(s.label, k.version, h.key);
      }
    }
    return this;
  }

  #tellFingerprint(label: L, version: number, key: Buffer): void {
    const id = slot(label, version);
    const fingerprint = invRef(key, version, FINGERPRINT_INPUT).slice(0, FINGERPRINT_LENGTH);
    if (this.#fingerprints.get(id) === fingerprint) return;
    this.#fingerprints.set(id, fingerprint);
    this.#onFingerprint?.(label, version, fingerprint);
  }

  /** 라벨 키 하나를 받는다. 받지 못하면 까닭만 적고 들고 있던 키는 수명까지 둔다 */
  async #fetch({ label, k }: Job<L>): Promise<boolean> {
    if (!('kmsKeyId' in k)) return true;
    const id = slot(label, k.version);
    try {
      const key = Buffer.from(await this.#client!.mac(k.kmsKeyId, labelKeyMessage(label)));
      if (key.length !== 32) throw new Error('라벨 키가 32바이트가 아니다');
      this.#held.set(id, { key, until: this.#clock.now() + INV_REF_KEY_TTL_MS });
      this.#lastError.delete(id);
      this.#tellFingerprint(label, k.version, key);
      return true;
    } catch (e) {
      const reason = THROTTLE_NAMES.includes((e as { name?: string }).name ?? '') ? 'THROTTLED' : 'KMS_ERROR';
      this.#lastError.set(id, reason);
      this.#onRefreshError(label, reason, e);
      return false;
    }
  }

  /** KMS 라벨 키를 모두 받고 받지 못한 것을 돌려준다(이음 기간이 지난 옛 판은 받지 않는다) */
  async #fetchAll(): Promise<Job<L>[]> {
    const now = this.#clock.now();
    const jobs = this.#sources.flatMap((s): Job<L>[] => [
      { label: s.label, k: s as KeySource },
      ...(s.previous && (s.bridgeUntil ?? 0) > now ? [{ label: s.label, k: s.previous }] : []),
    ]);
    const results = await Promise.all(jobs.map((j) => this.#fetch(j)));
    return jobs.filter((_, i) => !results[i]);
  }

  /** KMS 라벨 키를 모두 다시 받는다. 받지 못한 키는 까닭만 적고 들고 있던 키는 수명까지 둔다 */
  async refresh(): Promise<void> {
    await this.#fetchAll();
  }

  /**
   * 지금 받고 그 뒤 5분 [가정]마다 다시 받는다. ready는 첫 받기가 끝나거나 waitMs가 지나면 풀린다(뜰 때 라벨 키를 먼저 받되 KMS가 느려도 시작을 막지 않는다,
   * docs/security/secrets-and-keys.md '호출량'). 받지 못한 키만 15·30·60초 [가정]에 흔들림을 더해 다시 받고, 그래도 안 되면 정기 받기로 돌아간다. stop은 다시 받기를 멈춘다
   */
  start(o: { everyMs?: number; waitMs?: number; retryDelaysMs?: readonly number[]; random?: () => number } = {}): { stop: () => void; ready: Promise<void> } {
    const kms = this.#sources.some((s) => 'kmsKeyId' in s || (s.previous && 'kmsKeyId' in s.previous));
    if (!kms) return { stop: () => {}, ready: Promise.resolve() };
    const delays = o.retryDelaysMs ?? INV_REF_RETRY_DELAYS_MS;
    const random = o.random ?? Math.random;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const retrying = new Set<string>();
    let stopped = false;
    const retry = (job: Job<L>, attempt: number): void => {
      const id = slot(job.label, job.k.version);
      const base = delays[attempt];
      if (base === undefined) {
        retrying.delete(id);
        return;
      }
      const t = setTimeout(() => {
        timers.delete(t);
        // 그사이 정기 받기가 받았으면 더 부르지 않는다
        if (stopped || !this.#lastError.has(id)) {
          retrying.delete(id);
          return;
        }
        void this.#fetch(job).then((ok) => {
          if (ok) retrying.delete(id);
          else if (!stopped) retry(job, attempt + 1);
        });
      }, base * (1 + RETRY_JITTER * random()));
      t.unref?.();
      timers.add(t);
    };
    const run = (): Promise<void> =>
      this.#fetchAll().then((failed) => {
        if (stopped) return;
        for (const job of failed) {
          const id = slot(job.label, job.k.version);
          if (retrying.has(id)) continue;
          retrying.add(id);
          retry(job, 0);
        }
      });
    const first = run();
    const h = setInterval(() => void run(), o.everyMs ?? INV_REF_KEY_TTL_MS / 2);
    h.unref?.();
    let t: ReturnType<typeof setTimeout> | undefined;
    const ready = Promise.race([first, new Promise<void>((r) => (t = setTimeout(r, o.waitMs ?? 2_000)))]).finally(() => clearTimeout(t));
    return {
      stop: () => {
        stopped = true;
        clearInterval(h);
        for (const x of timers) clearTimeout(x);
        timers.clear();
      },
      ready,
    };
  }

  /** 지금 쓰는(새) 판의 값. 라벨 키가 없으면 비우고 센다 */
  ref(label: L, value: string): string | undefined {
    const s = this.#sources.find((x) => x.label === label);
    if (!s) {
      if (this.#countUnconfigured) this.#onMissing(label, 'NO_KEY');
      return undefined;
    }
    const h = this.#held.get(slot(label, s.version));
    if (!h || h.until <= this.#clock.now()) {
      this.#onMissing(label, this.#lastError.get(slot(label, s.version)) ?? 'KMS_ERROR');
      return undefined;
    }
    return invRef(h.key, s.version, value);
  }

  /** 이음 기간에만: 옛 판의 값(대응을 남기는 데만 쓴다. 없으면 undefined이고 세지 않는다) */
  prevRef(label: L, value: string): string | undefined {
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
      // 이음 기간인데 옛 판 키가 없으면 대응을 잃으므로 센다
      this.#onMissing(label, this.#lastError.get(id) ?? 'KMS_ERROR');
      return undefined;
    }
    return invRef(h.key, s.previous.version, value);
  }

  /** 그 라벨의 지금 판(없으면 null) */
  writeVersion(label: L): number | null {
    return this.#sources.find((x) => x.label === label)?.version ?? null;
  }

  /** 그 라벨의 이음(옛 판과 이음 끝). 이음이 없으면 null. 이음 끝이 지나도 설정이 남아 있으면 준다(옛 판 지우기가 쓴다) */
  bridgeOf(label: L): { prevVersion: number; until: number } | null {
    const s = this.#sources.find((x) => x.label === label);
    return s?.previous && s.bridgeUntil !== undefined ? { prevVersion: s.previous.version, until: s.bridgeUntil } : null;
  }

  toJSON(): string {
    return '[InvRefKeyRing]';
  }
}

/** 라벨 키 지문을 알리는 정보 지표(값은 늘 1, 지문은 키 값이 아니다). 서비스끼리 값을 견주어 같은 키를 쓰는지 본다 */
export function invRefKeyInfoGauge(registry: Registry, service: string): (label: string, version: number, fingerprint: string) => void {
  const gauge = new Gauge({ name: 'inv_ref_key_info', help: '조사용 가명 라벨 키의 지문(고정 문구의 invRef 앞 8자, 키 값이 아니다). 서비스끼리 값이 같아야 한다', labelNames: ['service', 'label', 'version', 'fingerprint'] as const, registers: [registry] });
  return (label, version, fingerprint) => gauge.set({ service, label, version: String(version), fingerprint }, 1);
}
