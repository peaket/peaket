'use client';
// 1단계 '공연장 찾기'·'아티스트 찾기' 콤보박스(목업 목록에서 거른다). 라벨은 부르는 쪽이 <label htmlFor={inputId}>로 단다.
// 방향키로 후보를 옮기고 Enter로 고르며 Esc로 닫는다(aria-activedescendant).
import { useId, useState, type KeyboardEvent } from 'react';

export interface SearchComboProps {
  inputId: string;
  options: readonly string[];
  defaultValue?: string;
  placeholder: string;
  describedBy?: string;
  /** 후보 목록 이름 */
  listLabel: string;
  disabled?: boolean;
  className?: string;
}

export function SearchCombo({ inputId, options, defaultValue = '', placeholder, describedBy, listLabel, disabled, className }: SearchComboProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const q = value.trim().toLowerCase();
  const matches = options.filter((o) => q === '' || o.toLowerCase().includes(q) || o === defaultValue);

  function pick(o: string) {
    setValue(o);
    setOpen(false);
    setActive(-1);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(matches.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && open && active >= 0 && matches[active]) {
      e.preventDefault();
      pick(matches[active]!);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className={`relative ${className ?? ''}`}>
      <div className="input-group">
        <i className="ic ic-search" aria-hidden="true" />
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={describedBy}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(false)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
        />
        <button
          className="icon-btn icon-btn-sm"
          type="button"
          tabIndex={-1}
          aria-label={`${listLabel} 펼치기`}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
        >
          <i className="ic ic-chevron-down" aria-hidden="true" />
        </button>
      </div>
      {open && matches.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={listLabel}
          className="menu"
          style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 20 }}
        >
          {matches.map((o, i) => (
            <li
              key={o}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o === value}
              className={i === active ? 'menu-item is-active' : 'menu-item'}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
