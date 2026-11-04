// 조사용 가명의 라벨 키 링(docs/features/identity.md §9.1 '조사용 값의 첫 구현', docs/security/secrets-and-keys.md '조사용 가명 키', BUILD_ORDER BOT-045).
// 라벨마다 KMS GenerateMac으로 라벨 키를 받아 메모리에만 두고 10분 [가정]마다 다시 받는다. 받은 지 10분이 지나면 쓰지 않는다(칸을 비우고 까닭을 센다).
// 로컬·CI는 라벨 키 값 자체를 설정으로 받을 수 있다(그 키는 늘 쓴다). 판은 라벨마다 하나다(이음 기간의 두 판은 BUILD_ORDER BOT-046).
import { type Clock } from '@peaket/platform';
import { INV_REF_KEY_TTL_MS, INV_REF_LABELS, invRef, type InvRefLabel, labelKeyMessage } from '../domain/inv-ref.js';
import type { InvRefs } from '../domain/ports.js';

/** GenerateMac을 부르는 것(main이 KMS 클라이언트를 넣는다, 시험은 대역) */
export interface LabelMacClient {
  mac(keyId: string, message: Uint8Array): Promise<Uint8Array>;
}

export type LabelSource = { label: InvRefLabel; version: number; kmsKeyId: string } | { label: InvRefLabel; version: number; key: Buffer };
export type MissingReason = 'THROTTLED' | 'KMS_ERROR';

const ENV: Record<InvRefLabel, { kms: string; raw: string; version: string }> = {
  device: { kms: 'PEAKET_INV_REF_DEVICE_KMS_KEY', raw: 'PEAKET_INV_REF_DEVICE_KEY', version: 'PEAKET_INV_REF_DEVICE_KEY_VERSION' },
  contact: { kms: 'PEAKET_INV_REF_CONTACT_KMS_KEY', raw: 'PEAKET_INV_REF_CONTACT_KEY', version: 'PEAKET_INV_REF_CONTACT_KEY_VERSION' },
};
export const KMS_ENDPOINT_ENV = 'PEAKET_KMS_ENDPOINT';
const LOCAL_ENVS = ['local', 'ci'];
const THROTTLE_NAMES = ['ThrottlingException', 'LimitExceededException', 'TooManyRequestsException'];

interface Held {
  key: Buffer;
  /** 이때까지 쓴다(로컬 값은 끝이 없다) */
  until: number;
}

export class InvRefKeyRing implements InvRefs {
  readonly #sources: LabelSource[];
  readonly #client: LabelMacClient | undefined;
  readonly #clock: Clock;
  readonly #held = new Map<InvRefLabel, Held>();
  /** 마지막으로 받지 못한 까닭(받은 적이 없으면 KMS_ERROR로 센다) */
  readonly #lastError = new Map<InvRefLabel, MissingReason>();
  #onMissing: (label: InvRefLabel, reason: MissingReason) => void;
  #onRefreshError: (label: InvRefLabel, reason: MissingReason, err: unknown) => void = () => {};

  constructor(o: { sources: LabelSource[]; client?: LabelMacClient; clock: Clock; onMissing?: (label: InvRefLabel, reason: MissingReason) => void }) {
    const labels = o.sources.map((s) => s.label);
    if (new Set(labels).size !== labels.length) throw new Error('라벨마다 라벨 키 하나다(이음 기간은 BOT-046)');
    for (const s of o.sources) {
      if (!(Number.isInteger(s.version) && s.version > 0)) throw new Error(`${s.label} 라벨 키 판은 양의 정수다`);
      if ('key' in s && s.key.length !== 32) throw new Error(`${s.label} 라벨 키는 32바이트다`);
      if ('kmsKeyId' in s && (s.kmsKeyId.startsWith('alias/') || s.kmsKeyId.includes(':alias/'))) throw new Error('KMS 별칭은 받지 않는다(키 ID나 키 ARN)');
    }
    if (o.sources.some((s) => 'kmsKeyId' in s) && !o.client) throw new Error('KMS 라벨 키에는 GenerateMac 클라이언트가 있어야 한다');
    // 라벨마다 다른 KMS 키다(같으면 두 라벨의 값이 이어진다). 키 ID와 키 ARN을 섞어 줘도 알아보게 'key/' 뒤를 견준다
    const kmsIds = o.sources.flatMap((s) => ('kmsKeyId' in s ? [s.kmsKeyId.slice(s.kmsKeyId.lastIndexOf('key/') >= 0 ? s.kmsKeyId.lastIndexOf('key/') + 4 : 0)] : []));
    if (new Set(kmsIds).size !== kmsIds.length) throw new Error('라벨마다 다른 KMS 키여야 한다');
    this.#sources = o.sources;
    this.#client = o.client;
    this.#clock = o.clock;
    this.#onMissing = o.onMissing ?? (() => {});
    for (const s of o.sources) if ('key' in s) this.#held.set(s.label, { key: Buffer.from(s.key), until: Number.POSITIVE_INFINITY });
  }

