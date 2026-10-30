// 화면 등록(booking 쪽: 추가 검증·좌석·결제·결과·월렛·양도·취소·굿즈).
// 상태 목록은 캔버스 보드 data-props의 state 열거값 그대로(첫 값이 기본). 화면 페이지도 이 상수를 가져와 ?state=를 읽는다.
// 한 보드가 여러 경로를 그린 화면(SCR-011 복귀·SCR-013·SCR-015)은 경로마다 그 경로에 보이는 상태만 나눠 담는다.
import { ORIGINS } from './origins';
import type { WebScreen } from './screens.types';

/** SCR-009 추가 검증: 보드 상태 8 */
export const SCR009_STATES = [
  '검증 중',
  '챌린지 실패',
  '통과, 차례 전',
  '통과, 차례 지남',
  '재검토 접수',
  '재검토 결과 인정(차례 전)',
  '재검토 결과 인정(차례 지남)',
  '재검토 결과 기각',
] as const;
export type Scr009State = (typeof SCR009_STATES)[number];

/** SCR-010 좌석 선택: 보드 상태 23 */
export const SCR010_STATES = [
  '전체 배치',
  '확대 — 좌석',
  '경합 패배',
  '목록으로 보기',
  '홀드 1분 전',
  '무활동 경고',
  '자동 배정 결과',
  '실시간 반영 지연',
  '확대 중간',
  '로딩',
  '실시간 연결 복구 중',
  '한도 초과',
  '연장 뒤',
  '홀드 만료',
  '구매 세션 끝',
  '판매 일시정지',
  '판매 종료',
  '운영 공지',
  '세션 무효',
  '배정 중(자동 배정)',
  '배정 실패(자동 배정)',
  '희망 조건 오류(자동 배정)',
  '방금 놓은 좌석',
] as const;
export type Scr010State = (typeof SCR010_STATES)[number];

/** SCR-011 주문·결제(/checkout): 보드 상태 15 */
export const SCR011_STATES = [
  '입력',
  '위젯 준비',
  '입력 오류',
  '판매 일시정지',
  '결제 일시 정지',
  '결제사 전환',
  '전환 뒤 원래 결제창 실패',
  '결제 시도 초과',
  '홀드 만료(결제창 열기 전)',
  '본인확인 정보 없음',
  '결제창 복귀 · 접수 중',
  '복귀 뒤 새로고침',
  '금액 불일치',
  '이미 진행 중',
  '예매 제한(주문 생성 403)',
] as const;
export type Scr011State = (typeof SCR011_STATES)[number];

/** SCR-011 결제 복귀(/checkout/return): 같은 보드에서 결제창 복귀 뒤에 나오는 상태 4(접수 중·새로고침·접수 400·접수 409, d5 §5.11) */
export const SCR011_RETURN_STATES = ['결제창 복귀 · 접수 중', '복귀 뒤 새로고침', '금액 불일치', '이미 진행 중'] as const;
export type Scr011ReturnState = (typeof SCR011_RETURN_STATES)[number];

/** SCR-012 결제 결과: 보드 상태 10 */
export const SCR012_STATES = [
  '확정',
  '확인 중',
  '확인이 길어짐',
  '결제 완료·티켓 발급 중',
  '결과 불명',
  '결과 불명 1시간 넘음',
  '승인 거절',
  '발권 불가 결제 취소',
  '입금 대기',
  '입금 오류',
] as const;
export type Scr012State = (typeof SCR012_STATES)[number];

/** SCR-013 마이 티켓 목록(/my/tickets): 보드(m) 상태 중 목록 전체에 걸리는 셋(첫 티켓 펼침이 보드 기본) */
export const SCR013_LIST_STATES = ['기본(QR 펼침)', '오프라인', '빈 화면'] as const;
export type Scr013ListState = (typeof SCR013_LIST_STATES)[number];

/** SCR-013 티켓 펼침(/my/tickets/[ticketId]): 보드(m) 상태 20 중 '빈 화면'을 뺀 19. t·d 보드의 '부스 재발급 동의'는 '저장소 유실 · 입장 시작 뒤'(대조 동의 창 열림)와 같다 */
export const SCR013_DETAIL_STATES = [
  '기본(QR 펼침)',
  'QR 15초 지남',
  '키 없음',
  '키 없음 · iOS 브라우저 탭',
  '키 없음 · 키 폐기 뒤',
  '오프라인',
  '받은 티켓',
  '저장소 유실 · 입장 시작 전',
  '재발급 한도',
  '저장소 유실 · 입장 시작 뒤',
  '부스 요청 한도',
  '부스 대조 불일치',
  '부스 코드(10분)',
  '취소 접수됨',
  '공연 취소됨',
  '일정 변경',
  '입장함·퇴장함',
  '취소 무효·회수됨',
  '환급됨',
] as const;
export type Scr013DetailState = (typeof SCR013_DETAIL_STATES)[number];

/** SCR-014 티켓 양도: 보드 상태 11 */
export const SCR014_STATES = [
  '받는 사람 확인',
  '비회원·본인확인 전',
  '확인 시도 초과',
  '재인증 시트',
  '양도 확인 시트',
  '요청 보냄',
  '철회 불가',
  '양도 불가 · 마감 지남',
  '양도 불가 · 받은 티켓',
  '양도 불가 상품',
  '재인증 만료',
] as const;
export type Scr014State = (typeof SCR014_STATES)[number];

