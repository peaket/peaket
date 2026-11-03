// SCR-037 현장 스태프·현장 운영 목업(보드 SCR-037-m·t·d의 renderVals 값 그대로). 합성 데이터이고 실제 사람·기기가 아니다.
// 개인정보는 싣지 않는다: 스태프는 닉네임·역할·수락 여부·건수만, 이상 표시는 좌석 표시만(d5 §6.11, data-classification).
// 합계 2,288장은 SCR-027 순 판매와 같다(캔버스 메모 cf037, 동문 1,200장 · 서문 1,088장).

export type StaffStatus = '대기' | '수락' | '만료' | '해제' | '종료';

export interface StaffRow {
  id: string;
  /** 수락 전이면 null(화면에는 '수락 전') */
  nickname: string | null;
  role: '현장 스태프' | '현장 책임자';
  status: StaffStatus;
  /** 대기·만료 행의 둘째 줄 */
  statusNote?: string;
  validity: string;
  scans: number | null;
  exceptions: number | null;
  /** 버튼 이름에 붙일 대상 설명(수락 전 초대는 만료 시각으로 구분) */
  target: string;
  canResend: boolean;
  canRevoke: boolean;
}

const VALID = '10/25(일) 13:30 ~ 22:00 KST';

export const staffRows: readonly StaffRow[] = [
  { id: 'gs-haneul', nickname: '하늘', role: '현장 책임자', status: '수락', validity: VALID, scans: 196, exceptions: 3, target: '하늘', canResend: false, canRevoke: true },
  { id: 'gs-doyun', nickname: '도윤', role: '현장 스태프', status: '수락', validity: VALID, scans: 288, exceptions: 0, target: '도윤', canResend: false, canRevoke: true },
  {
    id: 'gs-pending',
    nickname: null,
    role: '현장 스태프',
    status: '대기',
    statusNote: '초대 만료 10/26(월) 09:00 KST',
    validity: VALID,
    scans: null,
    exceptions: null,
    target: '수락 전 초대(10/26 09:00 만료)',
    canResend: true,
    canRevoke: true,
  },
  {
    id: 'gs-expired',
    nickname: null,
    role: '현장 스태프',
    status: '만료',
    statusNote: '10/15(목) 18:00 KST에 만료',
    validity: VALID,
    scans: null,
    exceptions: null,
    target: '만료된 초대(10/15 18:00 만료)',
    canResend: true,
    canRevoke: false,
  },
];

export const STAFF_STATUS_BADGE: Record<StaffStatus, string> = {
  대기: 'badge',
  수락: 'badge badge-success',
  만료: 'badge badge-warning',
  해제: 'badge badge-danger',
  종료: 'badge',
};

/** 초대 형식 오류 행(422, 보드 '초대 실패') */
export const INVITE_FAIL_TEXT = ['gate01@example.com', 'gate02@example.com', 'gate03@example', 'gate04@example.com', 'gate05@@example.com'].join('\n');
export const inviteErrors: readonly { line: number; input: string; reason: string }[] = [
  { line: 3, input: 'gate03@example', reason: '이메일 주소 형식이 아닙니다' },
  { line: 5, input: 'gate05@@example.com', reason: '이메일 주소 형식이 아닙니다' },
];

/** 스캔·예외 통과 요약 타일 */
export const staffSummary: readonly { label: string; value: string; meta: string }[] = [
  { label: '수락', value: '7명', meta: '명단 9명 · 대기 1 · 만료 1' },
  { label: '현장 책임자', value: '2명', meta: '예외 통과는 책임자만 합니다' },
  { label: '스캔', value: '1,518건', meta: '입장 1,431명 · 17:42 KST까지' },
  { label: '예외 통과', value: '5건', meta: '모두 CS 사후 검토 대상' },
];

/* ---------- 현장 운영 ---------- */

export type OpsMode = 'pre' | 'live' | 'closed';

export type Zone = '동문' | '서문';

export interface Placement {
  device: string;
  /** null = 배치 안 함 */
  zone: Zone | null;
  mode: '입장' | '퇴장' | null;
}

export const placements: readonly Placement[] = [
  { device: '동문-01', zone: '동문', mode: '입장' },
  { device: '동문-02', zone: '동문', mode: '입장' },
  { device: '동문-03', zone: '동문', mode: '입장' },
  { device: '동문-04', zone: '동문', mode: '입장' },
  { device: '서문-01', zone: '서문', mode: '입장' },
  { device: '서문-02', zone: '서문', mode: '입장' },
  { device: '서문-03', zone: null, mode: null },
];

