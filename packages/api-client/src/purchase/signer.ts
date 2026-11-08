// 구매 세션 서명기(docs/frontend.md §5.3 '키 수명'·'순서 보장', ADR-0221 결정 3·4). 좌석 화면이 입장 토큰을 처음 쓰기 전에(직접 선택은 첫 스냅샷,
// 자동 배정은 첫 홀드) openPurchaseSession을 부르고, 구매 세션 쓰기는 api-client에 `purchase`로 넘긴다(결정 5).
// - 키: 브라우저 ECDH P-256 임시 키 쌍과 서버 공개키로 합의 → HKDF → HMAC 키(추출 불가). ECDH 개인키는 합의 뒤 버린다
// - 저장: IndexedDB peaket-purchase sessions/{jti}(store.ts). 같은 jti가 살아 있으면 새로 만들지 않는다(새로고침해도 같은 공개키를 보낸다)
// - 순서: Web Locks `ps:{jti}` 안에서 요청 하나 전체(자동 재시도 포함)를 보내고, 시도마다 한 트랜잭션에서 일련번호를 1 올린 뒤 그 번호로 서명한다
import { admissionClaims, createClientKeyPair, purchaseMac, requestKey, sharedSecret, type ServerEcdhJwk } from './crypto';
import { indexedDbStore, type PurchaseRecord, type PurchaseStore } from './store';

export type PurchaseKeyErrorReason = 'token' | 'server-key' | 'storage' | 'ended';

/**
 * 만료(purchaseSessionExpiresAt·토큰 exp)를 지난 뒤에도 키를 두는 여유 [가정]. 만료는 기기 시계로 재므로 시계가 빠른 기기에서 살아 있는 세션의 키를
 * 지우지 않게 한다. 세션이 살아 있는지는 서버가 정하고(401), 기기는 저장소를 지울 때만 이 값을 본다(openapi purchaseSessionExpiresAt, ADR-0221 결정 3)
 */
export const PURCHASE_KEY_RETAIN_MS = 24 * 60 * 60 * 1000;

/** 구매 세션을 열지 못했거나 끝났다. 화면은 예매 시간이 끝난 것으로 다룬다(HOT-353·HOT-361) */
export class PurchaseKeyError extends Error {
  readonly reason: PurchaseKeyErrorReason;
  constructor(reason: PurchaseKeyErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PurchaseKeyError';
    this.reason = reason;
  }
}

/** 시도마다 부른다: 일련번호를 올리고 그 시도의 서명 머리를 준다 */
export type SignFn = (method: string, pathAndQuery: string, body: Uint8Array) => Promise<Record<string, string>>;

export interface PurchaseSigner {
  readonly jti: string;
  /** 첫 사용 요청에 싣는 클라이언트 임시 공개키(스냅샷 머리 X-Client-Ephemeral-Key, 자동 배정 홀드 본문 clientEphemeralPublicKey) */
  readonly clientPublicKey: string;
  readonly admissionToken: string;
  /** 요청 하나를 `ps:{jti}` 잠금 안에서 보낸다. 응답(또는 시간 초과)이 올 때까지 잠금을 놓지 않는다. signal이 끊기면 잠금을 기다리지 않는다 */
  run<T>(send: (sign: SignFn) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** 세션 끝: 이 jti의 키를 지운다 */
  end(): Promise<void>;
}

/** Web Locks에서 쓰는 만큼(navigator.locks.request) */
export interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<unknown>): Promise<unknown>;
}

/** Web Locks가 없을 때의 대체: 이 페이지 안에서만 이름별로 차례를 지킨다(다른 탭과의 차례는 서버가 일련번호로 거른다) */
export function pageLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name, { signal }, callback) {
      const prev = tails.get(name) ?? Promise.resolve();
      const mine = new Promise<unknown>((ok, no) => {
        let started = false;
        const onAbort = () => {
          if (!started) no(signal!.reason);
        };
        if (signal?.aborted) return no(signal.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        void prev.then(
          () => {
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) return no(signal.reason);
            started = true;
            callback().then(ok, no);
          },
          () => undefined,
        );
      });
      // 다음 차례는 앞 차례가 끝나고 내 일도 끝나면(성공·실패 모두) 시작한다. 내가 기다리다 취소돼도 앞 차례를 건너뛰지 않는다
      const tail = prev.then(() =>
        mine.then(
          () => undefined,
          () => undefined,
        ),
      );
      tails.set(name, tail);
      void tail.then(() => {
        if (tails.get(name) === tail) tails.delete(name);
      });
      return mine;
    },
  };
}

