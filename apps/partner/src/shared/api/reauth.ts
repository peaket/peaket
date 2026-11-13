// 파트너 관리자 재인증(openapi POST /v1/partner/auth/reauthentications, identity §6, I-T53, ADR-0206).
// 명단 내려받기는 비밀번호·TOTP 뒤 패스키까지 확인한 토큰(act BOOKER_EXPORT, factors에 passkey)만 받는다.
// 토큰은 서버가 한 번만 쓰고(jti), 화면은 받은 토큰을 그 요청의 X-Reauth-Token에만 넣는다.

export interface ReauthPasskeyStep {
  next: 'PASSKEY';
  reauthStep: string;
  publicKey: {
    challenge?: string;
    rpId?: string;
    timeout?: number;
    userVerification?: 'required';
    allowCredentials?: { id?: string; type?: 'public-key'; transports?: string[] }[];
  };
  expiresInSeconds: number;
}

export interface ReauthDone {
  next: 'DONE';
  reauthToken: string;
  factors: ('password' | 'totp' | 'passkey')[];
  expiresInSeconds: number;
}

export type ReauthResponse = ReauthPasskeyStep | ReauthDone;

export interface ReauthCredentialJson {
  id: string;
  rawId: string;
  type: 'public-key';
  authenticatorAttachment?: string;
  clientExtensionResults: Record<string, unknown>;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 채움 없는 base64url → 바이트. 화면 시험은 이 함수로 이진 값을 확인한다. */
export function base64urlToBytes(value: string): Uint8Array {
  const clean = value.replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(clean)) throw new TypeError('base64url 값이 아닙니다');
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new TypeError('base64url 값이 아닙니다');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** 바이트 → 채움 없는 base64url. */
export function bytesToBase64url(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET[(acc >> bits) & 0x3f];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (6 - bits)) & 0x3f];
  return out;
}

/** 서버가 준 PublicKeyCredentialRequestOptionsJSON을 navigator.credentials.get()의 옵션으로 바꾼다. */
export function toRequestOptions(publicKey: ReauthPasskeyStep['publicKey']): PublicKeyCredentialRequestOptions {
  // iOS Safari 16.4에는 이 편의 함수가 없다(BCP 8.1.7). 있으면 쓰고, 없으면 아래에서 손으로 바꾼다.
  const parse =
    typeof PublicKeyCredential === 'undefined'
      ? undefined
      : (Reflect.get(PublicKeyCredential, 'parseRequestOptionsFromJSON') as ((o: unknown) => PublicKeyCredentialRequestOptions) | undefined);
  if (typeof parse === 'function') {
    try {
      return parse(publicKey);
    } catch {
      // 아래 수동 변환으로 간다(구형 브라우저·시험 대역)
    }
  }
  if (!publicKey.challenge) throw new TypeError('패스키 확인 값에 challenge가 없습니다');
  return {
    challenge: base64urlToBytes(publicKey.challenge) as BufferSource,
    ...(publicKey.rpId ? { rpId: publicKey.rpId } : {}),
    ...(publicKey.timeout ? { timeout: publicKey.timeout } : {}),
    userVerification: 'required',
    ...(publicKey.allowCredentials
      ? {
          allowCredentials: publicKey.allowCredentials
            .filter((c): c is { id: string; type?: 'public-key'; transports?: string[] } => typeof c.id === 'string')
            .map((c) => ({ id: base64urlToBytes(c.id) as BufferSource, type: 'public-key' as const, ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}) })),
        }
      : {}),
  };
}

/** navigator.credentials.get()의 결과를 서버 본문(W3C AuthenticationResponseJSON)으로 바꾼다. */
export function serializeAssertion(credential: Credential): ReauthCredentialJson {
  if (!(credential instanceof PublicKeyCredential)) throw new TypeError('패스키 확인 결과가 아닙니다');
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) throw new TypeError('패스키 확인 응답이 아닙니다');
  const toJson = (credential as unknown as { toJSON?: () => ReauthCredentialJson }).toJSON;
  if (typeof toJson === 'function') {
    const json = toJson.call(credential);
    return { ...json, clientExtensionResults: json.clientExtensionResults ?? {} };
  }
  const bytes = (v: ArrayBuffer | null) => (v ? bytesToBase64url(new Uint8Array(v)) : undefined);
  return {
    id: credential.id,
    rawId: bytesToBase64url(new Uint8Array(credential.rawId)),
    type: 'public-key',
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
    clientExtensionResults: {},
    response: {
      clientDataJSON: bytes(response.clientDataJSON)!,
      authenticatorData: bytes(response.authenticatorData)!,
      signature: bytes(response.signature)!,
      ...(response.userHandle ? { userHandle: bytesToBase64url(new Uint8Array(response.userHandle)) } : {}),
    },
  };
}

/** BOOKER_EXPORT 토큰은 factors에 passkey가 있어야 한다(I-T53 ②③). */
export function hasPasskeyFactor(factors: readonly string[]): boolean {
  return factors.includes('passkey');
}

async function post(body: unknown): Promise<ReauthResponse> {
  const { partnerApi, OPERATIONS } = await import('@/shared/api');
  return partnerApi().request<ReauthResponse>(OPERATIONS.createPartnerAuthReauthentication, { body, timeoutMs: 20_000 });
}

/**
 * 비밀번호·TOTP를 확인하고, 서버가 패스키 단계를 주면 브라우저 패스키 창을 띄워 마친다.
 * 사용자가 창을 닫으면 NotAllowedError가 그대로 올라가고 화면은 '다시 인증하지 않았습니다'로 보인다.
 */
export async function requestBookerExportReauth(input: { password: string; code: string }): Promise<string> {
  const first = await post({ act: 'BOOKER_EXPORT', password: input.password, code: input.code, withPasskey: true });
  if (first.next === 'DONE') {
    if (!hasPasskeyFactor(first.factors)) throw new Error('패스키 확인 없이 발급된 재인증 토큰은 쓸 수 없습니다');
    return first.reauthToken;
  }
  if (typeof navigator === 'undefined' || !navigator.credentials?.get) throw new Error('이 브라우저에서는 패스키를 쓸 수 없습니다');
  const credential = await navigator.credentials.get({ publicKey: toRequestOptions(first.publicKey) });
  if (!credential) throw new Error('패스키 확인을 마치지 못했습니다');
  const second = await post({ reauthStep: first.reauthStep, credential: serializeAssertion(credential) });
  if (second.next !== 'DONE' || !hasPasskeyFactor(second.factors)) throw new Error('패스키 확인 없이 발급된 재인증 토큰은 쓸 수 없습니다');
  return second.reauthToken;
}
