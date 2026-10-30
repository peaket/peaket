'use client';
// CMP-052 DeviceSessionList(지금 로그인된 기기 세션 목록과 기기별 원격 로그아웃). 정본: d2 CMP-052, d5 §5.17 ②, 캔버스 보드 SCR-017-m·t·d '로그인한 기기'.
// 보드 마크업: <ul class="col" aria-label="로그인한 기기 목록"> 안에 기기마다 <li class="li">
//   [.state-icon 40px(기기 아이콘 20px)] [.li-title grow 기기 이름] [지금 이 기기: .badge.badge-primary | 다른 기기: .btn.btn-outline.btn-sm 로그아웃].
//   스태프 세션(현장 스캐너)은 이름 아래(휴대폰) 또는 옆(md 이상)에 .badge.badge-outline 꼬리표를 붙인다.
// - 각 로그아웃 버튼의 이름에 대상 기기 이름을 잇는다('Safari · iPhone 로그아웃', d2 CMP-052 접근성).
// - 원격 로그아웃 전 재인증(CMP-064)은 부르는 화면이 onLogout에서 연다. 목록을 불러오는 중이면 스피너와 상태 글을 보인다(d5 §5.17 상태 '기기 목록 로딩').
// - 버튼이 함수 props를 받으므로 클라이언트 부품이다. 문구는 앱이 props로 넘긴다.
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';

export interface DeviceSession {
  id: string;
  /** 기기 이름('Chrome · Windows', '현장 스캐너 동문-03') */
  name: string;
  /** 기기 아이콘(globe·phone·scan·device·tablet·monitor 등) */
  icon: IconName;
  /** 지금 이 기기(로그아웃 버튼 대신 꼬리표) */
  current?: boolean;
  /** 이름 옆 꼬리표(예: '스태프 세션') */
  tag?: ReactNode;
}

export interface DeviceSessionListProps {
  sessions: readonly DeviceSession[];
  /** 목록 이름(aria-label, 예: '로그인한 기기 목록') */
  label: string;
  /** 지금 이 기기 꼬리표 글(기본 '지금 이 기기') */
  currentLabel?: string;
  /** 로그아웃 버튼 글(기본 '로그아웃'). 버튼 이름은 '<기기 이름> <글>'이 된다 */
  logoutLabel?: string;
  /** 다른 기기 로그아웃을 누를 때(재인증을 먼저 여는 것은 부르는 쪽) */
  onLogout?: (session: DeviceSession) => void;
  /** 로그아웃 요청 중인 기기 id(버튼 스피너·aria-busy) */
  pendingId?: string;
  /** 목록을 불러오는 중 */
  loading?: boolean;
  /** 불러오는 중 상태 글(기본 '로그인한 기기를 불러오는 중입니다') */
  loadingLabel?: string;
  className?: string;
}

export function DeviceSessionList({
  sessions,
  label,
  currentLabel = '지금 이 기기',
  logoutLabel = '로그아웃',
  onLogout,
  pendingId,
  loading = false,
  loadingLabel = '로그인한 기기를 불러오는 중입니다',
  className,
}: DeviceSessionListProps) {
  if (loading) {
    return (
      <p className={cx('row t-sm muted', className)} role="status" style={{ gap: 8, minHeight: 56 }}>
        <span className="spinner" aria-hidden="true" />
        {loadingLabel}
      </p>
    );
  }
  return (
    <ul className={cx('col', className)} aria-label={label}>
      {sessions.map((s) => {
        const pending = pendingId === s.id;
        return (
          <li key={s.id} className="li">
            <span className="state-icon" style={{ width: 40, height: 40 }} aria-hidden="true">
              <Icon name={s.icon} style={{ width: 20, height: 20 }} />
            </span>
            {s.tag ? (
              <span className="col grow gap-1 md:flex-row md:items-center md:gap-2">
                <span className="li-title">{s.name}</span>
                <span className="row">
                  <span className="badge badge-outline">{s.tag}</span>
                </span>
              </span>
            ) : (
              <span className="li-title grow">{s.name}</span>
            )}
            {s.current ? (
              <span className="badge badge-primary">{currentLabel}</span>
            ) : (
              <button
                className="btn btn-outline btn-sm"
                type="button"
                aria-label={`${s.name} ${logoutLabel}`}
                aria-busy={pending || undefined}
                onClick={() => {
                  if (!pending) onLogout?.(s);
                }}
              >
                {pending ? <span className="spinner" aria-hidden="true" /> : null}
                {logoutLabel}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