function defaultLocks(): LockManagerLike {
  const l = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
  return l && typeof l.request === 'function' ? l : PAGE_LOCKS;
}
const PAGE_LOCKS = pageLocks();

export interface PurchaseDeps {
  subtle?: SubtleCrypto;
  store?: PurchaseStore;
  locks?: LockManagerLike;
  now?: () => number;
}

export interface OpenPurchaseSession {
  /** 입장 확정 응답의 입장 토큰(peaket.admission.{eventId}) */
  admissionToken: string;
  /** 입장 확정 응답의 서버 ECDH 공개키(JWK) */
  serverEcdhPublicKey?: ServerEcdhJwk | Record<string, string>;
  /** 입장 확정 응답의 구매 세션 만료(ISO 8601). 없으면 입장 토큰 exp */
  purchaseSessionExpiresAt?: string;
}

/** 구매 세션을 연다(키를 만들거나, 같은 jti의 살아 있는 키를 쓴다) */
export async function openPurchaseSession(o: OpenPurchaseSession, d: PurchaseDeps = {}): Promise<PurchaseSigner> {
  const subtle = d.subtle ?? globalThis.crypto.subtle;
  const store = d.store ?? indexedDbStore();
  const locks = d.locks ?? defaultLocks();
  const now = d.now ?? Date.now;
  const claims = admissionClaims(o.admissionToken);
  if (!claims) throw new PurchaseKeyError('token', '입장 토큰 모양이 틀렸다');
  let exp: number;
  if (o.purchaseSessionExpiresAt !== undefined) {
    exp = Date.parse(o.purchaseSessionExpiresAt);
    if (!Number.isFinite(exp)) throw new PurchaseKeyError('token', 'purchaseSessionExpiresAt가 날짜가 아니다');
  } else if (claims.exp !== undefined) {
    exp = claims.exp * 1000;
  } else {
    throw new PurchaseKeyError('token', '구매 세션 만료를 알 수 없다');
  }

  let rec: PurchaseRecord;
  try {
    // 기기 시계로 세션을 거절하지 않는다(판단은 서버가 한다). 여유까지 지난 항목만 지운다
    await store.sweep(now() - PURCHASE_KEY_RETAIN_MS);
    rec = (await store.get(claims.jti)) ?? (await store.putIfAbsent(await createRecord(subtle, claims.jti, exp, o.serverEcdhPublicKey)));
  } catch (e) {
    if (e instanceof PurchaseKeyError) throw e;
    throw new PurchaseKeyError('storage', '구매 세션 키를 두지 못했다', { cause: e });
  }

  const jti = rec.jti;
  const key = rec.key;
  const sign: SignFn = async (method, pathAndQuery, body) => {
    let seq: number | undefined;
    try {
      seq = await store.nextSeq(jti);
    } catch (e) {
      throw new PurchaseKeyError('storage', '일련번호를 올리지 못했다', { cause: e });
    }
    if (seq === undefined) throw new PurchaseKeyError('ended', '구매 세션이 끝났다');
    return {
      'x-admission-token': o.admissionToken,
      'x-purchase-seq': String(seq),
      'x-purchase-mac': await purchaseMac(subtle, key, method, pathAndQuery, seq, body),
    };
  };
  return {
    jti,
    clientPublicKey: rec.clientPublicKey,
    admissionToken: o.admissionToken,
    run: async <T>(send: (sign: SignFn) => Promise<T>, signal?: AbortSignal) => (await locks.request(`ps:${jti}`, signal ? { signal } : {}, () => send(sign))) as T,
    end: () => store.delete(jti),
  };
}

async function createRecord(subtle: SubtleCrypto, jti: string, exp: number, server: OpenPurchaseSession['serverEcdhPublicKey']): Promise<PurchaseRecord> {
  if (!server || typeof server !== 'object') throw new PurchaseKeyError('server-key', '서버 공개키가 없다');
  const client = await createClientKeyPair(subtle);
  let secret: ArrayBuffer;
  try {
    secret = await sharedSecret(subtle, client.privateKey, server as ServerEcdhJwk);
  } catch (e) {
    throw new PurchaseKeyError('server-key', '서버 공개키와 합의하지 못했다', { cause: e });
  }
  return { jti, key: await requestKey(subtle, secret, jti), seq: 0, exp, clientPublicKey: client.publicKey };
}

/** 로그아웃·세션 정리: 모든 구매 세션 키를 지운다(docs/frontend.md §5.14.4 2번) */
export async function clearPurchaseSessions(d: Pick<PurchaseDeps, 'store'> = {}): Promise<void> {
  await (d.store ?? indexedDbStore()).clear();
}
