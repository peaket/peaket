// SCR-053 스캐너 기기 목록·등록 코드의 화면 모델(d5 §7.11, docs/features/offline-gate.md §6.1·§8).
// API 값을 화면 표기로 바꾸는 순수 함수만 둔다. 실제 호출은 ui/ConnectedPage.tsx가 @peaket/api-client로 한다.

export type DeviceStatus = 'ACTIVE' | 'REVOKED' | 'RETIRED';
export type CredentialType = 'MTLS_CERT' | 'DEVICE_KEY';

export interface RawDevice {
  deviceId?: string;
  name?: string;
  promoterId?: string;
  status?: DeviceStatus;
  credentialType?: CredentialType;
  certExpiresAt?: string;
  lastSeenAt?: string;
  activeSessionNickname?: string;
}

export interface DeviceRow {
  deviceId: string;
  name: string;
  promoterId: string;
  status: DeviceStatus;
  credentialType: CredentialType;
  certExpiresAt?: string;
  lastSeenAt?: string;
  activeSessionNickname?: string;
}

export interface DeviceListPage {
  items: DeviceRow[];
  nextCursor: string | null;
}

const KST = 'Asia/Seoul';

/** 목록 응답을 화면 행으로. 없는 ID·이름은 빈 값이 아니라 '이름 없음'으로 둔다 */
export function mapDeviceList(raw: { items?: readonly RawDevice[]; nextCursor?: string | null }): DeviceListPage {
  const items = (raw.items ?? []).flatMap((d) => {
    if (!d.deviceId) return [];
    return [
      {
        deviceId: d.deviceId,
        name: d.name?.trim() || '이름 없음',
        promoterId: d.promoterId ?? '',
        status: d.status ?? 'ACTIVE',
        credentialType: d.credentialType ?? 'DEVICE_KEY',
        ...(d.certExpiresAt ? { certExpiresAt: d.certExpiresAt } : {}),
        ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}),
        ...(d.activeSessionNickname ? { activeSessionNickname: d.activeSessionNickname } : {}),
      } satisfies DeviceRow,
    ];
  });
  return { items, nextCursor: raw.nextCursor ?? null };
}

export function statusLabel(status: DeviceStatus): string {
  switch (status) {
    case 'ACTIVE':
      return '사용 중';
    case 'REVOKED':
      return '폐기됨';
    case 'RETIRED':
      return '퇴역';
  }
}

export function statusTone(status: DeviceStatus): 'success' | 'danger' | 'outline' {
  return status === 'ACTIVE' ? 'success' : status === 'REVOKED' ? 'danger' : 'outline';
}

/** KST 날짜 '10/15(목)'. 값이 없거나 잘못되면 '—' */
export function formatKstDate(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const parts = new Intl.DateTimeFormat('ko-KR', { timeZone: KST, month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(new Date(t));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}/${get('day')}(${get('weekday')})`;
}

/** KST 날짜·시각 '10/15(목) 14:20 KST' */
export function formatKstDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const time = new Intl.DateTimeFormat('ko-KR', { timeZone: KST, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));
  return `${formatKstDate(iso)} ${time} KST`;
}

/** 마지막 연락 '9초 전'·'6분 전'·'3일 전'. 값이 없으면 '—' */
export function relativeLastSeen(iso: string | undefined, nowMs: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}

/** SCR-053 마지막 연락 표시. 상대 시각과 KST 절대 시각을 함께 준다. 없으면 '아직 없음' */
export function lastSeenSummary(iso: string | undefined, nowMs: number): { relative: string; absolute: string; never: boolean } {
  if (!iso || !Number.isFinite(Date.parse(iso))) return { relative: '아직 없음', absolute: '—', never: true };
  return { relative: relativeLastSeen(iso, nowMs), absolute: formatKstDateTime(iso), never: false };
}

/** 등록 코드 QR의 내용(d5 §7.11). 코드는 주소 조각에만 넣는다 */
export function enrollmentUrl(code: string, scannerOrigin: string): string {
  return `${scannerOrigin.replace(/\/+$/, '')}/enroll#code=${encodeURIComponent(code)}`;
}

/** '18:14 KST까지 10분 동안 한 번 쓸 수 있습니다' 또는 만료 안내 */
export function enrollmentCodeNotice(expiresAt: string | undefined, nowMs: number): string {
  if (!expiresAt) return '등록 코드가 만료되었습니다. 새 코드를 만드세요';
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t) || t <= nowMs) return '등록 코드가 만료되었습니다. 새 코드를 만드세요';
  const time = new Intl.DateTimeFormat('ko-KR', { timeZone: KST, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));
  return `${time} KST까지 10분 동안 한 번 쓸 수 있습니다`;
}

/** 파트너 ID를 사람이 읽을 수 있는 짧은 표기로. 이름을 받아 오기 전의 대체 표기다 */
export function promoterLabel(promoterId: string): string {
  if (!promoterId) return '배정 없음';
  return `파트너 ${promoterId.slice(0, 8)}`;
}

export function filterDevices(rows: readonly DeviceRow[], f: { promoterId?: string; status?: DeviceStatus | 'ALL' }): DeviceRow[] {
  return rows.filter((d) => (f.promoterId ? d.promoterId === f.promoterId : true) && (f.status && f.status !== 'ALL' ? d.status === f.status : true));
}
