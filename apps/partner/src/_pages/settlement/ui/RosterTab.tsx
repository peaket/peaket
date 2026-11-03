// [예매자 명단] · [다운로드 이력] 탭(보드 상태 예매자 명단·다운로드 대화상자·사유 없음 오류·내려받는 중·명단 실무자 보기·보유 기간 끝·
// 다운로드 이력·다운로드 이력 없음·다운로드 이력 실무자 보기, d5 §6.10). 보기와 내려받기 모두 파트너 관리자만 한다.
// 휴대폰은 명단·이력 보기가 범위 밖이라(d5 §3.9) 안내 카드만 보이고 대화상자도 열지 않는다(보드 SCR-027-m).
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { Modal } from '@/shared/ui/Modal';
import { TIER_FILTER, exportLog, rosterRows, rosterTotals } from '../model/settlement';
import { MinMd } from './client';
import { RoundSelect, StateCard } from './parts';

export type RosterVariant = '예매자 명단' | '다운로드 대화상자' | '사유 없음 오류' | '내려받는 중' | '보유 기간 끝' | '실무자';
export type LogVariant = '다운로드 이력' | '다운로드 이력 없음' | '실무자';

const BIG_BODY_ROSTER = '다운로드 이력도 같습니다. 링크를 복사해 큰 화면에서 엽니다.';
const BIG_BODY_LOG = '예매자 명단도 같습니다. 링크를 복사해 큰 화면에서 엽니다.';

function FilterSelect({ id, label, options, className }: { id: string; label: string; options: readonly string[]; className: string }) {
  return (
    <div className={`field ${className}`}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="input-group input-group-sm">
        <select id={id} defaultValue={options[0]}>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
      </div>
    </div>
  );
}

/** 명단 내려받기 대화상자(사유 필수 · 형식 · 재인증과 패스키 확인 안내) */
function DownloadDialog({ open, error, round }: { open: boolean; error: boolean; round: string }) {
  return (
    <Modal id="roster-dl" defaultOpen={open} labelledBy="dl-t" describedBy="dl-d" maxWidth={480} sheetOnMobile={false}>
      <h2 className="dialog-title" id="dl-t">
        예매자 명단 내려받기
      </h2>
      <p className="t-sm muted" id="dl-d">
        {round} 회차 · {rosterTotals.bookings}건 · 동의 범위 항목만 담습니다. 다운로드 사유는 접속기록에 남습니다.
      </p>
      <fieldset className="col" role="radiogroup" aria-labelledby="dl-fmt-l">
        <legend className="label" id="dl-fmt-l" style={{ marginBottom: 10 }}>
          파일 형식 (필수)
        </legend>
        <div className="row" style={{ gap: 24 }}>
          {(['CSV', 'XLSX', 'PDF'] as const).map((f) => (
            <label key={f} className="check-row" htmlFor={`fmt-${f}`}>
              <input className="rd" id={`fmt-${f}`} type="radio" name="dl-fmt" defaultChecked={f === 'XLSX'} />
              {f}
            </label>
          ))}
        </div>
      </fieldset>
      {error ? (
        <div className="field">
          <label className="label" htmlFor="dl-reason">
            다운로드 사유 (필수)
          </label>
          <textarea
            className="input textarea is-error"
            id="dl-reason"
            aria-invalid="true"
            aria-describedby="dl-err dl-hint"
            required
            style={{ minHeight: 96 }}
          />
          <span className="error-msg" id="dl-err" role="alert">
            <i className="ic ic-alert-circle" aria-hidden="true" />
            다운로드 사유가 비어 있어 내려받지 않았습니다. 내려받는 이유를 적어 주세요.
          </span>
          <span className="hint" id="dl-hint">
            사유와 내려받은 건수는 접속기록에 남고 다운로드 이력에서 볼 수 있습니다.
          </span>
        </div>
      ) : (
        <div className="field">
          <label className="label" htmlFor="dl-reason">
            다운로드 사유 (필수)
          </label>
          <textarea
            className="input textarea"
            id="dl-reason"
            aria-describedby="dl-hint"
            required
            style={{ minHeight: 96 }}
            defaultValue="현장 명단 대조(동문 입장 확인용)"
          />
          <span className="hint" id="dl-hint">
            사유와 내려받은 건수는 접속기록에 남고 다운로드 이력에서 볼 수 있습니다.
          </span>
        </div>
      )}
      <p className="row t-sm" style={{ gap: 8, alignItems: 'center' }}>
        <i className="ic ic-key ic-16" aria-hidden="true" />
        내려받기 전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다
      </p>
      <div className="dialog-actions">
        <button className="btn btn-ghost" type="button" data-modal-close="">
          닫기
        </button>
        <button className="btn btn-primary" type="button">
          <i className="ic ic-download" aria-hidden="true" />
          명단 내려받기
        </button>
      </div>
    </Modal>
  );
}

