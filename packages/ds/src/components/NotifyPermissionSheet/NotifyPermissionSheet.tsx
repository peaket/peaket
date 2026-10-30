'use client';
// CMP-068 NotifyPermissionSheet(웹 푸시 권한을 묻기 전에 왜 필요한지 설명하는 시트). 정본: d2 CMP-068, d5 §3 공통 상태 '알림 권한 안내',
// 캔버스 보드 SCR-001-m(.scrim.bottom + .sheet)·SCR-001-d(.scrim + .dialog)의 '알림 권한 안내'.
// 보드 마크업: [.state-icon.is-primary 56px ic-bell] → 제목 → 설명 .t-sm.muted 두 줄 →
//   시트: [알림 켜기 btn-primary btn-lg btn-block] [이메일로만 받기 btn-ghost btn-block] · 대화상자: .dialog-actions [이메일로만 받기 ghost] [알림 켜기 primary].
// - 권한은 사용자가 '알림 켜기'를 누른 뒤에만 묻는다(NFR-019). 이 부품은 실제로 묻지 않는다 — onAllow에서 부르는 쪽이 묻는다.
// - iOS는 홈 화면에 추가한 앱에서만 웹 푸시가 되므로 ios-install·pwa-install 변형은 추가 방법(installSteps)을 먼저 보인다.
// - 결과(granted·denied·unsupported)는 role="status" 글로 알리고, 거부·미지원이면 대신 쓰는 수단(이메일 등)을 그 글에 적는다.
// - 휴대폰(768 미만)은 바텀 시트, 그 위는 가운데 대화상자(Dialog layout auto). 초점 가두기·Esc는 Dialog가 한다. 문구는 앱이 props로 넘긴다.
import { useId, type ReactNode } from 'react';
import { useMediaQuery } from '../../lib/hooks';
import { Dialog } from '../Dialog/Dialog';

export type NotifyPermissionVariant = 'push' | 'ios-install' | 'pwa-install';
export type NotifyPermissionStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'unsupported';

export interface NotifyPermissionSheetProps {
  open: boolean;
  onClose: () => void;
  /** 제목(예: '오픈 알림을 이 기기로 보냅니다') */
  title: ReactNode;
  /** 왜 필요한지 설명(.t-sm.muted 문단들). 대화상자의 aria-describedby로 잇는다 */
  description: ReactNode;
  variant?: NotifyPermissionVariant;
  status?: NotifyPermissionStatus;
  /** 결과 글(role="status"). granted·denied·unsupported일 때 보인다 */
  statusText?: ReactNode;
  /** 홈 화면에 추가하는 방법(ios-install·pwa-install 변형) */
  installSteps?: ReactNode;
  /** 권한을 묻는 버튼 글(기본 '알림 켜기') */
  allowLabel?: string;
  /** 대신 쓰는 수단 버튼 글(기본 '이메일로만 받기') */
  fallbackLabel?: string;
  /** 결과가 나온 뒤 닫기 버튼 글(기본 '닫기') */
  closeLabel?: string;
  /** '알림 켜기'를 눌렀을 때(여기서 브라우저 권한을 묻는다) */
  onAllow?: () => void;
  /** '이메일로만 받기'를 눌렀을 때. 없으면 닫는다 */
  onFallback?: () => void;
}

export function NotifyPermissionSheet({
  open,
  onClose,
  title,
  description,
  variant = 'push',
  status = 'idle',
  statusText,
  installSteps,
  allowLabel = '알림 켜기',
  fallbackLabel = '이메일로만 받기',
  closeLabel = '닫기',
  onAllow,
  onFallback,
}: NotifyPermissionSheetProps) {
  const descId = `${useId()}-np`;
  const wide = useMediaQuery('(min-width: 768px)', true);
  const settled = status === 'granted' || status === 'denied' || status === 'unsupported';
  const requesting = status === 'requesting';

  const allow = (
    <button
      key="allow"
      className={wide ? 'btn btn-primary' : 'btn btn-primary btn-lg btn-block'}
      type="button"
      aria-busy={requesting || undefined}
      onClick={() => {
        if (!requesting) onAllow?.();
      }}
    >
      {requesting ? <span className="spinner" aria-hidden="true" /> : null}
      {allowLabel}
    </button>
  );
  const fallback = (
    <button key="fallback" className={wide ? 'btn btn-ghost' : 'btn btn-ghost btn-block'} type="button" onClick={() => (onFallback ?? onClose)()}>
      {fallbackLabel}
    </button>
  );
  const close = (
    <button key="close" className={wide ? 'btn btn-primary' : 'btn btn-primary btn-lg btn-block'} type="button" onClick={onClose}>
      {closeLabel}
    </button>
  );
  // 대화상자는 오른쪽 끝이 주 행동(보드 SCR-001-d), 시트는 주 행동이 위
  const actions = settled ? close : wide ? [fallback, allow] : [allow, fallback];

  return (
    <Dialog open={open} onClose={onClose} title={title} icon="bell" iconTone="primary" layout="auto" describedBy={descId} actions={actions}>
      <div className="col" id={descId} style={{ gap: 8 }}>
        {description}
      </div>
      {variant !== 'push' && installSteps ? (
        <div className="card-flat col t-sm" style={{ gap: 8, padding: '14px 16px' }}>
          {installSteps}
        </div>
      ) : null}
      {/* 결과 글 자리는 늘 두어(비어 있으면 화면에서만 숨김) 바뀔 때 낭독기가 읽게 한다 */}
      <p className={settled && statusText ? 't-sm' : 'sr-only'} role="status">
        {settled ? statusText : null}
      </p>
    </Dialog>
  );
}
