// 약관·정책 문서 목업(SCR-057, d5 §5.31, planning/04 SCR-057 ①). 문서 일곱 가지와 목차(h2)·작은 제목(h3).
// 조항 본문은 캔버스 보드처럼 '[조항 본문은 법무 검토 뒤 확정]' 자리 표시로 둔다. 정본 문구가 있는 곳만 그대로 옮겼다:
// 판매 조건 공통의 정렬 방식 표준 문구(POL-004), 분쟁 해결 기준의 취소 공제표(POL-032), 미성년자 계약 취소(POL-038 ⑧), 통신판매중개자 고지(POL-037).
// 주소 이름(slug)은 셸 바닥글·다른 화면 링크가 이미 쓰는 terms·privacy·dispute·business와 FAQ의 sale-terms를 따랐다.

export type PolicySlug = 'terms' | 'privacy' | 'dispute' | 'sale-terms' | 'community' | 'business' | 'security-notice';

/** 본문 한 덩이: 문단 · 자리 표시 · 작은 제목 · 표 · 링크 */
export type PolicyBlock =
  | { kind: 'placeholder' }
  | { kind: 'p'; text: string }
  | { kind: 'h3'; text: string; id?: string }
  /** 표: 이름은 앞 작은 제목(labelledBy) 또는 숨긴 caption */
  | { kind: 'table'; labelledBy?: string; caption?: string; head: readonly string[]; rows: readonly (readonly string[])[]; mutedCols?: readonly number[] }
  | { kind: 'link'; href: string; text: string }
  | { kind: 'legal'; text: string };

export interface PolicySection {
  /** 앵커 id(목차 링크 #id) */
  id: string;
  title: string;
  blocks: readonly PolicyBlock[];
}

export interface PolicyDoc {
  slug: PolicySlug;
  title: string;
  /** 시행일(KST) */
  effective: string;
  /** 바로 앞 버전의 시행일 [가정] */
  previous?: string;
  /** 게시 중일 때만 고를 수 있는 문서(보안 사고 안내) */
  postedOnly?: boolean;
  sections: readonly PolicySection[];
}

const TBD: PolicyBlock = { kind: 'placeholder' };

/** 취소 공제표(POL-032). 공연 상세 '취소·환불 안내사항'과 같은 값 */
export const CANCEL_FEE_ROWS: readonly (readonly [string, string])[] = [
  ['예매 후 24시간 안', '없음'],
  ['관람일 10일 전까지', '없음'],
  ['관람일 9~7일 전', '10%'],
  ['관람일 6~3일 전', '20%'],
  ['관람일 2~1일 전', '30%'],
  ['공연 당일 시작 전까지', '90%'],
];

/** 바닥글·사업자 정보의 통신판매중개자 고지(POL-037 초기 화면 문장). 한 글자도 바꾸지 않는다 */
export const BROKER_NOTICE_FOOTER =
  'PEAKET은 통신판매중개자로서 공연과 상품 거래의 당사자가 아닙니다. 공연의 개최·변경·취소와 상품의 제공·품질에 따른 책임은 각 판매자에게 있고, 예매·주문 취소와 환불은 PEAKET이 처리합니다. 판매자 정보는 각 공연·상품 상세에 있습니다.';

