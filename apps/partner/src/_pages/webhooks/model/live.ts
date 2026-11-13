// SCR-025 웹훅 화면이 계약 값을 읽고, 주소를 등록 전에 같은 규칙으로 한 번 더 본다.
// 서버가 SSRF 검사를 다시 한다(docs/features/notify.md §9). 여기 검사는 바로 고칠 수 있게 하려는 것이다.
import type { WebhookDelivery, WebhookEndpoint, WebhookEventType } from '@/shared/api/partner-live';

export const EVENT_TYPE_OPTIONS: readonly { type: WebhookEventType; label: string; desc: string }[] = [
  { type: 'order.confirmed', label: '판매 확정', desc: '결제가 확정되어 티켓을 발권했을 때' },
  { type: 'order.cancelled', label: '예매 취소·환급', desc: '예매 취소가 확정되어 환급을 시작할 때' },
  { type: 'event.sold_out', label: '매진', desc: '회차의 모든 좌석이 팔렸을 때' },
  { type: 'event.cancelled', label: '회차 취소 확정', desc: '회차 취소가 확정되었을 때' },
  { type: 'event.postponed', label: '회차 연기 확정', desc: '회차 연기가 확정되었을 때' },
  { type: 'statement.notified', label: '정산서 통지', desc: '정산서를 계산해 알렸을 때(이의 기간 시작)' },
  { type: 'payout.completed', label: '지급 완료', desc: '정산금이 정산 계좌로 지급되었을 때' },
  { type: 'payout.failed', label: '지급 실패', desc: '지급이 실패해 계좌 확인이 필요할 때' },
];

export function eventTypeLabel(type: string): string {
  return EVENT_TYPE_OPTIONS.find((e) => e.type === type)?.label ?? type;
}

export interface UrlCheck {
  ok: boolean;
  /** 'scheme' | 'port' | 'credentials' | 'ip-literal' | 'private-address' | 'format' */
  reason?: string;
  message?: string;
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^\[[0-9a-f:]+\]$/i;

function privateIpv4(host: string): boolean {
  const p = host.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a === 0;
}

/** 등록·고치기 전에 보는 주소 규칙. 서버의 DNS 해석 뒤 사설 IP 검사는 여기서 할 수 없다. */
export function checkWebhookUrl(value: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, reason: 'format', message: '주소 모양이 맞지 않습니다. https://로 시작하는 주소를 적어 주세요' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme', message: 'https 주소만 등록할 수 있습니다' };
  if (url.port !== '' && url.port !== '443') return { ok: false, reason: 'port', message: '443 포트만 받습니다. 주소에서 포트를 빼 주세요' };
  if (url.username || url.password) return { ok: false, reason: 'credentials', message: '주소에 사용자 정보(user:pass@)를 넣을 수 없습니다' };
  const host = url.hostname.toLowerCase();
  if (IPV4.test(host) || IPV6.test(host)) return { ok: false, reason: 'ip-literal', message: 'IP 주소를 그대로 쓴 주소는 등록할 수 없습니다. 도메인 이름을 써 주세요' };
  if (PRIVATE_HOST.test(host) || (IPV4.test(host) && privateIpv4(host))) {
    return { ok: false, reason: 'private-address', message: '사설·루프백 주소로는 보낼 수 없습니다. 공인 도메인 이름을 써 주세요' };
  }
  return { ok: true };
}

export interface EndpointView {
  label: string;
  badge: string;
  canRedeliver: boolean;
  canEdit: boolean;
}

export function endpointView(e: WebhookEndpoint): EndpointView {
  if (e.status === 'DISABLED' && e.disabledReason === 'FAILING') return { label: '꺼짐 · 계속 실패', badge: 'badge badge-danger', canRedeliver: false, canEdit: true };
  if (e.status === 'DISABLED') return { label: '꺼짐', badge: 'badge', canRedeliver: false, canEdit: true };
  return { label: '켜짐', badge: 'badge badge-success', canRedeliver: true, canEdit: true };
}

export interface DeliveryView {
  label: string;
  badge: string;
  canRedeliver: boolean;
}

export function deliveryView(d: WebhookDelivery): DeliveryView {
  switch (d.status) {
    case 'PENDING':
      return { label: '보내는 중', badge: 'badge badge-outline', canRedeliver: false };
    case 'RETRYING':
      return { label: '재시도 중', badge: 'badge badge-warning', canRedeliver: false };
    case 'SUCCEEDED':
      return { label: '성공', badge: 'badge badge-success', canRedeliver: true };
    default:
      return { label: 'DLQ', badge: 'badge badge-danger', canRedeliver: true };
  }
}

export function deliveryResult(d: WebhookDelivery): string {
  if (d.lastHttpStatus !== null) return String(d.lastHttpStatus);
  if (d.lastError) {
    const map: Record<string, string> = {
      TIMEOUT: '응답 없음(시간 초과)',
      TLS: 'TLS 연결 실패',
      DNS_BLOCKED: '주소를 찾지 못함(차단)',
      REDIRECT: '리디렉션 응답',
    };
    return map[d.lastError] ?? d.lastError;
  }
  return '—';
}

export function deliveryWhen(d: WebhookDelivery): string {
  const created = kst(d.createdAt);
  if (d.nextAttemptAt) return `${created} · 다음 ${kst(d.nextAttemptAt)}`;
  if (d.finishedAt) return `${created} · 끝 ${kst(d.finishedAt)}`;
  return created;
}

export function kst(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** 비밀 원문은 발급 응답에만 온다. 화면은 이 값이 있을 때만 전체를 보여 준다. */
export function secretMasked(issuedAt: string | null): string {
  return issuedAt ? 'whsec_••••••••••••••••••••••••' : '—';
}

/** 이벤트 8종 가운데 고른 것만. 구독이 없으면 빈 배열이다. */
export function toggleEvent(selected: readonly WebhookEventType[], type: WebhookEventType): WebhookEventType[] {
  return selected.includes(type) ? selected.filter((t) => t !== type) : [...selected, type];
}

export function subscriptionText(types: readonly string[]): string {
  return types.length === 0 ? '고른 이벤트가 없어 보내지 않습니다' : types.map(eventTypeLabel).join(' · ');
}
