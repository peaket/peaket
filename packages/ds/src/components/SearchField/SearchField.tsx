'use client';
// CMP-004 TextField search 변형: 전역 머리의 통합 검색창(콤보박스). 보드 SCR-003 마크업을 그대로 낸다:
//   <form role="search"> .input-group(ic-search + input role="combobox" + 지우기 icon-btn-sm)
//   + 아래 .menu 창 안 listbox(.menu-item role="option", 고른 후보 .is-active)
// - ARIA combobox: aria-expanded·aria-controls·aria-activedescendant·aria-autocomplete="list", 창은 listbox, 후보는 option.
// - ↑↓로 후보 이동, Enter로 고르기(후보가 없으면 검색), Esc로 창 닫기. 한글 조합 중(isComposing·keyCode 229)에는 처리하지 않는다.
// - 입력 전(빈 칸) 초점이면 최근 검색어(하나씩·전체 지우기), 입력하면 후보(최대 8개는 부르는 쪽이 자른다)와 맨 아래 '전체 결과 보기'.
// - 후보 수가 바뀌면 aria-live="polite"로 한 번 알린다. type="search"·enterkeyhint="search"·autocomplete="off"·spellcheck="false".
// - 상태 미리보기: open으로 창을 열어 두고 defaultActiveIndex로 고른 후보를 정한다.
import { useId, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { useControllable } from '../../lib/hooks';
import { Icon, type IconName } from '../../icons';
import { IconButton } from '../IconButton/IconButton';

export type SearchSuggestionKind = 'production' | 'artist' | 'venue';

export interface SearchSuggestion {
  id: string;
  label: string;
  kind?: SearchSuggestionKind;
  /** 굵게 보일 일치 부분 */
  match?: string;
  /** 아래 보조 글(다음 오픈 일시 등) */
  meta?: ReactNode;
  /** 작은 포스터 등(장식) */
  thumbnail?: ReactNode;
}

export interface SearchFieldProps {
  id: string;
  /** 칸 이름(aria-label) */
  label?: string;
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  suggestions?: readonly SearchSuggestion[];
  /** 입력 전 보일 최근 검색어 */
  recent?: readonly string[];
  onRemoveRecent?: (term: string) => void;
  onClearRecent?: () => void;
  onSelect?: (suggestion: SearchSuggestion | { id: 'recent'; label: string }) => void;
  /** 검색(Enter·'전체 결과 보기') */
  onSubmit?: (query: string) => void;
  /** 서버 이동 검색이면 form action */
  action?: string;
  loading?: boolean;
  /** 창을 열어 둔다(상태 미리보기) */
  open?: boolean;
  defaultActiveIndex?: number;
  size?: 'md' | 'sm';
  /** 창 위치·모양(보드: 휴대폰은 머리 바로 아래 꽉 찬 폭) */
  popupStyle?: CSSProperties;
  className?: string;
  style?: CSSProperties;
}

const kindIcon: Record<SearchSuggestionKind, IconName> = { production: 'ticket', artist: 'user', venue: 'building' };
const kindText: Record<SearchSuggestionKind, string> = { production: '공연', artist: '아티스트', venue: '공연장' };

function Highlight({ text, match }: { text: string; match?: string }) {
  const at = match ? text.indexOf(match) : -1;
  if (!match || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <strong>{match}</strong>
      {text.slice(at + match.length)}
    </>
  );
}

export function SearchField({
  id,
  label = '공연, 아티스트, 공연장 검색',
  placeholder = '공연, 아티스트, 공연장 검색',
  value,
  defaultValue = '',
  onValueChange,
  suggestions = [],
  recent = [],
  onRemoveRecent,
  onClearRecent,
  onSelect,
  onSubmit,
  action,
  loading = false,
  open: openProp,
  defaultActiveIndex = -1,
  size = 'sm',
  popupStyle,
  className,
  style,
}: SearchFieldProps) {
  const base = useId();
  const listId = `${base}-list`;
  const recentHeadId = `${base}-rh`;
  const [query, setQuery] = useControllable(value, defaultValue, onValueChange);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(defaultActiveIndex);

  const showRecent = query.trim() === '' && recent.length > 0;
  const showSuggest = query.trim() !== '' && (suggestions.length > 0 || loading);
  const open = openProp ?? (focused && !dismissed && (showRecent || showSuggest));
  // 고를 수 있는 항목: 최근 검색어, 또는 후보 + '전체 결과 보기'
  const optionCount = showRecent ? recent.length : suggestions.length + (query.trim() ? 1 : 0);
  const optId = (i: number) => `${base}-opt-${i}`;
  const activeId = open && active >= 0 && active < optionCount ? optId(active) : undefined;

  const submit = (q: string) => {
    setDismissed(true);
    setActive(-1);
    onSubmit?.(q);
  };
  const chooseIndex = (i: number) => {
    if (showRecent) {
      const term = recent[i];
      if (term === undefined) return;
      setQuery(term);
      onSelect?.({ id: 'recent', label: term });
      submit(term);
      return;
    }
    const s = suggestions[i];
    if (s) {
      setQuery(s.label);
      setDismissed(true);
      setActive(-1);
      onSelect?.(s);
    } else {
      submit(query);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setDismissed(false);
      if (optionCount === 0) return;
      setActive((i) => (event.key === 'ArrowDown' ? (i + 1) % optionCount : i <= 0 ? optionCount - 1 : i - 1));
    } else if (event.key === 'Enter' && open && active >= 0 && active < optionCount) {
      event.preventDefault();
      chooseIndex(active);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setDismissed(true);
      setActive(-1);
    }
  };

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (onSubmit) {
      event.preventDefault();
      submit(query);
    }
  };

  const popup: CSSProperties = {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 'calc(100% + 4px)',
    zIndex: 20,
    gap: 2,
    padding: 8,
    ...popupStyle,
  };

  return (
    <form role="search" action={action} onSubmit={onFormSubmit} className={className} style={{ position: 'relative', ...style }}>
      <div className={cx('input-group', size === 'sm' && 'input-group-sm', focused && open && 'is-focus')}>
        <Icon name="search" />
        <input
          id={id}
          name="q"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-busy={loading || undefined}
          aria-label={label}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setDismissed(false);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {query ? (
          <IconButton
            size="sm"
            label="검색어 지우기"
            icon="close"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setQuery('');
              setActive(-1);
            }}
          />
        ) : null}
      </div>

      {!open ? (
        // 닫힌 창: 보드처럼 빈 listbox만 숨겨 둔다(aria-controls가 가리킬 곳). .menu는 display:flex라 hidden 대신 그리지 않는다
        <ul id={listId} role="listbox" aria-label="자동완성" hidden />
      ) : (
      <div className="menu" style={popup} onMouseDown={(e) => e.preventDefault()}>
        {showRecent ? (
          <>
            <div className="row between" style={{ padding: '6px 10px 4px' }}>
              <span className="eyebrow" id={recentHeadId}>
                최근 검색어
              </span>
              <span className="t-xs muted">이 기기에만 저장됩니다</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', alignItems: 'start' }}>
              <ul id={listId} role="listbox" aria-labelledby={recentHeadId} className="col">
                {recent.map((term, i) => (
                  <li
                    key={term}
                    id={optId(i)}
                    role="option"
                    aria-selected={i === active}
                    className={cx('menu-item', i === active && 'is-active')}
                    style={{ minHeight: 44 }}
                    onClick={() => chooseIndex(i)}
                  >
                    <Icon name="history" size={16} className="muted" />
                    {term}
                  </li>
                ))}
              </ul>
              {onRemoveRecent ? (
                <ul className="col" aria-label="최근 검색어 하나씩 지우기">
                  {recent.map((term) => (
                    <li key={term}>
                      <IconButton label={`최근 검색어 ${term} 지우기`} icon="close" onClick={() => onRemoveRecent(term)} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {onClearRecent ? (
              <div className="row" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--border)', padding: '6px 6px 0', marginTop: 4 }}>
                <button className="btn btn-text btn-sm" type="button" style={{ minHeight: 44 }} onClick={onClearRecent}>
                  최근 검색어 전체 지우기
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <ul id={listId} role="listbox" aria-label="자동완성" className="col" style={{ gap: 2 }}>
            {suggestions.map((s, i) => {
              const kind = s.kind ?? 'production';
              return (
                <li
                  key={s.id}
                  id={optId(i)}
                  role="option"
                  aria-selected={i === active}
                  className={cx('menu-item', i === active && 'is-active')}
                  style={{ minHeight: s.meta ? 56 : 44, gap: 10 }}
                  onClick={() => chooseIndex(i)}
                >
                  <Icon name={kindIcon[kind]} size={16} className="muted" />
                  {s.thumbnail}
                  <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                    <span className="ellipsis">
                      <Highlight text={s.label} match={s.match} />
                    </span>
                    {s.meta ? <span className="t-xs muted num">{s.meta}</span> : null}
                  </span>
                  <span className="t-xs muted">{kindText[kind]}</span>
                </li>
              );
            })}
            {query.trim() ? (
              <li
                id={optId(suggestions.length)}
                role="option"
                aria-selected={active === suggestions.length}
                className={cx('menu-item', active === suggestions.length && 'is-active')}
                style={{ minHeight: 48, gap: 10, borderTop: '1px solid var(--border)', borderRadius: 0, marginTop: 4 }}
                onClick={() => submit(query)}
              >
                <Icon name="search" size={16} />
                <span className="grow fw-b">&apos;{query}&apos; 전체 결과 보기</span>
                <Icon name="chevron-right" size={16} />
              </li>
            ) : null}
          </ul>
        )}
      </div>
      )}
      <p className="sr-only" aria-live="polite">
        {open && !showRecent ? (loading ? '후보를 찾는 중입니다' : `검색어 후보 ${suggestions.length}개`) : ''}
      </p>
    </form>
  );
}
