// SCR-017 ② 로그인한 기기(account 담당, docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현', ADR-0209)와 현장 스캐너 세션 줄(ADR-0362 결정 7).
// 설정 화면(SettingsFlows)이 실제 모드에서 쓴다.
export { browserDevicesApi } from './browser';
export {
  chooseReturn,
  devicesFooterText,
  endResultText,
  leaveForDeviceReauth,
  markPending,
  otherLoginsOf,
  reauthPurposeFor,
  SCANNER_BANNER_TEXT,
  SCANNER_FAILED_TEXT,
  scannerRowName,
  takePending,
  toDeviceSessions,
  toScannerSessions,
  type DeviceRow,
  type DevicesApi,
  type EndAnswer,
  type ListAnswer,
  type LogoutScope,
  type PendingLogout,
  type ScannerListAnswer,
  type ScannerRow,
} from './flow';
