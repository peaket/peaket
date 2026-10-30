// SCR-023 [배송·반품 처리] 탭(보드 상태 '배송·반품 처리'·'배송 명단 내려받기'·'반품 거절', POL-037·POL-016).
// 택배는 판매자가 보내고 송장을 등록한다. 주문서의 제3자 제공 동의 범위 항목만 가려서 보이고, 배송 완료 후 3개월까지 본다.
// 휴대폰은 주문 보기와 반품 도착 확인만 하고, 송장 등록·반품 거절·배송 명단 내려받기·현장 수령 처리는 안내 카드(d5 §3.9).
// 배송 명단 내려받기는 여러 건의 개인정보를 한 번에 받으므로 파트너 관리자만, 사유 필수(사유·건수는 접속기록).
import { AdminOnly } from '@/features/admin-only';
import { Modal } from '@/shared/ui/Modal';
import { CopyLinkButton } from './CopyLinkButton';
import { RETURN_ORDER_NO, SHIP_STATUS_BADGE, shipOrders, type ShipOrder } from '../model/products';

export interface ShippingSectionProps {
  isMember: boolean;
  /** 상태 '배송 명단 내려받기'면 대화상자를 연 채로(실무자는 열 수 없어 닫아 둔다) */
  openDownload: boolean;
  /** 상태 '반품 거절'이면 대화상자를 연 채로 */
  openReject: boolean;
}