export const POLICY_DOCS: readonly PolicyDoc[] = [
  {
    slug: 'terms',
    title: '이용약관',
    effective: '2026-11-01',
    previous: '2026-05-01',
    sections: [
      { id: 'tm-1', title: '제1조(목적)', blocks: [TBD] },
      { id: 'tm-2', title: '제2조(정의)', blocks: [TBD] },
      { id: 'tm-3', title: '제3조(회원 가입과 계정)', blocks: [TBD] },
      {
        id: 'tm-4',
        title: '제4조(예매와 판매 조건)',
        blocks: [
          { kind: 'h3', text: '정렬 방식' },
          TBD,
          { kind: 'h3', text: '1인 1순번' },
          TBD,
          { kind: 'h3', text: '매수 한도' },
          TBD,
          { kind: 'link', href: '/policy/sale-terms', text: '판매 조건 공통' },
        ],
      },
      {
        id: 'tm-5',
        title: '제5조(취소와 환불)',
        blocks: [TBD, { kind: 'p', text: '만 19세 미만 미성년자가 법정대리인(부모 등)의 동의 없이 결제하면, 미성년자 본인이나 법정대리인이 이 계약을 취소할 수 있습니다.' }],
      },
      { id: 'tm-6', title: '제6조(양도)', blocks: [TBD] },
      { id: 'tm-7', title: '제7조(금지 행위)', blocks: [TBD] },
      { id: 'tm-8', title: '제8조(통신판매중개자의 지위)', blocks: [TBD] },
      { id: 'tm-9', title: '제9조(분쟁 해결)', blocks: [TBD, { kind: 'link', href: '/policy/dispute', text: '분쟁 해결 기준' }] },
    ],
  },
  {
    slug: 'privacy',
    title: '개인정보 처리방침',
    effective: '2026-11-01',
    previous: '2026-05-01',
    sections: [
      { id: 'pp-1', title: '1. 개인정보의 처리 목적과 항목', blocks: [TBD] },
      { id: 'pp-2', title: '2. 처리·보유 기간과 파기', blocks: [TBD] },
      { id: 'pp-3', title: '3. 제3자 제공과 처리 위탁', blocks: [TBD] },
      { id: 'pp-4', title: '4. 정보주체의 권리와 행사 방법', blocks: [TBD] },
      {
        id: 'pp-5',
        title: '5. 자동화된 결정',
        blocks: [
          { kind: 'h3', text: '판정 사실과 목적' },
          TBD,
          { kind: 'h3', text: '대상과 활용하는 개인정보 유형' },
          TBD,
          { kind: 'h3', text: '판단 기준과 처리 절차' },
          TBD,
          { kind: 'h3', text: '설명과 인적 검토를 요구하는 방법' },
          TBD,
          { kind: 'link', href: '/help/inquiries/new', text: '설명·재검토 문의하기' },
        ],
      },
      {
        id: 'pp-6',
        title: '6. 자동 수집 장치(쿠키)의 운영과 거부',
        blocks: [
          TBD,
          { kind: 'h3', text: '쿠키 목록', id: 'pp-6-t' },
          {
            kind: 'table',
            labelledBy: 'pp-6-t',
            head: ['쿠키 이름', '목적', '보관 기간', '거부 방법', '거부 때 영향'],
            // 쿠키 이름·보관 기간은 정본이 정하지 않아 보드처럼 [미정](d5 §5.31: 목적은 로그인·대기열 공정성·봇 방어)
            rows: [
              ['[미정]', '로그인', '[미정]', '[미정]', '[미정]'],
              ['[미정]', '대기열 공정성', '[미정]', '[미정]', '[미정]'],
              ['[미정]', '봇 방어', '[미정]', '[미정]', '[미정]'],
            ],
            mutedCols: [0, 2, 3, 4],
          },
        ],
      },
      { id: 'pp-7', title: '7. 개인정보 보호책임자와 고충 처리', blocks: [TBD] },
    ],
  },
  {
    slug: 'dispute',
    title: '분쟁 해결 기준',
    effective: '2026-11-01',
    previous: '2026-05-01',
    sections: [
      { id: 'ds-1', title: '1. 적용 범위', blocks: [TBD] },
      {
        id: 'ds-2',
        title: '2. 예매 취소와 공제',
        blocks: [
          {
            kind: 'table',
            caption: '취소 시점별 공제율',
            head: ['취소 시점', '공제'],
            rows: CANCEL_FEE_ROWS,
          },
          { kind: 'p', text: '예매 후 24시간 안 취소는 관람일 3일 전까지만 해당하고, 주말·공휴일은 24시간 계산에서 뺍니다. 근거: 소비자분쟁해결기준' },
        ],
      },
      { id: 'ds-3', title: '3. 회차 취소·연기 때 환급과 배상', blocks: [TBD] },
      { id: 'ds-4', title: '4. 환급 수단과 기한', blocks: [TBD] },
      { id: 'ds-5', title: '5. 분쟁 접수와 처리 절차', blocks: [TBD, { kind: 'link', href: '/help/inquiries/new', text: '분쟁 문의하기' }] },
    ],
  },
  {
    slug: 'sale-terms',
    title: '판매 조건 공통',
    effective: '2026-11-01',
    previous: '2026-05-01',
    sections: [
      {
        id: 'st-1',
        title: '1. 정렬 방식',
        blocks: [
          { kind: 'h3', text: '하이브리드' },
          { kind: 'p', text: '오픈 전에 들어온 분은 오픈 시각에 무작위로 순번을 받습니다. 일찍 들어와도 유리하지 않습니다. 오픈 후에 오신 분은 그 뒤에 도착 순으로 섭니다.' },
          { kind: 'h3', text: '사전 셔플' },
          {
            kind: 'p',
            text: '오픈 전에 들어온 분은 오픈 시각에 무작위로 순번을 받습니다. 일찍 들어와도 유리하지 않습니다. 오픈 후에 오신 분은 대기실 참가자 모두의 뒤에 도착 순으로 섭니다.',
          },
          { kind: 'h3', text: '선착순' },
          {
            kind: 'p',
            text: '오픈 직후 2초 안에 도착한 분들은 같은 시각에 온 것으로 보고 무작위로 순서를 정합니다. 그 뒤에 오신 분은 도착 순으로 섭니다. 순서를 정하는 동안에는 순번이 보이지 않습니다. 오픈 직후 약 20초 안에 순번이 정해지고, 그 뒤 차례대로 입장합니다.',
          },
          { kind: 'p', text: '좌석은 등급 안에서 자동으로 배정됩니다(자동 배정 공연).' },
        ],
      },
      { id: 'st-2', title: '2. 1인 1순번', blocks: [TBD] },
      { id: 'st-3', title: '3. 매수 한도', blocks: [TBD] },
      { id: 'st-4', title: '4. 셔플 검증', blocks: [TBD, { kind: 'link', href: '/events/evt-lumen-1025/shuffle-proof', text: '셔플 검증' }] },
    ],
  },
  {
    slug: 'community',
    title: '운영정책(게시물)',
    effective: '2026-11-01',
    previous: '2026-05-01',
    sections: [
      { id: 'cp-1', title: '1. 게시물 노출 제한', blocks: [TBD] },
      { id: 'cp-2', title: '2. 게시물 신고', blocks: [TBD] },
      { id: 'cp-3', title: '3. 권리 침해 삭제 요청과 임시조치', blocks: [TBD] },
      { id: 'cp-4', title: '4. 처리 결과 알림과 이의 제기', blocks: [TBD] },
    ],
  },
  {
    slug: 'business',
    title: '사업자 정보',
    effective: '2026-11-01',
    sections: [
      {
        id: 'bz-1',
        title: '1. 사업자 신원정보',
        blocks: [
          // 사업자 값은 바닥글과 같은 자리 표시(사업자 등록 뒤 확정)
          {
            kind: 'table',
            caption: 'PEAKET 사업자 신원정보',
            head: ['항목', '내용'],
            rows: [
              ['상호', 'PEAKET(피켓)'],
              ['대표자', '[대표자]'],
              ['사업자등록번호', '[000-00-00000]'],
              ['통신판매업 신고번호', '[제0000-서울○○-0000호]'],
              ['주소', '[사업장 주소]'],
              ['고객센터', '[0000-0000]'],
            ],
          },
        ],
      },
      { id: 'bz-2', title: '2. 통신판매중개자 고지', blocks: [{ kind: 'legal', text: BROKER_NOTICE_FOOTER }] },
      {
        id: 'bz-3',
        title: '3. 구매안전서비스',
        blocks: [
          { kind: 'p', text: '구매안전서비스: 굿즈 택배 주문은 토스페이먼츠 결제대금예치를 이용할 수 있습니다' },
          { kind: 'h3', text: '서비스 가입 사실 확인' },
          TBD,
        ],
      },
    ],
  },
  {
    slug: 'security-notice',
    title: '보안 사고 안내',
    effective: '2026-11-01',
    postedOnly: true,
    sections: [],
  },
];

export function getPolicyDoc(slug: string): PolicyDoc | undefined {
  return POLICY_DOCS.find((d) => d.slug === slug);
}

export function policyHref(slug: PolicySlug): string {
  return `/policy/${slug}`;
}
