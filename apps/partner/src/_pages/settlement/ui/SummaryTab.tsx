// [판매 요약] 탭(보드 상태 판매 요약·판매 요약 확정 전, d5 §6.10). 회차가 끝난 다음 영업일(R3)에 확정한 숫자만 보인다.
// 배치: 데스크톱은 등급별 표 7 · 권고 5열 다음 그래프 / 태블릿은 표 · 그래프 · 안내 · 권고 / 휴대폰은 등급 목록 · 그래프 · 권고 · 안내(보드 m·t·d).
import Link from 'next/link';
import { routes } from '@/shared/config/routes';
import { tierSales } from '../model/settlement';
import { ChartToggle, DownloadMenu } from './client';
import { CumulativeChart, CumulativeTable, RoundSelect, StateCard } from './parts';

export function SummaryTab({ pending, rounds, eventId }: { pending: boolean; rounds: readonly string[]; eventId: string }) {
  const round = rounds[0] ?? '';
  if (pending)
    return (
      <div className="col" style={{ gap: 16 }}>
        <div className="row between wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
          <RoundSelect id="sm-round" rounds={rounds} className="grow md:grow-0 md:w-[240px] lg:w-[280px]" />
          <span className="badge badge-lg max-md:mb-2.5">확정 전</span>
        </div>
        <StateCard icon="ic-clock" title="확정 전입니다(예정 10/26(월) 10:00 KST)" status={false} titleClass="t-lg">
          <p className="t-sm muted md:max-w-[560px] lg:max-w-[600px]">
            판매 요약은 회차가 끝난 다음 영업일에 숫자를 확정한 뒤 올라옵니다. 판매량, 매진 시각, 등급별 판매·매출, 환불 집계와 PEAKET의 권고 문장(있을 때)을 보여
            드립니다.
          </p>
          <p className="t-xs muted md:max-w-[560px] lg:max-w-[600px]">
            판매 5건 [가정] 미만 칸은 옆 칸과 합쳐 보이고, 개인정보와 봇 정보, 다른 파트너와의 비교는 넣지 않습니다.
          </p>
          <Link className="link-more" href={routes.eventTab(eventId, 'live')}>
            판매 현황에서 잠정 숫자 보기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </StateCard>
      </div>
    );

  const stats = [
    { label: '순 판매', value: '2,288매', meta: '판매 2,400매 − 환불 112매' },
    { label: '판매 금액', value: '₩[합계]', meta: '등급별 매출의 합' },
    { label: '환불', value: '112매', meta: '취소·환불한 매수' },
    { label: '매진', value: '21:09 KST', meta: '10/14(수) · 오픈 20:00 KST 뒤 69분' },
  ];
  const tierCaption = `${round} 회차 등급별 판매·환불·순 판매 매수와 매출(확정 집계)`;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <RoundSelect id="sd-round" rounds={rounds} />
        <div className="flex flex-col gap-3 md:items-end md:gap-1.5 lg:flex-row lg:flex-wrap lg:items-center lg:gap-3">
          <span className="badge badge-lg badge-success max-md:self-start">
            <i className="ic ic-check-circle" aria-hidden="true" />
            확정 10/26(월) 10:00 KST
          </span>
          <DownloadMenu label="내려받기 · CSV·XLSX·PDF" menuLabel="판매 요약 파일 형식" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="group" aria-label={`${round} 회차 판매 요약, 확정 집계`}>
        {stats.map((s) => (
          <div key={s.label} className="stat">
            <span className="stat-label">{s.label}</span>
            <span className="stat-value max-md:text-[20px] max-md:leading-[27px]">{s.value}</span>
            <span className="stat-meta">{s.meta}</span>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-12 lg:gap-x-6" style={{ alignItems: 'start' }}>
        <section className="col max-lg:order-1 lg:col-span-7" style={{ gap: 10 }} aria-labelledby="tier-h">
          <div className="row between" style={{ gap: 8 }}>
            <h3 className="t-md fw-b" id="tier-h">
              등급별 판매
            </h3>
            <span className="t-xs muted">[예시 숫자]</span>
          </div>
          <div className="table-wrap max-md:hidden">
            <table className="table dense">
              <caption className="sr-only">{tierCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">등급</th>
                  <th scope="col" className="r">
                    판매
                  </th>
                  <th scope="col" className="r">
                    환불
                  </th>
                  <th scope="col" className="r">
                    순 판매
                  </th>
                  <th scope="col" className="r">
                    매출
                  </th>
                </tr>
              </thead>
              <tbody>
                {tierSales.map((t) => (
                  <tr key={t.grade}>
                    <td className="fw-b">{t.grade}</td>
                    <td className="r">{t.sold}</td>
                    <td className="r">{t.refunded}</td>
                    <td className="r fw-b">{t.net}</td>
                    <td className="r">₩[예시]</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="card col md:hidden" aria-label={tierCaption}>
            {tierSales.map((t, i) => (
              <li
                key={t.grade}
                className="row between"
                style={{ gap: 12, padding: '12px 16px', borderBottom: i < tierSales.length - 1 ? '1px solid var(--border)' : undefined }}
              >
                <span className="t-md fw-b">{t.grade}</span>
                <span className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
                  <span className="t-sm fw-b num">순 판매 {t.net}</span>
                  <span className="t-xs muted num">
                    판매 {t.sold} · 환불 {t.refunded} · 매출 ₩[예시]
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="t-xs muted">휠체어석 20석은 A석 안에 들어 있습니다</p>
        </section>

        <section className="card-flat pad col max-md:order-3 md:max-lg:order-4 lg:col-span-5" style={{ gap: 10 }} aria-labelledby="rec-h">
          <div className="row" style={{ gap: 8 }}>
            <i className="ic ic-info ic-16" aria-hidden="true" style={{ color: 'var(--link)' }} />
            <h3 className="t-sm fw-b" id="rec-h">
              PEAKET의 권고
            </h3>
            <span className="badge badge-success">확정</span>
          </div>
          <p className="t-sm">[권고 문장 자리 표시]</p>
        </section>

        <div className="max-lg:order-2 lg:col-span-12">
          <ChartToggle
            titleId="time-h"
            title="시간대별 판매"
            sub={
              <>
                확정 집계 · 오픈 <span className="max-md:hidden">10/14(수) </span>20:00 KST부터 누적 판매 매수 · [예시 숫자]
              </>
            }
            chart={<CumulativeChart />}
            table={<CumulativeTable />}
          />
        </div>

        <p className="t-xs muted max-md:order-4 md:max-lg:order-3 lg:col-span-12">
          판매 5건 미만인 칸은 합쳐 보입니다. 개인정보와 봇 정보, 다른 파트너와의 비교는 넣지 않습니다.
        </p>
      </div>
    </div>
  );
}
