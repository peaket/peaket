// SCR-052 퍼블리싱 미리보기용 표본(운영 빌드의 `?live=1`은 LiveManageBridge가 실제 API를 쓴다).
// 시험은 ManageScreen이 fixtures/scanner를 읽지 않고 manage-model을 쓰는지만 본다.
export const device = { name: "동문-03", partner: "(주)피켓엔터테인먼트" };
export const placement = { event: "LUMEN 콘서트 2026 가을 · 10/25(일) 18:00", zone: "동문 구역", zoneShort: "동문" };
export const sync = { queue: 12, lastUpload: "18:42", serverSeq: "#48291" };
export const zoneFlags = [
  { id: "f1", seat: "R구역 12열 7번", kind: "중복 입장(동시)", at: "18:41", done: null },
  { id: "f2", seat: "S구역 4열 11번", kind: "취소 뒤 입장", at: "18:27", done: null },
  { id: "f3", seat: "A구역 9열 3번", kind: "시각 불확실", at: "17:55", done: { result: "정상 확인", at: "18:30" } },
] as const;
export const fleet = [
  { name: "동문-01", ready: true, synced: "1분 전", queue: "0", placement: "동문 · 입장", self: false },
  { name: "동문-02", ready: true, synced: "2분 전", queue: "3", placement: "동문 · 입장", self: false },
  { name: "동문-03", ready: true, synced: "3분 전", queue: "12", placement: "동문 · 입장", self: true },
  { name: "동문-04", ready: false, synced: "9분 전", queue: "?", placement: null, self: false },
] as const;
export const myOverrides = [
  { at: "18:20", seat: "R구역 5열 14번", reason: "휴대폰 방전", review: "검토 대기" },
  { at: "17:58", seat: "S구역 11열 2번", reason: "키 미반영", review: "정상" },
  { at: "17:41", seat: "A구역 2열 20번", reason: "카메라 고장", review: "부적정" },
] as const;
