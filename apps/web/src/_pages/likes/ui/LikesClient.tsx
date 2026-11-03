'use client';
// SCR-054의 작은 클라이언트 부품: 탭(CMP-030), 찜 해제, 알림 끄기·다시 신청, 알림 권한 설정(CMP-068 시트).
// 퍼블리싱 단계라 찜·알림 API와 실제 브라우저 권한 요청은 붙이지 않는다(데이터 연결 단계). 결과는 토스트로 알린다.
import { useState, type ReactNode } from 'react';
import { NotifyPermissionSheet } from '@peaket/ds/NotifyPermissionSheet';
import { Tabs } from '@peaket/ds/Tabs';
import { useToast } from '@/shared/ui/toast';
import type { LikesTab } from '../model/state';

export interface LikesTabsProps {
  initial: LikesTab;
  /** 탭 배지 숫자(빈 화면이면 없음) */
  likesBadge?: number;
  alertsBadge?: number;
  likesPanel: ReactNode;
  alertsPanel: ReactNode;
}

export function LikesTabs({ initial, likesBadge, alertsBadge, likesPanel, alertsPanel }: LikesTabsProps) {
  return (
    <div className="col gap-5 lg:gap-6">
      <Tabs
        label="관심 공연과 알림"
        defaultValue={initial}
        items={[
          { value: 'likes', label: '관심 공연', badge: likesBadge },
          { value: 'alerts', label: '알림 신청', badge: alertsBadge },
        ]}
      >
        {(v) => (v === 'alerts' ? alertsPanel : likesPanel)}
      </Tabs>
    </div>
  );
}

/** 카드의 찜 해제(하트 아이콘 버튼). 누르면 해제하고, 다시 누르면 다시 찜한다(카드는 목록에 남겨 되돌릴 수 있게 한다) */
export function UnlikeButton({ title }: { title: string }) {
  const [liked, setLiked] = useState(true);
  const toast = useToast();
  return (
    <button
      className="icon-btn"
      type="button"
      aria-label={liked ? `${title} 찜 해제` : `${title} 다시 찜하기`}
      style={{ margin: '-6px -10px -6px 0' }}
      onClick={() => {
        setLiked(!liked);
        toast(liked ? '찜을 해제했습니다' : '찜했습니다', liked ? 'ic-heart' : 'ic-heart-fill');
      }}
    >
      <i className={liked ? 'ic ic-heart-fill tx-danger' : 'ic ic-heart'} aria-hidden="true" />
    </button>
  );
}

/** 알림 신청 카드의 [끄기]·[다시 신청]. srLabel은 버튼 이름 뒤에 붙는 공연·회차·알림 종류(화면 낭독용) */
export function AlertActionButton({ srLabel, kindLabel, ended }: { srLabel: string; kindLabel: string; ended: boolean }) {
  const [active, setActive] = useState(!ended);
  const toast = useToast();
  return (
    <button
      className="btn btn-outline btn-sm"
      type="button"
      onClick={() => {
        setActive(!active);
        toast(active ? `${kindLabel}을 껐습니다` : `${kindLabel}을 신청했습니다`, active ? 'ic-bell' : 'ic-bell-fill');
      }}
    >
      {active ? '끄기' : ended ? '다시 신청' : '켜기'}
      <span className="sr-only"> {srLabel}</span>
    </button>
  );
}

/** ( 알림 권한 설정 › ) → 웹 푸시 권한 안내 시트(CMP-068). 권한은 시트의 버튼을 누른 뒤에만 묻는다(NFR-019) */
export function PermissionSettingsButton() {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <>
      <button className="btn btn-text" type="button" aria-haspopup="dialog" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        알림 권한 설정
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </button>
      <NotifyPermissionSheet
        open={open}
        onClose={() => setOpen(false)}
        title="알림을 이 기기로 보냅니다"
        description={
          <>
            <p className="t-sm muted">오픈·취소표 알림을 웹 푸시로 보냅니다. 아래 버튼을 누른 뒤에만 브라우저가 알림 권한을 묻습니다.</p>
            <p className="t-sm muted">권한을 거부하거나 지원하지 않는 브라우저라면 이메일로 알려 드립니다.</p>
          </>
        }
        onAllow={() => {
          setOpen(false);
          toast('이 기기로 알림을 받습니다', 'ic-bell-fill');
        }}
        onFallback={() => {
          setOpen(false);
          toast('알림을 이메일로만 받습니다', 'ic-mail');
        }}
      />
    </>
  );
}
