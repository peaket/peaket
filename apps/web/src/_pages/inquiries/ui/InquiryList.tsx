'use client';
// 내 문의 목록(보드 SCR-056 '내 문의 내역'): 답변 상태 칩(aria-pressed) → 목록 → 페이지 번호.
// 휴대폰·태블릿은 줄 전체가 문의 상세로 가는 링크(태블릿은 날짜를 오른쪽 칸에), 데스크톱(lg)은 표(제목이 링크, d5 'lg는 표').
// 칩은 화면 안에서 거른다. 한 페이지 20개 [가정]이라 목업 4건은 한 페이지다.
import Link from 'next/link';
import { useState } from 'react';
import { InquiryStatusBadge, inquiryHref, inquiryTypeShort, type Inquiry, type InquiryStatus } from '@/entities/inquiry';

const FILTERS: readonly { key: string; label: string; match: readonly InquiryStatus[] }[] = [
  { key: 'all', label: '전체', match: ['접수됨', '처리 중', '답변 완료', '닫힘'] },
  { key: 'waiting', label: '답변 기다리는 중', match: ['접수됨', '처리 중'] },
  { key: 'answered', label: '답변 완료', match: ['답변 완료'] },
  { key: 'closed', label: '닫힘', match: ['닫힘'] },
];

function None({ label }: { label: string }) {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </>
  );
}

export function InquiryList({ items }: { items: readonly Inquiry[] }) {
  const [filter, setFilter] = useState('all');
  const match = FILTERS.find((f) => f.key === filter)?.match ?? FILTERS[0]!.match;
  const rows = items.filter((q) => match.includes(q.status));

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row wrap" role="group" aria-label="답변 상태로 거르기" style={{ gap: 8 }}>
        {FILTERS.map((f) => (
          <button key={f.key} className={f.key === filter ? 'chip is-selected' : 'chip'} type="button" aria-pressed={f.key === filter} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        // 칩으로 걸러 0건일 때의 글은 추천안(보드에 없음)
        <p className="t-sm muted" role="status" style={{ padding: '24px 0', borderTop: '1px solid var(--border)' }}>
          이 상태의 문의가 없습니다
        </p>
      ) : (
        <>
          <ul className="col lg:hidden" aria-label={`내 문의 ${rows.length}건`} style={{ borderTop: '1px solid var(--border)' }}>
            {rows.map((q) => (
              <li key={q.id}>
                <Link
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-(--border) py-3.5 md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-5 md:px-1 md:py-4"
                  href={inquiryHref(q.id)}
                  style={{ color: 'inherit' }}
                >
                  <span className="col min-w-0" style={{ gap: 6 }}>
                    <span className="row wrap" style={{ gap: 6 }}>
                      <InquiryStatusBadge status={q.status} />
                      {q.newAnswer ? <span className="badge badge-solid">새 답변</span> : null}
                      <span className="t-xs muted">{inquiryTypeShort(q.type)}</span>
                    </span>
                    <span className="t-md fw-b ellipsis">{q.title}</span>
                    <span className="t-sm muted md:hidden">
                      접수 <span className="num">{q.submittedDate}</span>
                      {q.answeredDate ? (
                        <>
                          {' '}
                          · 답변 <span className="num">{q.answeredDate}</span>
                        </>
                      ) : null}
                    </span>
                    {q.order ? <span className="t-sm muted ellipsis">{q.order.short}</span> : null}
                  </span>
                  <span className="col t-sm muted num hidden text-right md:flex" style={{ gap: 2 }}>
                    <span>접수 {q.submittedDate}</span>
                    {q.answeredDate ? <span>답변 {q.answeredDate}</span> : null}
                  </span>
                  <i className="ic ic-chevron-right" aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
                </Link>
              </li>
            ))}
          </ul>

          <div className="table-wrap hidden lg:block">
            <table className="table">
              <caption className="sr-only">내 문의 {rows.length}건. 최근에 접수한 순서입니다. 제목을 누르면 문의 상세로 갑니다</caption>
              <thead>
                <tr>
                  <th scope="col" style={{ width: 176 }}>
                    상태
                  </th>
                  <th scope="col" style={{ width: 180 }}>
                    유형
                  </th>
                  <th scope="col">제목</th>
                  <th scope="col" style={{ width: 200 }}>
                    관련 주문
                  </th>
                  <th scope="col" style={{ width: 96 }}>
                    접수
                  </th>
                  <th scope="col" style={{ width: 96 }}>
                    답변
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => (
                  <tr key={q.id}>
                    <td>
                      <span className="row wrap" style={{ gap: 6 }}>
                        <InquiryStatusBadge status={q.status} />
                        {q.newAnswer ? <span className="badge badge-solid">새 답변</span> : null}
                      </span>
                    </td>
                    <td>{inquiryTypeShort(q.type)}</td>
                    <td>
                      <Link className="row" href={inquiryHref(q.id)} style={{ gap: 4, color: 'inherit', fontWeight: 700 }}>
                        {q.title}
                        <i className="ic ic-chevron-right ic-16" aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
                      </Link>
                    </td>
                    <td className="muted">{q.order ? q.order.short : <None label="없음" />}</td>
                    <td className="num nowrap">{q.submittedDate}</td>
                    <td className={q.answeredDate ? 'num nowrap' : 'muted'}>{q.answeredDate ?? <None label="아직 없음" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <nav className="pager" aria-label="문의 목록 페이지" style={{ justifyContent: 'center', gap: 4 }}>
        <span className="pg" aria-disabled="true" style={{ display: 'inline-flex', gap: 2, padding: '0 8px', minHeight: 44, color: 'var(--text-disabled)', cursor: 'not-allowed' }}>
          <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
          이전
        </span>
        <a className="pg" href="#main" aria-current="page" style={{ minHeight: 44, minWidth: 36 }}>
          <span className="sr-only">페이지 </span>1
        </a>
        <span className="pg" aria-disabled="true" style={{ display: 'inline-flex', gap: 2, padding: '0 8px', minHeight: 44, color: 'var(--text-disabled)', cursor: 'not-allowed' }}>
          다음
          <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
        </span>
      </nav>
    </div>
  );
}
