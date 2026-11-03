// 디자인 캔버스 보드 SCR-068-d.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';
import { useRo } from '@/features/screen-access';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_D = ["템플릿", "파트너 긴급 공지", "승인된 템플릿 없음", "홈 구성"] as const;
export const DEFAULT_D = "템플릿";

export function valsD(state: string) {
    let st = state || '템플릿';
    return {
      tplTab: st === '템플릿' || st === '승인된 템플릿 없음',
      partnerTab: st === '파트너 긴급 공지',
      homeTab: st === '홈 구성',
      hasApproved: st === '템플릿',
      noApproved: st === '승인된 템플릿 없음'
    };
  }

type V = ReturnType<typeof valsD>;

// 보드 루트: {"class": "pk dark cs", "style": "width:100%;min-height:1290px;grid-template-rows:auto 1fr"}

// <main class="cs-main" id="main">
export function MainD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="page-head">
      <div className="col" style={{ gap: "4px" }}>
        <h1>공지 관리</h1>
        <p className="t-sm muted">대기실 공지는 승인된 템플릿만 운영 명령 7로 띄웁니다. 파트너 긴급 공지는 파트너 콘솔 팝업과 이메일로 보냅니다.</p>
      </div>
    </div>
    {v.tplTab ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <div className="tabs" role="tablist" aria-label="공지 종류">
            <button onClick={() => go?.('템플릿')} className="tab is-active" role="tab" id="nt-tpl" aria-selected="true" aria-controls="np-tpl" type="button">
              <i className="ic ic-megaphone" aria-hidden="true" />
              대기실 공지 템플릿
            </button>
            {' '}
            <button onClick={() => go?.('파트너 긴급 공지')} className="tab" role="tab" id="nt-partner" aria-selected="false" type="button">
              <i className="ic ic-building" aria-hidden="true" />
              파트너 긴급 공지
            </button>
            {' '}
            <button onClick={() => go?.('홈 구성')} className="tab" role="tab" id="nt-home" aria-selected="false" type="button">
              <i className="ic ic-home" aria-hidden="true" />
              홈 구성
            </button>
          </div>
          <div className="col" role="tabpanel" id="np-tpl" aria-labelledby="nt-tpl" style={{ gap: "16px" }}>
            {v.hasApproved ? (
              <>
                <div className="banner banner-info">
                  <i className="ic ic-info" aria-hidden="true" />
                  <div className="banner-body">
                    <span className="banner-title">승인 전 템플릿은 운영 명령 7에서 고를 수 없습니다</span>
                    템플릿은 법무·운영 검토를 거쳐 commander가 승인합니다. operator는 작성하고 승인을 요청합니다.{' '}
                    <Link to="/commands" className="link">운영 명령 7로 대기실 공지 띄우기</Link>
                  </div>
                </div>
              </>
            ) : null}
            {' '}
            {v.noApproved ? (
              <>
                <div className="banner banner-warning" role="status">
                  <i className="ic ic-alert" aria-hidden="true" />
                  <div className="banner-body">
                    <span className="banner-title">승인된 템플릿이 없습니다</span>
                    지금은 운영 명령 7로 대기실 공지를 띄울 수 없습니다. 템플릿은 법무·운영 검토를 거쳐 commander가 승인하면 고를 수 있습니다.
                  </div>
                </div>
              </>
            ) : null}
            <div className="grid-12" style={{ rowGap: "16px", alignItems: "start" }}>
              <section className="widget span-7" aria-labelledby="h-tpl">
                <div className="widget-head">
                  <h2 className="t-sm fw-b" id="h-tpl">대기실 공지 템플릿</h2>
                  <span className="actions">
                    <button className="btn btn-secondary btn-sm" type="button" {...ro()}>
                      <i className="ic ic-plus" aria-hidden="true" />
                      새 템플릿 작성
                    </button>
                  </span>
                </div>
                <div className="widget-body" style={{ padding: "12px" }}>
                  {v.hasApproved ? (
                    <>
                      <div className="table-wrap">
                        <table className="table dense">
                          <caption className="sr-only">대기실 공지 템플릿 2개(승인됨 1, 검토 중 1)</caption>
                          <thead>
                            <tr>
                              <th scope="col">제목</th>
                              <th scope="col">언어</th>
                              <th scope="col">승인 상태</th>
                              <th scope="col">승인자</th>
                              <th scope="col">마지막 사용</th>
                              <th scope="col"><span className="sr-only">작업</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="is-selected">
                              <td>
                                <strong className="fw-b">결제 지연 안내</strong>
                                <span className="t-xs muted" style={{ display: "block" }}>편집 중</span>
                              </td>
                              <td>
                                <span className="row" style={{ gap: "4px" }}>
                                  <span className="badge badge-outline">ko</span>
                                  <span className="badge badge-outline">en</span>
                                  <span className="badge badge-outline">ja</span>
                                  <span className="badge badge-outline">zh</span>
                                </span>
                              </td>
                              <td>
                                <span className="badge badge-warning">
                                  <i className="ic ic-clock" aria-hidden="true" />
                                  검토 중
                                </span>
                              </td>
                              <td className="muted">commander 승인 대기</td>
                              <td className="muted">없음</td>
                              <td>
                                <button className="btn btn-ghost btn-sm" type="button" aria-label="결제 지연 안내 템플릿 편집">
                                  <i className="ic ic-edit" aria-hidden="true" />
                                  편집
                                </button>
                              </td>
                            </tr>
                            <tr>
                              <td><strong className="fw-b">입장 지연 안내</strong></td>
                              <td>
                                <span className="row" style={{ gap: "4px" }}>
                                  <span className="badge badge-outline">ko</span>
                                  <span className="badge badge-outline">en</span>
                                  <span className="badge badge-outline">ja</span>
                                  <span className="badge badge-outline">zh</span>
                                </span>
                              </td>
                              <td>
                                <span className="badge badge-success">
                                  <i className="ic ic-check" aria-hidden="true" />
                                  승인됨
                                </span>
                              </td>
                              <td>
                                수진(commander)
                                <span className="t-xs muted" style={{ display: "block" }}>10/13(화) 16:20 KST</span>
                              </td>
                              <td className="muted">없음</td>
                              <td>
                                <button className="btn btn-ghost btn-sm" type="button" aria-label="입장 지연 안내 템플릿 보기">
                                  <i className="ic ic-eye" aria-hidden="true" />
                                  보기
                                </button>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : null}
                  {' '}
                  {v.noApproved ? (
                    <>
                      <div className="table-wrap">
                        <table className="table dense">
                          <caption className="sr-only">대기실 공지 템플릿 2개(모두 검토 중)</caption>
                          <thead>
                            <tr>
                              <th scope="col">제목</th>
                              <th scope="col">언어</th>
                              <th scope="col">승인 상태</th>
                              <th scope="col">승인자</th>
                              <th scope="col">마지막 사용</th>
                              <th scope="col"><span className="sr-only">작업</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="is-selected">
                              <td>
                                <strong className="fw-b">결제 지연 안내</strong>
                                <span className="t-xs muted" style={{ display: "block" }}>편집 중</span>
                              </td>
                              <td>
                                <span className="row" style={{ gap: "4px" }}>
                                  <span className="badge badge-outline">ko</span>
                                  <span className="badge badge-outline">en</span>
                                  <span className="badge badge-outline">ja</span>
                                  <span className="badge badge-outline">zh</span>
                                </span>
                              </td>
                              <td>
                                <span className="badge badge-warning">
                                  <i className="ic ic-clock" aria-hidden="true" />
                                  검토 중
                                </span>
                              </td>
                              <td className="muted">commander 승인 대기</td>
                              <td className="muted">없음</td>
                              <td>
                                <button className="btn btn-ghost btn-sm" type="button" aria-label="결제 지연 안내 템플릿 편집">
                                  <i className="ic ic-edit" aria-hidden="true" />
                                  편집
                                </button>
                              </td>
                            </tr>
                            <tr>
                              <td><strong className="fw-b">입장 지연 안내</strong></td>
                              <td>
                                <span className="row" style={{ gap: "4px" }}>
                                  <span className="badge badge-outline">ko</span>
                                  <span className="badge badge-outline">en</span>
                                  <span className="badge badge-outline">ja</span>
                                  <span className="badge badge-outline">zh</span>
                                </span>
                              </td>
                              <td>
                                <span className="badge badge-warning">
                                  <i className="ic ic-clock" aria-hidden="true" />
                                  검토 중
                                </span>
                              </td>
                              <td className="muted">commander 승인 대기</td>
                              <td className="muted">없음</td>
                              <td>
                                <button className="btn btn-ghost btn-sm" type="button" aria-label="입장 지연 안내 템플릿 편집">
                                  <i className="ic ic-edit" aria-hidden="true" />
                                  편집
                                </button>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : null}
                  <p className="hint">검토 중 템플릿은 운영 명령 7의 템플릿 목록에 나오지 않습니다.</p>
                </div>
              </section>
              <section className="widget span-5" aria-labelledby="h-edit">
                <div className="widget-head">
                  <h2 className="t-sm fw-b" id="h-edit">템플릿 편집 · 결제 지연 안내</h2>
                  <span className="actions">
                    <span className="badge badge-warning">
                      <i className="ic ic-clock" aria-hidden="true" />
                      검토 중
                    </span>
                  </span>
                </div>
                <div className="widget-body" style={{ padding: "16px", gap: "14px" }}>
                  <div className="field">
                    <label className="label" htmlFor="te-title">제목 (필수)</label>
                    {' '}
                    <input className="input input-sm" id="te-title" type="text" defaultValue="결제 지연 안내" />
                  </div>
                  <div className="col" style={{ gap: "8px" }}>
                    <span className="label" id="te-lang">언어별 문구</span>
                    <div className="tabs tabs-sm" role="tablist" aria-labelledby="te-lang">
                      <button className="tab is-active" role="tab" id="tl-ko" aria-selected="true" aria-controls="tp-ko" type="button">
                        ko
                        <span className="sr-only">한국어</span>
                      </button>
                      {' '}
                      <button className="tab" role="tab" id="tl-en" aria-selected="false" type="button">
                        en
                        <span className="sr-only">영어</span>
                      </button>
                      {' '}
                      <button className="tab" role="tab" id="tl-ja" aria-selected="false" type="button">
                        ja
                        <span className="sr-only">일본어</span>
                      </button>
                      {' '}
                      <button className="tab" role="tab" id="tl-zh" aria-selected="false" type="button">
                        zh
                        <span className="sr-only">중국어 간체</span>
                      </button>
                    </div>
                    <div className="field" role="tabpanel" id="tp-ko" aria-labelledby="tl-ko" style={{ paddingTop: "4px" }}>
                      <label className="label" htmlFor="te-ko">한국어 문구 (필수)</label>
                      {' '}
                      <textarea className="textarea" id="te-ko" aria-describedby="te-ko-h te-ko-c" style={{ minHeight: "96px" }} defaultValue="결제 대행사 점검으로 결제가 잠시 늦어질 수 있습니다. 대기 순서는 그대로입니다." />
                      <div className="row between" style={{ gap: "12px" }}>
                        <span className="hint" id="te-ko-h">승인 전 초안입니다(위임 결정 2026-10-14, ADR-0062)</span>
                        <span className="counter" id="te-ko-c" aria-live="polite">남은 글자 75자 · 최대 120자 [가정]</span>
                      </div>
                    </div>
                    <p className="t-xs muted">en·ja·zh 문구</p>
                    <dl className="kv" style={{ fontSize: "12px", lineHeight: "18px", gap: "4px 10px" }}>
                      <dt>en</dt>
                      <dd lang="en">Payments may be briefly delayed due to maintenance by our payment provider. Your place in line is kept.</dd>
                      <dt>ja</dt>
                      <dd lang="ja">決済代行会社のメンテナンスにより、決済が一時的に遅れる場合があります。順番はそのままです。</dd>
                      <dt>zh</dt>
                      <dd lang="zh">由于支付服务商进行系统维护，付款可能会暂时延迟。您的排队顺序不变。</dd>
                    </dl>
                  </div>
                  <figure className="col" style={{ gap: "6px" }}>
                    <figcaption className="eyebrow">대기실 미리보기</figcaption>
                    <div className="banner banner-announce">
                      <i className="ic ic-megaphone" aria-hidden="true" />
                      <div className="banner-body">
                        <span className="banner-title">운영 공지</span>
                        결제 대행사 점검으로 결제가 잠시 늦어질 수 있습니다. 대기 순서는 그대로입니다.
                      </div>
                    </div>
                  </figure>
                  <p className="t-xs muted">저장하면 검토 중으로 남고, commander가 승인한 뒤에 운영 명령 7에서 고를 수 있습니다.</p>
                  <div className="row" style={{ gap: "8px", justifyContent: "flex-end" }}>
                    <button className="btn btn-ghost" type="button">편집 닫기</button>
                    {' '}
                    <button className="btn btn-primary" type="button" {...ro()}>
                      <i className="ic ic-stamp" aria-hidden="true" />
                      저장하고 승인 요청하기
                    </button>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.partnerTab ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <div className="tabs" role="tablist" aria-label="공지 종류">
            <button onClick={() => go?.('템플릿')} className="tab" role="tab" id="nt-tpl2" aria-selected="false" type="button">
              <i className="ic ic-megaphone" aria-hidden="true" />
              대기실 공지 템플릿
            </button>
            {' '}
            <button onClick={() => go?.('파트너 긴급 공지')} className="tab is-active" role="tab" id="nt-partner2" aria-selected="true" aria-controls="np-partner" type="button">
              <i className="ic ic-building" aria-hidden="true" />
              파트너 긴급 공지
            </button>
            {' '}
            <button onClick={() => go?.('홈 구성')} className="tab" role="tab" id="nt-home2" aria-selected="false" type="button">
              <i className="ic ic-home" aria-hidden="true" />
              홈 구성
            </button>
          </div>
          <div className="grid-12" role="tabpanel" id="np-partner" aria-labelledby="nt-partner2" style={{ rowGap: "16px", alignItems: "start" }}>
            <section className="widget span-7" aria-labelledby="h-pn">
              <div className="widget-head"><h2 className="t-sm fw-b" id="h-pn">긴급 공지 보내기</h2></div>
              <div className="widget-body" style={{ padding: "16px", gap: "16px" }}>
                <div className="field">
                  <label className="label" htmlFor="pn-target">대상 파트너 (필수)</label>
                  <div className="input-group input-group-sm">
                    <select id="pn-target" aria-describedby="pn-target-h">
                      <option>회차의 파트너 · LUMEN 콘서트 2026 서울 1회차</option>
                      <option>전체 파트너</option>
                    </select>
                    <i className="ic ic-chevron-down" aria-hidden="true" />
                  </div>
                  <span className="hint" id="pn-target-h">받는 곳: (주)스텔라엔터테인먼트의 파트너 계정</span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="pn-title">제목 (필수)</label>
                  <div className="row" style={{ gap: "8px" }}>
                    <div className="input-group input-group-sm" style={{ flex: "none", width: "112px" }}>
                      <select id="pn-head" aria-label="상태 말머리" defaultValue="[진행]">
                        <option>[발생]</option>
                        <option>[진행]</option>
                        <option>[해결]</option>
                      </select>
                      <i className="ic ic-chevron-down" aria-hidden="true" />
                    </div>
                    <input className="input input-sm" id="pn-title" type="text" defaultValue="결제 확정 지연 안내" aria-describedby="pn-title-c" style={{ flex: "1", minWidth: "0" }} />
                  </div>
                  <span className="counter" id="pn-title-c" aria-live="polite" style={{ alignSelf: "flex-end" }}>남은 글자 24자 · 최대 40자 [가정]</span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="pn-body">본문 (필수)</label>
                  {' '}
                  <textarea className="textarea" id="pn-body" aria-describedby="pn-body-h pn-body-c" style={{ minHeight: "120px" }} defaultValue="10/14(수) 20:03 KST부터 결제 대행사 응답이 늦어 LUMEN 콘서트 2026 서울 10/25(일) 18:00 회차의 결제 확정이 늦어지고 있습니다. 판매 현황 숫자가 몇 분 늦게 바뀔 수 있습니다. 파트너께서 하실 일은 없습니다. 20:30 KST까지 다음 소식을 알려 드립니다." />
                  <div className="row between" style={{ gap: "12px" }}>
                    <span className="hint" id="pn-body-h">무슨 일 → 언제부터·지금 상태 → 파트너 영향과 할 일 → 다음 안내 시각 순서로 씁니다. 콘솔 팝업과 이메일에 같은 본문이 갑니다</span>
                    <span className="counter" id="pn-body-c" aria-live="polite">남은 글자 337자 · 최대 500자 [가정]</span>
                  </div>
                </div>
                <fieldset className="col" style={{ gap: "10px" }}>
                  <legend className="label" style={{ marginBottom: "6px" }}>채널 (필수, 하나 이상)</legend>
                  <label className="check-row" htmlFor="pn-ch-pop">
                    <input className="cb" type="checkbox" id="pn-ch-pop" defaultChecked />
                    <span>
                      콘솔 팝업{' '}
                      <span className="t-sm muted">· 파트너 콘솔에 팝업으로 띄우고 알림함에 남깁니다</span>
                    </span>
                  </label>
                  {' '}
                  <label className="check-row" htmlFor="pn-ch-mail">
                    <input className="cb" type="checkbox" id="pn-ch-mail" defaultChecked />
                    <span>
                      이메일{' '}
                      <span className="t-sm muted">· 파트너 계정 이메일로 보냅니다</span>
                    </span>
                  </label>
                </fieldset>
                <div className="row" style={{ gap: "12px", justifyContent: "flex-end" }}>
                  <span className="t-xs muted">보낸 공지는 발송 이력에 남습니다</span>
                  {' '}
                  <button className="btn btn-primary" type="button" {...ro()}>
                    <i className="ic ic-megaphone" aria-hidden="true" />
                    긴급 공지 발송하기
                  </button>
                </div>
              </div>
            </section>
            <div className="span-5 col" style={{ gap: "16px" }}>
              <section className="widget" aria-labelledby="h-pv">
                <div className="widget-head"><h2 className="t-sm fw-b" id="h-pv">파트너 콘솔 미리보기</h2></div>
                <div className="widget-body" style={{ padding: "16px" }}>
                  <div className="banner banner-danger">
                    <i className="ic ic-alert-circle" aria-hidden="true" />
                    <div className="banner-body">
                      <span className="banner-title">[진행] 결제 확정 지연 안내</span>
                      10/14(수) 20:03 KST부터 결제 대행사 응답이 늦어 LUMEN 콘서트 2026 서울 10/25(일) 18:00 회차의 결제 확정이 늦어지고 있습니다. 판매 현황 숫자가 몇 분 늦게 바뀔 수 있습니다. 파트너께서 하실 일은 없습니다. 20:30 KST까지 다음 소식을 알려 드립니다.
                    </div>
                  </div>
                  <p className="t-xs muted">파트너 콘솔에 팝업으로 뜨고 알림함에 남습니다.</p>
                </div>
              </section>
              <section className="widget" aria-labelledby="h-ph">
                <div className="widget-head"><h2 className="t-sm fw-b" id="h-ph">발송 이력</h2></div>
                <div className="widget-body" style={{ padding: "12px" }}>
                  <div className="table-wrap">
                    <table className="table dense">
                      <thead>
                        <tr>
                          <th scope="col">보낸 시각</th>
                          <th scope="col">대상</th>
                          <th scope="col">채널</th>
                          <th scope="col">보낸 사람</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td colSpan={4}>
                            <div className="state" style={{ padding: "20px 16px", gap: "8px" }}>
                              <span className="state-icon" style={{ width: "44px", height: "44px" }}>
                                <i className="ic ic-mail" aria-hidden="true" />
                              </span>
                              <p className="t-sm muted">보낸 긴급 공지가 없습니다</p>
                            </div>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.homeTab ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <div className="tabs" role="tablist" aria-label="공지 종류">
            <button onClick={() => go?.('템플릿')} className="tab" role="tab" id="nt-tpl3" aria-selected="false" type="button">
              <i className="ic ic-megaphone" aria-hidden="true" />
              대기실 공지 템플릿
            </button>
            {' '}
            <button onClick={() => go?.('파트너 긴급 공지')} className="tab" role="tab" id="nt-partner3" aria-selected="false" type="button">
              <i className="ic ic-building" aria-hidden="true" />
              파트너 긴급 공지
            </button>
            {' '}
            <button onClick={() => go?.('홈 구성')} className="tab is-active" role="tab" id="nt-home3" aria-selected="true" aria-controls="np-home" type="button">
              <i className="ic ic-home" aria-hidden="true" />
              홈 구성
            </button>
          </div>
          <div className="col" role="tabpanel" id="np-home" aria-labelledby="nt-home3" style={{ gap: "16px" }}>
            <div className="banner banner-info">
              <i className="ic ic-info" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">판매 승인된 공연만 고를 수 있습니다</span>
                배너와 테마는 operator가 한 사람으로 게시하고, 게시와 변경은 감사 로그에 남습니다. 장르별 랭킹과 지금 판매 중은 시스템이 계산하므로 여기서 고치지 않습니다.
              </div>
            </div>
            <div className="grid-12" style={{ rowGap: "16px", alignItems: "start" }}>
              <div className="span-8 col" style={{ gap: "16px" }}>
                <section className="widget" aria-labelledby="h-hb">
                  <div className="widget-head">
                    <h2 className="t-sm fw-b" id="h-hb">배너</h2>
                    <span className="t-xs muted fw-r">5장 · 최대 10장 [가정]</span>
                    <span className="actions">
                      <button className="btn btn-secondary btn-sm" type="button" {...ro('hb-h')}>
                        <i className="ic ic-plus" aria-hidden="true" />
                        배너 추가
                      </button>
                    </span>
                  </div>
                  <div className="widget-body" style={{ padding: "12px" }}>
                    <p className="hint" id="hb-h">
                      배너 이미지는 운영자가 올린 가로형 이미지(가로 1,240×400px 이상 [가정])입니다. 파트너의 포스터·상세 이미지를 쓰지 않습니다. 배너 이미지의 대체 텍스트를 적어 주세요.
                    </p>
                    <div className="table-wrap">
                      <table className="table dense">
                        <caption className="sr-only">홈 배너 5장(게시 중 2, 예정 1, 끝남 1, 노출 안 됨 1)</caption>
                        <thead>
                          <tr>
                            <th scope="col">순서</th>
                            <th scope="col">배너 이미지</th>
                            <th scope="col">대상 공연 · 대체 텍스트</th>
                            <th scope="col">노출 기간</th>
                            <th scope="col">상태</th>
                            <th scope="col"><span className="sr-only">작업</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>
                              <span className="row" style={{ gap: "2px" }}>
                                <button className="icon-btn icon-btn-sm" type="button" aria-label="1번 배너 순서 바꾸기">
                                  <i className="ic ic-grip" aria-hidden="true" />
                                </button>
                                <span className="num fw-b">1</span>
                              </span>
                            </td>
                            <td>
                              <span className="poster poster-lumen" role="img" aria-label="배너 이미지 미리보기: LUMEN 콘서트 2026 서울" style={{ aspectRatio: "1240/400", width: "112px", padding: "0", borderRadius: "6px" }} />
                            </td>
                            <td>
                              <strong className="fw-b">LUMEN 콘서트 2026 서울</strong>
                              <span className="t-xs muted" style={{ display: "block" }}>대체 텍스트: LUMEN 콘서트 2026 서울, 10/25(일)~10/26(월) 피켓 아레나</span>
                            </td>
                            <td className="num">
                              10/10(토) 00:00 ~
                              <br />
                              10/26(월) 17:00 KST
                            </td>
                            <td>
                              <span className="badge badge-success">
                                <i className="ic ic-check" aria-hidden="true" />
                                게시 중
                              </span>
                            </td>
                            <td>
                              <button className="btn btn-ghost btn-sm" type="button" aria-label="LUMEN 콘서트 2026 서울 배너 편집">
                                <i className="ic ic-edit" aria-hidden="true" />
                                편집
                              </button>
                            </td>
                          </tr>
                          <tr>
                            <td>
                              <span className="row" style={{ gap: "2px" }}>
                                <button className="icon-btn icon-btn-sm" type="button" aria-label="2번 배너 순서 바꾸기">
                                  <i className="ic ic-grip" aria-hidden="true" />
                                </button>
                                <span className="num fw-b">2</span>
                              </span>
                            </td>
                            <td>
                              <span className="poster poster-fanmeet" role="img" aria-label="배너 이미지 미리보기: 팬미팅" style={{ aspectRatio: "1240/400", width: "112px", padding: "0", borderRadius: "6px" }} />
                            </td>
                            <td>
                              <strong className="fw-b">팬미팅</strong>
                              <span className="t-xs muted" style={{ display: "block" }}>대체 텍스트: 팬미팅, 10/28(수) 20:00 오픈</span>
                            </td>
                            <td className="num">
                              10/14(수) 12:00 ~
                              <br />
                              10/28(수) 20:00 KST
                            </td>
                            <td>
                              <span className="badge badge-success">
                                <i className="ic ic-check" aria-hidden="true" />
                                게시 중
                              </span>
                            </td>
                            <td>
                              <button className="btn btn-ghost btn-sm" type="button" aria-label="팬미팅 배너 편집">
                                <i className="ic ic-edit" aria-hidden="true" />
                                편집
                              </button>
                            </td>
                          </tr>
                          <tr>
                            <td>
                              <span className="row" style={{ gap: "2px" }}>
                                <button className="icon-btn icon-btn-sm" type="button" aria-label="3번 배너 순서 바꾸기">
                                  <i className="ic ic-grip" aria-hidden="true" />
                                </button>
                                <span className="num fw-b">3</span>
                              </span>
                            </td>
                            <td>
                              <span className="poster poster-fest" role="img" aria-label="배너 이미지 미리보기: 가을 야외 페스티벌" style={{ aspectRatio: "1240/400", width: "112px", padding: "0", borderRadius: "6px" }} />
                            </td>
                            <td>
                              <strong className="fw-b">가을 야외 페스티벌</strong>
                              <span className="t-xs muted" style={{ display: "block" }}>대체 텍스트: 가을 야외 페스티벌, 11/7(토) 피켓 아레나</span>
                            </td>
                            <td className="num">
                              10/16(금) 00:00 ~
                              <br />
                              11/7(토) [시각] KST
                            </td>
                            <td>
                              <span className="badge badge-primary">
                                <i className="ic ic-clock" aria-hidden="true" />
                                예정
                              </span>
                            </td>
                            <td>
                              <button className="btn btn-ghost btn-sm" type="button" aria-label="가을 야외 페스티벌 배너 편집">
                                <i className="ic ic-edit" aria-hidden="true" />
                                편집
                              </button>
                            </td>
                          </tr>
                          <tr>
                            <td className="muted">—</td>
                            <td>
                              <span className="poster poster-musical" role="img" aria-label="배너 이미지 미리보기: 소극장 뮤지컬" style={{ aspectRatio: "1240/400", width: "112px", padding: "0", borderRadius: "6px", opacity: ".6" }} />
                            </td>
                            <td>
                              <strong className="fw-b">소극장 뮤지컬</strong>
                              <span className="t-xs muted" style={{ display: "block" }}>대체 텍스트: 소극장 뮤지컬, 회차 3개</span>
                            </td>
                            <td className="num muted">
                              10/1(목) 00:00 ~
                              <br />
                              10/12(월) 23:59 KST
                            </td>
                            <td><span className="badge">끝남</span></td>
                            <td>
                              <button className="btn btn-ghost btn-sm" type="button" aria-label="소극장 뮤지컬 배너 보기">
                                <i className="ic ic-eye" aria-hidden="true" />
                                보기
                              </button>
                            </td>
                          </tr>
                          <tr>
                            <td className="muted">—</td>
                            <td>
                              <span className="poster poster-gala" role="img" aria-label="배너 이미지 미리보기: [공연명]" style={{ aspectRatio: "1240/400", width: "112px", padding: "0", borderRadius: "6px", opacity: ".6" }} />
                            </td>
                            <td>
                              <strong className="fw-b">[공연명]</strong>
                              <span className="t-xs muted" style={{ display: "block" }}>대체 텍스트: [대체 텍스트]</span>
                            </td>
                            <td className="num muted">[노출 기간]</td>
                            <td>
                              <span className="badge badge-warning">
                                <i className="ic ic-eye-off" aria-hidden="true" />
                                노출 안 됨
                              </span>
                              <span className="t-xs muted" style={{ display: "block", marginTop: "4px" }}>판매 승인이 풀림</span>
                            </td>
                            <td>
                              <button className="btn btn-ghost btn-sm" type="button" aria-label="[공연명] 배너 보기">
                                <i className="ic ic-eye" aria-hidden="true" />
                                보기
                              </button>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="hint">노출 기간이 끝났거나 판매 승인이 풀렸거나 회차가 모두 취소된 공연은 홈에서 자동으로 빠집니다.</p>
                  </div>
                </section>
                <section className="widget" aria-labelledby="h-ht">
                  <div className="widget-head">
                    <h2 className="t-sm fw-b" id="h-ht">테마</h2>
                    <span className="t-xs muted fw-r">3개</span>
                    <span className="actions">
                      <button className="btn btn-secondary btn-sm" type="button" {...ro()}>
                        <i className="ic ic-plus" aria-hidden="true" />
                        테마 추가
                      </button>
                    </span>
                  </div>
                  <div className="widget-body" style={{ padding: "12px" }}>
                    <div className="table-wrap">
                      <table className="table dense">
                        <caption className="sr-only">홈 테마 3개(게시 중 2, 예정 1)</caption>
                        <thead>
                          <tr>
                            <th scope="col">순서</th>
                            <th scope="col">테마 이름</th>
                            <th scope="col" className="r">공연 수</th>
                            <th scope="col">노출 기간</th>
                            <th scope="col">상태</th>
                            <th scope="col"><span className="sr-only">작업</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td>
                              <span className="row" style={{ gap: "2px" }}>
                                <button className="icon-btn icon-btn-sm" type="button" aria-label="1번 테마 순서 바꾸기">
                                  <i className="ic ic-grip" aria-hidden="true" />
                                </button>
                                <span className="num fw-b">1</span>
                              </span>
                            </td>
                            <td><strong className="fw-b">[테마 이름 1]</strong></td>
                            <td className="r">6개</td>
                            <td className="num">10/12(월) ~ 10/31(토)</td>
                            <td>
                              <span className="badge badge-success">
                                <i className="ic ic-check" aria-hidden="true" />
                                게시 중
                              </span>
                            </td>
                            <td>
                              <button className="btn btn-ghost btn-sm" type="button" aria-label="[테마 이름 1] 테마 편집">
                                <i className="ic ic-edit" aria-hidden="true" />
                                편집
                              </button>
                            </td>
                          </tr>
                          <tr>
                            <td>
                              <span className="row" style={{ gap: "2px" }}>
                                <button className="icon-btn icon-btn-sm" type="button" aria-label="2번 테마 순서 바꾸기">
                                  <i className="ic ic-grip" aria-hidden="true" />
                                </button>
                                <span className="num fw-b">2</span>
                              </span>
                            </td>
                            <td><strong className="fw-b">[테마 이름 2]</strong></td>
                            <td className="r">6개</td>
                            <td className="num">10/14(수) ~ 11/7(토)</td>
                            <td>
                              <span className="badge badge-success">
                                <i className="ic ic-check" aria-hidden="true" />
                                게시 중
                              </span>
                            </td>
                            <td>
                              <button className="btn btn-ghost btn-sm" type="button" aria-label="[테마 이름 2] 테마 편집">
                                <i className="ic ic-edit" aria-hidden="true" />
                                편집
                              </button>
                            </td>
                          </tr>
                          <tr>
                            <td>
                              <span className="row" style={{ gap: "2px" }}>
                                <button className="icon-btn icon-btn-sm" type="button" aria-label="3번 테마 순서 바꾸기">
                                  <i className="ic ic-grip" aria-hidden="true" />
                                </button>
                                <span className="num fw-b">3</span>
                              </span>
                            </td>
                            <td><strong className="fw-b">[테마 이름 3]</strong></td>
                            <td className="r">4개</td>
                            <td className="num">10/19(월) ~ 11/15(일)</td>
                            <td>
                              <span className="badge badge-primary">
                                <i className="ic ic-clock" aria-hidden="true" />
                                예정
                              </span>
                            </td>
                            <td>
                              <button className="btn btn-ghost btn-sm" type="button" aria-label="[테마 이름 3] 테마 편집">
                                <i className="ic ic-edit" aria-hidden="true" />
                                편집
                              </button>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="hint">테마 이름은 20자 [가정]까지이고, 판매 승인된 공연을 골라 순서를 정합니다.</p>
                  </div>
                </section>
              </div>
              <div className="span-4 col" style={{ gap: "16px" }}>
                <section className="widget" aria-labelledby="h-hp">
                  <div className="widget-head">
                    <h2 className="t-sm fw-b" id="h-hp">미리보기</h2>
                    <span className="actions t-xs muted fw-r">홈 슬라이드·테마 줄 모양</span>
                  </div>
                  <div className="widget-body" style={{ padding: "14px", gap: "12px" }}>
                    <div style={{ position: "relative" }}>
                      <span className="poster poster-lumen" role="img" aria-label="미리보기 1번 배너: LUMEN 콘서트 2026 서울" style={{ aspectRatio: "1240/400", borderRadius: "10px", padding: "10px 12px" }}>
                        <span className="poster-title" style={{ fontSize: "14px", lineHeight: "16px" }}>LUMEN</span>
                      </span>
                      {' '}
                      <span className="t-xs fw-b num" style={{ position: "absolute", right: "8px", bottom: "8px", padding: "2px 8px", borderRadius: "999px", background: "var(--inverse)", color: "var(--on-inverse)" }}>
                        1 / 2
                      </span>
                    </div>
                    <div className="col" style={{ gap: "6px" }}>
                      <span className="t-xs fw-b">[테마 이름 1]</span>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,minmax(0,1fr))", gap: "6px" }} aria-hidden="true">
                        <span className="poster poster-sm poster-lumen" style={{ padding: "0" }} />
                        {' '}
                        <span className="poster poster-sm poster-fanmeet" style={{ padding: "0" }} />
                        {' '}
                        <span className="poster poster-sm poster-fest" style={{ padding: "0" }} />
                        {' '}
                        <span className="poster poster-sm poster-musical" style={{ padding: "0" }} />
                        {' '}
                        <span className="poster poster-sm poster-gala" style={{ padding: "0" }} />
                      </div>
                    </div>
                    <button className="btn btn-outline btn-sm" type="button" style={{ alignSelf: "flex-start" }} {...ro()}>
                      <i className="ic ic-eye" aria-hidden="true" />
                      홈 전체 미리보기
                    </button>
                  </div>
                </section>
                <section className="widget" aria-labelledby="h-hpub">
                  <div className="widget-head"><h2 className="t-sm fw-b" id="h-hpub">게시</h2></div>
                  <div className="widget-body" style={{ padding: "14px", gap: "10px" }}>
                    <dl className="kv" style={{ fontSize: "13px" }}>
                      <dt>마지막 게시</dt>
                      <dd>10/14(수) 12:00 KST · 민호(operator)</dd>
                      <dt>게시할 배너</dt>
                      <dd>게시 중 2 · 예정 1</dd>
                      <dt>게시할 테마</dt>
                      <dd>게시 중 2 · 예정 1</dd>
                    </dl>
                    <p className="hint" id="hpub-h">게시하면 1분 안에 홈에 반영됩니다 [가정]. 게시와 변경은 감사 로그에 남습니다.</p>
                    <button className="btn btn-primary btn-block" type="button" {...ro('hpub-h')}>
                      <i className="ic ic-upload" aria-hidden="true" />
                      홈에 게시하기
                    </button>
                  </div>
                </section>
                <section className="widget" aria-labelledby="h-hlog">
                  <div className="widget-head">
                    <h2 className="t-sm fw-b" id="h-hlog">변경 이력</h2>
                    <span className="actions">
                      <Link to="/audit" className="link-more" style={{ fontSize: "12px" }}>
                        감사 로그에서 보기
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </span>
                  </div>
                  <div className="widget-body" style={{ padding: "6px 14px 10px", gap: "0" }}>
                    <ol className="col">
                      <li className="col" style={{ gap: "2px", padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
                        <span className="t-sm">
                          <strong className="fw-b">홈 구성 게시</strong>
                          {' '}· 배너 2 · 테마 2
                        </span>
                        <span className="t-xs muted num">10/14(수) 12:00 KST · 민호(operator)</span>
                      </li>
                      <li className="col" style={{ gap: "2px", padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
                        <span className="t-sm">
                          <strong className="fw-b">배너 추가</strong>
                          {' '}· 팬미팅
                        </span>
                        <span className="t-xs muted num">10/14(수) 11:52 KST · 민호(operator)</span>
                      </li>
                      <li className="col" style={{ gap: "2px", padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
                        <span className="t-sm">
                          <strong className="fw-b">테마 순서 바꿈</strong>
                          {' '}· [테마 이름 2] → 2번
                        </span>
                        <span className="t-xs muted num">10/13(화) 16:40 KST · 수진(commander)</span>
                      </li>
                      <li className="col" style={{ gap: "2px", padding: "9px 0" }}>
                        <span className="t-sm">
                          <strong className="fw-b">노출 끝남(자동)</strong>
                          {' '}· 소극장 뮤지컬 배너
                        </span>
                        <span className="t-xs muted num">10/12(월) 23:59 KST · 시스템</span>
                      </li>
                    </ol>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      </>
    ) : null}
    </>
  );
}