export const zoneSummary: readonly { zone: Zone; tickets: string; recommend: string; placed: string }[] = [
  { zone: '동문', tickets: '티켓 1,200장', recommend: '권장 2대 [가정 기반]', placed: '배치 4대' },
  { zone: '서문', tickets: '티켓 1,088장', recommend: '권장 2대 [가정 기반]', placed: '배치 2대' },
];

export interface DeviceReadiness {
  device: string;
  /** null = 미보고(아무것도 보고하지 않은 기기) */
  login: string | null;
  serial: string;
  sync: string;
  /** 동기화 지연 행의 '· 3분 전' */
  ago?: string;
  queue: string;
  queueBold?: boolean;
  badge: string;
  label: string;
  warn?: boolean;
}

export interface OpsTile {
  label: string;
  value: string;
  sub?: string;
  meta?: string;
  /** '입장 전'처럼 값이 아직 없을 때 흐리게 */
  muted?: boolean;
}

export interface ZoneEntry {
  zone: Zone;
  count: string;
  meta: string;
  /** 막대 폭(%) */
  bar: number;
  now: number;
  text: string;
}

export interface Flag {
  seat: string;
  kind: string;
  at: string;
  result: '미처리' | '정상 확인' | '부정 의심' | '판단 불가';
}

export const FLAG_BADGE: Record<Flag['result'], string> = {
  미처리: 'badge badge-warning',
  '정상 확인': 'badge badge-success',
  '부정 의심': 'badge badge-danger',
  '판단 불가': 'badge',
};

export const REJECT_REASONS: readonly { reason: string; verdict: '거부' | '확인 필요' }[] = [
  { reason: '유효시간이 지난 QR', verdict: '거부' },
  { reason: '다른 게이트 구역', verdict: '거부' },
  { reason: '키 미반영', verdict: '거부' },
  { reason: '퇴장 기록 없음', verdict: '확인 필요' },
  { reason: '입장 기록 없음', verdict: '확인 필요' },
];

export interface OpsData {
  /** 시간 띠의 '지금'(마감 뒤는 null) */
  now: string | null;
  tiles: readonly OpsTile[];
  devices: readonly DeviceReadiness[];
  zones: readonly [ZoneEntry, ZoneEntry];
  /** REJECT_REASONS 순서의 건수 */
  rejects: readonly string[];
  flags: readonly Flag[];
  flagAt: string;
  /** 미처리 이상 표시 · 예외 통과 · 부스 재발급 */
  close: readonly [string, string, string];
}

const UNREPORTED: DeviceReadiness = { device: '서문-03', login: null, serial: '—', sync: '—', queue: '—', badge: 'badge', label: '미보고' };

function ready(device: string, login: string, serial: string, sync: string, queue: string): DeviceReadiness {
  return { device, login, serial, sync, queue, badge: 'badge badge-success', label: '준비' };
}

function done(device: string, sync: string, spare = false): DeviceReadiness {
  return { device, login: spare ? '세션 끝 · 예비' : '세션 끝', serial: '#48377', sync, queue: '0건', badge: 'badge badge-success', label: '업로드 마침' };
}

const FLAGS_LIVE: readonly Flag[] = [
  { seat: 'S2구역 3열 14번', kind: '중복 입장(알고도 통과)', at: '17:00:44 KST', result: '미처리' },
  { seat: 'R1구역 12열 7번', kind: '중복 입장(동시)', at: '16:51:08 KST', result: '정상 확인' },
  { seat: 'A1구역 9열 2번', kind: '취소 뒤 입장', at: '16:42:30 KST', result: '부정 의심' },
];

