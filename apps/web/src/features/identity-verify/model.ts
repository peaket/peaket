// SCR-006 본인확인 흐름의 문구와 결과 종류(d5 §5.6 상태 표, 캔버스 보드 SCR-006-m·t·d). 문구는 d5 표가 정본이다(docs/planning/04 SCR-006).
// 별도 화면이 없다: 부르는 화면의 [휴대폰 본인확인]이 기관 창을 바로 열고, 결과는 부르는 화면 위 대화상자로 보인다(ADR-0063).

/** 부르는 목적: 최초(SCR-002·005·050 등) · 재확인(SCR-009) · 부스 대조(SCR-013 ⑩) */
export type VerifyPurpose = 'first' | 'reverify' | 'booth';

/** 기관 창의 결과. success는 토스트만, 나머지는 결과 대화상자 */
export type VerifyOutcome = 'success' | 'closed' | 'down' | 'other' | 'under14' | 'mismatch' | 'popup';

/** 버튼 위 목적 문구 한 줄(①) */
export const VERIFY_PURPOSE_TEXT: Record<VerifyPurpose, string> = {
  first: '휴대폰 본인확인은 계정당 한 번만 합니다. 한 사람은 한 계정으로만 예매할 수 있습니다',
  reverify: '같은 분인지 다시 확인합니다',
  booth: '이 티켓을 가진 분과 같은 분인지 대조합니다. 대조 결과만 남기고 연계정보는 버립니다',
};

/** 기관 창이 열린 동안 부르는 화면의 진행 글(②) */
export const VERIFY_WAITING_TEXT = '본인확인 창에서 진행해 주세요';
/** 완료 토스트 */
export const VERIFY_DONE_TOAST = '본인확인을 마쳤습니다';

export interface VerifyResultCopy {
  title: string;
  body: string;
  /** 키트 아이콘 이름(ic-…) */
  icon: string;
  tone: 'danger' | 'warning';
  /** retry: [다시 시도][닫기] · login: [로그인][닫기] · home: [홈으로]만 · close: [닫기]만 */
  action: 'retry' | 'login' | 'home' | 'close';
  /** 본문이 길어 작은 글씨(t-sm)로 쓴다 */
  small?: boolean;
  /** 대화상자 최대 폭(px) */
  maxWidth?: number;
}

/** 결과 대화상자 문구(d5 §5.6 표 · 보드 dlg*) */
export const VERIFY_RESULT_COPY: Record<Exclude<VerifyOutcome, 'success'>, VerifyResultCopy> = {
  closed: { title: '본인확인을 마치지 못했습니다', body: '다시 시도해 주세요', icon: 'alert-circle', tone: 'danger', action: 'retry' },
  down: { title: '지금은 본인확인을 할 수 없습니다', body: '잠시 후 다시 시도해 주세요', icon: 'alert', tone: 'warning', action: 'retry' },
  other: { title: '이미 다른 계정에서 본인확인한 분입니다', body: '그 계정으로 로그인해 주세요', icon: 'user', tone: 'danger', action: 'login' },
  under14: {
    title: '만 14세 미만은 피켓을 이용할 수 없습니다',
    body: '휴대폰 본인확인 결과 만 14세 미만으로 확인되어 이 계정을 삭제합니다. 본인확인 결과는 저장하지 않았습니다. 주문·결제 기록은 법에 따라 5년간 분리 보관 후 파기됩니다.',
    icon: 'ban',
    tone: 'danger',
    action: 'home',
    small: true,
    maxWidth: 480,
  },
  mismatch: { title: '티켓을 가진 분과 다른 분으로 확인되었습니다', body: '부스 직원에게 문의해 주세요', icon: 'x-circle', tone: 'danger', action: 'close' },
  popup: { title: '팝업이 차단되었습니다', body: '브라우저에서 팝업을 허용한 뒤 다시 눌러 주세요', icon: 'ban', tone: 'warning', action: 'retry' },
};

/** 부스 재발급 1/3단계 대조 동의(보드 dlgConsent, SCR-013 ⑩ 동의 시트) */
export const BOOTH_CONSENT = {
  eyebrow: '부스 재발급 1/3단계',
  title: '본인확인 결과 대조 동의',
  items: [
    { term: '목적', desc: '입장이 시작된 뒤 이 티켓을 다시 받으려는 분이 티켓을 가진 계정의 본인인지 대조합니다' },
    {
      term: '항목',
      desc: '휴대폰 본인확인 결과의 연계정보(대조한 뒤 바로 버립니다), 대조 결과(일치 여부)와 요청 일시. 이름·생년월일 등 다른 본인확인 결과는 받는 즉시 버립니다',
    },
    { term: '보유 기간', desc: '연계정보는 저장하지 않습니다. 대조 결과는 공연(회차)이 끝나고 1년까지' },
    {
      term: '거부권과 불이익',
      desc: '동의를 거부할 수 있습니다. 동의하지 않으면 부스에서 티켓을 다시 받을 수 없습니다. 입장 방법은 현장 직원에게 문의해 주세요',
    },
  ],
  checkbox: '대조 목적에 동의합니다 (필수)',
  error: '동의해야 휴대폰 본인확인을 시작할 수 있습니다',
  confirm: '동의하고 휴대폰 본인확인',
} as const;

/** 시험용 기관 화면에서 고르는 결과(d5 §5.6 '시연 흉내 방법': 여섯 결과와 팝업이 막힌 경우). 부스 대조는 만 나이를 계산하지 않고 불일치가 있다 */
export function demoOutcomes(purpose: VerifyPurpose): { value: VerifyOutcome; label: string }[] {
  const base: { value: VerifyOutcome; label: string }[] = [
    { value: 'success', label: '성공' },
    { value: 'closed', label: '실패·창 닫기' },
    { value: 'down', label: '기관 장애' },
  ];
  if (purpose === 'booth') return [...base, { value: 'mismatch', label: '다른 분' }, { value: 'popup', label: '팝업이 막힌 경우' }];
  return [...base, { value: 'other', label: '다른 계정의 본인' }, { value: 'under14', label: '만 14세 미만' }, { value: 'popup', label: '팝업이 막힌 경우' }];
}
