// SCR-027 정산 리포트·명단 목업(보드 SCR-027-m·t·d의 예시 숫자 그대로). 합성 데이터이고 실제 사람·연락처가 아니다.
// 예매자 이름·휴대폰은 보드처럼 가린 값만 둔다(동의 범위 항목, data-classification).

export interface Statement {
  /** 'toss' | 'portone' — 이의 제기 대화상자 id에 쓴다 */
  key: 'toss' | 'portone';
  provider: string;
  sales: number;
  refund: number;
  fee: number;
  offset: number;
  payout: number;
  payDate: string;
  /** 토스페이먼츠 결제분은 KYC 필요(보류)일 때 'KYC 확인 뒤 지급' */
  kycHold: boolean;
}

/** 10/25(일) 18:00 KST 회차의 결제사별 정산서 */
export const statements: readonly Statement[] = [
  {
    key: 'toss',
    provider: '토스페이먼츠',
    sales: 290_004_000,
    refund: 2_464_000,
    fee: 31_629_400,
    offset: 4_804_800,
    payout: 251_105_800,
    payDate: '10/30(금)',
    kycHold: true,
  },
  {
    key: 'portone',
    provider: '포트원',
    sales: 22_880_000,
    refund: 220_000,
    fee: 2_492_600,
    offset: 0,
    payout: 20_167_400,
    payDate: '10/30(금)',
    kycHold: false,
  },
];

export const settleTotals = {
  sales: 312_884_000,
  refund: 2_684_000,
  fee: 34_122_000,
  offset: 4_804_800,
  payout: 271_273_200,
};

/** 지급이 멈추거나 늦어질 때(d5 §6.10, 보류·지급일 연기 설명은 추천 적용 2026-10-28 글) */
export const PAYOUT_HOLDS: readonly { label: string; badge: string; text: string }[] = [
  {
    label: '이의 처리 중',
    badge: 'badge badge-warning',
    text: '그 정산서만 지급을 멈추고 PEAKET이 확인합니다. 3영업일 안에 진행 상황을, 10영업일 안에 결과를 알립니다. 조정하거나 받아들이지 않아 다시 알릴 때 이의 기간은 1영업일입니다.',
  },
  {
    label: '보류',
    badge: 'badge badge-warning',
    text: 'KYC 필요, 정산 계좌 변경 뒤 3영업일, 결제사 잔액 부족, 포트원 계좌 불일치(정산 계좌를 다시 내야 풀립니다), 판매 중지(판매가 재개될 때까지)면 지급을 멈춥니다. 사유가 풀리면 다음 지급 묶음으로 지급합니다.',
  },
  {
    label: '지급일 연기',
    badge: 'badge badge-warning',
    text: '지급 묶음 승인이 늦어지거나, 결제사 잔액이 모자라거나, 결제사 지급 API에 장애가 나면 지급일을 다음 영업일로 미루고 알립니다.',
  },
  {
    label: '지급 실패',
    badge: 'badge badge-danger',
    text: '계좌를 확인해 주세요. 확인되면 새 지급 건으로 다시 보냅니다.',
  },
];

/** 이의 사유 코드(settlement §4.2, d5 §6.10) */
export const DISPUTE_CODES: readonly { code: string; label: string; help: string }[] = [
  { code: 'GROSS_AMOUNT', label: '판매 대금 차이', help: '승인된 결제 금액의 합이 판매 기록과 다릅니다' },
  { code: 'REFUND_AMOUNT', label: '환급 금액 차이', help: '취소·환불 금액의 합이나 공제가 다릅니다' },
  { code: 'COMMISSION', label: '중개수수료·부가세 차이', help: '적용한 수수료율이나 계산이 계약과 다릅니다' },
  {
    code: 'OFFSET',
    label: '미수금 상계 차이',
    help: '상계한 미수금(지급 뒤 환불, 카드 이의제기, 배상 선지급, 지난 정산 이월)의 금액이나 근거가 다릅니다',
  },
  { code: 'OTHER', label: '그 밖의 사유', help: '위에 없는 사유입니다. 설명을 적어야 보낼 수 있습니다' },
];

