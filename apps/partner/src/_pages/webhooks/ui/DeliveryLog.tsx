'use client';
// ③ 보낸 이벤트와 재시도(d5 §6.8): 상태 거르기 칩 + 표(태블릿·데스크톱) / 카드 목록(휴대폰, 다시 보내기 없음).
// 재시도 중 행은 버튼 대신 '자동으로 다시 보냅니다'(409). 막힌 [다시 보내기]는 aria-disabled + 이유 글(실무자 배너 또는 꺼짐 이유 줄)을 가리킨다.
import { useState } from 'react';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { DELIVERY_STATUS, type Delivery, type LogCounts, type LogFilter } from '../model/webhooks';

export interface DeliveryLogProps {
  rows: readonly Delivery[];
  counts: LogCounts;
  initial: LogFilter;
  /** 계속 실패해 꺼짐: 이유 줄을 표 위에 한 번 두고 다시 보내기를 막는다 */
  off: boolean;
  /** 실무자 보기: 머리 배너 id(다시 보내기를 막고 그 배너를 가리킨다) */
  memberReasonId?: string;
}

const FILTERS: readonly { key: LogFilter; label: string; noun: string }[] = [
  { key: 'all', label: '전체', noun: '보낸 이벤트' },
  { key: 'retrying', label: '재시도 중', noun: '재시도 중인 이벤트' },
  { key: 'dlq', label: 'DLQ', noun: 'DLQ로 옮긴 이벤트' },
  { key: 'success', label: '성공', noun: '성공한 이벤트' },
];

const OFF_REASON_ID = 'wh-off-why';

function Response({ r }: { r: Delivery }) {
  return (
    <>
      {r.code ? <span className="mono">{r.code}</span> : r.responseText} · {r.at}
    </>
  );
}

function NextRetry({ r, cell }: { r: Delivery; cell?: boolean }) {
  if (r.next) return cell ? <td className="nowrap">{r.next}</td> : <dd>{r.next}</dd>;
  const text = r.status === 'dlq' ? '— 재시도 끝' : '—';
  return cell ? <td className="muted nowrap">{text}</td> : <dd className="muted">{text}</dd>;
}

export function DeliveryLog({ rows, counts, initial, off, memberReasonId }: DeliveryLogProps) {
  const [filter, setFilter] = useState<LogFilter>(initial);
  const shown = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
  const noun = FILTERS.find((f) => f.key === filter)?.noun ?? '보낸 이벤트';
  // 꺼진 주소의 기록은 53건 가운데 최근 5건만 싣는다
  const what = off && filter !== 'retrying' && filter !== 'success' ? `DLQ로 옮긴 이벤트 ${counts.dlq}건 가운데 최근 ${shown.length}건` : `${noun} ${shown.length}건`;
  const reasonId = off ? OFF_REASON_ID : memberReasonId;
  const blocked = reasonId !== undefined;

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8 }} role="group" aria-label="상태로 거르기">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? 'chip chip-sm is-selected' : 'chip chip-sm'}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label} {counts[f.key]}
          </button>
        ))}
      </div>
      {off && (
        <p className="row t-sm" id={OFF_REASON_ID} style={{ gap: 6, alignItems: 'flex-start' }}>
          <i className="ic ic-lock ic-16 muted" aria-hidden="true" style={{ marginTop: 2 }} />
          <span>보내기를 멈춘 동안에는 다시 보낼 수 없습니다. 다시 켠 뒤에 보내세요</span>
        </p>
      )}
      <BigScreenNotice title="다시 보내기는 태블릿이나 데스크톱에서 합니다" copyLabel="다시 보내기 링크 복사" />

      {shown.length === 0 ? (
        <p className="t-sm muted" role="status">
          고른 상태의 이벤트가 없습니다
        </p>
      ) : (
        <>
          <div className="table-wrap table-scroll max-md:hidden" role="region" aria-label="보낸 이벤트 표" tabIndex={0}>
            <table className="table dense max-lg:min-w-[900px]">
              <caption className="sr-only">{what}의 시도 수, 마지막 응답, 다음 재시도, 상태. 마지막 시도가 늦은 순</caption>
              <thead>
                <tr>
                  <th scope="col">이벤트</th>
                  <th scope="col">webhook-id</th>
                  <th scope="col" className="r">
                    시도 수
                  </th>
                  <th scope="col">마지막 응답</th>
                  <th scope="col">다음 재시도</th>
                  <th scope="col">상태</th>
                  <th scope="col">
                    <span className="sr-only">다시 보내기</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td className="fw-b">
                      {r.label} <span className="t-xs muted mono fw-r">· {r.type}</span>
                    </td>
                    <td className="mono">{r.id}</td>
                    <td className="r">{r.attempts}</td>
                    <td className="nowrap">
                      <Response r={r} />
                    </td>
                    <NextRetry r={r} cell />
                    <td>
                      <span className={DELIVERY_STATUS[r.status].cls}>{DELIVERY_STATUS[r.status].label}</span>
                    </td>
                    {r.status === 'retrying' ? (
                      <td className="muted">자동으로 다시 보냅니다</td>
                    ) : (
                      <td>
                        <button
                          className="btn btn-outline btn-sm"
                          type="button"
                          aria-label={`${r.label} ${r.id} 다시 보내기`}
                          aria-disabled={blocked ? 'true' : undefined}
                          aria-describedby={reasonId}
                        >
                          <i className="ic ic-refresh" aria-hidden="true" />
                          다시 보내기
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="col md:hidden" style={{ gap: 12 }} aria-label={`${what}, 마지막 시도가 늦은 순`}>
            {shown.map((r, i) => (
              <li key={r.id}>
                <article className="card col" style={{ padding: '14px 16px', gap: 8 }} aria-labelledby={`ev-${i}`}>
                  <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <h3 className="t-md fw-b" id={`ev-${i}`}>
                      {r.label} <span className="t-xs muted mono fw-r">· {r.type}</span>
                    </h3>
                    <span className={DELIVERY_STATUS[r.status].cls}>{DELIVERY_STATUS[r.status].label}</span>
                  </div>
                  <p className="t-sm muted">
                    webhook-id <span className="mono">{r.id}</span>
                  </p>
                  <dl className="kv">
                    <dt>시도 수</dt>
                    <dd>{r.attempts}</dd>
                    <dt>마지막 응답</dt>
                    <dd>
                      <Response r={r} />
                    </dd>
                    <dt>다음 재시도</dt>
                    <NextRetry r={r} />
                  </dl>
                  {r.status === 'retrying' && <p className="t-xs muted">자동으로 다시 보냅니다</p>}
                </article>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