export function RosterTab({ v, rounds }: { v: RosterVariant; rounds: readonly string[] }) {
  const round = rounds[0] ?? '';
  if (v === '실무자')
    return (
      <div className="col" style={{ gap: 16 }}>
        <StateCard icon="ic-lock" title="예매자 명단은 파트너 관리자만 볼 수 있습니다">
          <p className="t-sm muted">명단 내려받기는 파트너 관리자만 할 수 있습니다</p>
        </StateCard>
      </div>
    );
  if (v === '보유 기간 끝')
    return (
      <div className="col" style={{ gap: 16 }}>
        <RoundSelect id="rt-round" rounds={rounds} />
        <StateCard icon="ic-lock" title="회차가 끝나고 1개월이 지나 명단을 볼 수 없습니다(예매 때 받은 제3자 제공 동의의 보유 기간)" />
      </div>
    );

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="banner banner-info" role="note">
        <i className="ic ic-shield" aria-hidden="true" />
        <div className="banner-body">
          예매 때 받은 제3자 제공 동의 범위의 항목만 보입니다(예매자 이름·휴대폰 번호·예매번호·회차·좌석·매수). 회차가 끝나고 1개월까지 볼 수 있습니다.
        </div>
      </div>
      <BigScreenNotice title="예매자 명단 보기와 내려받기는 태블릿이나 데스크톱에서 합니다" body={BIG_BODY_ROSTER} copyLabel="예매자 명단 링크 복사" />

      <div className="col max-md:hidden" style={{ gap: 16 }}>
        {/* 태블릿: 찾기 3칸 → 건수·안내 | 내려받기 / 데스크톱: 찾기 | 내려받기 → 건수 · 안내 */}
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <form
            className="grid grid-cols-3 gap-3 md:max-lg:order-1 md:max-lg:col-span-2 lg:flex lg:items-end"
            role="search"
            aria-label="예매자 찾기"
            action="#"
          >
            <div className="field lg:w-[220px]">
              <label className="label" htmlFor="rs-no">
                예매번호
              </label>
              <div className="input-group input-group-sm">
                <i className="ic ic-search ic-16" aria-hidden="true" />
                <input id="rs-no" type="search" inputMode="numeric" placeholder="예매번호" />
              </div>
            </div>
            <FilterSelect id="rs-round" label="회차" options={rounds} className="lg:w-[220px]" />
            <FilterSelect id="rs-tier" label="등급" options={TIER_FILTER} className="lg:w-[160px]" />
          </form>
          <div className="col md:max-lg:order-3" style={{ gap: 4, alignItems: 'flex-end' }}>
            <button className="btn btn-outline" type="button" aria-haspopup="dialog" aria-describedby="rs-dl-h" data-modal-open="roster-dl">
              <i className="ic ic-download" aria-hidden="true" />
              명단 내려받기
            </button>
            <span className="t-xs muted" id="rs-dl-h">
              파트너 관리자 · 사유를 적고 다시 인증한 뒤 내려받습니다
            </span>
          </div>
          <div className="flex flex-col gap-0.5 md:max-lg:order-2 lg:col-span-2 lg:flex-row lg:flex-wrap lg:justify-between lg:gap-2">
            <span className="t-sm muted num">
              예매 {rosterTotals.bookings}건 · {rosterTotals.tickets}매({rosterTotals.asOf} 기준)
            </span>
            <span className="t-xs muted">다운로드 사유는 접속기록에 남습니다</span>
          </div>
        </div>

        {v === '내려받는 중' && (
          <div className="card-flat pad col" style={{ gap: 8 }} role="status">
            <div className="row between wrap" style={{ gap: 8 }}>
              <span className="t-sm fw-b">명단 파일을 만드는 중입니다 · XLSX</span>
              <span className="t-sm muted num">536 / {rosterTotals.bookings}건 · 52%</span>
            </div>
            <div
              className="progress"
              role="progressbar"
              aria-label="명단 파일 만들기 진행률"
              aria-valuenow={52}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={`${rosterTotals.bookings}건 중 536건, 52%`}
            >
              <span style={{ width: '52%' }} />
            </div>
            <span className="t-xs muted">사유와 건수는 다운로드 이력에 남습니다.</span>
          </div>
        )}

        <div className="table-wrap table-scroll" role="region" aria-label="예매자 명단 표" tabIndex={0}>
          <table className="table dense md:max-lg:min-w-[720px]">
            <caption className="sr-only">{round} 회차 예매자 명단, 동의 범위 항목만 가려서 표시</caption>
            <thead>
              <tr>
                <th scope="col">예매자</th>
                <th scope="col">휴대폰</th>
                <th scope="col">예매번호</th>
                <th scope="col">회차(KST)</th>
                <th scope="col">좌석</th>
                <th scope="col" className="r">
                  매수
                </th>
              </tr>
            </thead>
            <tbody>
              {rosterRows.map((r) => (
                <tr key={r.bookingNo}>
                  <td>{r.name}</td>
                  <td className="mono">{r.phone}</td>
                  <td className="mono">{r.bookingNo}</td>
                  <td className="num">{r.round}</td>
                  <td>{r.seat}</td>
                  <td className="r">{r.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row between">
          <span className="t-xs muted">25건씩 보기</span>
          <nav className="row" style={{ gap: 6 }} aria-label="명단 쪽 넘기기">
            <button className="btn btn-outline btn-sm" type="button" disabled>
              <i className="ic ic-chevron-left" aria-hidden="true" />
              이전
            </button>
            <button className="btn btn-outline btn-sm" type="button">
              다음
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </button>
          </nav>
        </div>
      </div>

      <MinMd>
        <DownloadDialog open={v === '다운로드 대화상자' || v === '사유 없음 오류'} error={v === '사유 없음 오류'} round={round} />
      </MinMd>
    </div>
  );
}

export function LogTab({ v, productionName }: { v: LogVariant; productionName: string }) {
  if (v === '실무자')
    return (
      <div className="col" style={{ gap: 16 }}>
        <StateCard icon="ic-lock" title="다운로드 이력은 파트너 관리자만 볼 수 있습니다" />
      </div>
    );
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="banner banner-info" role="note">
        <i className="ic ic-history" aria-hidden="true" />
        <div className="banner-body">예매자 명단을 내려받은 기록입니다. 같은 기록이 PEAKET 접속기록에 2년 이상 남습니다.</div>
      </div>
      <BigScreenNotice title="다운로드 이력 보기는 태블릿이나 데스크톱에서 합니다" body={BIG_BODY_LOG} copyLabel="다운로드 이력 링크 복사" />

      <section className="col max-md:hidden" style={{ gap: 16 }} aria-labelledby="log-h">
        <div className="row between wrap" style={{ gap: 8 }}>
          <h3 className="t-md fw-b" id="log-h">
            내려받은 기록
          </h3>
          <span className="badge badge-outline">파트너 관리자만 봅니다</span>
        </div>
        {v === '다운로드 이력 없음' ? (
          <StateCard icon="ic-history" title="내려받은 기록이 없습니다" />
        ) : (
          <div className="table-wrap table-scroll" role="region" aria-label="다운로드 이력 표" tabIndex={0}>
            <table className="table dense md:max-lg:min-w-[760px]">
              <caption className="sr-only">{productionName} 예매자 명단 다운로드 이력: 일시, 내려받은 사람, 사유, 건수, 형식, 결과</caption>
              <thead>
                <tr>
                  <th scope="col">일시(KST)</th>
                  <th scope="col">내려받은 사람</th>
                  <th scope="col">사유</th>
                  <th scope="col" className="r">
                    건수
                  </th>
                  <th scope="col">형식</th>
                  <th scope="col">결과</th>
                </tr>
              </thead>
              <tbody>
                {exportLog.map((r) => (
                  <tr key={r.at}>
                    <td className="num">{r.at}</td>
                    <td>
                      <div className="col" style={{ gap: 2 }}>
                        <span className="fw-b">{r.who}</span>
                        <span className="t-xs muted">{r.role}</span>
                      </div>
                    </td>
                    <td>{r.reason}</td>
                    <td className={r.count ? 'r' : 'r muted'}>{r.count ?? '—'}</td>
                    <td>{r.format}</td>
                    <td>
                      {r.ok ? (
                        <span className="badge badge-success">
                          <i className="ic ic-check" aria-hidden="true" />
                          완료
                        </span>
                      ) : (
                        <span className="badge badge-danger">
                          <i className="ic ic-x-circle" aria-hidden="true" />
                          실패
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
