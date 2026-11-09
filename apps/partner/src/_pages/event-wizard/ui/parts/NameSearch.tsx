'use client';
// 1단계 공연장·아티스트 찾기(실제 위저드, ADR-0242, ADR-0245). 글자를 치면 서버에 묻는다. 방향키로 후보를 옮기고 Enter로 고르며 Esc로 닫는다.
// 고르면 입력 칸을 비운다(고른 값은 부르는 쪽이 칸 위에 보인다). 늦게 온 응답은 버린다.
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { NameHit } from '../../model/wizard-api';

type SearchStatus = 'idle' | 'loading' | 'done' | 'error';

export interface NameSearchProps {
  inputId: string;
  placeholder: string;
  listLabel: string;
  /** 찾는 이름이 없을 때 안내 */
  emptyText: string;
  describedBy?: string;
  invalid?: boolean;
  autoFocus?: boolean;
  search: (q: string, signal: AbortSignal) => Promise<NameHit[]>;
  onPick: (hit: NameHit) => void;
  onError?: (e: unknown) => void;
}

const DEBOUNCE_MS = 250;
/** 찾기 경로의 q 상한(openapi) */
const QUERY_MAX = 50;

export function NameSearch({ inputId, placeholder, listLabel, emptyText, describedBy, invalid, autoFocus, search, onPick, onError }: NameSearchProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const statusId = `${uid}-status`;
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [hits, setHits] = useState<NameHit[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');

  const q = value.trim().slice(0, QUERY_MAX);

  useEffect(() => {
    // 검색어가 바뀌면 옛 후보를 바로 치운다(새 응답을 기다리는 동안 옛 후보를 고르지 않게)
    setHits([]);
    setActive(-1);
    if (q === '') {
      setStatus('idle');
      return;
    }
    const ac = new AbortController();
    setStatus('loading');
    const timer = setTimeout(() => {
      search(q, ac.signal).then(
        (found) => {
          if (ac.signal.aborted) return;
          setHits(found);
          setStatus('done');
        },
        (e: unknown) => {
          if (ac.signal.aborted) return;
          setHits([]);
          setStatus('error');
          onError?.(e);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [q, search, onError]);

  function pick(hit: NameHit) {
    onPick(hit);
    setValue('');
    setOpen(false);
    setActive(-1);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    // 한글 조합을 끝내는 Enter·방향키는 후보 고르기가 아니다
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(hits.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && open && active >= 0 && hits[active]) {
      e.preventDefault();
      pick(hits[active]!);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const statusText = status === 'loading' ? '찾는 중입니다' : status === 'error' ? '찾지 못했습니다. 잠시 뒤 다시 시도해 주세요' : status === 'done' ? (hits.length > 0 ? `${hits.length}개를 찾았습니다` : emptyText) : '';
  const expanded = open && hits.length > 0;

  return (
    <div className="relative grow">
      <div className={invalid ? 'input-group is-error' : 'input-group'}>
        <i className="ic ic-search" aria-hidden="true" />
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={[describedBy, statusId].filter(Boolean).join(' ')}
          aria-invalid={invalid || undefined}
          placeholder={placeholder}
          value={value}
          autoComplete="off"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- 사용자가 '바꾸기'를 누른 뒤에만 켠다. 누른 버튼이 사라져 초점을 옮겨야 한다
          autoFocus={autoFocus}
          maxLength={QUERY_MAX}
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
        />
      </div>
      {expanded ? (
        <ul id={listId} role="listbox" aria-label={listLabel} className="menu" style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 20 }}>
          {hits.map((h, i) => (
            <li
              key={h.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'menu-item is-active' : 'menu-item'}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(h);
              }}
            >
              <span className="col" style={{ gap: 2 }}>
                <span>{h.name}</span>
                {h.detail ? <span className="t-xs muted">{h.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="hint" id={statusId} role="status">
        {statusText}
      </span>
    </div>
  );
}
