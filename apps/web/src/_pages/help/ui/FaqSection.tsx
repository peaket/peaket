'use client';
// 고객센터 머리(h1 + FAQ 검색)와 자주 묻는 질문 접는 항목(키트 .acc, d3 SCR-056 접근성: button + aria-expanded).
// 검색은 화면 안에서 질문·답 글을 거른다(정적 FAQ라 서버에 묻지 않는다). 맞는 질문이 없을 때의 글은 추천안이다(보드에 없음).
// 데스크톱(lg)은 12열 격자: 질문 8열 + 오른쪽 aside 4열(문의하기·내 문의·약관). aside는 서버 페이지가 넘긴다.
import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { cx } from '@/shared/lib/cx';
import type { FaqItem } from '../model/faq';

const H1 = 't-xl md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]';

export function FaqSection({ items, aside }: { items: readonly FaqItem[]; aside: ReactNode }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(items.filter((i) => i.open).map((i) => i.id)));
  const searchId = useId();
  const q = query.trim();
  const shown = q
    ? items.filter((i) => [i.q, i.a ?? '', ...(i.defs ?? []).flatMap((d) => [d.term, d.desc])].some((t) => t.includes(q)))
    : items;
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <div className="col gap-3.5 md:gap-4">
        <h1 className={H1}>고객센터</h1>
        <form role="search" className="lg:max-w-[642px]" onSubmit={(e) => e.preventDefault()}>
          <div className="input-group">
            <i className="ic ic-search" aria-hidden="true" />
            <input
              id={searchId}
              type="search"
              aria-label="자주 묻는 질문 검색"
              placeholder="무엇을 도와드릴까요?"
              enterKeyHint="search"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </form>
      </div>

      <div className="col gap-7 md:gap-8 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:gap-y-6">
        <section className="col lg:col-span-8" aria-labelledby="h-faq">
          <div className="section-title" style={{ marginBottom: 8 }}>
            <h2 id="h-faq">자주 묻는 질문</h2>
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {q ? `맞는 질문 ${shown.length}개` : ''}
          </p>
          {shown.length === 0 ? (
            <p className="t-sm muted" style={{ padding: '16px 0' }}>
              맞는 질문이 없습니다. 문의하기로 물어봐 주세요
            </p>
          ) : (
            <div className="acc">
              {shown.map((it) => {
                const expanded = open.has(it.id);
                const panelId = it.id.replace('-q', '-a');
                return (
                  <div key={it.id}>
                    <h3>
                      <button className="acc-btn" type="button" id={it.id} aria-expanded={expanded} aria-controls={panelId} onClick={() => toggle(it.id)}>
                        {it.q}
                        <i className={cx('ic', expanded ? 'ic-chevron-up' : 'ic-chevron-down')} aria-hidden="true" />
                      </button>
                    </h3>
                    <div className={cx('acc-panel', it.defs || it.link ? 'col' : undefined)} id={panelId} role="region" aria-labelledby={it.id} hidden={!expanded} style={it.defs || it.link ? { gap: 12 } : undefined}>
                      {it.defs ? (
                        <dl className="col" style={{ gap: 12 }}>
                          {it.defs.map((d) => (
                            <div key={d.term} className="col" style={{ gap: 2 }}>
                              <dt className="fw-b">{d.term}</dt>
                              <dd>{d.desc}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                      {it.a ? <p>{it.a}</p> : null}
                      {it.link ? (
                        <Link className="link-more" href={it.link.href} style={{ alignSelf: 'flex-start' }}>
                          {it.link.label}
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        {aside}
      </div>
    </>
  );
}