function SelectField({ id, label, options, className }: { id: string; label: string; options: string[]; className?: string }) {
  return (
    <div className={`field ${className ?? ''}`}>
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

function StatusCell({ o }: { o: ShipOrder }) {
  if (o.escrow)
    return (
      <div className="row wrap" style={{ gap: 4 }}>
        <span className={SHIP_STATUS_BADGE[o.status]}>{o.status}</span>
        <span className="badge badge-outline">결제대금예치</span>
      </div>
    );
  if (o.statusNote)
    return (
      <div className="col" style={{ gap: 2, alignItems: 'flex-start' }}>
        <span className={SHIP_STATUS_BADGE[o.status]}>{o.status}</span>
        <span className="t-xs muted">{o.statusNote}</span>
      </div>
    );
  return <span className={SHIP_STATUS_BADGE[o.status]}>{o.status}</span>;
}

function Actions({ o }: { o: ShipOrder }) {
  if (o.status === '배송 준비')
    return (
      <button className="btn btn-outline btn-sm" type="button" aria-label={`${o.no} 송장 등록`}>
        송장 등록
      </button>
    );
  if (o.status === '반품 요청')
    return (
      <div className="row" style={{ gap: 6 }}>
        <button className="btn btn-primary btn-sm" type="button" aria-label={`${o.no} 반품 도착 확인`}>
          반품 도착 확인
        </button>
        <button className="btn btn-danger-outline btn-sm" type="button" aria-haspopup="dialog" data-modal-open="return-reject" aria-label={`${o.no} 반품 거절`}>
          거절
        </button>
      </div>
    );
  return null;
}

export function ShippingSection({ isMember, openDownload, openReject }: ShippingSectionProps) {
  const ret = shipOrders.find((o) => o.no === RETURN_ORDER_NO)!;
  // 휴대폰 카드: 반품 요청을 맨 위에(보드 SCR-023-m)
  const mobileOrders = [ret, ...shipOrders.filter((o) => o.mobile && o.no !== RETURN_ORDER_NO)];
  return (
    <section className="col" style={{ gap: 16 }} aria-labelledby="h-ship">
      <div className="section-title">
        <h2 id="h-ship">배송·반품 처리</h2>
        <span className="t-xs muted md:text-[14px]">10/14(수) 19:30 KST 기준</span>
      </div>
      <div className="banner banner-info" role="note">
        <i className="ic ic-shield" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">주문서에서 받은 제3자 제공 동의 범위의 항목만 가려서 보입니다</span>
          받는 분 이름·연락처·배송 주소, 주문번호, 주문 상품·수량만 보이고, 배송 완료 후 3개월까지 봅니다.
          <span className="max-md:hidden"> 택배는 판매자가 보내고 송장을 등록합니다.</span>
        </div>
      </div>
      <div className="md:hidden">
        <div className="banner banner-info bigscreen" role="note">
          <i className="ic ic-monitor" aria-hidden="true" />
          <div className="banner-body" style={{ flexBasis: 'calc(100% - 30px)' }}>
            <span className="banner-title">송장 등록·반품 거절·배송 명단 내려받기·현장 수령 처리는 태블릿이나 데스크톱에서 합니다</span>
            휴대폰에서는 주문을 보고 반품 도착을 확인합니다
          </div>
          <CopyLinkButton />
        </div>
      </div>

      {/* 거르기 + 배송 명단 내려받기 */}
      <div className="toolbar between max-lg:flex-col max-lg:items-stretch" style={{ alignItems: 'flex-end', gap: 12 }}>
        <form className="row max-lg:grid max-lg:grid-cols-3 max-md:grid-cols-1" role="search" aria-label="택배 주문 거르기" action="/products" style={{ gap: 12, alignItems: 'flex-end' }}>
          <SelectField id="s-status" label="상태" className="lg:w-[200px]" options={['전체 상태', '배송 준비', '배송 중', '배송 완료', '반품 요청', '반품 확인 중(분쟁)']} />
          <SelectField
            id="s-product"
            label="상품"
            className="max-md:hidden lg:w-[220px]"
            options={['전체 상품', 'LUMEN 공식 응원봉', 'LUMEN 투어 티셔츠', 'LUMEN 포토카드 세트', 'LUMEN 투어 후드']}
          />
          <div className="field max-md:hidden lg:w-[200px]">
            <label className="label" htmlFor="s-no">
              주문번호
            </label>
            <div className="input-group input-group-sm">
              <i className="ic ic-search ic-16" aria-hidden="true" />
              <input id="s-no" name="no" type="search" placeholder="주문번호" />
            </div>
          </div>
        </form>
        <div className="flex flex-col items-end gap-1 max-md:hidden max-lg:flex-row-reverse max-lg:items-start max-lg:justify-between max-lg:gap-3">
          <AdminOnly isMember={isMember} id="s-dl" className="btn btn-outline" opensModal="ship-dl" describedBy="s-dl-h">
            <i className="ic ic-download" aria-hidden="true" />
            배송 명단 내려받기
          </AdminOnly>
          <span className="t-xs muted" id="s-dl-h">
            <span className="lg:hidden">배송 명단 내려받기는 파트너 관리자만 하고, 사유를 적어야 내려받습니다</span>
            <span className="max-lg:hidden">파트너 관리자 · 사유를 적어야 내려받습니다</span>
          </span>
        </div>
      </div>

      {/* 태블릿·데스크톱: 표 */}
      <div className="table-wrap table-scroll max-md:hidden" role="region" aria-label="택배 주문 표" tabIndex={0}>
        <table className="table dense" style={{ minWidth: 900 }}>
          <caption className="sr-only">택배 주문 목록, 동의 범위 항목만 가려서 표시</caption>
          <thead>
            <tr>
              <th scope="col">주문번호 · 주문 상품·수량</th>
              <th scope="col">받는 분 · 연락처 · 배송 주소</th>
              <th scope="col">상태</th>
              <th scope="col">송장</th>
              <th scope="col">
                <span className="sr-only">처리</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shipOrders.map((o) => (
              <tr key={o.no} className={o.no === RETURN_ORDER_NO ? 'is-selected' : undefined}>
                <td>
                  <div className="col" style={{ gap: 2 }}>
                    <span className="mono">{o.no}</span>
                    <span className="t-xs muted">{o.item}</span>
                  </div>
                </td>
                <td>
                  <div className="col" style={{ gap: 2 }}>
                    <span>
                      {o.recipient} · <span className="mono">{o.phone}</span>
                    </span>
                    <span className="t-xs muted">{o.address}</span>
                  </div>
                </td>
                <td>
                  <StatusCell o={o} />
                </td>
                <td>
                  {o.returnInvoice ? (
                    <div className="col" style={{ gap: 2 }}>
                      <span className="mono t-xs">{o.invoice}</span>
                      <span className="t-xs muted">반품 송장 {o.returnInvoice}</span>
                    </div>
                  ) : o.invoice ? (
                    <span className="mono t-xs">{o.invoice}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <Actions o={o} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row between max-md:hidden" style={{ gap: 12, alignItems: 'flex-start' }}>
        <span className="t-xs muted">
          반품 도착을 확인하면 PEAKET이 3영업일 안에 환급합니다. 전자상거래법 §17②1·2호 사유가 있으면 근거와 함께 거절할 수 있고, 거절하면 CS 처리함 &apos;분쟁
          접수&apos;로 넘어갑니다.
        </span>
        <div className="row" style={{ gap: 6, flex: 'none' }}>
          <button className="btn btn-outline btn-sm" type="button" disabled>
            <i className="ic ic-chevron-left" aria-hidden="true" />
            이전
          </button>
          <button className="btn btn-outline btn-sm" type="button">
            다음
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* 휴대폰: 카드 목록 */}
      <ul className="col md:hidden" style={{ gap: 12 }} aria-label="택배 주문 목록, 동의 범위 항목만 가려서 표시">
        {mobileOrders.map((o) => {
          const isReturn = o.status === '반품 요청';
          return (
            <li key={o.no}>
              <article className={`card col${isReturn ? ' is-selected' : ''}`} style={{ padding: '14px 16px', gap: 10 }} aria-labelledby={`so-${o.no}`}>
                <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <div className="col" style={{ gap: 2 }}>
                    <h3 className="t-md fw-b" id={`so-${o.no}`}>
                      {o.item}
                    </h3>
                    <span className="mono t-xs muted">{o.no}</span>
                  </div>
                  {o.escrow ? (
                    <div className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <span className={SHIP_STATUS_BADGE[o.status]}>{o.status}</span>
                      <span className="badge badge-outline">결제대금예치</span>
                    </div>
                  ) : (
                    <span className={SHIP_STATUS_BADGE[o.status]}>{o.status}</span>
                  )}
                </div>
                <dl className="kv">
                  <dt>받는 분</dt>
                  <dd>
                    {o.recipient} · <span className="mono">{o.phone}</span>
                  </dd>
                  <dt>배송 주소</dt>
                  <dd>{o.address}</dd>
                  {isReturn ? (
                    <>
                      <dt>반품 사유</dt>
                      <dd>{o.statusNote}</dd>
                      <dt>반품 송장</dt>
                      <dd className="mono">{o.returnInvoice}</dd>
                    </>
                  ) : o.status === '반품 확인 중(분쟁)' ? (
                    <>
                      <dt>처리</dt>
                      <dd>{o.statusNote}</dd>
                    </>
                  ) : (
                    <>
                      <dt>송장</dt>
                      <dd className={o.invoice ? 'mono' : 'muted'}>{o.invoice ?? '—'}</dd>
                    </>
                  )}
                </dl>
                {isReturn ? (
                  <>
                    <button className="btn btn-primary btn-lg btn-block" type="button" aria-label={`${o.no} 반품 도착 확인`}>
                      반품 도착 확인
                    </button>
                    <p className="t-xs muted">반품 도착을 확인하면 PEAKET이 3영업일 안에 환급합니다. 거절은 태블릿이나 데스크톱에서 합니다.</p>
                  </>
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>
      <a className="link-more md:hidden" href="#h-ship" style={{ alignSelf: 'flex-start', minHeight: 44 }}>
        택배 주문 더 보기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </a>

      {/* 송장 등록 · 현장 수령 처리(태블릿·데스크톱) */}
      <div className="grid gap-4 max-md:hidden lg:grid-cols-12" style={{ alignItems: 'start' }}>
        <section className="card pad-lg col lg:col-span-7" style={{ gap: 14 }} aria-labelledby="h-inv">
          <div className="col" style={{ gap: 2 }}>
            <h3 className="t-md fw-b" id="h-inv">
              송장 등록
            </h3>
            <span className="t-xs muted">한 건씩 또는 CSV 묶음으로 등록합니다</span>
          </div>
          <div className="field">
            <label className="label" htmlFor="inv-order">
              주문
            </label>
            <div className="input-group input-group-sm">
              <select id="inv-order" defaultValue="2026101400412 · LUMEN 투어 티셔츠 · L · 1개">
                <option>2026101400412 · LUMEN 투어 티셔츠 · L · 1개</option>
                <option>2026101300298 · LUMEN 포토카드 세트 · 2개</option>
              </select>
              <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
            </div>
          </div>
          <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
            <div className="field" style={{ width: 160 }}>
              <label className="label" htmlFor="inv-courier">
                택배사
              </label>
              <div className="input-group input-group-sm">
                <select id="inv-courier" defaultValue="[택배사]">
                  <option>[택배사]</option>
                </select>
                <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
              </div>
            </div>
            <div className="field grow">
              <label className="label" htmlFor="inv-no">
                송장 번호
              </label>
              <input className="input input-sm" id="inv-no" type="text" inputMode="numeric" />
            </div>
            <button className="btn btn-primary" type="button">
              송장 등록하기
            </button>
          </div>
          <p className="t-xs muted">에스크로 주문의 송장 등록은 결제사 배송 정보 등록으로 이어집니다.</p>
          <hr className="divider" />
          <div className="row between" style={{ gap: 12 }}>
            <span className="t-sm">여러 건은 CSV 묶음으로 올립니다</span>
            <button className="btn btn-outline btn-sm" type="button">
              <i className="ic ic-upload" aria-hidden="true" />
              송장 CSV 올리기
            </button>
          </div>
        </section>
        <section className="card pad-lg col lg:col-span-5" style={{ gap: 14 }} aria-labelledby="h-pick">
          <div className="row between wrap" style={{ gap: 8 }}>
            <div className="col" style={{ gap: 2 }}>
              <h3 className="t-md fw-b" id="h-pick">
                현장 수령 처리
              </h3>
              <span className="t-xs muted">공연 당일 교환권 QR로 확인합니다</span>
            </div>
            <button className="btn btn-outline lg:hidden" type="button">
              <i className="ic ic-qr" aria-hidden="true" />
              교환권 QR 확인하기
            </button>
          </div>
          <div className="row" style={{ gap: 32 }}>
            <div className="col" style={{ gap: 2 }}>
              <span className="t-xs muted">현장 수령</span>
              <span className="t-lg num">608개</span>
            </div>
            <div className="col" style={{ gap: 2 }}>
              <span className="t-xs muted">수령함</span>
              <span className="t-lg num">0개</span>
            </div>
          </div>
          <p className="t-sm muted">현장 수령은 PEAKET 교환권 QR로 확인하고 판매자에게 개인정보를 주지 않습니다.</p>
          <button className="btn btn-outline max-lg:hidden" type="button" style={{ alignSelf: 'flex-start' }}>
            <i className="ic ic-qr" aria-hidden="true" />
            교환권 QR 확인하기
          </button>
        </section>
      </div>

      {/* 대화상자: 배송 명단 내려받기(파트너 관리자) */}
      {!isMember ? (
        <Modal id="ship-dl" defaultOpen={openDownload} labelledBy="sdl-t" describedBy="sdl-d" maxWidth={480}>
          <h2 className="dialog-title" id="sdl-t">
            배송 명단 내려받기
          </h2>
          <p className="t-sm muted" id="sdl-d">
            택배 주문 702건 · 동의 범위 항목만 담습니다(받는 분 이름·연락처·배송 주소, 주문번호, 주문 상품·수량). 다운로드 사유는 접속기록에 남습니다.
          </p>
          <fieldset className="col" role="radiogroup" aria-labelledby="sdl-fmt-l">
            <legend className="label" id="sdl-fmt-l" style={{ marginBottom: 10 }}>
              파일 형식 (필수)
            </legend>
            <div className="row" style={{ gap: 24 }}>
              <label className="check-row" htmlFor="sfmt-csv">
                <input className="rd" id="sfmt-csv" type="radio" name="sdl-fmt" defaultChecked />
                CSV
              </label>
              <label className="check-row" htmlFor="sfmt-xlsx">
                <input className="rd" id="sfmt-xlsx" type="radio" name="sdl-fmt" />
                XLSX
              </label>
            </div>
          </fieldset>
          <div className="field">
            <label className="label" htmlFor="sdl-reason">
              다운로드 사유 (필수)
            </label>
            <textarea className="input textarea" id="sdl-reason" aria-describedby="sdl-hint" style={{ minHeight: 96 }} defaultValue="10/15(목) 발송분 송장 출력" required />
            <span className="hint" id="sdl-hint">
              사유와 내려받은 건수는 접속기록에 남습니다.
            </span>
          </div>
          <div className="dialog-actions">
            <button className="btn btn-ghost" type="button" data-modal-close>
              닫기
            </button>
            <button className="btn btn-primary" type="button">
              <i className="ic ic-download" aria-hidden="true" />
              명단 내려받기
            </button>
          </div>
        </Modal>
      ) : null}

      {/* 대화상자: 반품 거절(전자상거래법 §17②1·2호) */}
      <Modal id="return-reject" defaultOpen={openReject} labelledBy="rj-t" describedBy="rj-d" maxWidth={500}>
        <h2 className="dialog-title" id="rj-t">
          반품 거절
        </h2>
        <p className="t-sm muted" id="rj-d">
          {ret.no} · LUMEN 포토카드 세트 1개 · 반품 사유 단순 변심 · 10/12(월) 요청
        </p>
        <fieldset className="col" style={{ gap: 8 }} role="radiogroup" aria-labelledby="rj-code-l">
          <legend className="label" id="rj-code-l" style={{ marginBottom: 8 }}>
            거절 사유 (필수)
          </legend>
          <label className="check-row" style={{ alignItems: 'flex-start' }}>
            <input className="rd" type="radio" name="rj-code" defaultChecked />
            <span className="col" style={{ gap: 2 }}>
              <span className="t-sm fw-b">구매자 책임의 훼손</span>
              <span className="t-xs muted">전자상거래법 §17②1호</span>
            </span>
          </label>
          <label className="check-row" style={{ alignItems: 'flex-start' }}>
            <input className="rd" type="radio" name="rj-code" />
            <span className="col" style={{ gap: 2 }}>
              <span className="t-sm fw-b">사용으로 가치가 현저히 줄어듦</span>
              <span className="t-xs muted">전자상거래법 §17②2호</span>
            </span>
          </label>
        </fieldset>
        <p className="t-xs muted">내용 확인을 위한 포장 개봉은 거절 사유가 아닙니다.</p>
        <div className="field">
          <label className="label" htmlFor="rj-basis">
            근거 (필수)
          </label>
          <textarea className="textarea" id="rj-basis" aria-describedby="rj-h" style={{ minHeight: 104 }} required />
          <span className="hint" id="rj-h">
            거절하면 CS 처리함 &apos;분쟁 접수&apos;로 넘어가고, 3영업일 안에 진행 경과를, 10영업일 안에 결과를 알립니다.
          </span>
        </div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" type="button" data-modal-close>
            닫기
          </button>
          <button className="btn btn-danger" type="button">
            반품 거절하기
          </button>
        </div>
      </Modal>
    </section>
  );
}
