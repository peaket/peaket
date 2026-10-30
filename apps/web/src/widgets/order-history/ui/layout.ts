// SCR-055 예매·주문 내역의 본문 상자와 데스크톱 12열(목록 /my/orders와 상세 /my/orders/[orderId]가 같이 쓴다).
/** 본문 상자: 휴대폰 16 · 태블릿 24 · 데스크톱 1040 상자 안 32(보드 .container) */
export const ORDERS_WRAP =
  'col w-full gap-5 px-4 pt-4 pb-10 md:px-6 md:pt-6 md:pb-12 lg:mx-auto lg:max-w-[1040px] lg:gap-6 lg:px-8 lg:pt-8 lg:pb-16';
/** 데스크톱 12열(보드 .grid-12, 줄 사이 24) */
export const ORDERS_GRID = 'col gap-6 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:gap-y-6';
