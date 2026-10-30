'use client';
// 데스크톱 카드 줄 오른쪽 끝의 '다음 공연 보기' 화살표(보드 SCR-001-d). 같은 줄(가로 스크롤 목록)을 한 화면 폭만큼 넘긴다.
// 휴대폰·태블릿은 손가락으로 넘기므로 보이지 않는다(lg부터).
export function RailNextButton({ targetId, label, top = 128 }: { targetId: string; label: string; top?: number }) {
  return (
    <button
      className="icon-btn icon-btn-outline absolute right-[10px] z-[2] hidden lg:grid"
      type="button"
      aria-label={label}
      aria-controls={targetId}
      style={{ top, borderRadius: '50%', boxShadow: 'var(--shadow-md)' }}
      onClick={() => {
        const el = document.getElementById(targetId);
        if (!el) return;
        const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
        el.scrollTo({ left: atEnd ? 0 : el.scrollLeft + el.clientWidth, behavior: 'smooth' });
      }}
    >
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </button>
  );
}