/** 판매 요약(확정 집계) 등급별 판매 [예시 숫자]. 휠체어석 20석은 A석 안에 있다 */
export const tierSales: readonly { grade: string; sold: number; refunded: number; net: number }[] = [
  { grade: 'R석', sold: 600, refunded: 24, net: 576 },
  { grade: 'S석', sold: 900, refunded: 41, net: 859 },
  { grade: 'A석', sold: 900, refunded: 47, net: 853 },
];

/** 시간대별 누적 판매(오픈 10/14(수) 20:00 KST부터 분, 누적 매수). 보드 그래프의 점에서 읽은 값 [예시 숫자] */
export const cumulativeSales: readonly { min: number; total: number }[] = [
  { min: 0, total: 0 },
  { min: 1, total: 35 },
  { min: 2, total: 133 },
  { min: 3, total: 237 },
  { min: 5, total: 433 },
  { min: 10, total: 797 },
  { min: 15, total: 1022 },
  { min: 20, total: 1157 },
  { min: 22, total: 1204 },
  { min: 30, total: 1404 },
  { min: 40, total: 1664 },
  { min: 50, total: 1914 },
  { min: 60, total: 2174 },
  { min: 69, total: 2400 },
];

/** 오픈 20:00에서 min분 뒤의 'HH:MM' */
export function clockAfterOpen(min: number): string {
  const h = 20 + Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

export interface RosterRow {
  name: string;
  phone: string;
  bookingNo: string;
  round: string;
  seat: string;
  qty: number;
}

/** 예매자 명단 첫 쪽(동의 범위 항목만, 가린 값) */
export const rosterRows: readonly RosterRow[] = [
  { name: '김*민', phone: '010-****-1234', bookingNo: '2026101400123', round: '10/25(일) 18:00', seat: 'R1구역 12열 7·8번', qty: 2 },
  { name: '이*영', phone: '010-****-7730', bookingNo: '2026101400219', round: '10/25(일) 18:00', seat: 'S1구역 3열 11~14번', qty: 4 },
  { name: '박*준', phone: '010-****-0412', bookingNo: '2026101400226', round: '10/25(일) 18:00', seat: 'A2구역 16열 3번', qty: 1 },
  { name: '최*아', phone: '010-****-5568', bookingNo: '2026101400230', round: '10/25(일) 18:00', seat: 'R2구역 5열 10·11번', qty: 2 },
  { name: '정*호', phone: '010-****-1906', bookingNo: '2026101400244', round: '10/25(일) 18:00', seat: 'S2구역 9열 1~3번', qty: 3 },
  { name: '한*결', phone: '010-****-6623', bookingNo: '2026101400251', round: '10/25(일) 18:00', seat: 'A1구역 2열 5·6번', qty: 2 },
];

export const rosterTotals = { bookings: '1,031', tickets: '2,330', asOf: '10/24(토) 15:00 KST' };

export interface ExportLogRow {
  at: string;
  who: string;
  role: string;
  reason: string;
  count: string | null;
  format: 'CSV' | 'XLSX' | 'PDF';
  ok: boolean;
}

/** 예매자 명단 다운로드 이력(d5 §6.10 예, 건수는 명단의 예매 건수와 같다) */
export const exportLog: readonly ExportLogRow[] = [
  { at: '10/24(토) 15:02', who: '스텔라 관리자', role: '파트너 관리자', reason: '현장 명단 대조(동문 입장 확인용)', count: '1,031건', format: 'XLSX', ok: true },
  { at: '10/24(토) 14:58', who: '스텔라 관리자', role: '파트너 관리자', reason: '현장 명단 대조(동문 입장 확인용)', count: null, format: 'XLSX', ok: false },
  { at: '10/21(수) 11:20', who: '스텔라 관리자', role: '파트너 관리자', reason: '[예시 사유]', count: '[예시]건', format: 'CSV', ok: true },
];

export const TIER_FILTER = ['전체 등급', 'R석', 'S석', 'A석', '휠체어석'] as const;

/** 공연에 회차 목록이 없으면 쓰는 LUMEN 회차 */
export const FALLBACK_ROUNDS = ['10/25(일) 18:00 KST', '10/26(월) 17:00 KST'] as const;
