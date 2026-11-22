// SCR-017 ② 로그인한 기기의 화면 흐름 규칙(docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현', d5 §5.17, BUILD_ORDER BOT-044, ADR-0209).
// 설정 화면(SettingsFlows)이 이 두 함수로 돌아오기와 원격 로그아웃을 정하고, 화면은 결과만 그린다. 브라우저 기능은 받아서 쓰므로 node 시험(state.test.mjs)이 실제 흐름을 본다.
// 상대 경로로 가져온다(경로 별칭 없이 node --test가 바로 읽게).
import { reauthFailureText, type ReauthFailure, takePendingAt } from '../../../features/account-withdraw/flow.ts';
import {
  chooseReturn,
  devicesFooterText,
  type EndAnswer,
  endResultText,
  type PendingLogout,
  SCANNER_BANNER_TEXT,
  SCANNER_FAILED_TEXT,
  type ScannerListAnswer,
  type StorageLike,
  takePending as takeDevicePending,
  toScannerSessions,
} from '../../../features/device-sessions/flow.ts';
import type { DeviceSession } from '@peaket/ds/DeviceSessionList';

/** 재인증에서 돌아왔을 때 이을 일: 원격 로그아웃(그 할 일), 탈퇴, 없음 */
export type ReturnOnMount = { kind: 'device'; pending: PendingLogout } | { kind: 'withdraw' } | null;

/**
 * 화면이 열릴 때 탭 저장소의 두 표시(원격 로그아웃·탈퇴 재인증)를 읽어 지우고, 나중에 남긴 쪽만 잇는다.
 * 실제 흐름이 아니면(목업) 표시를 건드리지 않는다. devices·withdraw: 그 흐름의 API가 있는가
 */
export function returnOnMount(storage: StorageLike, now: number, o: { devices: boolean; withdraw: boolean }): ReturnOnMount {
  const device = o.devices ? takeDevicePending(storage, now) : null;
  const withdrawAt = o.withdraw ? takePendingAt(storage, now) : null;
  const back = chooseReturn(device, withdrawAt);
  if (back === 'device' && device) return { kind: 'device', pending: device };
  return back === 'withdraw' ? { kind: 'withdraw' } : null;
}

/** 원격 로그아웃 뒤 화면이 할 일: 토스트, 그 기기의 재인증 창(실패 문구), 로그인 화면 */
export type DeviceStep = { kind: 'toast'; text: string; icon: string } | { kind: 'reauth-failed'; text: string; target: PendingLogout } | { kind: 'login' };

/**
 * 돌아와 재인증 토큰을 한 번 받아(pickup) 그 기기를 끈다(end). 범위가 현장 스캐너 세션(scanner)이면 endScanner로 DELETE /v1/identity/scanner-sessions/{sessionId}를 보낸다
 * (BUILD_ORDER F-05-7, ADR-0362 결정 7, I-T90 ③). endScanner가 없으면 보내지 않고 '잠시 뒤 다시' 토스트다. 토큰을 받지 못하면 끄지 않고 이유별 실패 문구로 그 기기의 재인증 창을 다시 연다.
 * 403(재인증 만료·이미 씀)도 그 기기의 재인증 창, 401 뒤 갱신도 401이면 로그인 화면, 그 밖은 결과 토스트다(d5 §5.17). 화면은 로그인 화면 밖이면 목록을 다시 불러온다
 */
export async function resumeDeviceLogout(o: {
  pending: PendingLogout;
  pickup: () => Promise<{ kind: 'token'; token: string } | { kind: 'failed'; reason: ReauthFailure }>;
  end: (sessionId: string, reauthToken: string) => Promise<EndAnswer>;
  endScanner?: (sessionId: string, reauthToken: string) => Promise<EndAnswer>;
}): Promise<DeviceStep> {
  const r = await o.pickup();
  if (r.kind !== 'token') return { kind: 'reauth-failed', text: reauthFailureText(r.reason), target: o.pending };
  const endOf = o.pending.scope === 'scanner' ? o.endScanner : o.end;
  const e: EndAnswer = endOf ? await endOf(o.pending.sessionId, r.token) : { kind: 'error' };
  if (e.kind === 'login') return { kind: 'login' };
  if (e.kind === 'reauth') return { kind: 'reauth-failed', text: reauthFailureText('expired'), target: o.pending };
  return { kind: 'toast', ...endResultText(e, o.pending)! };
}

/** 로그인한 기기 칸의 스캐너 세션 부분(d5 §5.17 '스태프 세션'·'스태프 세션 못 불러옴', I-T90 ①④) */
export interface ScannerSectionView {
  /** 기기 목록 끝에 붙일 스태프 세션 줄(없으면 빈 배열) */
  rows: DeviceSession[];
  /** 안내 띠 '휴대폰에서 로그아웃해도 스캐너 세션은 따로 끝내야 합니다'. 줄이 있을 때만 */
  banner: string | null;
  /** 스캐너 줄 자리의 실패 안내와 [다시 불러오기]. 목록이 401이 아닌 이유로 실패했을 때만(기기 목록은 그대로 그린다) */
  failed: string | null;
  /** 목록 아래 줄 */
  footer: string;
}

/** 스캐너 세션 목록 답 → 칸 모양. 읽는 중(null)이면 줄·띠·실패 없이 기본 아래 줄이다. 401(login)은 화면이 로그인 화면으로 보내므로 여기서는 빈 칸이다 */
export function scannerSectionView(a: ScannerListAnswer | null): ScannerSectionView {
  if (a?.kind === 'ok' && a.items.length > 0) return { rows: toScannerSessions(a.items), banner: SCANNER_BANNER_TEXT, failed: null, footer: devicesFooterText(true) };
  if (a?.kind === 'error') return { rows: [], banner: null, failed: SCANNER_FAILED_TEXT, footer: devicesFooterText(false) };
  return { rows: [], banner: null, failed: null, footer: devicesFooterText(false) };
}
