// 5단계 판매자 정보·승인 요청(보드 s5). 판매자 정보 7항목(전자상거래법 §20②) · 판매자 고지 미리보기(CMP-058 detail) · 정산 계좌(CMP-062 payout,
// 저장하지 않고 결제사 등록에 넘김) · 수수료와 지급 · 휠체어석 확인(FR-023). 422 오류(예금주 불일치·휠체어석 확인 누락)는 d5 §6.4 상태 표 문구로 칸 아래에 둔다.
import Link from 'next/link';
import { stellaOrg } from '@/entities/partner-org';
import { routes } from '@/shared/config/routes';
import { WHEELCHAIR_REASONS } from '../model/fixtures';

export interface StepSellerProps {
  eventId: string;
  holderMismatch: boolean;
  wheelchairMissing: boolean;
  /** 반려(통신판매업 신고번호 누락)를 고치는 화면 */
  rejected: boolean;
}

export function StepSeller({ eventId, holderMismatch, wheelchairMissing, rejected }: StepSellerProps) {
  const s = stellaOrg.seller;
  const errors = [
    rejected ? { href: '#n-mono', text: '통신판매업 신고번호: 반려 사유입니다. 신고번호를 넣거나 면제 대상을 고르세요' } : null,
    holderMismatch ? { href: '#n-holder', text: '예금주: 예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다' } : null,
    wheelchairMissing ? { href: '#n-wc-ok', text: '휠체어석 확인: 휠체어석 확인에 체크해 주세요' } : null,
  ].filter((e): e is { href: string; text: string } => e !== null);

  return (
    <div className="col" style={{ gap: 16 }}>
      {errors.length > 0 ? (
        <div className="error-summary" role="alert" aria-labelledby="n-err-t">
          <strong className="row" id="n-err-t" style={{ gap: 6 }}>
            <i className="ic ic-alert-circle tx-danger" aria-hidden="true" />
            {rejected ? `반려된 항목 ${errors.length}건을 고친 뒤 다시 요청합니다` : `판매 승인 요청을 보내지 못했습니다 · 고칠 항목 ${errors.length}건`}
          </strong>
          {errors.map((e) => (
            <a key={e.href} href={e.href}>
              {e.text}
            </a>
          ))}
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-12">
        <section className="card pad-lg col lg:col-span-7" style={{ gap: 16 }} aria-labelledby="h-seller">
          <div className="section-title">
            <h2 id="h-seller">판매자 정보 7항목 확인</h2>
            <Link className="link-more" href={routes.settingsSeller()}>
              판매자 정보 설정
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          </div>
          <p className="t-sm muted" id="n-seller-h">
            설정의 판매자 정보를 가져왔습니다. 상호·대표자를 바꾸려면 판매자 정보에서 변경을 요청하고 판매 재승인을 먼저 받습니다(POL-039).
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-[14px]">
            <div className="field">
              <label className="label" htmlFor="n-co">
                상호
              </label>
              <input className="input input-sm" id="n-co" type="text" defaultValue={s.companyName} disabled aria-describedby="n-seller-h" />
            </div>
            <div className="field">
              <label className="label" htmlFor="n-rep">
                대표자
              </label>
              <input className="input input-sm" id="n-rep" type="text" defaultValue={s.representative} disabled aria-describedby="n-seller-h" />
            </div>
            <div className="field col-span-2">
              <label className="label" htmlFor="n-addr">
                주소 <span className="opt">(필수)</span>
              </label>
              <input className="input input-sm" id="n-addr" type="text" defaultValue={s.address} />
            </div>
            <div className="field">
              <label className="label" htmlFor="n-tel">
                전화 <span className="opt">(필수)</span>
              </label>
              <input className="input input-sm" id="n-tel" type="tel" autoComplete="tel" defaultValue={s.phone} />
            </div>
            <div className="field">
              <label className="label" htmlFor="n-mail">
                전자우편 <span className="opt">(필수)</span>
              </label>
              <input className="input input-sm" id="n-mail" type="email" autoComplete="email" defaultValue={s.email} />
            </div>
            <div className="field">
              <label className="label" htmlFor="n-brn">
                사업자등록번호 <span className="opt">(필수)</span>
              </label>
              <input className="input input-sm" id="n-brn" type="text" inputMode="numeric" defaultValue={s.businessNo} />
            </div>
            <div className="field" role="radiogroup" aria-labelledby="n-mo-l">
              <span className="label" id="n-mo-l">
                통신판매업 신고 <span className="opt">(필수)</span>
              </span>
              <div className="row" style={{ gap: 16, minHeight: 40 }}>
                <label className="check-row" style={{ fontSize: 14, alignItems: 'center' }}>
                  <input className="rd" type="radio" name="n-mo" defaultChecked />
                  신고번호 있음
                </label>
                <label className="check-row" style={{ fontSize: 14, alignItems: 'center' }}>
                  <input className="rd" type="radio" name="n-mo" />
                  면제 대상
                </label>
              </div>
            </div>
            <div className="field col-span-2">
              <label className="label" htmlFor="n-mono">
                통신판매업 신고번호 <span className="opt">(필수)</span>
              </label>
              {rejected ? (
                <>
                  <input className="input input-sm is-error" id="n-mono" type="text" defaultValue="" aria-invalid="true" aria-describedby="n-mono-e" />
                  <span className="error-msg" id="n-mono-e">
                    <i className="ic ic-alert-circle" aria-hidden="true" />
                    반려 사유: 통신판매업 신고번호 누락 · 신고번호를 넣거나 면제 대상을 고르세요
                  </span>
                </>
              ) : (
                <input className="input input-sm" id="n-mono" type="text" defaultValue={s.mailOrderNo} />
              )}
            </div>
          </div>
          <div className="col" style={{ gap: 8 }}>
            <span className="eyebrow">공연 상세에 보이는 판매자 고지 미리보기</span>
            <section className="card-flat pad col" style={{ gap: 12 }} aria-label="판매자 고지 미리보기">
              <div className="banner banner-legal">
                <i className="ic ic-scale" aria-hidden="true" />
                <div className="banner-body">
                  <span className="legal-tag">법정 고지</span>판매자: {s.companyName}. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은
                  판매자에게 있고, 예매 취소와 환불은 PEAKET이 처리합니다
                </div>
              </div>
              <dl className="kv">
                <dt>상호</dt>
                <dd>{s.companyName}</dd>
                <dt>대표자</dt>
                <dd>{s.representative}</dd>
                <dt>주소</dt>
                <dd>{s.address}</dd>
                <dt>전화</dt>
                <dd>{s.phone}</dd>
                <dt>전자우편</dt>
                <dd>{s.email}</dd>
                <dt>사업자등록번호</dt>
                <dd>{s.businessNo}</dd>
                <dt>통신판매업 신고번호</dt>
                <dd>
                  {rejected ? (
                    <span className="row tx-danger" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <i className="ic ic-alert-circle ic-16" aria-hidden="true" />
                      입력 안 됨
                    </span>
                  ) : (
                    s.mailOrderNo
                  )}
                </dd>
              </dl>
            </section>
          </div>
        </section>

        <div className="col gap-5 lg:col-span-5">
          <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="h-payout">
            <div className="section-title">
              <h2 id="h-payout">정산 계좌</h2>
            </div>
            <p className="t-sm muted">입력한 계좌는 PEAKET에 저장하지 않고 결제사 지급대행 등록에 바로 넘깁니다. 등록 뒤에는 은행과 끝 4자리만 보입니다.</p>
            <div className="field">
              <label className="label" htmlFor="n-bank">
                은행 <span className="opt">(필수)</span>
              </label>
              <div className="input-group input-group-sm">
                <select id="n-bank" defaultValue={stellaOrg.payout.bank}>
                  <option>{stellaOrg.payout.bank}</option>
                </select>
                <i className="ic ic-chevron-down" aria-hidden="true" />
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="n-acc">
                계좌번호 <span className="opt">(필수)</span>
              </label>
              <input className="input input-sm" id="n-acc" type="text" inputMode="numeric" autoComplete="off" placeholder="숫자만 입력합니다" defaultValue="" />
            </div>
            <div className="field">
              <label className="label" htmlFor="n-holder">
                예금주 <span className="opt">(필수)</span>
              </label>
              <input
                className={holderMismatch ? 'input input-sm is-error' : 'input input-sm'}
                id="n-holder"
                type="text"
                autoComplete="off"
                defaultValue={holderMismatch ? '[다른 예금주]' : stellaOrg.payout.holder}
                aria-invalid={holderMismatch ? true : undefined}
                aria-describedby={holderMismatch ? 'n-holder-e' : 'n-holder-h'}
              />
              {holderMismatch ? (
                <span className="error-msg" id="n-holder-e">
                  <i className="ic ic-alert-circle" aria-hidden="true" />
                  예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다
                </span>
              ) : (
                <span className="hint" id="n-holder-h">
                  예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다
                </span>
              )}
            </div>
          </section>

          <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="h-fee">
            <div className="section-title">
              <h2 id="h-fee">수수료와 지급</h2>
            </div>
            <dl className="kv">
              <dt>중개수수료율</dt>
              <dd>{stellaOrg.commissionRate}</dd>
              <dt>토스페이먼츠 셀러</dt>
              <dd>
                <span className="badge badge-warning">{stellaOrg.tossSellerStatus}</span>
              </dd>
            </dl>
            <p className="hint">중개수수료율은 판매 승인 때 이 공연에 고정됩니다. 토스페이먼츠 셀러가 지급 가능 상태가 되어야 판매 승인이 끝납니다.</p>
            <p className="t-sm">주 1천만 원 이상 첫 지급에서 결제사 KYC 때문에 지급이 늦어질 수 있습니다</p>
            <div className="banner banner-info">
              <i className="ic ic-info" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">판매 승인 때 PEAKET 운영자가 확인하는 것</span>
                판매자 신원정보와 사업자 진위 · 표시 사항(휠체어석 확인 포함)과 공연예술통합전산망 항목 · 판매 정책 상한(공제율·양도) · 결제사 지정 · 결제사 지급대행 등록. 판매 조건은
                파트너가 정하고, 운영자는 확인한 뒤 승인하거나 사유를 적어 반려합니다.
              </div>
            </div>
          </section>

          <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="h-wc">
            <div className="section-title">
              <h2 id="h-wc">휠체어석 확인</h2>
              <Link className="link-more" href={routes.eventTab(eventId, 'seatmap')}>
                좌석맵 보기
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
            </div>
            <p className="t-sm num">휠체어석 20석 · 기준 20석 이상 · 위치 확인 0석</p>
            <label className="check-row" htmlFor="n-wc-ok">
              <input
                className="cb"
                id="n-wc-ok"
                type="checkbox"
                aria-invalid={wheelchairMissing ? true : undefined}
                aria-describedby={wheelchairMissing ? 'n-wc-e n-wc-h' : 'n-wc-h'}
              />
              휠체어석의 수와 위치를 공연장 좌석 배치도와 대조했습니다 (필수)
            </label>
            {wheelchairMissing ? (
              <span className="error-msg" id="n-wc-e">
                <i className="ic ic-alert-circle" aria-hidden="true" />
                휠체어석 확인에 체크해 주세요
              </span>
            ) : null}
            <div className="field">
              <label className="label" htmlFor="n-wc-why">
                기준보다 적은 이유 <span className="opt">(기준보다 적을 때 필수)</span>
              </label>
              <div className="input-group input-group-sm is-disabled">
                <select id="n-wc-why" disabled defaultValue="">
                  <option value="">이유를 고르세요</option>
                  {WHEELCHAIR_REASONS.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
                <i className="ic ic-chevron-down" aria-hidden="true" />
              </div>
            </div>
            <p className="hint" id="n-wc-h">
              판매 승인에서 운영자가 이 확인과 이유를 봅니다.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
