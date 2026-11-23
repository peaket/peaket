// 회차 가명(docs/streaming.md §6.2, docs/features/analytics.md §3.3, OPS-200, F-04-3).
// - 회차 키 = HMAC(분석 가명 키, "PEAKET-analytics-v1" ‖ 회차 ID). 운영은 KMS GenerateMac(HMAC_SHA_256)으로 파드마다 회차당 한 번 얻어
//   메모리에만 둔다. local·ci는 설정의 32바이트 키로 같은 식을 몸 안에서 계산한다(KMS가 없다, 추천 적용 2026-11-23, F-04-3 계획)
// - 가명 = HMAC-SHA256(회차 키, 식별값)의 256비트 전체(16진수 64자). 같은 사람이라도 회차가 다르면 다르다
// - 회차 키를 얻지 못하면 던진다(fail-closed). 싱크가 묶음 쓰기를 실패로 돌려 실행기가 그 파티션을 멈추고 다시 시도한다(원문을 쓰지 않는다)
// - 키와 회차 키는 디스크·로그에 쓰지 않는다(toJSON·toString이 이름만 준다)
import { createHmac, createSecretKey, type KeyObject } from 'node:crypto';
import { GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';

export const PSEUDONYM_DOMAIN = 'PEAKET-analytics-v1';
const KEY_BYTES = 32;
/** 회차 키를 메모리에 두는 상한 [가정](한 파드가 동시에 받는 회차 수보다 넉넉하게) */
export const EVENT_KEY_CACHE = 2_048;

/** 회차 키를 얻지 못했다(KMS 실패·시간 초과). 원문을 쓰지 않고 다시 시도한다 */
export class EventKeyUnavailable extends Error {
  override readonly name = 'EventKeyUnavailable';
}

export interface EventKeySource {
  /** 키 판(브론즈 행의 key_version) */
  readonly version: string;
  /** HMAC(분석 가명 키, 영역 ‖ 회차 ID) */
  eventKey(eventId: string): Promise<Buffer>;
}

/** local·ci: 설정의 32바이트 키로 몸 안에서 계산한다 */
export class LocalEventKeySource implements EventKeySource {
  readonly #key: KeyObject;
  constructor(
    key: Buffer,
    readonly version: string,
  ) {
    if (key.length !== KEY_BYTES) throw new Error(`분석 가명 키는 ${KEY_BYTES}바이트여야 한다`);
    this.#key = createSecretKey(Buffer.from(key));
  }
  async eventKey(eventId: string): Promise<Buffer> {
    return createHmac('sha256', this.#key).update(`${PSEUDONYM_DOMAIN}${eventId}`, 'utf8').digest();
  }
  toJSON() {
    return '[LocalEventKeySource]';
  }
}

/** 운영: KMS GenerateMac(HMAC_SHA_256). 키 ID는 별칭이나 ARN */
export class KmsEventKeySource implements EventKeySource {
  readonly #client: Pick<KMSClient, 'send'>;
  constructor(
    private readonly keyId: string,
    readonly version: string,
    o: { region?: string; client?: Pick<KMSClient, 'send'> } = {},
  ) {
    this.#client = o.client ?? new KMSClient({ ...(o.region ? { region: o.region } : {}), maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 3_000, throwOnRequestTimeout: true } });
  }
  async eventKey(eventId: string): Promise<Buffer> {
    try {
      const r = await this.#client.send(new GenerateMacCommand({ KeyId: this.keyId, MacAlgorithm: 'HMAC_SHA_256', Message: Buffer.from(`${PSEUDONYM_DOMAIN}${eventId}`, 'utf8') }));
      if (!r.Mac || r.Mac.byteLength !== KEY_BYTES) throw new Error('GenerateMac 응답에 32바이트 MAC이 없다');
      return Buffer.from(r.Mac);
    } catch (err) {
      throw new EventKeyUnavailable(err instanceof Error ? err.name : 'kms');
    }
  }
  toJSON() {
    return '[KmsEventKeySource]';
  }
}

/** 회차마다 키를 한 번 얻어 메모리에 두는 가명기 */
export class EventPseudonymizer {
  readonly #keys = new Map<string, KeyObject>();
  readonly #pending = new Map<string, Promise<KeyObject>>();

  constructor(readonly source: EventKeySource) {}

  get version(): string {
    return this.source.version;
  }

  /** 회차 키를 준비한다. 실패하면 EventKeyUnavailable(캐시에 넣지 않는다) */
  async prepare(eventId: string): Promise<void> {
    if (this.#keys.has(eventId)) return;
    let p = this.#pending.get(eventId);
    if (!p) {
      p = this.source
        .eventKey(eventId)
        .then((raw) => {
          if (this.#keys.size >= EVENT_KEY_CACHE) this.#keys.delete(this.#keys.keys().next().value!);
          const k = createSecretKey(raw);
          this.#keys.set(eventId, k);
          return k;
        })
        .catch((err: unknown) => {
          throw err instanceof EventKeyUnavailable ? err : new EventKeyUnavailable(err instanceof Error ? err.name : 'key');
        })
        .finally(() => this.#pending.delete(eventId));
      this.#pending.set(eventId, p);
    }
    await p;
  }

  /** prepare한 회차의 가명 함수. 준비하지 않은 회차면 던진다(원문을 내보내지 않게) */
  forEvent(eventId: string): (value: string) => string {
    const k = this.#keys.get(eventId);
    if (!k) throw new EventKeyUnavailable(`회차 키 없음`);
    return (value) => createHmac('sha256', k).update(value, 'utf8').digest('hex');
  }

  toJSON() {
    return '[EventPseudonymizer]';
  }
}

/** 설정으로 키 원천을 고른다: PEAKET_ANALYTICS_KMS_KEY_ID가 있으면 KMS, 없으면 local·ci에서만 PEAKET_ANALYTICS_PSEUDONYM_KEY(base64 32바이트) */
export function eventKeySourceFromEnv(env: Record<string, string | undefined>): EventKeySource {
  const version = env.PEAKET_ANALYTICS_KEY_VERSION || 'v1';
  if (env.PEAKET_ANALYTICS_KMS_KEY_ID) return new KmsEventKeySource(env.PEAKET_ANALYTICS_KMS_KEY_ID, version, { ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}) });
  if (env.PEAKET_ENV !== 'local' && env.PEAKET_ENV !== 'ci') throw new Error(`PEAKET_ENV=${env.PEAKET_ENV ?? '(없음)'}에서는 PEAKET_ANALYTICS_KMS_KEY_ID가 있어야 한다`);
  const raw = env.PEAKET_ANALYTICS_PSEUDONYM_KEY;
  const key = raw ? Buffer.from(raw, 'base64') : undefined;
  if (!key || key.length !== KEY_BYTES) throw new Error('PEAKET_ANALYTICS_PSEUDONYM_KEY(base64 32바이트)가 없다');
  return new LocalEventKeySource(key, `local-${version}`);
}
