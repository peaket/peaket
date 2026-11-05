'use client';
// SCR-003 ③ 필터(장르 · 공연 일정 · 예매 상태 · 공연장 · 아티스트 · 지난 공연 포함). 바꾸면 주소(?genre=&dateFrom=&dateTo=&status=&placeId=&artistId=&includePast=)를
// 바꿔 다시 찾는다. 계약은 필터마다 값 하나라 하나씩 고른다(openapi listSearchResults, docs/features/search.md §5.2, BUILD_ORDER HOT-312).
// 공연장은 홈 피드의 공연장 줄을 고를 목록으로 두고(search.md §5.2 '홈 공연장 줄'), 아티스트는 검색창 자동완성 후보가 ID로 연다(목록 경로가 없어
// 고른 것을 보이고 풀기만 한다). 홈의 '공연장' 칸(`?filter=venue`)으로 오면 휴대폰·태블릿은 공연장 시트를 열어 둔다.
// 휴대폰·태블릿: 칩 한 줄(휴대폰은 가로 스크롤, 태블릿은 줄바꿈). 칩을 누르면 그 필터의 시트·대화상자(WebShellModal)가 열린다.
// 데스크톱(lg): 왼쪽 3칸 필터 패널(보드 SCR-003-d aside).
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { WebShellModal, webModalButtonClass } from '@peaket/ds/WebShell';
import { cx } from '@/shared/lib/cx';
import { GENRES, GENRE_LABEL } from '@/shared/config/genres';
import { searchUrl, STATUS_OPTIONS, type SearchFilters, type SearchQuery } from '../model/search';

type Group = 'genre' | 'date' | 'status' | 'venue' | 'artist';
const GROUP_LABEL: Record<Group, string> = { genre: '장르', date: '공연 일정', status: '예매 상태', venue: '공연장', artist: '아티스트' };
const GROUPS: readonly Group[] = ['genre', 'date', 'status', 'venue', 'artist'];

export interface FiltersProps {
  query: SearchQuery;
  /** 주소로 받은 공연장·아티스트 필터의 이름(검색 응답 filterNames) */
  placeName?: string | undefined;
  artistName?: string | undefined;
  /** 처음 열 필터 시트(`?filter=venue`, 홈의 '공연장' 칸) */
  openGroup?: string | undefined;
}

function useApply(query: SearchQuery) {
  const router = useRouter();
  return (next: SearchFilters) => router.push(searchUrl(query, { filters: next }), { scroll: false });
}

