// ticket-svc 기기 공개키 등록 포트(FR-012, offline-gate §2, openapi POST /v1/tickets/{ticketId}/device-keys).
// 지금 ticket-svc에는 이 경로와 device_key 표가 없어 실제 등록은 막혀 있다(BAT-350 기록).
// 그래서 화면은 키를 이 기기에만 만들고(LOCAL), 서버 등록은 아래 스위치를 켠 배포에서만 시도한다.
// 스위치를 켜면 생성 클라이언트가 404를 받을 수 있으므로 ticket-svc 경로가 열린 뒤 켠다.
import type { CreateTicketDeviceKeyBody } from '@peaket/api-client/model';
import { ORIGINS } from '@/shared/config/origins';

export type DeviceKeyRegistrationResult =
  | { kind: 'registered' }
  | { kind: 'unavailable'; reason: 'not-configured' | 'no-api' }
  | { kind: 'failed'; status?: number };

/** 서버 등록을 시도할 배포인가. 기본은 꺼 둔다(ticket-svc device-keys 경로·device_key 표 선행) */
export function deviceKeyRegistrationConfigured(): boolean {
  return process.env.NEXT_PUBLIC_WALLET_DEVICE_KEY_REGISTRATION === '1';
}

export interface RegisterDeviceKeyInput {
  ticketId: string;
  publicKeyJwk: JsonWebKey;
  reason: 'ISSUE' | 'REISSUE' | 'TRANSFER' | 'BOOTH';
  reauthToken?: string;
  boothRequestId?: string;
}

/** 공개키를 ticket-svc에 등록한다. 실패해도 기기 키는 로컬에 남아 QR을 계속 만들 수 있다 */
export async function registerDeviceKey(input: RegisterDeviceKeyInput): Promise<DeviceKeyRegistrationResult> {
  if (!deviceKeyRegistrationConfigured()) return { kind: 'unavailable', reason: 'not-configured' };
  if (!ORIGINS.api) return { kind: 'unavailable', reason: 'no-api' };
  const [{ ensureBrowserApi }, { createTicketDeviceKey }] = await Promise.all([
    import('@/shared/api'),
    import('@peaket/api-client/endpoints/tickets'),
  ]);
  if (!ensureBrowserApi()) return { kind: 'unavailable', reason: 'no-api' };
  try {
    await createTicketDeviceKey(
      input.ticketId,
      {
        publicKeyJwk: input.publicKeyJwk as CreateTicketDeviceKeyBody['publicKeyJwk'],
        reason: input.reason,
        ...(input.boothRequestId ? { boothRequestId: input.boothRequestId } : null),
      },
      input.reauthToken ? { headers: { 'X-Reauth-Token': input.reauthToken } } : undefined,
    );
    return { kind: 'registered' };
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
    return { kind: 'failed', status };
  }
}
