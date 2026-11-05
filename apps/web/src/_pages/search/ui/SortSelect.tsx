'use client';
// SCR-003 ② 정렬(CMP-010 Select): 정확도 · 오픈 임박 · 인기. 휴대폰은 이름을 화면 밖에 두고(보드 sr-only), 태블릿 이상은 '정렬'을 보인다.
import { useRouter } from 'next/navigation';
import { useId } from 'react';
import { effectiveSort, searchUrl, SORT_OPTIONS, type SearchQuery, type SortKey } from '../model/search';

export function SortSelect({ query }: { query: SearchQuery }) {
  const router = useRouter();
  const id = useId();
  return (
    <div className="row" style={{ gap: 8 }}>
      <label className="sr-only md:not-sr-only md:text-sm md:leading-[19px] md:text-(--text-muted)" htmlFor={id}>
        정렬
      </label>
      <div className="input-group input-group-sm w-[118px] md:w-[140px]">
        <select id={id} value={effectiveSort(query)} onChange={(e) => router.push(searchUrl(query, { sort: e.target.value as SortKey }), { scroll: false })}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <i className="ic ic-chevron-down" aria-hidden="true" />
      </div>
    </div>
  );
}