function Radio({ id, name, label, checked, onChange }: { id: string; name: string; label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="check-row" htmlFor={id}>
      <input className="rd" id={id} type="radio" name={name} checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

function Fields({ group, p, apply, idPrefix }: { group: Group; p: FiltersProps; apply: (f: SearchFilters) => void; idPrefix: string }) {
  const f = p.query.filters;
  const legend = (
    <legend className="label" style={{ marginBottom: 10 }}>
      {GROUP_LABEL[group]}
    </legend>
  );
  const name = `${idPrefix}-${group}`;
  switch (group) {
    case 'genre': {
      const { genre: _g, ...rest } = f;
      return (
        <fieldset className="col" style={{ gap: 10 }}>
          {legend}
          <Radio id={`${name}-all`} name={name} label="전체" checked={!f.genre} onChange={() => apply(rest)} />
          {GENRES.map((g) => (
            <Radio key={g.key} id={`${name}-${g.key}`} name={name} label={g.label} checked={f.genre === g.key} onChange={() => apply({ ...rest, genre: g.key })} />
          ))}
        </fieldset>
      );
    }
    case 'status': {
      const { status: _s, ...rest } = f;
      return (
        <fieldset className="col" style={{ gap: 10 }}>
          {legend}
          <Radio id={`${name}-all`} name={name} label="전체" checked={!f.status} onChange={() => apply(rest)} />
          {STATUS_OPTIONS.map((s) => (
            <Radio key={s.value} id={`${name}-${s.value}`} name={name} label={s.label} checked={f.status === s.value} onChange={() => apply({ ...rest, status: s.value })} />
          ))}
        </fieldset>
      );
    }
    case 'date':
      return <DateFields f={f} apply={apply} name={name} legend={legend} />;
    case 'venue':
    case 'artist': {
      const isVenue = group === 'venue';
      if (isVenue && !f.placeId) return <VenueOptions f={f} apply={apply} name={name} legend={legend} />;
      const id = isVenue ? f.placeId : f.artistId;
      const label = (isVenue ? p.placeName : p.artistName) ?? (isVenue ? '고른 공연장' : '고른 아티스트');
      const { placeId: _p, artistId: _a, ...others } = f;
      const cleared: SearchFilters = isVenue ? { ...others, ...(f.artistId ? { artistId: f.artistId } : {}) } : { ...others, ...(f.placeId ? { placeId: f.placeId } : {}) };
      return (
        <fieldset className="col" style={{ gap: 10 }}>
          {legend}
          {id ? (
            <>
              <Radio id={`${name}-all`} name={name} label="전체" checked={false} onChange={() => apply(cleared)} />
              <Radio id={`${name}-picked`} name={name} label={label} checked onChange={() => {}} />
            </>
          ) : (
            <p className="t-sm muted">검색창의 아티스트 후보로 고릅니다</p>
          )}
        </fieldset>
      );
    }
  }
}

/** 날짜 칸의 최댓값. 없으면 Chrome이 여섯 자리 연도를 받아 키보드로 20261201을 치면 연도가 202612가 된다(2026-11-05 Chrome 확인) */
const DATE_MAX = '9999-12-31';

/**
 * 공연 일정: 공연 기간이 고른 범위와 겹치는 공연(KST 날짜, search.md §5.2). 날짜 칸은 칸 안에서만 바꾸고 칸을 떠날 때·Enter 때 주소에 반영한다
 * (값마다 주소를 바꾸면 입력 중 칸이 옛 값으로 되돌고 중간 날짜마다 검색이 일어난다). 시작일이 종료일보다 늦으면 반영하지 않는다.
 */
function DateFields({ f, apply, name, legend }: { f: SearchFilters; apply: (f: SearchFilters) => void; name: string; legend: React.ReactNode }) {
  const hasRange = Boolean(f.dateFrom || f.dateTo);
  const [ranged, setRanged] = useState(hasRange);
  const [draft, setDraft] = useState({ from: f.dateFrom ?? '', to: f.dateTo ?? '' });
  // 주소가 바뀌면(뒤로 가기·필터 풀기) 표시를 따라간다
  useEffect(() => {
    setRanged(hasRange);
    setDraft({ from: f.dateFrom ?? '', to: f.dateTo ?? '' });
  }, [hasRange, f.dateFrom, f.dateTo]);
  const { dateFrom: _f, dateTo: _t, ...rest } = f;
  const invalid = Boolean(draft.from && draft.to && draft.from > draft.to);
  const commit = () => {
    if (invalid || (draft.from === (f.dateFrom ?? '') && draft.to === (f.dateTo ?? ''))) return;
    apply({ ...rest, ...(draft.from ? { dateFrom: draft.from } : {}), ...(draft.to ? { dateTo: draft.to } : {}) });
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
  };
  return (
    <fieldset className="col" style={{ gap: 10 }}>
      {legend}
      <Radio
        id={`${name}-all`}
        name={name}
        label="전체 기간"
        checked={!ranged}
        onChange={() => {
          setRanged(false);
          if (hasRange) apply(rest);
        }}
      />
      <Radio id={`${name}-range`} name={name} label="기간 정하기" checked={ranged} onChange={() => setRanged(true)} />
      {ranged ? (
        <div className="col" style={{ gap: 6 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="col t-sm" style={{ gap: 4 }} htmlFor={`${name}-from`}>
              시작일
              <input className="input" id={`${name}-from`} type="date" max={DATE_MAX} value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} onBlur={commit} onKeyDown={onKey} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${name}-err` : undefined} />
            </label>
            <label className="col t-sm" style={{ gap: 4 }} htmlFor={`${name}-to`}>
              종료일
              <input className="input" id={`${name}-to`} type="date" max={DATE_MAX} value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} onBlur={commit} onKeyDown={onKey} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${name}-err` : undefined} />
            </label>
          </div>
          {invalid ? (
            <p className="t-sm tx-danger" id={`${name}-err`} role="alert">
              시작일이 종료일보다 늦습니다
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

/** 공연장 묶음(고른 공연장이 없을 때): 홈 피드의 공연장 줄을 고를 목록으로 둔다 */
function VenueOptions({ f, apply, name, legend }: { f: SearchFilters; apply: (f: SearchFilters) => void; name: string; legend: React.ReactNode }) {
  const list = usePlaceOptions(true);
  return (
    <fieldset className="col" style={{ gap: 10 }} aria-busy={list === undefined || undefined}>
      {legend}
      <Radio id={`${name}-all`} name={name} label="전체" checked onChange={() => {}} />
      {list === undefined ? <span className="skel" style={{ height: 18, width: 120 }} /> : null}
      {(list ?? []).map((p) => (
        <Radio key={p.id} id={`${name}-${p.id}`} name={name} label={p.name} checked={false} onChange={() => apply({ ...f, placeId: p.id })} />
      ))}
      {list !== undefined && list.length === 0 ? <p className="t-sm muted">검색창의 공연장 후보로 고릅니다</p> : null}
    </fieldset>
  );
}

/** 홈 피드의 공연장 줄(공연장 필터 목록, search.md §5.2 '홈 공연장 줄'). 공개 CDN 경로라 한 번 받아 둔다 */
let placesOnce: Promise<{ id: string; name: string }[]> | undefined;
function usePlaceOptions(enabled: boolean): { id: string; name: string }[] | undefined {
  const [list, setList] = useState<{ id: string; name: string }[] | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    placesOnce ??= (async () => {
      const [{ getHome }, api] = await Promise.all([import('@peaket/api-client/endpoints/catalog'), import('@/shared/api')]);
      api.ensureBrowserApi();
      const r = await getHome();
      return (r.data.places ?? []).flatMap((p) => (p.placeId && p.name ? [{ id: p.placeId, name: p.name }] : []));
    })().catch(() => {
      placesOnce = undefined;
      return [];
    });
    void placesOnce.then((l) => {
      if (live) setList(l);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return list;
}

function PastToggle({ id, f, apply, className }: { id: string; f: SearchFilters; apply: (f: SearchFilters) => void; className?: string }) {
  return (
    <label className={cx('check-row', className)} htmlFor={id}>
      <input className="cb" id={id} type="checkbox" checked={f.includePast} onChange={() => apply({ ...f, includePast: !f.includePast })} />
      지난 공연 포함
    </label>
  );
}

/** 칩 글: 고른 값이 있으면 ' · 콘서트' */
function chipSuffix(group: Group, p: FiltersProps): string | null {
  const f = p.query.filters;
  if (group === 'genre') return f.genre ? ` · ${GENRE_LABEL[f.genre]}` : null;
  if (group === 'status') return f.status ? ` · ${STATUS_OPTIONS.find((o) => o.value === f.status)?.label ?? ''}` : null;
  if (group === 'date') return f.dateFrom || f.dateTo ? ` · ${f.dateFrom ?? ''}~${f.dateTo ?? ''}` : null;
  if (group === 'venue') return f.placeId ? ` · ${p.placeName ?? '고름'}` : null;
  return f.artistId ? ` · ${p.artistName ?? '고름'}` : null;
}

/** 휴대폰·태블릿 칩 줄 */
export function FilterChips(props: FiltersProps) {
  const apply = useApply(props.query);
  const base = useId();
  const [open, setOpen] = useState<Group | null>(props.openGroup === 'venue' ? 'venue' : null);
  return (
    <>
      <div
        className="relative row gap-2 overflow-x-auto px-4 pt-4 [scrollbar-width:none] md:flex-wrap md:overflow-visible md:px-0 md:pt-0"
        role="group"
        aria-label="필터"
      >
        {GROUPS.map((g) => {
          const suffix = chipSuffix(g, props);
          return (
            <button key={g} className={cx('chip', suffix && 'is-selected')} type="button" aria-haspopup="dialog" onClick={() => setOpen(g)}>
              {GROUP_LABEL[g]}
              {suffix}
              <i className="ic ic-chevron-down" aria-hidden="true" />
            </button>
          );
        })}
        <PastToggle id={`${base}-past`} f={props.query.filters} apply={apply} className="flex-none items-center whitespace-nowrap" />
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
            <Fields group={open} p={props} apply={apply} idPrefix={`${base}-sheet`} />
          </div>
        ) : null}
      </WebShellModal>
    </>
  );
}

/** 데스크톱 왼쪽 필터 패널 */
export function FilterPanel({ className, ...props }: FiltersProps & { className?: string }) {
  const apply = useApply(props.query);
  const base = useId();
  return (
    <aside className={className} aria-labelledby={`${base}-h`}>
      <div className="card col" style={{ padding: 20, gap: 18 }}>
        <h2 className="t-md fw-b" id={`${base}-h`}>
          필터
        </h2>
        {GROUPS.map((g) => (
          <div key={g} className="col" style={{ gap: 18 }}>
            <Fields group={g} p={props} apply={apply} idPrefix={`${base}-panel`} />
            <div className="divider" />
          </div>
        ))}
        <PastToggle id={`${base}-past`} f={props.query.filters} apply={apply} />
      </div>
    </aside>
  );
}
