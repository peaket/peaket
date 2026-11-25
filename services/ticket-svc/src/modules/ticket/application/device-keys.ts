// 입장용 기기 공개키 등록·폐기 유스케이스(FR-012, POL-018, ADR-0025·0050 결정 2·ADR-0051 결정 10·11, ADR-0363 결정 1·2).
// 키는 월렛의 '이 휴대폰을 입장용으로 등록' 버튼으로만 만든다. 서버는 공개키만 받고 keyId를 계산해 등록한다.
// - 재인증(ADR-0363 결정 1): 양도·돌려주기와 같은 팬 재인증 확인기를 쓰고, 받는 쪽 작업 DEVICE_KEY_ISSUE·작업 묶음 FAN_SENSITIVE를 기대한다.
//   확인기·jti 저장소 장애는 삼키지 않고 REAUTH_UNAVAILABLE(503 reauth-unavailable)이다.
// - 403 세 이름(ADR-0363 결정 2)은 저장소가 티켓 행 잠금 안에서 가른다: 입장 시작 전 다른 키 → REISSUE_REQUIRED, 입장 시작 뒤 다른 키 →
//   REISSUE_AT_BOOTH(재인증과 상관없이), 입장 시작 뒤 첫 등록에 재인증 없음 → REAUTH_REQUIRED.
// - 같은 키 다시 등록(지금 유효 키와 keyId가 같으면 바꾸지 않고 201, offline-gate §2, ADR-0336 결정 4)은 저장소가 티켓 행 잠금 안에서
//   보유자 확인 바로 뒤에 지킨다. 재인증 없는 REISSUE는 같은 키여도 403이고 보유자가 아니어도 404보다 403이다(RV350-1, 저장소가 지킨다).
// - BOOTH의 재인증·부스 허용 확인은 지금처럼 이 계층에서 저장소보다 먼저 한다(부스 허용 저장소는 GAT-190 몫이라 늘 403).
import type { Clock } from '@peaket/platform';
import { assertReason, DeviceKeyInputError, deviceKeyMaterialOf, type DeviceKeyReason, type PublicKeyJwk } from '../domain/device-key.js';
import type { DeviceKeyRegistrationResult, DeviceKeyStore } from '../domain/ports.js';
import { ReauthUnavailable, type TransferAct, type TransferOp } from '../domain/transfer-ports.js';

export type DeviceKeyErrorCode =
  | 'NOT_FOUND'
  | 'NOT_HOLDER'
  | 'REAUTH_REQUIRED'
  | 'ENTRY_STARTED'
  | 'REISSUE_REQUIRED'
  | 'REISSUE_AT_BOOTH'
  | 'REAUTH_UNAVAILABLE'
  | 'REISSUE_LIMIT'
  | 'BOOTH_NOT_ALLOWED'
  | 'TRANSFER_NOT_ALLOWED'
  | 'INVALID_KEY';

export class DeviceKeyError extends Error {
  constructor(readonly code: DeviceKeyErrorCode) {
    super(`기기 키 처리 오류: ${code}`);
    this.name = 'DeviceKeyError';
  }
}

/** 기기 키 등록이 재인증 토큰에 기대하는 작업 묶음과 받는 쪽 작업(docs/security/authz-matrix.md §6, ADR-0363 결정 1) */
export const DEVICE_KEY_REAUTH_ACT: TransferAct = 'FAN_SENSITIVE';
export const DEVICE_KEY_REAUTH_OP: TransferOp = 'DEVICE_KEY_ISSUE';

/**
 * 재인증 토큰 확인(어댑터 JwksFanReauthGate, 양도와 같은 인스턴스). false면 거절(403), 던지면 ReauthUnavailable(503).
 * act·op는 이 유스케이스가 늘 DEVICE_KEY_REAUTH_ACT·DEVICE_KEY_REAUTH_OP로 넘긴다
 */
export interface ReauthGate {
  verify(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: TransferAct; readonly op: TransferOp }): Promise<boolean>;
}

/** 등록 한 번의 결과 이름(지표 ticket_device_key_registrations_total의 result, docs/features/offline-gate.md §10.1) */
export type DeviceKeyRegistrationOutcome =
  | 'registered'
  | 'unchanged'
  | 'reissue_required'
  | 'reissue_at_booth'
  | 'reauth_required'
  | 'reauth_unavailable'
  | 'limit'
  | 'not_found'
  | 'invalid'
  | 'booth_not_allowed'
  | 'transfer_not_allowed';

export interface DeviceKeysDeps {
  readonly store: DeviceKeyStore;
  readonly clock: Clock;
  /** 없으면 재인증이 필요한 요청은 모두 거절한다(local·ci의 닫힌 대역과 같다) */
  readonly reauth?: ReauthGate;
  /** BOOTH 허용 확인(시험 조립). 운영은 DrizzleDeviceKeyStore가 같은 트랜잭션에서 부른다 */
  readonly booth?: { ownerOf?(ticketId: string): Promise<string | undefined>; consumeForRegistration(i: { ticketId: string; boothRequestId: string; nowMs: number }): Promise<boolean> };
  /** 등록 한 번마다 이유·결과를 알린다(지표·로그 줄, 계정·keyId 없음). start.ts가 지표에 잇는다 */
  readonly observe?: (o: { readonly reason: DeviceKeyReason | 'UNKNOWN'; readonly result: DeviceKeyRegistrationOutcome }) => void;
}

