// SCR-020 '내 계정' 실제 판의 화면 모델(F-07-13, d5 §6.1 ⑦).
// 계약 응답을 화면 말로 바꾸고, 기기 정렬·KST 시간·오류 문구를 화면 없이 시험할 수 있게 한다.
export interface PartnerSecuritySettingsRaw {
  totpRegistered: boolean;
  recoveryCodesRemaining: number;
  passkeyCount: number;
  sessionLimit: number;
}

export interface AccountSecurityView {
  totpText: string;
  recoveryText: string;
  passkeyCount: number;
  sessionLimit: number;
}

export interface PartnerDeviceSessionRaw {
  sessionId: string;
  deviceName: string | null;
  lastActiveAt: string;
  current: boolean;
  otherSessions: number;
}

export interface DeviceSessionView {
  sessionId: string;
  label: string;
  lastActiveText: string;
  current: boolean;
  otherSessions: number;
}

const safeCount = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

export function accountSecurityView(raw: PartnerSecuritySettingsRaw): AccountSecurityView {
  const remaining = Math.min(10, safeCount(raw.recoveryCodesRemaining));
  return {
    totpText: raw.totpRegistered === true ? '등록됨' : '등록되지 않음',
    recoveryText: `남은 코드 ${remaining}개`,
    passkeyCount: safeCount(raw.passkeyCount),
    sessionLimit: 2,
  };
}

/** 화면용 기기 이름. null·빈 값은 '알 수 없는 기기', 41자 이상은 40자로 자른다 */
export function deviceNameText(name: string | null | undefined): string {
  const text = (name ?? '').trim();
  return text.length === 0 ? '알 수 없는 기기' : text.slice(0, 40);
}

const KST = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function kstParts(iso: string): { date: string; time: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = KST.formatToParts(d);
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  return date && time ? { date, time } : null;
}

/** 마지막 활동을 KST로. 오늘은 HH:mm KST, 다른 날은 M/D HH:mm KST, 읽지 못하면 '알 수 없음' */
export function lastActiveText(iso: string, now: number): string {
  const p = kstParts(iso);
  if (!p) return '알 수 없음';
  const today = kstParts(new Date(now).toISOString());
  if (today && today.date === p.date) return `${p.time} KST`;
  const [, month, day] = p.date.split('-');
  return `${Number(month)}/${Number(day)} ${p.time} KST`;
}

export function deviceSessionsView(items: PartnerDeviceSessionRaw[], now: number): DeviceSessionView[] {
  return items
    .map((r) => ({
      view: {
        sessionId: r.sessionId,
        label: r.current ? `이 기기 · ${deviceNameText(r.deviceName)}` : deviceNameText(r.deviceName),
        lastActiveText: lastActiveText(r.lastActiveAt, now),
        current: r.current === true,
        otherSessions: safeCount(r.otherSessions),
      } satisfies DeviceSessionView,
      at: Number.isNaN(Date.parse(r.lastActiveAt)) ? 0 : Date.parse(r.lastActiveAt),
    }))
    .sort((a, b) => (a.view.current === b.view.current ? b.at - a.at : a.view.current ? -1 : 1))
    .map((x) => x.view);
}

export function accountPageMode(state: string | undefined | null): 'live' | 'preview' {
  return state === undefined || state === null ? 'live' : 'preview';
}

export function reauthWithPasskey(passkeyCount: number): boolean {
  return Number.isSafeInteger(passkeyCount) && passkeyCount > 0;
}

export function deviceRowActions(row: { current: boolean; otherSessions: number }): { canLogout: boolean; canEndOtherLogins: boolean } {
  return { canLogout: row.current !== true, canEndOtherLogins: row.current === true && safeCount(row.otherSessions) > 0 };
}

export function recoveryCodeDialogState(codesSaved: boolean): { closeEnabled: boolean } {
  return { closeEnabled: codesSaved === true };
}

export interface SecurityProblem {
  status: number;
  type?: string;
  remainingAttempts?: number;
  extensions?: Record<string, unknown>;
}

/** 오류를 화면 글로 바꾼다. 서버 title·detail 원문은 싣지 않는다 */
export function accountSecurityProblemMessage(problem: SecurityProblem): string {
  const type = problem.type ?? '';
  if (problem.status === 403 && type === 'reauth-required') return '재인증이 끝났거나 이미 썼습니다. 비밀번호·인증 앱 코드로 다시 인증해 주세요';
  if (problem.status === 403 && type === 'password-change-required') return '비밀번호를 먼저 바꾼 뒤 다시 시도해 주세요';
  if (problem.status === 409 && type === 'totp-not-registered') return '인증 앱이 등록되어 있지 않습니다. 먼저 인증 앱을 등록해 주세요';
  if (problem.status === 410 && type === 'totp-enrollment-invalid') return '인증 앱 다시 등록이 만료되었거나 시도 횟수를 넘었습니다. 처음부터 다시 해 주세요';
  if (problem.status === 422 && type === 'reauth-code-invalid') {
    const ext = problem.extensions?.remainingAttempts;
    const remaining = problem.remainingAttempts ?? (typeof ext === 'number' ? ext : 0);
    return `코드가 맞지 않습니다. ${remaining}번 더 시도할 수 있습니다`;
  }
  if (problem.status === 404 && type === 'session-not-found') return '이미 로그아웃했거나 이 기기의 세션이 아닙니다. 목록을 다시 불러와 주세요';
  if (problem.status >= 500) return '지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요';
  return '요청을 마치지 못했습니다. 다시 시도해 주세요';
}
