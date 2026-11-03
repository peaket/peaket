// 스캐너 화면 목업(합성 데이터, 고정 값). 실제 사람 이름·연락처는 쓰지 않는다.
// 닉네임·기기 이름·공연·회사 이름은 디자인 캔버스 보드와 docs/design/d5 §8에 나온 지어낸 이름이다. 시각은 KST.
// 관람객 이름·연락처는 어느 화면에도 보이지 않는다(d5 §8, identity §6.1). 데이터 연결 단계에서 걷어 낸다(ADR-0170).

export const device = {
  name: "동문-03",
  partner: "(주)스텔라엔터테인먼트",
};

export const lead = { name: "하늘", initial: "하", role: "현장 책임자" };
export const staff = { name: "도윤", initial: "도", role: "현장 스태프" };

export const placement = {
  event: "LUMEN 콘서트 2026 서울 · 10/25(일) 18:00",
  zone: "동문 구역",
  zoneShort: "동문",
};

export const approval = {
  code: "WDJB-MJHT",
  /** 보드의 '[새 확인 코드]' 자리 글 대신 쓰는 목업 코드(RFC 8628 §6.1 모음 없는 대문자) */
  nextCode: "KTNB-QRXL",
  loginOpens: "10/25 13:30",
  shiftEnds: "22:00",
  validRange: "13:30~22:00",
};

export const prep = {
  listSeq: "#48213",
  clockOffset: "+0.4초",
  progress: 82,
  appVersion: "1.3.2",
  minAppVersion: "1.4.0",
};

export const sync = {
  queue: 12,
  lastUpload: "18:42",
  serverSeq: "#48291",
};

/** SCR-034 태블릿 '최근 판정'(이 기기 · 최근 4건) */
export const recentScans = [
  { at: "19:13:58", verdict: "pass", seat: "S구역 4열 2번", reason: null },
  { at: "19:13:41", verdict: "reject", seat: "A구역 9열 15번", reason: "유효시간이 지난 QR입니다" },
  { at: "19:13:20", verdict: "pass", seat: "R구역 3열 11번", reason: null },
  { at: "19:12:57", verdict: "reject", seat: "R구역 1열 4번", reason: "양도·취소·재발급된 티켓의 옛 QR입니다" },
] as const;

/** SCR-035 이 기기 관련 이상 표시 */
export const deviceFlags = [
  { seat: "R구역 12열 7번", kind: "중복 입장(동시)", at: "18:41" },
  { seat: "S구역 4열 11번", kind: "취소 뒤 입장", at: "18:27" },
] as const;

/** SCR-052 [이상 표시] 동문 구역 */
export const zoneFlags = [
  { id: "f1", seat: "R구역 12열 7번", kind: "중복 입장(동시)", at: "18:41", done: null },
  { id: "f2", seat: "S구역 4열 11번", kind: "취소 뒤 입장", at: "18:27", done: null },
  { id: "f3", seat: "A구역 9열 3번", kind: "시각 불확실", at: "17:55", done: { result: "정상 확인", at: "18:30" } },
] as const;

/** SCR-052 [기기] 이 회차 이 파트너 기기 */
export const fleet = [
  { name: "동문-01", ready: true, synced: "1분 전", queue: "0", placement: "동문 · 입장", self: false },
  { name: "동문-02", ready: true, synced: "2분 전", queue: "3", placement: "동문 · 입장", self: false },
  { name: "동문-03", ready: true, synced: "3분 전", queue: "12", placement: "동문 · 입장", self: true },
  { name: "동문-04", ready: false, synced: "9분 전", queue: "—", placement: null, self: false },
] as const;

/** SCR-052 [내 예외 통과] */
export const myOverrides = [
  { at: "18:20", seat: "R구역 5열 14번", reason: "휴대폰 방전", review: "검토 대기" },
  { at: "17:58", seat: "S구역 11열 2번", reason: "키 미반영", review: "정상" },
  { at: "17:41", seat: "A구역 2열 20번", reason: "카메라 고장", review: "부적정" },
] as const;

/** 예외 통과 사유(d5 §8.3, CMP-010 Select) */
export const overrideReasons = ["카메라 고장", "휴대폰 방전", "키 미반영", "부스 통신 두절", "기타"] as const;

/** 예외 통과에서 좌석 표시로 찾은 티켓(이 기기 목록) */
export const overrideMatch = { query: "R구역 12열 7", seat: "R구역 12열 7번", meta: "동문 구역 · 사용 가능" };
