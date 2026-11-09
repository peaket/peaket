// drand quicknet 비콘(docs/features/queue-admission.md §2, ADR-0050 결정 7, ADR-0231 결정 11). 공시한 라운드만 여러 중계 주소에서 차례로 받는다.
// 값이 없거나 서명 검증이 실패하면 null을 돌려 그 라운드를 기다리게 하고, 다른 라운드로 대신하지 않는다.
// 서명 검증(BLS12-381)은 BeaconVerifier 포트다. 운영은 QuicknetBeaconVerifier(@noble/curves, ADR-0239 결정 3)이고 BLS 수식을 직접 짜지 않는다.
import { createHash } from 'node:crypto';
import { type Clock, systemClock } from '@peaket/platform';
import { DRAND_CHAIN_HASH, drandRoundTimeMs, type ShuffleGroup } from '@peaket/shuffle';
import type { Beacon, BeaconRound, ShuffleRecords } from '../domain/ports.js';

/** 라운드 서명 검증. drand 프로젝트의 공개 체인 정보(quicknet)로 검증한다 */
export interface BeaconVerifier {
  verify(round: number, signatureHex: string): boolean;
}

/** 외부 호출 포트(운영은 플랫폼 createExternalHttpClient가 짧은 마감으로 감싼 GET, 시험은 대역) */
export interface BeaconHttp {
  get(url: string): Promise<{ status: number; body: unknown }>;
}

export interface DrandBeaconOptions {
  relays: readonly string[];
  records: ShuffleRecords;
  verifier: BeaconVerifier;
  http: BeaconHttp;
  clock?: Clock;
}

/** 구간마다 중계를 부르는 간격 1초 [가정](ADR-0239 결정 4). 리더 주기(200ms)마다 공개 서비스를 두드리지 않는다 */
export const BEACON_POLL_MS = 1_000;

interface DrandBody {
  round?: unknown;
  randomness?: unknown;
  signature?: unknown;
}

export class DrandBeacon implements Beacon {
  readonly #clock: Clock;
  readonly #polledAt = new Map<string, number>();

  constructor(private readonly o: DrandBeaconOptions) {
    this.#clock = o.clock ?? systemClock;
  }

  async round(eventId: string, group: ShuffleGroup): Promise<BeaconRound | null> {
    const rec = await this.o.records.read(eventId, group);
    if (!rec) return null;
    // 라운드 예정 시각 전에는 값이 없다. 부르지 않는다
    const now = this.#clock.now();
    if (now < drandRoundTimeMs(rec.round)) return null;
    const key = `${eventId}|${group}`;
    const last = this.#polledAt.get(key);
    if (last !== undefined && now - last < BEACON_POLL_MS) return null;
    this.#polledAt.delete(key);
    this.#polledAt.set(key, now);
    while (this.#polledAt.size > 1_024) this.#polledAt.delete(this.#polledAt.keys().next().value!);
    for (const relay of this.o.relays) {
      const v = await this.#fromRelay(relay, rec.round);
      if (v) return v;
    }
    return null;
  }

  /** 기록한 비콘은 중계 없이 쓰되 받을 때와 같게 본다: 값 = SHA-256(서명), 그리고 공시 라운드에 대한 BLS 서명 */
  verifyStored(_eventId: string, _group: ShuffleGroup, round: number, value: string, signature: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(value) || !/^[0-9a-f]+$/.test(signature)) return false;
    if (createHash('sha256').update(Buffer.from(signature, 'hex')).digest('hex') !== value) return false;
    return this.o.verifier.verify(round, signature);
  }

  async value(eventId: string, group: ShuffleGroup): Promise<Buffer | null> {
    return (await this.round(eventId, group))?.value ?? null;
  }

  async #fromRelay(relay: string, round: number): Promise<BeaconRound | null> {
    try {
      const r = await this.o.http.get(`${relay}/${DRAND_CHAIN_HASH}/public/${round}`);
      if (r.status !== 200) return null;
      const b = (r.body ?? {}) as DrandBody;
      if (b.round !== round || typeof b.randomness !== 'string' || typeof b.signature !== 'string') return null;
      if (!/^[0-9a-f]{64}$/.test(b.randomness) || !/^[0-9a-f]+$/.test(b.signature)) return null;
      // quicknet의 라운드 값은 SHA-256(서명)이다. 값과 서명이 어긋나면 검증 전에 버린다
      if (createHash('sha256').update(Buffer.from(b.signature, 'hex')).digest('hex') !== b.randomness) return null;
      if (!this.o.verifier.verify(round, b.signature)) return null;
      return { value: Buffer.from(b.randomness, 'hex'), signature: b.signature };
    } catch {
      // 이 중계가 안 되면 다음 중계를 본다
      return null;
    }
  }
}
