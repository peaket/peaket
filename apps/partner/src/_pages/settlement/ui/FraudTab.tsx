// [부정 예매 조치] 탭(기획사 보고, d5 §6.10 그림과 상태 '부정 예매 집계'·'부정 예매 집계 전', FRN-070·FRN-090). 보드에 없는 탭이라 d5 그림이 시각 기준이다.
// 데이터는 `GET /v1/partner/events/{eventId}/fraud-report`(PromoterFraudReport, 관리자·실무자 모두)이고, 온세일 윈도우 전은 404 `fraud-report-not-ready`다.
// 회차 집계만 보인다: 타일 다섯 · 사유 범주별 표 · 소명 인정 비율. 사람 단위 행·좌석·계정·주문·점수는 없다(FR-074, POL-046 ⑧).
// 가린 칸(suppressed)은 '가림', 서버가 '그 밖'으로 합친 범주는 '그 밖에 합침'이다(forensic-replay.md §6.7.7. 줄을 늘 여섯으로 두는 것은 추천 적용 2026-10-31).
// 배치(추천 적용 2026-10-31): 타일은 휴대폰 2열 · 태블릿 3열 · 데스크톱 5열, 표와 비율은 데스크톱에서 7·5열로 나란히. 휴대폰에서도 같은 집계를 본다(§3.9가 빼지 않은 보기).
import {
  APPEAL_RATIO_HIDDEN,
  FRAUD_REPORT,
  FRAUD_REPORT_EMPTY,
  FRAUD_REPORT_FOOTNOTE,
  FRAUD_REPORT_INTRO,
  FRAUD_REPORT_NOT_READY,
  FRAUD_TILES,
  asOfText,
  countText,
  ratioText,
  reasonRows,
  type PromoterFraudReport,
} from '../model/fraud-report';
import { RoundSelect, StateCard } from './parts';

export type FraudVariant = '부정 예매 집계' | '부정 예매 집계 전' | '부정 예매 끝난 사건 없음';

export function FraudTab({ v, rounds }: { v: FraudVariant; rounds: readonly string[] }) {
  const round = rounds[0] ?? '';
  const report: PromoterFraudReport | null = v === '부정 예매 집계 전' ? null : v === '부정 예매 끝난 사건 없음' ? FRAUD_REPORT_EMPTY : FRAUD_REPORT;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <RoundSelect id="fr-round" rounds={rounds} />
        {report ? (
          <span className="badge badge-lg max-md:self-start">
            <i className="ic ic-clock" aria-hidden="true" />
            집계 {asOfText(report.asOf)}
          </span>
        ) : null}
      </div>

      <p className="t-sm muted md:max-w-[720px]">{FRAUD_REPORT_INTRO}</p>

      {report ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5" role="group" aria-label={`${round} 회차 부정 예매 조치 집계`}>
            {FRAUD_TILES.map((t) => (
              <div key={t.key} className="stat">
                <span className="stat-label">{t.label}</span>
                <span className="stat-value max-md:text-[20px] max-md:leading-[27px]">{countText(report[t.key], t.unit)}</span>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-12 lg:gap-x-6" style={{ alignItems: 'start' }}>
            <section className="col lg:col-span-7" style={{ gap: 10 }} aria-labelledby="fr-reason-h">
              <h3 className="t-md fw-b" id="fr-reason-h">
                사유 범주별 끝난 사건
              </h3>
              <div className="table-wrap">
                <table className="table dense">
                  <caption className="sr-only">{`${round} 회차 사유 범주별 끝난 사건 수. 5건 미만 칸은 그 밖으로 합치거나 가렸다`}</caption>
                  <thead>
                    <tr>
                      <th scope="col">사유 범주</th>
                      <th scope="col" className="r">
                        끝난 사건
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {reasonRows(report).map((r) => (
                      <tr key={r.category}>
                        <td>{r.label}</td>
                        <td className={r.text === '가림' || r.text === '그 밖에 합침' ? 'r muted' : 'r fw-b'}>{r.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card-flat pad col lg:col-span-5" style={{ gap: 6 }} aria-labelledby="fr-ratio-h">
              <h3 className="t-sm fw-b" id="fr-ratio-h">
                소명 인정 비율
              </h3>
              {report.appealAcceptedRatio === null ? (
                <p className="t-sm muted">{APPEAL_RATIO_HIDDEN}</p>
              ) : (
                <>
                  <span className="stat-value">{ratioText(report.appealAcceptedRatio)}</span>
                  <p className="t-xs muted">소명 판단을 받은 계정 가운데 소명이 인정된 비율입니다</p>
                </>
              )}
            </section>

            <p className="t-xs muted lg:col-span-12">{FRAUD_REPORT_FOOTNOTE}</p>
          </div>
        </>
      ) : (
        <StateCard icon="ic-clock" title={FRAUD_REPORT_NOT_READY} titleClass="t-lg" />
      )}
    </div>
  );
}
