// 입장 토큰 공개키 묶음 주기 읽기(docs/features/seat-hold.md §2 '입장 토큰 공개키 묶음 주기 읽기', ADR-0288 결정 7, BUILD_ORDER PRF-137, 묶음 BAT-057).
// 묶음은 queue-svc GET /internal/jwks/admission.json(PEAKET_ADMISSION_JWKS_URL)이다. 정한 값([가정]):
// - 읽는 때: start() 때 바로, 처음 받기 전에는 1초마다, 받은 뒤에는 5분마다 배경에서. 한 번 읽기의 시간 한도는 1초다.
// - 실패(오류 응답·연결 실패 error, 시간 초과 timeout, 빈 keys·틀린 모양 invalid): 마지막 묶음을 그대로 쓰고(끝 없이) 30초 뒤 다시 읽는다.
// - 모르는 kid: 그 요청이 다시 읽기 한 번을 기다린다(돌고 있는 읽기가 있으면 거기에 붙고, 새로 읽는 것은 30초에 한 번, 기다림은 1초까지).
// - 한 번도 받지 못했으면 keysFor는 돌고 있는 읽기만 1초까지 기다리고(새로 읽지 않는다) 그래도 없으면 AdmissionKeysUnavailable을 던진다
//   (받는 층이 503 dependency-unavailable). 준비 상태는 막지 않는다.
// - 끝 시각(peaket_until)은 묶음 확인(verifyAdmissionToken)이 키마다 지킨다.
// 지표: purchase_admission_jwks_age_seconds(마지막으로 받은 뒤 지난 초, 받은 적이 없으면 만든 뒤 지난 초), purchase_admission_jwks_fetch_failures_total{reason}.
// 시계·타이머는 주입한 clock과 전역 setTimeout을 쓴다(시험은 가짜 타이머로 몬다). 부르기는 공용 호출 클라이언트(createExternalHttpClient: 경로 틀 span,
// 추적 머리 안 실음, 리디렉트 따르지 않음, 시간 한도)로 한다(ASVS 15.3.2, ADR-0259).
import { AsyncResource } from 'node:async_hooks';
import { Counter, createExternalHttpClient, type ExternalHttpClient, Gauge, type Registry } from '@peaket/platform';
import { type AdmissionKeyMap, type AdmissionKeys, type AdmissionKeySource, AdmissionKeysUnavailable, parseAdmissionJwks } from '../domain/admission-token.js';

/** 받은 뒤 다시 읽는 주기 5분 [가정] */
export const ADMISSION_JWKS_REFRESH_MS = 5 * 60_000;
/** 받은 적이 있을 때 실패 뒤 다시 읽기까지 30초 [가정] */
export const ADMISSION_JWKS_RETRY_MS = 30_000;
/** 처음 받기 전 다시 읽는 주기 1초 [가정] */
export const ADMISSION_JWKS_FIRST_RETRY_MS = 1_000;
/** 한 번 읽기의 시간 한도 1초 [가정] */
export const ADMISSION_JWKS_TIMEOUT_MS = 1_000;
/** 모르는 kid 때문에 새로 읽는 간격 30초 [가정] */
export const ADMISSION_JWKS_UNKNOWN_KID_MS = 30_000;
/** 모르는 kid 요청이 다시 읽기를 기다리는 한도 1초 */
export const ADMISSION_JWKS_UNKNOWN_KID_WAIT_MS = 1_000;
/** 받는 본문 크기 상한(넘으면 틀린 모양) */
const MAX_BODY_CHARS = 64 * 1024;

export const ADMISSION_JWKS_FAILURE_REASONS = ['error', 'timeout', 'invalid'] as const;
export type AdmissionJwksFailureReason = (typeof ADMISSION_JWKS_FAILURE_REASONS)[number];

