'use client';
// 에디터의 클라이언트 조각: 네 단계 탭(StepTabs), 시작 안내 배너 닫기(DismissBanner), 휠체어석 '기준 보기' 펼침(CriteriaToggle),
// 격자 맞춤 토글(GridToggle). 단계 탭은 퍼블리싱 단계라 그 단계의 대표 상태 주소(?state=)로 옮긴다.
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Step } from '../model/view';

const STEPS: readonly { step: Step; num?: string; label: string; state: string }[] = [
  { step: 1, num: '①', label: '배치 그리기', state: '배치 그리기' },
  { step: 2, num: '②', label: '좌석 채우기', state: '좌석 채우기' },
  { step: 3, num: '③', label: '좌석 다듬기', state: '좌석 다듬기' },
  { step: 4, label: '미리보기', state: '미리보기' },
];

export function StepTabs({ current, large = false }: { current: Step; large?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const ref = useRef<HTMLDivElement>(null);

  function go(state: string) {
    const q = new URLSearchParams(sp?.toString());
    q.set('state', state);
    router.push(`${pathname}?${q.toString()}`, { scroll: false });
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]?.focus();
  }

  return (
    <div ref={ref} className="seg" role="tablist" aria-label="편집 단계" onKeyDown={onKey} style={{ maxWidth: '100%', overflowX: 'auto' }}>
      {STEPS.map((s) => {
        const on = s.step === current;
        return (
          <button
            key={s.step}
            className={on ? 'seg-item is-active' : 'seg-item'}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls="canvas-panel"
            tabIndex={on ? 0 : -1}
            onClick={() => !on && go(s.state)}
            style={large ? { height: 40, padding: '0 12px' } : undefined}
          >
            {s.num ? (
              <>
                <span aria-hidden="true">{s.num}</span>
                <span className="sr-only">{s.step}단계 </span>
              </>
            ) : null}
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

export function DismissBanner({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="banner banner-success" role="status" style={{ alignItems: 'center' }}>
      <i className="ic ic-check-circle" aria-hidden="true" />
      <div className="banner-body">{children}</div>
      <button className="icon-btn icon-btn-sm" type="button" aria-label="안내 닫기" style={{ margin: '-6px -6px -6px 0' }} onClick={() => setOpen(false)}>
        <i className="ic ic-close" aria-hidden="true" />
      </button>
    </div>
  );
}

const CRITERIA =
  '휠체어석 기준(장애인등편의법 시행령 별표 2, 시행규칙 별표 1 제20호): 공연장과 관람장은 전체 관람석의 1% 이상(2,000석 이상이면 20석 이상, 소수점은 올림)을 휠체어석으로 둡니다. 출입구와 피난통로에서 접근하기 쉬운 곳, 무대 기준 중간 줄이나 맨 앞줄처럼 무대가 잘 보이는 곳에 두고, 1석당 폭 0.9m·깊이 1.3m 이상이어야 합니다. 이 기준은 공연장(시설주)이 지키는 것이고, PEAKET은 좌석맵이 공연장과 같은지 확인합니다.';

/** '좌석맵으로는 …' 안내와 [기준 보기] 펼침(d5 §6.5 '기준 보기' 문구 그대로) */
export function CriteriaToggle({ defaultOpen, idPrefix, stacked = false }: { defaultOpen: boolean; idPrefix: string; stacked?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `${idPrefix}-crit-panel`;
  return (
    <>
      <div
        className={stacked ? 'col' : 'row wrap'}
        style={stacked ? { gap: 2, marginTop: 10, alignItems: 'flex-start' } : { gap: '4px 8px', marginTop: 8, alignItems: 'center' }}
      >
        <span className="t-xs muted">
          좌석맵으로는 휠체어석의 수와 열 안의 위치만 검사합니다. 크기와 실제 위치는 판매 승인 요청 때 공연장 좌석 배치도와 대조해 확인합니다.
        </span>
        <button className="btn btn-text btn-sm" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
          기준 보기
          <i className={`ic ${open ? 'ic-chevron-up' : 'ic-chevron-down'}`} aria-hidden="true" />
        </button>
      </div>
      <div className="card-flat pad" id={panelId} role="region" aria-label="휠체어석 기준" style={{ marginTop: 8 }} hidden={!open}>
        <p className="t-sm">{CRITERIA}</p>
      </div>
    </>
  );
}

export function GridToggle({ large = false }: { large?: boolean }) {
  const [on, setOn] = useState(true);
  return (
    <button
      className={large ? 'btn btn-outline' : 'btn btn-outline btn-sm'}
      type="button"
      aria-pressed={on}
      onClick={() => setOn((v) => !v)}
      style={{
        ...(large ? { height: 44, padding: '0 12px' } : {}),
        ...(on ? { background: 'var(--primary-subtle)', borderColor: 'var(--border-primary)', color: 'var(--link)' } : {}),
      }}
    >
      <i className="ic ic-grid" aria-hidden="true" />
      격자 맞춤
    </button>
  );
}