/** SCR-015 굿즈 스토어(/shop) — SCR-015 담당이 보드에 맞춰 나눈다 */
export const SCR015_SHOP_STATES = ['카탈로그', '옵션 고르기', '장바구니에 담음', '장바구니 드로어', '품절', '한도 초과', '빈 화면', '로딩'] as const;
export type Scr015ShopState = (typeof SCR015_SHOP_STATES)[number];

/** SCR-015 굿즈 상세(/shop/[productId]) */
export const SCR015_PRODUCT_STATES = ['상품 상세', '티켓 미소지', '품절'] as const;
export type Scr015ProductState = (typeof SCR015_PRODUCT_STATES)[number];

/** SCR-015 장바구니(/shop/cart) */
export const SCR015_CART_STATES = ['기본', '빈 화면'] as const;
export type Scr015CartState = (typeof SCR015_CART_STATES)[number];

/** SCR-015 굿즈 주문·결제(/shop/checkout) */
export const SCR015_CHECKOUT_STATES = ['주문서', '배송 정보 동의 없음', '재고 예약 만료', '주문 완료'] as const;
export type Scr015CheckoutState = (typeof SCR015_CHECKOUT_STATES)[number];

/** SCR-015 티켓 연동 부가 상품(/my/tickets/[ticketId]/addons) */
export const SCR015_ADDON_STATES = ['기본', '장바구니에 담음', '빈 화면'] as const;
export type Scr015AddonState = (typeof SCR015_ADDON_STATES)[number];

/** SCR-038 예매 취소: 보드 상태 14 */
export const SCR038_STATES = [
  '선택',
  '계산 중',
  '재인증',
  '재인증 만료',
  '최종 확인 시트',
  '취소 불가',
  '결제사 지연',
  '양도 요청 중이라 불가',
  '취소 처리 중',
  '입장 시작 뒤 접수',
  '취소 확인 중',
  '취소 무효',
  '연기 환급',
  '연기 환급 최종 확인',
] as const;
export type Scr038State = (typeof SCR038_STATES)[number];

/** SCR-041 양도 받기: 보드 상태 9 */
export const SCR041_STATES = [
  '요청',
  '수락 완료',
  '기한 만료',
  '철회됨',
  '공연 취소로 철회됨',
  '일정 변경으로 철회됨',
  '처리됨',
  '입장 시작',
  '권한 없음',
] as const;
export type Scr041State = (typeof SCR041_STATES)[number];

export const BOOKING_SCREENS: readonly WebScreen[] = [
  { id: 'SCR-009', name: '추가 검증', path: '/queue/evt-lumen-1025/verify', group: 'request', owner: 'booking', states: SCR009_STATES },
  { id: 'SCR-010', name: '좌석 선택', path: '/booking/evt-lumen-1025/seats', group: 'request', owner: 'booking', states: SCR010_STATES },
  { id: 'SCR-011', name: '주문·결제', path: '/booking/evt-lumen-1025/checkout', group: 'request', owner: 'booking', states: SCR011_STATES },
  {
    id: 'SCR-011',
    name: '결제 복귀',
    path: '/booking/evt-lumen-1025/checkout/return',
    group: 'cached',
    owner: 'booking',
    states: SCR011_RETURN_STATES,
    note: '결제창에서 돌아오는 첫 요청(쿠키 없음)',
  },
  { id: 'SCR-012', name: '결제 결과', path: '/booking/evt-lumen-1025/result', group: 'request', owner: 'booking', states: SCR012_STATES },
  { id: 'SCR-013', name: '마이 티켓(월렛)', path: '/my/tickets', group: 'cached', owner: 'booking', states: SCR013_LIST_STATES },
  { id: 'SCR-013', name: '티켓 상세', path: '/my/tickets/tkt-lumen-r1-0312', group: 'cached', owner: 'booking', states: SCR013_DETAIL_STATES },
  { id: 'SCR-014', name: '티켓 양도', path: '/my/tickets/tkt-lumen-r1-0312/transfer', group: 'request', owner: 'booking', states: SCR014_STATES },
  { id: 'SCR-038', name: '예매 취소', path: '/my/tickets/tkt-lumen-r1-0312/cancel', group: 'request', owner: 'booking', states: SCR038_STATES },
  {
    id: 'SCR-015',
    name: '티켓 연동 부가 상품',
    path: '/my/tickets/tkt-lumen-r1-0312/addons',
    group: 'request',
    owner: 'booking',
    states: SCR015_ADDON_STATES,
  },
  { id: 'SCR-015', name: '굿즈 스토어', path: '/shop', group: 'cached', owner: 'booking', states: SCR015_SHOP_STATES },
  { id: 'SCR-015', name: '굿즈 상세', path: '/shop/gds-lumen-lightstick', group: 'cached', owner: 'booking', states: SCR015_PRODUCT_STATES },
  { id: 'SCR-015', name: '장바구니', path: '/shop/cart', group: 'request', owner: 'booking', states: SCR015_CART_STATES },
  { id: 'SCR-015', name: '굿즈 주문·결제', path: '/shop/checkout', group: 'request', owner: 'booking', states: SCR015_CHECKOUT_STATES },
  { id: 'SCR-041', name: '양도 받기', path: '/my/transfers/ofr-0001', group: 'request', owner: 'booking', states: SCR041_STATES },
  // 굿즈 대기는 대기실 경량 페이지(포트 3004)
  {
    id: 'SCR-015',
    name: '굿즈 대기',
    path: `${ORIGINS.queueRoom}/shop/gds-lumen-lightstick/queue`,
    group: 'queue-room',
    owner: 'queue-room',
    states: [],
    external: true,
  },
];
