// SCR-065 파트너사·계약 화면의 표기 함수(BAT-615 LCH-070). bp(만분율)를 퍼센트로, 시각을 KST로 바꾼다.
export type GuaranteeKind = 'DEPOSIT' | 'PERFORMANCE_BOND';

export const guaranteeLabel = (kind: string | null | undefined): string => (kind === 'PERFORMANCE_BOND' ? '이행보증보험' : '보증금');

/** 10,000bp = 100%. 소수 둘째 자리까지 남기고 0을 줄인다(875bp → 8.75%) */
export function formatBp(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return '-';
  const value = bp / 100;
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** 입력 퍼센트 글자를 bp 정수로. 비었거나 범위 밖이면 undefined */
export function parseBp(text: string): number | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return Math.round(n * 100);
}

const kst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const kstTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });

/** 2026. 11. 20. 오후 8:04 같은 표기 대신 2026-11-20 20:04 KST로 고정한다 */
export function formatKst(iso: string | null | undefined): string {
  if (!iso) return '지금';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${kst.format(d).replace(/\s/g, '')} ${kstTime.format(d)} KST`;
}

export const periodLabel = (validUntil: string | null): string => (validUntil ? `~ ${formatKst(validUntil)}` : '지금 계약(상한 없음)');

/** 화면 오류 문구: 서버 title 원문 대신 상태별로 정한 문구만 보인다 */
export function contractProblemMessage(err: unknown): string {
  const status = (err as { status?: number } | undefined)?.status;
  const type = (err as { type?: string } | undefined)?.type;
  if (status === 409 && type === 'contract-change-pending') return '이미 승인 대기 중인 계약 변경이 있습니다. 그 변경이 끝난 뒤 다시 요청해 주세요.';
  if (status === 409) return '다른 사람이 먼저 처리했습니다. 목록을 새로 고친 뒤 다시 시도해 주세요.';
  if (status === 422) return '바꿀 값이 지금과 같거나 범위를 벗어났습니다. 수수료율·보증은 0~100%이고, 바꿀 칸을 하나 이상 골라야 합니다.';
  if (status === 404) return '파트너사를 찾을 수 없습니다.';
  if (status === 503) return '승인 업무 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  if (status === 403) return '이 역할은 계약을 바꿀 수 없습니다.';
  return '요청을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}
