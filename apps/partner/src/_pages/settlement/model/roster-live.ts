// SCR-027 [예매자 명단]·[다운로드 이력]이 계약 값을 화면 말로 바꾸고, 내려받기 전에 사유·형식을 본다.
// 내려받기는 파트너 관리자만, 비밀번호·TOTP·패스키 재인증(act BOOKER_EXPORT) 뒤에만 된다(I-T53, J-T26).
import type { AttendeeExport, AttendeeRow } from '../../../shared/api/partner-live.ts';
import { isProblem, isReauthRequired, isRetentionEnded } from '../../../shared/api/problem.ts';

export function attendeeName(row: AttendeeRow): string {
  return row.name || '—';
}

export function attendeePhone(row: AttendeeRow): string {
  return row.phone || '—';
}

export function attendeeSeat(row: AttendeeRow): string {
  return row.seat || '—';
}

export function exportFormatLabel(format: 'CSV' | 'XLSX' | 'PDF'): string {
  return format;
}

export function exportResult(e: AttendeeExport): { label: string; badge: string } {
  return e.result === 'COMPLETED'
    ? { label: '완료', badge: 'badge badge-success' }
    : { label: '실패', badge: 'badge badge-danger' };
}

export function exportCount(e: AttendeeExport): string {
  return e.result === 'COMPLETED' ? `${e.count.toLocaleString('ko-KR')}건` : '—';
}

export function exportWhen(e: AttendeeExport): string {
  const d = new Date(e.exportedAt);
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

/** 사유는 1~500자다(openapi createPartnerEventAttendeeExport). */
export function checkAttendeeExportReason(reason: string): string | null {
  const text = reason.trim();
  if (text.length === 0) return '다운로드 사유가 비어 있어 내려받지 않았습니다. 내려받는 이유를 적어 주세요.';
  if (text.length > 500) return '다운로드 사유는 500자까지입니다.';
  return null;
}

export interface ReauthErrorView {
  kind: 'reauth-required' | 'retention-ended' | 'cancelled' | 'other';
  message: string;
}

/** 재인증·보유 기간·사용자 취소를 화면 문구로 가른다. */
export function reauthErrorView(e: unknown): ReauthErrorView {
  if (isReauthRequired(e)) {
    return { kind: 'reauth-required', message: '다시 인증하지 않아 내려받지 않았습니다. 비밀번호·인증 앱 코드와 패스키로 다시 확인해 주세요.' };
  }
  if (isRetentionEnded(e)) {
    return { kind: 'retention-ended', message: '회차가 끝나고 1개월이 지나 명단을 내려받을 수 없습니다.' };
  }
  if (e instanceof DOMException && e.name === 'NotAllowedError') {
    return { kind: 'cancelled', message: '패스키 확인을 취소해 내려받지 않았습니다.' };
  }
  if (isProblem(e) && e.status === 403) {
    return { kind: 'other', message: '파트너 관리자만 명단을 내려받을 수 있습니다.' };
  }
  return { kind: 'other', message: '명단을 내려받지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
}

/** 파일 이름은 서버 Content-Disposition을 우선하고, 없으면 화면이 만든다. */
export function downloadName(eventName: string, format: 'CSV' | 'XLSX' | 'PDF'): string {
  const safe = eventName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '공연';
  return `${safe}_예매자명단.${format.toLowerCase()}`;
}