  /** 설정에서 만든다. client는 KMS 키가 하나라도 있을 때 쓴다(main이 kmsMacClient로 만든다) */
  static fromEnv(
    env: Record<string, string | undefined>,
    clock: Clock,
    client?: (endpoint: string | undefined) => LabelMacClient,
    /** 받을 라벨(relay는 contact만) */
    labels: readonly InvRefLabel[] = INV_REF_LABELS,
  ): { ring: InvRefKeyRing; warnings: string[] } {
    const peaketEnv = env.PEAKET_ENV ?? 'prod';
    const local = LOCAL_ENVS.includes(peaketEnv);
    const endpoint = env[KMS_ENDPOINT_ENV];
    if (endpoint && !local) throw new Error(`${KMS_ENDPOINT_ENV}는 ${LOCAL_ENVS.join('·')}에서만 쓴다(지금 ${peaketEnv})`);
    const sources: LabelSource[] = [];
    const warnings: string[] = [];
    for (const label of labels) {
      const e = ENV[label];
      const version = Number(env[e.version] ?? '1');
      if (env[e.kms]) sources.push({ label, version, kmsKeyId: env[e.kms]! });
      else if (env[e.raw]) {
        if (!local) throw new Error(`${e.raw}(라벨 키 값)는 ${LOCAL_ENVS.join('·')}에서만 쓴다. 운영은 ${e.kms}`);
        sources.push({ label, version, key: Buffer.from(env[e.raw]!, 'base64') });
      } else warnings.push(`${e.kms}·${e.raw}가 없어 ${label} 조사용 가명 칸을 늘 비운다(identity §9.1)`);
    }
    const needsKms = sources.some((s) => 'kmsKeyId' in s);
    return { ring: new InvRefKeyRing({ sources, clock, ...(needsKms && client ? { client: client(endpoint) } : {}) }), warnings };
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

  /** KMS 라벨 키를 모두 다시 받는다. 받지 못한 라벨은 까닭만 적고 들고 있던 키는 수명까지 둔다 */
  async refresh(): Promise<void> {
    await Promise.all(
      this.#sources.map(async (s) => {
        if (!('kmsKeyId' in s)) return;
        try {
          const key = Buffer.from(await this.#client!.mac(s.kmsKeyId, labelKeyMessage(s.label)));
          if (key.length !== 32) throw new Error('라벨 키가 32바이트가 아니다');
          this.#held.set(s.label, { key, until: this.#clock.now() + INV_REF_KEY_TTL_MS });
          this.#lastError.delete(s.label);
        } catch (e) {
          const reason = THROTTLE_NAMES.includes((e as { name?: string }).name ?? '') ? 'THROTTLED' : 'KMS_ERROR';
          this.#lastError.set(s.label, reason);
          this.#onRefreshError(s.label, reason, e);
        }
      }),
    );
  }

  /**
   * 지금 받고 그 뒤 5분 [가정]마다 다시 받는다. ready는 첫 받기가 끝나거나 waitMs가 지나면 풀린다(뜰 때 라벨 키를 먼저 받되 KMS가 느려도 시작을 막지 않는다,
   * docs/security/secrets-and-keys.md '호출량'). stop은 다시 받기를 멈춘다
   */
  start(o: { everyMs?: number; waitMs?: number } = {}): { stop: () => void; ready: Promise<void> } {
    if (!this.#sources.some((s) => 'kmsKeyId' in s)) return { stop: () => {}, ready: Promise.resolve() };
    const first = this.refresh();
    const h = setInterval(() => void this.refresh(), o.everyMs ?? INV_REF_KEY_TTL_MS / 2);
    h.unref?.();
    let t: ReturnType<typeof setTimeout> | undefined;
    const ready = Promise.race([first, new Promise<void>((r) => (t = setTimeout(r, o.waitMs ?? 2_000)))]).finally(() => clearTimeout(t));
    return { stop: () => clearInterval(h), ready };
  }

  ref(label: InvRefLabel, value: string): string | undefined {
    const s = this.#sources.find((x) => x.label === label);
    if (!s) return undefined;
    const h = this.#held.get(label);
    if (!h || h.until <= this.#clock.now()) {
      this.#onMissing(label, this.#lastError.get(label) ?? 'KMS_ERROR');
      return undefined;
    }
    return invRef(h.key, s.version, value);
  }

  toJSON(): string {
    return '[InvRefKeyRing]';
  }
}
