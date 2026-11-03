'use client';
// 화면 오른쪽 아래에 떠 있는 퍼블리싱 상태 고르기 패널(개발용). 캔버스 보드의 state 열거값을 링크로 보인다.
import { useState } from 'react';
import { renderLinkOrAnchor, type RenderLink } from '../../lib/link';
import { previewHref } from './preview';

export interface StateSwitcherProps {
  /** 이 화면의 경로(검색 문자열 없이) */
  path: string;
  states: readonly string[];
  current: string;
  /** 남길 다른 검색 값(theme, role 등) */
  keep?: Record<string, string | undefined>;
  renderLink?: RenderLink;
  /** 라이트 고정 앱(스캐너)은 false로 다크 보기 링크를 숨긴다 */
  allowDark?: boolean;
  /** 처음 테마. 관제 콘솔처럼 다크가 처음인 앱은 'dark' */
  baseTheme?: 'light' | 'dark';
}

export function StateSwitcher({ path, states, current, keep, renderLink, allowDark = true, baseTheme = 'light' }: StateSwitcherProps) {
  const [open, setOpen] = useState(true);
  if (states.length < 2 && !keep) return null;
  const theme = keep?.theme ?? baseTheme;
  // 처음 테마로 돌아갈 때는 theme 값을 지운다
  const otherTheme = theme === 'dark' ? 'light' : 'dark';
  const nextTheme = otherTheme === baseTheme ? undefined : otherTheme;
  return (
    <aside
      aria-label="퍼블리싱 상태 고르기"
      className="pk-preview-switcher"
      style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 2147483000, maxWidth: 260 }}
    >
      <div className="card" style={{ padding: 8, boxShadow: 'var(--shadow-lg)', background: 'var(--surface-raised)' }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{ width: '100%', justifyContent: 'space-between' }}
        >
          <span className="t-xs fw-b">상태 · 개발용</span>
          <span className="t-xs muted">{current}</span>
        </button>
        {open && (
          <ul className="col" style={{ gap: 2, marginTop: 4, maxHeight: '40vh', overflow: 'auto' }}>
            {states.map((s) => (
              <li key={s}>
                {renderLinkOrAnchor(renderLink, {
                  href: previewHref(path, s, keep),
                  className: 't-xs',
                  'aria-current': s === current ? 'true' : undefined,
                  children: s === current ? <strong>● {s}</strong> : s,
                })}
              </li>
            ))}
            {allowDark && (<li style={{ marginTop: 4 }}>
              {renderLinkOrAnchor(renderLink, {
                href: previewHref(path, current, { ...keep, theme: nextTheme }),
                className: 't-xs',
                children: theme === 'dark' ? '라이트로 보기' : '다크로 보기',
              })}
            </li>)}
          </ul>
        )}
      </div>
    </aside>
  );
}
