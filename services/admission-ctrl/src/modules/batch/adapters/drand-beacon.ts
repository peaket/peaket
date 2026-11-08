// drand quicknet 비콘(docs/features/queue-admission.md §2, ADR-0050 결정 7, ADR-0231 결정 11). 공시한 라운드만 여러 중계 주소에서 차례로 받는다.
// 값이 없거나 서명 검증이 실패하면 null을 돌려 그 라운드를 기다리게 하고, 다른 라운드로 대신하지 않는다.
// 서명 검증(BLS12-381)은 BeaconVerifier 포트다. 라이브러리와 운영 조립은 BUILD_ORDER HOT-041이다(BLS 검증을 직접 짜지 않는다).
import { createHash } from 'node:crypto';
import { DRAND_CHAIN_HASH, type ShuffleGroup } from '@peaket/shuffle';
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
}

interface DrandBody {
  round?: unknown;
  randomness?: unknown;
  signature?: unknown;
}

export class DrandBeacon implements Beacon {
  constructor(private readonly o: DrandBeaconOptions) {}

  async round(eventId: string, group: ShuffleGroup): Promise<BeaconRound | null> {
    const rec = await this.o.records.read(eventId, group);
    if (!rec) return null;
    for (const relay of this.o.relays) {
      const v = await this.#fromRelay(relay, rec.round);
      if (v) return v;
    }
    return null;
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
