// 퍼블리싱 상태 고르기 패널(개발 서버에서만). 화면이 자기 상태 목록을 넘긴다. theme·role 같은 다른 검색 값은 남긴다.
// ds StateSwitcher와 같은 모양이다. 다만 관제는 데스크톱에서 다크가 처음 값이라 테마 링크를 지금 그린 테마의 반대로 만든다
// (ds StateSwitcher는 라이트가 처음인 앱 기준이라 다크가 처음인 화면에서 라이트로 넘어가지 못한다 — 보고에 적음).
import { useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { previewHref } from '@peaket/ds/Preview';
import { useLayout } from '@/shared/lib/layout';
import { usePreviewKeep } from '@/shared/lib/preview';
import { useResolvedTheme } from '@/shared/lib/theme';

export function PreviewSwitcher({ states, current }: { states: readonly string[]; current: string }) {
  const { pathname } = useLocation();
  const keep = usePreviewKeep();
  const [params] = useSearchParams();
  const layout = useLayout();
  const theme = useResolvedTheme(layout, params.get('theme'));
  // 휴대폰에서는 본문을 가리지 않게 접은 채로 시작한다
  const [open, setOpen] = useState(layout !== 'phone');
  if (!__PREVIEW__) return null;
  return (
    <aside aria-label="퍼블리싱 상태 고르기" style={{ position: 'fixed', right: 12, bottom: layout === 'phone' ? 68 : 12, zIndex: 2147483000, maxWidth: 260 }}>
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
        {open ? (
          <ul className="col" style={{ gap: 2, marginTop: 4, maxHeight: '40vh', overflow: 'auto' }}>
            {states.map((s) => (
              <li key={s}>
                <Link className="t-xs" to={previewHref(pathname, s, keep)} aria-current={s === current ? 'true' : undefined}>
                  {s === current ? <strong>● {s}</strong> : s}
                </Link>
              </li>
            ))}
            <li style={{ marginTop: 4 }}>
              <Link className="t-xs" to={previewHref(pathname, current, { ...keep, theme: theme === 'dark' ? 'light' : 'dark' })}>
                {theme === 'dark' ? '라이트로 보기' : '다크로 보기'}
              </Link>
            </li>
          </ul>
        ) : null}
      </div>
    </aside>
  );
}
