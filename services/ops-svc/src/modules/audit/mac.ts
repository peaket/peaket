// 감사 체인 mac의 입력 바이트와 키(ADR-0341 결정 1·2, docs/security/secrets-and-keys.md '감사 체인 키').
// mac = HMAC-SHA256(감사 체인 키, "PEAKET-audit-v1"(UTF-8 15바이트) ‖ seq(부호 없는 8바이트 빅엔디언) ‖ 직전 행의 mac(32바이트, seq 1은 0바이트) ‖ record_sha256(32바이트))
// 운영은 KMS HMAC 다중 리전 키(adapters/kms-audit-mac-key.ts), local·ci·demo는 메모리 HMAC 키다. 기록 트랜잭션은 이 키를 부르지 않는다.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** mac 입력의 앞 글자(판). 바꾸면 새 판 글자로 새 체인 구간을 시작한다 */
export const AUDIT_MAC_DOMAIN = 'PEAKET-audit-v1';
/** 키를 넣지 않고 만든 메모리 키의 최소 길이(바이트) */
export const AUDIT_LOCAL_KEY_MIN_BYTES = 32;

/**
 * mac 입력 바이트(ADR-0341 결정 1). prevMac은 seq가 가장 작은 행(seq 1)이면 0바이트다.
 * @throws RangeError seq가 1 미만이거나 8바이트를 넘음
 */
export function auditMacInput(seq: number | bigint, prevMac: Uint8Array, recordSha256: Uint8Array): Buffer {
  const n = BigInt(seq);
  if (n < 1n || n > 0xffff_ffff_ffff_ffffn) throw new RangeError(`감사 체인 seq 범위 밖: ${n}`);
  const seqBytes = Buffer.alloc(8);
  seqBytes.writeBigUInt64BE(n);
  return Buffer.concat([Buffer.from(AUDIT_MAC_DOMAIN, 'utf8'), seqBytes, Buffer.from(prevMac), Buffer.from(recordSha256)]);
}

/** 감사 체인 키. 작업자는 mac(GenerateMac), 검증 잡은 verify(VerifyMac)만 쓴다 */
export interface AuditMacKey {
  /** 앵커에 남기는 키 ID(키를 바꾼 지점을 찾게) */
  readonly keyId: string;
  mac(message: Uint8Array): Promise<Uint8Array>;
  verify(message: Uint8Array, mac: Uint8Array): Promise<boolean>;
}

/** 두 리전 모두 부르지 못함(검증은 ERROR, 작업자는 그 바퀴를 멈춘다). 오류 이름만 싣는다 */
export class AuditMacKeyUnavailable extends Error {
  constructor(readonly errorName: string) {
    super(`감사 체인 키를 쓸 수 없다: ${errorName}`);
    this.name = 'AuditMacKeyUnavailable';
  }
}

/** 메모리 HMAC-SHA256 키(local·ci·demo, ADR-0341 결정 2) */
export class LocalAuditMacKey implements AuditMacKey {
  readonly #key: Buffer;

  constructor(
    key: Uint8Array,
    readonly keyId: string = 'local',
  ) {
    if (key.length < AUDIT_LOCAL_KEY_MIN_BYTES) throw new Error(`감사 체인 메모리 키는 ${AUDIT_LOCAL_KEY_MIN_BYTES}바이트 이상이다`);
    this.#key = Buffer.from(key);
  }

  async mac(message: Uint8Array): Promise<Uint8Array> {
    return createHmac('sha256', this.#key).update(message).digest();
  }

  async verify(message: Uint8Array, mac: Uint8Array): Promise<boolean> {
    const expected = createHmac('sha256', this.#key).update(message).digest();
    return mac.length === expected.length && timingSafeEqual(Buffer.from(mac), expected);
  }
}

/** 시작 때 만든 임시 키(재시작하면 앞의 mac을 검증하지 못한다, local·ci·demo만) */
export const ephemeralAuditMacKey = (): LocalAuditMacKey => new LocalAuditMacKey(randomBytes(32), 'ephemeral');
