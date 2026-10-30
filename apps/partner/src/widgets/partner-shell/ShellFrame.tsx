'use client';
// 파트너 셸(ds PartnerShell)에 지금 경로·역할·테마·셸 단위 상태를 잇는다. (console) 경로 묶음의 레이아웃이 감싼다.
// 셸이 맡는 상태(?state=): '메뉴 열림'(서랍) · '긴급 공지 팝업' · '유휴 만료 2분 전 경고' · '유휴 만료'. 역할은 ?role=member 또는 실무자 상태.
import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { PartnerShell, type PartnerNavKey } from '@peaket/ds/PartnerShell';
import { stellaOrg } from '@/entities/partner-org';
import { me } from '@/entities/partner-user';
import { notifications, urgentNotice } from '@/entities/notification';
import { routes } from '@/shared/config/routes';
import { readParam, resolveRole } from '@/shared/lib/preview';
import { renderNextLink } from '@/shared/ui/link';

function navKey(pathname: string): PartnerNavKey | null {
  if (pathname.startsWith('/events')) return 'events';
  if (pathname.startsWith('/products')) return 'products';
  if (pathname.startsWith('/settings/account')) return 'account';
  if (pathname.startsWith('/settings/seller')) return 'seller';
  if (pathname.startsWith('/settings/payout')) return 'payout';
  if (pathname.startsWith('/settings/webhooks')) return 'webhooks';
  return null;
}

/** 유휴 만료 뒤 '보던 화면' 이름 */
function screenName(key: PartnerNavKey | null): string {
  switch (key) {
    case 'events':
      return '공연 관리';
    case 'products':
      return '상품';
    case 'account':
      return '내 계정';
    case 'seller':
      return '판매자 정보';
    case 'payout':
      return '정산 계좌';
    case 'webhooks':
      return '웹훅';
    default:
      return '이 화면';
  }
}

export function ShellFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const sp = useSearchParams();
  const state = readParam(sp ?? undefined, 'state');
  const dark = readParam(sp ?? undefined, 'theme') === 'dark';
  const role = resolveRole(sp ?? undefined);
  const current = navKey(pathname);
  const idle = state === '유휴 만료 2분 전 경고' ? 'warning' : state === '유휴 만료' ? 'expired' : null;
  const menu = state === '메뉴 열림';
  const urgent = state === '긴급 공지 팝업';
  // 겹침 상태가 바뀌면 셸을 새로 그려 처음 열린 모양을 맞춘다
  const overlayKey = `${idle ?? ''}|${menu}|${urgent}`;
  return (
    <PartnerShell
      key={overlayKey}
      orgName={stellaOrg.name}
      userName={me.displayName}
      avatarText={me.avatarText}
      role={role}
      current={current}
      hrefs={{
        home: routes.home(),
        events: routes.events(),
        products: routes.products(),
        account: routes.settingsAccount(),
        seller: routes.settingsSeller(),
        payout: routes.settingsPayout(),
        webhooks: routes.settingsWebhooks(),
        logout: routes.login(),
        inbox: routes.events(),
      }}
      notifications={notifications}
      dark={dark}
      defaultMenuOpen={menu}
      idle={idle}
      idleReturnName={screenName(current)}
      urgentNotice={urgent ? urgentNotice : null}
      renderLink={renderNextLink}
    >
      {children}
    </PartnerShell>
  );
}
