// 설정 네 페이지의 틀(보드 SCR-020-d·t·m 설정 구역, d5 §6.1).
// 데스크톱(lg 1280부터): grid-12의 span-3 설정 메뉴 카드 + span-9 본문 · 태블릿·휴대폰: 위 탭 줄(.tabs-scroll) + 본문.
// 팀 계정은 파트너 관리자에게만 메뉴에 보인다.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { routes } from '@/shared/config/routes';

export type SettingsKey = 'account' | 'seller' | 'payout' | 'team';

const MENU: readonly { key: SettingsKey; label: string; icon: string; href: string; adminOnly?: boolean }[] = [
  { key: 'account', label: '내 계정', icon: 'ic-user', href: routes.settingsAccount() },
  { key: 'seller', label: '판매자 정보', icon: 'ic-building', href: routes.settingsSeller() },
  { key: 'payout', label: '정산 계좌', icon: 'ic-bank', href: routes.settingsPayout() },
  { key: 'team', label: '팀 계정', icon: 'ic-users', href: routes.settingsTeam(), adminOnly: true },
];

/** 미리보기 검색 값(theme·role)을 남긴 주소 */
export function withKeep(href: string, keep: Record<string, string | undefined>, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(keep)) if (v !== undefined) params.set(k, v);
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  const q = params.toString();
  return q ? `${href}?${q}` : href;
}

export interface SettingsFrameProps {
  current: SettingsKey;
  isMember: boolean;
  keep: Record<string, string | undefined>;
  children: ReactNode;
}

export function SettingsFrame({ current, isMember, keep, children }: SettingsFrameProps) {
  const items = MENU.filter((m) => !m.adminOnly || !isMember || m.key === current);
  return (
    <div className="grid-12 items-start gap-y-5 max-lg:flex max-lg:flex-col max-lg:items-stretch max-lg:gap-4">
      <div className="span-3 max-lg:hidden">
        <nav className="card col" style={{ padding: 8, gap: 2 }} aria-label="설정 메뉴">
          <p className="eyebrow" style={{ padding: '8px 10px 6px' }}>
            설정
          </p>
          {items.map((m) => (
            <Link
              key={m.key}
              className={m.key === current ? 'menu-item is-active fw-b' : 'menu-item'}
              href={withKeep(m.href, keep)}
              aria-current={m.key === current ? 'page' : undefined}
            >
              <i className={`ic ${m.icon} ic-16`} aria-hidden="true" />
              {m.label}
            </Link>
          ))}
        </nav>
      </div>
      <nav className="tabs tabs-scroll lg:hidden" aria-label="설정 메뉴">
        {items.map((m) => (
          <Link
            key={m.key}
            className={m.key === current ? 'tab is-active' : 'tab'}
            href={withKeep(m.href, keep)}
            aria-current={m.key === current ? 'page' : undefined}
          >
            {m.label}
          </Link>
        ))}
      </nav>
      <div className="span-9 col gap-5 max-lg:gap-4" style={{ minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}