export function opsData(mode: OpsMode, noFlag: boolean): OpsData {
  if (mode === 'pre') {
    return {
      now: '16:00 KST',
      tiles: [
        { label: '기기 준비', value: '6/7대', meta: '서문-03 미보고' },
        { label: '입장', value: '입장 전', meta: '입장 시작 16:30', muted: true },
        { label: '거부', value: '입장 전', muted: true },
        { label: '이상 표시', value: '입장 전', muted: true },
      ],
      devices: [
        ready('동문-01', '로그인함', '#48102', '15:59:52 KST', '0건'),
        ready('동문-02', '로그인함', '#48102', '15:59:41 KST', '0건'),
        ready('동문-03', '로그인함', '#48102', '15:59:30 KST', '0건'),
        ready('동문-04', '로그인함 · 예비', '#48102', '15:59:12 KST', '0건'),
        ready('서문-01', '로그인함', '#48102', '15:59:48 KST', '0건'),
        ready('서문-02', '로그인함', '#48101', '15:59:05 KST', '0건'),
        UNREPORTED,
      ],
      zones: [
        { zone: '동문', count: '0명', meta: '티켓 1,200장 · 0%', bar: 0, now: 0, text: '티켓 1,200장 중 0명 입장, 0%' },
        { zone: '서문', count: '0명', meta: '티켓 1,088장 · 0%', bar: 0, now: 0, text: '티켓 1,088장 중 0명 입장, 0%' },
      ],
      rejects: ['0건', '0건', '0건', '0건', '0건'],
      flags: [],
      flagAt: '16:00:10 KST',
      close: ['0건', '0건', '0건'],
    };
  }
  if (mode === 'closed') {
    return {
      now: null,
      tiles: [
        { label: '기기 준비', value: '6/7대', meta: '서문-03 미보고' },
        { label: '입장', value: '2,241', sub: '/2,288명', meta: '98% · [예시 숫자]' },
        { label: '거부', value: '31건', meta: '[예시 숫자]' },
        { label: '이상 표시', value: '4건', meta: '처리 대기 2' },
      ],
      devices: [
        done('동문-01', '22:00:41 KST'),
        done('동문-02', '22:00:37 KST'),
        done('동문-03', '22:01:12 KST'),
        done('동문-04', '22:00:20 KST', true),
        done('서문-01', '22:00:48 KST'),
        done('서문-02', '22:00:05 KST'),
        UNREPORTED,
      ],
      zones: [
        { zone: '동문', count: '1,176명', meta: '티켓 1,200장 · 98.0%', bar: 98, now: 98, text: '티켓 1,200장 중 1,176명 입장, 98.0%' },
        { zone: '서문', count: '1,065명', meta: '티켓 1,088장 · 97.9%', bar: 97.9, now: 98, text: '티켓 1,088장 중 1,065명 입장, 97.9%' },
      ],
      rejects: ['13건', '11건', '7건', '0건', '0건'],
      flags: [{ seat: 'S1구역 7열 20번', kind: '마감 뒤 도착', at: '23:31:05 KST', result: '미처리' }, ...FLAGS_LIVE],
      flagAt: '23:31:10 KST',
      close: ['2건', '5건', '3건'],
    };
  }
  return {
    now: '17:12 KST',
    tiles: [
      { label: '기기 준비', value: '6/7대', meta: '서문-03 미보고' },
      { label: '입장', value: '1,204', sub: '/2,288명', meta: '53%' },
      { label: '거부', value: '12건' },
      noFlag ? { label: '이상 표시', value: '0건', meta: '처리 대기 0' } : { label: '이상 표시', value: '3건', meta: '처리 대기 1' },
    ],
    devices: [
      ready('동문-01', '로그인함', '#48291', '17:11:52 KST', '0건'),
      ready('동문-02', '로그인함', '#48291', '17:11:37 KST', '1건'),
      {
        device: '동문-03',
        login: '로그인함',
        serial: '#48262',
        sync: '17:08:40 KST',
        ago: ' · 3분 전',
        queue: '12건',
        queueBold: true,
        badge: 'badge badge-danger',
        label: '동기화 지연',
        warn: true,
      },
      ready('동문-04', '로그인함 · 예비', '#48291', '17:11:20 KST', '0건'),
      ready('서문-01', '로그인함', '#48291', '17:11:48 KST', '0건'),
      ready('서문-02', '로그인함', '#48290', '17:11:05 KST', '3건'),
      UNREPORTED,
    ],
    zones: [
      { zone: '동문', count: '624명', meta: '티켓 1,200장 · 52.0%', bar: 52, now: 52, text: '티켓 1,200장 중 624명 입장, 52.0%' },
      { zone: '서문', count: '580명', meta: '티켓 1,088장 · 53.3%', bar: 53.3, now: 53, text: '티켓 1,088장 중 580명 입장, 53.3%' },
    ],
    rejects: ['5건', '4건', '3건', '0건', '0건'],
    flags: noFlag ? [] : FLAGS_LIVE,
    flagAt: '17:12:10 KST',
    close: [noFlag ? '0건' : '1건', '3건', '2건'],
  };
}
