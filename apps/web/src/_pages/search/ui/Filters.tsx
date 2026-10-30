'use client';
// SCR-003 ③ 필터(장르 · 공연 일정 · 예매 상태 · 공연장 · 아티스트 · 지난 공연 포함). 바꾸면 주소(?genre=&status=&placeId=&artistId=&includePast=)를 바꿔 다시 찾는다.
// 휴대폰·태블릿: 칩 한 줄(휴대폰은 가로 스크롤, 태블릿은 줄바꿈). 칩을 누르면 그 필터의 시트·대화상자(WebShellModal)가 열린다 —
//   보드에 시트 그림이 없어 데스크톱 패널의 같은 묶음을 그대로 넣었다(추천안).
// 데스크톱(lg): 왼쪽 3칸 필터 패널(보드 SCR-003-d aside). '기간 정하기'의 날짜 고르기는 보드에 없어 그리지 않았다.
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { WebShellModal, webModalButtonClass } from '@peaket/ds/WebShell';
import { cx } from '@/shared/lib/cx';
import { GENRES, GENRE_LABEL, type Genre } from '@/shared/config/genres';
import { searchUrl, STATUS_OPTIONS, type SearchFilters, type SortKey, type StatusFilter } from '../model/search';

/** 보드의 공연장·아티스트 필터 목록(데스크톱 '피켓 아레나'·'서울 소극장', '루멘'·'[아티스트]') */
const VENUE_OPTIONS = [
  { value: 'ven-peaket-arena', label: '피켓 아레나' },
  { value: 'ven-seoul-small', label: '서울 소극장' },
] as const;
const ARTIST_OPTIONS = [
  { value: 'art-lumen', label: '루멘' },
  { value: 'art-haneul-band', label: '하늘밴드' },
] as const;

type Group = 'genre' | 'date' | 'status' | 'venue' | 'artist';
const GROUP_LABEL: Record<Group, string> = { genre: '장르', date: '공연 일정', status: '예매 상태', venue: '공연장', artist: '아티스트' };

export interface FiltersProps {
  q: string;
  filters: SearchFilters;
  sort: SortKey;
}

function useApply({ q, filters, sort }: FiltersProps) {
  const router = useRouter();
  return (next: SearchFilters) => router.push(searchUrl({ q, filters, sort }, { filters: next }), { scroll: false });
}