export interface RegisterDeviceKeyInput {
  readonly ticketId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly reauthToken?: string;
  readonly publicKeyJwk: PublicKeyJwk;
  readonly reason: DeviceKeyReason;
  readonly boothRequestId?: string;
}

const OUTCOME_OF: Record<DeviceKeyErrorCode, DeviceKeyRegistrationOutcome> = {
  NOT_FOUND: 'not_found',
  NOT_HOLDER: 'not_found',
  REAUTH_REQUIRED: 'reauth_required',
  ENTRY_STARTED: 'reauth_required',
  REISSUE_REQUIRED: 'reissue_required',
  REISSUE_AT_BOOTH: 'reissue_at_booth',
  REAUTH_UNAVAILABLE: 'reauth_unavailable',
  REISSUE_LIMIT: 'limit',
  BOOTH_NOT_ALLOWED: 'booth_not_allowed',
  TRANSFER_NOT_ALLOWED: 'transfer_not_allowed',
  INVALID_KEY: 'invalid',
};

export class DeviceKeys {
  constructor(private readonly d: DeviceKeysDeps) {}

  async register(i: RegisterDeviceKeyInput): Promise<{ keyId: string }> {
    let reason: DeviceKeyReason | 'UNKNOWN' = 'UNKNOWN';
    try {
      reason = assertReason(i.reason);
      const out = await this.#register(i, reason);
      this.d.observe?.({ reason, result: out.unchanged ? 'unchanged' : 'registered' });
      return { keyId: out.keyId };
    } catch (e) {
      if (e instanceof DeviceKeyError) this.d.observe?.({ reason, result: OUTCOME_OF[e.code] });
      else if (e instanceof DeviceKeyInputError) this.d.observe?.({ reason, result: 'invalid' });
      throw e;
    }
  }

  async #register(i: RegisterDeviceKeyInput, reason: DeviceKeyReason): Promise<{ keyId: string; unchanged: boolean }> {
    const material = deviceKeyMaterialOf(i.publicKeyJwk);
    const now = this.d.clock.now();
    // 확인기는 토큰이 없거나 비면 false이고, 통과하면 jti를 한 번 잡으므로 확인은 요청마다 한 번이다
    const reauth = reason === 'REISSUE' || reason === 'BOOTH' || reason === 'ISSUE' ? await this.#reauth(i) : false;
    if (reason === 'BOOTH' && !reauth) throw new DeviceKeyError('REAUTH_REQUIRED');
    // 시험 조립은 여기서 허용을 소모한다(메모리 저장소). 운영은 DrizzleDeviceKeyStore가 키 저장과 같은 트랜잭션에서 소모한다
    if (reason === 'BOOTH' && this.d.booth) {
      if (this.d.booth.ownerOf) {
        const owner = await this.d.booth.ownerOf(i.ticketId);
        if (owner === undefined || owner !== i.accountId) throw new DeviceKeyError('NOT_FOUND');
      }
      if (i.boothRequestId === undefined || !(await this.d.booth.consumeForRegistration({ ticketId: i.ticketId, boothRequestId: i.boothRequestId, nowMs: now }))) {
        throw new DeviceKeyError('BOOTH_NOT_ALLOWED');
      }
    }
    const r: DeviceKeyRegistrationResult = await this.d.store.register({
      ticketId: i.ticketId,
      accountId: i.accountId,
      keyId: material.keyId,
      publicKey: material.publicKey,
      reason,
      nowMs: now,
      reauthVerified: reauth,
      ...(i.boothRequestId !== undefined ? { boothRequestId: i.boothRequestId } : {}),
    });
    switch (r.kind) {
      case 'REGISTERED':
        return { keyId: r.keyId, unchanged: r.unchanged === true };
      case 'NOT_FOUND':
      case 'NOT_HOLDER':
        throw new DeviceKeyError('NOT_FOUND');
      case 'ENTRY_STARTED':
        throw new DeviceKeyError('ENTRY_STARTED');
      case 'REAUTH_REQUIRED':
        throw new DeviceKeyError('REAUTH_REQUIRED');
      case 'REISSUE_REQUIRED':
        throw new DeviceKeyError('REISSUE_REQUIRED');
      case 'REISSUE_AT_BOOTH':
        throw new DeviceKeyError('REISSUE_AT_BOOTH');
      case 'REISSUE_LIMIT':
        throw new DeviceKeyError('REISSUE_LIMIT');
      case 'TRANSFER_NOT_ALLOWED':
        throw new DeviceKeyError('TRANSFER_NOT_ALLOWED');
      case 'BOOTH_NOT_ALLOWED':
        throw new DeviceKeyError('BOOTH_NOT_ALLOWED');
    }
  }

  async #reauth(i: RegisterDeviceKeyInput): Promise<boolean> {
    if (!this.d.reauth) return false;
    try {
      return await this.d.reauth.verify(i.reauthToken, { accountId: i.accountId, sessionId: i.sessionId, act: DEVICE_KEY_REAUTH_ACT, op: DEVICE_KEY_REAUTH_OP });
    } catch (e) {
      // 확인기·jti 저장소 장애는 토큰 거절로 덮지 않는다(503, ADR-0363 결정 1). 뜻밖 오류는 그대로 던진다(500)
      if (e instanceof ReauthUnavailable) throw new DeviceKeyError('REAUTH_UNAVAILABLE');
      throw e;
    }
  }
}
