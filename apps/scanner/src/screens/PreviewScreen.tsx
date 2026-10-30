// 화면 목록(/preview, 개발 서버에서만). ds PreviewCatalog로 SCR·경로·상태 링크를 보인다(add-screen-publishing design.md 결정 7).
import { PreviewCatalog, type PreviewScreen as Screen } from "@peaket/ds/Preview";
import { renderLink } from "../app/router";
import { ENROLL_STATES, LOGIN_STATES } from "./LoginScreen";
import { MANAGE_STATES } from "./ManageScreen";
import { SCAN_STATES } from "./ScanScreen";
import { SETUP_STATES } from "./SetupScreen";
import { SYNC_STATES } from "./SyncScreen";
import { SYSTEM_STATES } from "./SystemScreen";

const LAYOUT_NOTE = "배치는 화면 폭·방향으로 고른다(휴대폰 세로·가로, 태블릿 세로). ?layout=p·l·t로 고정해 볼 수 있다";

const SCREENS: Screen[] = [
  { id: "SCR-036", name: "현장 스태프 로그인(기기 승인)", path: "/login", states: LOGIN_STATES, note: LAYOUT_NOTE },
  {
    id: "SCR-036",
    name: "기기 등록",
    path: "/enroll",
    states: ENROLL_STATES,
    note: "frontend §2.5 경로표의 /enroll. d5에 따로 화면이 없어 SCR-036의 기기 등록 상태를 그린다",
  },
  { id: "SCR-033", name: "근무 준비", path: "/setup", states: SETUP_STATES },
  {
    id: "SCR-034",
    name: "티켓 스캔 및 판정",
    path: "/scan",
    states: SCAN_STATES,
    note: "보드 상태 9개 뒤에 d5 판정 표의 거부 사유·판정 오류와 예외 통과(대화상자)를 더했다",
  },
  { id: "SCR-035", name: "동기화 상태와 이상 표시", path: "/sync", states: SYNC_STATES },
  { id: "SCR-052", name: "현장 관리(현장 책임자)", path: "/manage", states: MANAGE_STATES },
  { id: "SCR-059", name: "시스템 안내(스캐너 셸)", path: "/error", states: SYSTEM_STATES, note: "없는 주소는 404 상태로 보인다" },
];

export function PreviewScreen() {
  return (
    <PreviewCatalog
      appName="게이트 스캐너"
      screens={SCREENS}
      otherApps={[{ name: "소비자 웹 화면 목록", href: "http://localhost:3000/preview" }]}
      renderLink={renderLink}
    />
  );
}