function toggle<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function Fields({ group, filters, apply, idPrefix }: { group: Group; filters: SearchFilters; apply: (f: SearchFilters) => void; idPrefix: string }) {
  const legend = (
    <legend className="label" style={{ marginBottom: 10 }}>
      {GROUP_LABEL[group]}
    </legend>
  );
  const box = (id: string, label: string, checked: boolean, onChange: () => void) => (
    <label key={id} className="check-row" htmlFor={id}>
      <input className="cb" id={id} type="checkbox" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
  switch (group) {
    case 'genre':
      return (
        <fieldset className="col" style={{ gap: 10 }}>
          {legend}
          {GENRES.map((g) => box(`${idPrefix}-g-${g.key}`, g.label, filters.genres.includes(g.key), () => apply({ ...filters, genres: toggle(filters.genres, g.key) })))}
        </fieldset>
      );
    case 'date':
      return (
        <fieldset className="col" style={{ gap: 10 }}>
          {legend}
          <label className="check-row" htmlFor={`${idPrefix}-d-all`}>
            <input className="rd" id={`${idPrefix}-d-all`} type="radio" name={`${idPrefix}-date`} defaultChecked />
            전체 기간
          </label>
          <label className="check-row" htmlFor={`${idPrefix}-d-range`}>
            <input className="rd" id={`${idPrefix}-d-range`} type="radio" name={`${idPrefix}-date`} />
            기간 정하기
          </label>
        </fieldset>
      );
    case 'status':
      return (
        <fieldset className="col" style={{ gap: 10 }}>
          {legend}
          {STATUS_OPTIONS.map((s) =>
            box(`${idPrefix}-s-${s.value}`, s.label, filters.statuses.includes(s.value), () =>
              apply({ ...filters, statuses: toggle<StatusFilter>(filters.statuses, s.value) }),
            ),
          )}
        </fieldset>
      );
    case 'venue':
      return (
        <fieldset className="col" style={{ gap: 10 }}>
          {legend}
          {VENUE_OPTIONS.map((v) => box(`${idPrefix}-v-${v.value}`, v.label, filters.venueIds.includes(v.value), () => apply({ ...filters, venueIds: toggle(filters.venueIds, v.value) })))}
        </fieldset>
      );
    case 'artist':
      return (
        <fieldset className="col" style={{ gap: 10 }}>
          {legend}
          {ARTIST_OPTIONS.map((a) =>
            box(`${idPrefix}-a-${a.value}`, a.label, filters.artistIds.includes(a.value), () => apply({ ...filters, artistIds: toggle(filters.artistIds, a.value) })),
          )}
        </fieldset>
      );
  }
}

function PastToggle({ id, filters, apply, className }: { id: string; filters: SearchFilters; apply: (f: SearchFilters) => void; className?: string }) {
  return (
    <label className={cx('check-row', className)} htmlFor={id}>
      <input className="cb" id={id} type="checkbox" checked={filters.includePast} onChange={() => apply({ ...filters, includePast: !filters.includePast })} />
      지난 공연 포함
    </label>
  );
}

/** 칩 글: 고른 값이 하나면 ' · 콘서트', 여럿이면 ' · 2' */
function chipSuffix(group: Group, f: SearchFilters): string | null {
  const pick = (labels: string[]) => (labels.length === 0 ? null : labels.length === 1 ? ` · ${labels[0]}` : ` · ${labels.length}`);
  if (group === 'genre') return pick(f.genres.map((g: Genre) => GENRE_LABEL[g]));
  if (group === 'status') return pick(f.statuses.map((s) => STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s));
  if (group === 'venue') return pick(f.venueIds.map((v) => VENUE_OPTIONS.find((o) => o.value === v)?.label ?? '공연장'));
  if (group === 'artist') return pick(f.artistIds.map((a) => ARTIST_OPTIONS.find((o) => o.value === a)?.label ?? '아티스트'));
  return null;
}

/** 휴대폰·태블릿 칩 줄 */
export function FilterChips(props: FiltersProps) {
  const apply = useApply(props);
  const base = useId();
  const [open, setOpen] = useState<Group | null>(null);
  const groups: Group[] = ['genre', 'date', 'status', 'venue', 'artist'];
  return (
    <>
      <div
        className="relative row gap-2 overflow-x-auto px-4 pt-4 [scrollbar-width:none] md:flex-wrap md:overflow-visible md:px-0 md:pt-0"
        role="group"
        aria-label="필터"
      >
        {groups.map((g) => {
          const suffix = chipSuffix(g, props.filters);
          return (
            <button key={g} className={cx('chip', suffix && 'is-selected')} type="button" aria-haspopup="dialog" onClick={() => setOpen(g)}>
              {GROUP_LABEL[g]}
              {suffix}
              <i className="ic ic-chevron-down" aria-hidden="true" />
            </button>
          );
        })}
        <PastToggle id={`${base}-past`} filters={props.filters} apply={apply} className="flex-none items-center whitespace-nowrap" />
      </div>
      <WebShellModal
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open ? GROUP_LABEL[open] : ''}
        closeLabel={open ? `${GROUP_LABEL[open]} 필터 닫기` : undefined}
        actions={
          <button className={webModalButtonClass('secondary')} type="button" onClick={() => setOpen(null)}>
            닫기
          </button>
        }
      >
        {open ? (
          <div className="[&_legend]:sr-only">
            <Fields group={open} filters={props.filters} apply={apply} idPrefix={`${base}-sheet`} />
          </div>
        ) : null}
      </WebShellModal>
    </>
  );
}

/** 데스크톱 왼쪽 필터 패널 */
export function FilterPanel({ className, ...props }: FiltersProps & { className?: string }) {
  const apply = useApply(props);
  const base = useId();
  const groups: Group[] = ['genre', 'date', 'status', 'venue', 'artist'];
  return (
    <aside className={className} aria-labelledby={`${base}-h`}>
    <div className="card col" style={{ padding: 20, gap: 18 }}>
      <h2 className="t-md fw-b" id={`${base}-h`}>
        필터
      </h2>
      {groups.map((g) => (
        <div key={g} className="col" style={{ gap: 18 }}>
          <Fields group={g} filters={props.filters} apply={apply} idPrefix={`${base}-panel`} />
          <div className="divider" />
        </div>
      ))}
      <PastToggle id={`${base}-past`} filters={props.filters} apply={apply} />
    </div>
    </aside>
  );
}