export interface AdmissionJwksLoaderOptions {
  /** 묶음 주소(PEAKET_ADMISSION_JWKS_URL, http·https) */
  url: string;
  /** 시험은 대역 fetch를 넣는다(공용 호출 클라이언트에 넘긴다. 기본 전역 fetch) */
  fetch?: typeof fetch;
  /** 지금(epoch ms). 기본 Date.now */
  clock?: { now(): number };
  logger?: { warn(obj: object, msg: string): void };
  /** 있으면 지표 둘을 붙인다(나중에 register로 붙여도 된다) */
  registry?: Registry;
}

class ReadFailed extends Error {
  constructor(readonly reason: AdmissionJwksFailureReason) {
    super(`입장 토큰 공개키 묶음 읽기 실패: ${reason}`);
    this.name = 'AdmissionJwksReadFailed';
  }
}

export class AdmissionJwksLoader implements AdmissionKeySource {
  readonly #client: ExternalHttpClient;
  readonly #path: string;
  /** 만든 때의 비동기 문맥에서 돌린다: 요청 안에서 시작한 다시 읽기가 그 요청의 남은 시간·로그 줄에 묶이지 않게(뒤의 배경 반복도 같다) */
  readonly #detached: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly #clock: { now(): number };
  readonly #logger: AdmissionJwksLoaderOptions['logger'];
  readonly #createdAtMs: number;
  #keys: AdmissionKeyMap | undefined;
  #receivedAtMs: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inflight: Promise<void> | undefined;
  #lastUnknownKidReadMs: number | undefined;
  #started = false;
  #stopped = false;
  readonly #failures = new Counter({
    name: 'purchase_admission_jwks_fetch_failures_total',
    help: '입장 토큰 공개키 묶음 읽기 실패 수(reason: error·timeout·invalid, seat-hold §2 입장 토큰 공개키 묶음 주기 읽기)',
    labelNames: ['reason'] as const,
    registers: [],
  });
  readonly #age: Gauge;

  constructor(o: AdmissionJwksLoaderOptions) {
    let u: URL;
    try {
      u = new URL(o.url);
    } catch {
      throw new Error('PEAKET_ADMISSION_JWKS_URL이 주소가 아니다');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('PEAKET_ADMISSION_JWKS_URL은 http·https 주소다');
    if (u.search || u.hash || u.username || u.password || /[{}]/.test(u.pathname)) throw new Error('PEAKET_ADMISSION_JWKS_URL은 쿼리·조각·사용자 정보가 없는 주소다');
    this.#path = u.pathname;
    this.#client = createExternalHttpClient({ provider: 'queue-svc-jwks', baseUrl: u.origin, timeoutCapMs: ADMISSION_JWKS_TIMEOUT_MS, ...(o.fetch ? { fetch: o.fetch } : {}) });
    this.#clock = o.clock ?? { now: () => Date.now() };
    this.#detached = AsyncResource.bind(<T>(fn: () => Promise<T>) => fn());
    this.#logger = o.logger;
    this.#createdAtMs = this.#clock.now();
    const ageOf = () => (this.#clock.now() - (this.#receivedAtMs ?? this.#createdAtMs)) / 1000;
    this.#age = new Gauge({
      name: 'purchase_admission_jwks_age_seconds',
      help: '입장 토큰 공개키 묶음을 마지막으로 받은 뒤 지난 초(받은 적이 없으면 시작 뒤 지난 초)',
      registers: [],
      collect() {
        this.set(Math.max(0, ageOf()));
      },
    });
    for (const reason of ADMISSION_JWKS_FAILURE_REASONS) this.#failures.inc({ reason }, 0);
    if (o.registry) this.register(o.registry);
  }

  /** 지표 둘을 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#age);
    registry.registerMetric(this.#failures);
    return this;
  }

  /** 바로 첫 읽기를 하고 배경 반복을 건다. 돌려준 약속은 첫 읽기가 끝나면(성공이든 실패든) 풀린다. 두 번째부터는 아무것도 하지 않는다 */
  start(): Promise<void> {
    if (this.#started || this.#stopped) return this.#inflight ?? Promise.resolve();
    this.#started = true;
    return this.#read();
  }

  /** 배경 반복을 멈추고 돌던 읽기가 끝나기를 기다린다. 마지막 묶음은 그대로 둔다 */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    // 돌던 읽기는 시간 한도(1초) 안에 끝난다
    await this.#inflight;
  }

  /** 마지막으로 받은 묶음(받은 적이 없으면 undefined) */
  keys(): AdmissionKeys | undefined {
    return this.#keys;
  }

  /**
   * 그 kid가 든 묶음. 모르는 kid면 다시 읽기 한 번을 기다린다(돌던 읽기에 붙고, 새로 읽는 것은 30초에 한 번, 1초까지).
   * 받은 적이 없으면 돌고 있는 읽기만 1초까지 기다린다.
   * 그래도 모르는 kid면 마지막 묶음을 준다(확인이 'kid'로 거절한다).
   * @throws AdmissionKeysUnavailable 묶음을 한 번도 받지 못했다
   */
  async keysFor(kid: string | undefined): Promise<AdmissionKeys> {
    const current = this.#keys;
    if (current && (kid === undefined || current.has(kid))) return current;
    if (!current) {
      // 한 번도 받지 못했다: 돌고 있는 읽기가 있으면 1초까지 기다리고, 새로 읽지는 않는다(배경이 1초마다 다시 읽는다. 요청이 queue-svc를 두드리지 못하게)
      if (this.#inflight) await waitAtMost(this.#inflight, ADMISSION_JWKS_UNKNOWN_KID_WAIT_MS);
      const first = this.#keys;
      if (!first) throw new AdmissionKeysUnavailable();
      return first;
    }
    if (!this.#stopped) {
      let pending = this.#inflight;
      const now = this.#clock.now();
      if (!pending && (this.#lastUnknownKidReadMs === undefined || now - this.#lastUnknownKidReadMs >= ADMISSION_JWKS_UNKNOWN_KID_MS)) {
        this.#lastUnknownKidReadMs = now;
        pending = this.#read();
      }
      if (pending) await waitAtMost(pending, ADMISSION_JWKS_UNKNOWN_KID_WAIT_MS);
    }
    const after = this.#keys;
    if (!after) throw new AdmissionKeysUnavailable();
    return after;
  }

  /** 읽기 한 번(돌고 있으면 그것). 끝나면 다음 읽기를 건다 */
  #read(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    let ok = false;
    const p = this.#detached(() => this.#fetchOnce())
      .then(
        (keys) => {
          if (this.#stopped) return;
          this.#keys = keys;
          this.#receivedAtMs = this.#clock.now();
          ok = true;
        },
        (err: unknown) => {
          const reason: AdmissionJwksFailureReason = err instanceof ReadFailed ? err.reason : 'error';
          if (this.#stopped) return;
          this.#failures.inc({ reason });
          this.#logger?.warn({ dep: 'queue-svc', event: 'purchase-admission-jwks-fetch-failed', reason, everReceived: this.#keys !== undefined }, '입장 토큰 공개키 묶음을 읽지 못했다(마지막 묶음을 쓴다)');
        },
      )
      .finally(() => {
        this.#inflight = undefined;
        this.#schedule(ok);
      });
    this.#inflight = p;
    return p;
  }

  #schedule(ok: boolean): void {
    if (this.#stopped) return;
    const delay = this.#keys === undefined ? ADMISSION_JWKS_FIRST_RETRY_MS : ok ? ADMISSION_JWKS_REFRESH_MS : ADMISSION_JWKS_RETRY_MS;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#read();
    }, delay);
    // 배경 반복이 프로세스를 붙잡지 않게 한다(종료는 stop이 한다)
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /** 한 번 읽기: 1초 안에 응답과 본문을 받아 묶음으로 읽는다. 실패는 ReadFailed(이유) */
  async #fetchOnce(): Promise<AdmissionKeyMap> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 클라이언트의 시간 한도와 따로, 응답 머리와 본문을 합친 한 번 읽기를 1초로 묶는다(가짜 타이머로도 몬다)
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReadFailed('timeout')), ADMISSION_JWKS_TIMEOUT_MS);
    });
    timeout.catch(() => {});
    try {
      const res = await Promise.race([
        this.#client.request({ method: 'GET', path: this.#path, headers: { accept: 'application/json' } }).catch((err: unknown) => {
          throw new ReadFailed(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'error');
        }),
        timeout,
      ]);
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new ReadFailed('error');
      }
      const text = await Promise.race([
        res.text().catch(() => {
          throw new ReadFailed('error');
        }),
        timeout,
      ]);
      if (text.length > MAX_BODY_CHARS) throw new ReadFailed('invalid');
      try {
        // 빈 keys·d가 섞인 원소·kid 겹침·P-256 아님·peaket_until이 정수 아님은 모두 틀린 모양이다
        return parseAdmissionJwks(text);
      } catch {
        throw new ReadFailed('invalid');
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** 묶음 주소 환경 값(queue-svc GET /internal/jwks/admission.json) */
export const ADMISSION_JWKS_URL_ENV = 'PEAKET_ADMISSION_JWKS_URL';
/** 정적 묶음 환경 값(JWKS JSON). PEAKET_ENV가 local·ci일 때만 받는다 */
export const ADMISSION_JWKS_ENV = 'PEAKET_ADMISSION_JWKS';
/** 정적 묶음을 받는 PEAKET_ENV */
export const STATIC_ADMISSION_JWKS_ENVS = ['local', 'ci'] as const;

/**
 * 시작 설정 규칙(seat-hold §2 '정적 묶음'): 주소가 있으면 주기 읽기(loader, 아직 start하지 않았다), local·ci에서 주소가 없으면 정적 묶음.
 * 두 값이 함께 있거나, local·ci 밖에서 주소가 없으면 던진다. PEAKET_ENV가 없으면 플랫폼(loadPlatformConfig)처럼 prod로 본다
 * @param o 주기 읽기에 넘길 대역(fetch·시계·로거·지표 레지스트리)
 */
export function admissionKeysFromEnv(
  env: Record<string, string | undefined>,
  o: Omit<AdmissionJwksLoaderOptions, 'url'> = {},
): { keys: AdmissionKeys | AdmissionKeySource; loader?: AdmissionJwksLoader } {
  const url = env[ADMISSION_JWKS_URL_ENV];
  const raw = env[ADMISSION_JWKS_ENV];
  const peaketEnv = env.PEAKET_ENV || 'prod';
  if (url && raw) throw new Error(`${ADMISSION_JWKS_URL_ENV}와 ${ADMISSION_JWKS_ENV}를 함께 두지 않는다(운영은 주소, local·ci는 둘 가운데 하나)`);
  if (url) {
    const loader = new AdmissionJwksLoader({ ...o, url });
    return { keys: loader, loader };
  }
  if (!(STATIC_ADMISSION_JWKS_ENVS as readonly string[]).includes(peaketEnv)) {
    throw new Error(`${ADMISSION_JWKS_URL_ENV}가 없다(입장 토큰 공개키 묶음 주소, queue-svc /internal/jwks/admission.json. 정적 ${ADMISSION_JWKS_ENV}는 local·ci만 받는다)`);
  }
  if (!raw) throw new Error(`${ADMISSION_JWKS_URL_ENV}나 ${ADMISSION_JWKS_ENV}가 없다(입장 토큰 공개키 묶음)`);
  return { keys: parseAdmissionJwks(raw) };
}

/** p가 끝나거나 ms가 지날 때까지 기다린다(p의 실패는 삼킨다) */
async function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}
