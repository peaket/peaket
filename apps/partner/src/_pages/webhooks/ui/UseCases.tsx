'use client';
// '이렇게 씁니다' 접는 상자(d5 §6.8, 키트 .acc-btn·.acc-panel). 처음에는 펼쳐 둔다(보드). 휴대폰은 한 줄씩, 태블릿·데스크톱은 2열.
import { useState } from 'react';
import { USE_CASES } from '../model/webhooks';

export function UseCases() {
  const [open, setOpen] = useState(true);
  return (
    <section className="card" aria-labelledby="h-use">
      <h2>
        <button
          className="acc-btn px-4 md:px-5"
          type="button"
          id="h-use"
          aria-expanded={open}
          aria-controls="use-panel"
          style={open ? undefined : { borderBottom: 0 }}
          onClick={() => setOpen((v) => !v)}
        >
          이렇게 씁니다
          <i className={open ? 'ic ic-chevron-up' : 'ic ic-chevron-down'} aria-hidden="true" />
        </button>
      </h2>
      <ul
        className="acc-panel flex flex-col gap-3.5 px-4 pt-3.5 pb-4 md:grid md:grid-cols-2 md:gap-x-5 md:px-5 md:pt-4 md:pb-5 lg:gap-x-6"
        id="use-panel"
        hidden={!open}
        style={{ borderBottom: 0 }}
      >
        {USE_CASES.map((u) => (
          <li key={u.title} className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <i className={`ic ${u.icon}`} aria-hidden="true" style={{ color: 'var(--link)' }} />
            <span className="col" style={{ gap: 2, minWidth: 0 }}>
              <span className="t-sm fw-m" style={{ color: 'var(--text)' }}>
                {u.title}
              </span>
              <span className="t-xs muted mono">{u.types}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
