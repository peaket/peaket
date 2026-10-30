// 디자인 캔버스 보드 SCR-068-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';
import { useRo } from '@/features/screen-access';
import { copyLink } from '@/shared/lib/clipboard';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_M = ["템플릿", "파트너 긴급 공지", "승인된 템플릿 없음", "홈 구성"] as const;
export const DEFAULT_M = "템플릿";

export function valsM(state: string) {
    let st = state || '템플릿';
    return {
      tplTab: st === '템플릿' || st === '승인된 템플릿 없음',
      partnerTab: st === '파트너 긴급 공지',
      homeTab: st === '홈 구성',
      hasApproved: st === '템플릿',
      noApproved: st === '승인된 템플릿 없음'
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:1900px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
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
        <div className="col" style={{ gap: "12px" }}>
          <div className="tabs tabs-scroll" role="tablist" aria-label="공지 종류">
            <button onClick={() => go?.('템플릿')} className="tab is-active" role="tab" id="nt-tpl" aria-selected="true" aria-controls="np-tpl" type="button">대기실 공지 템플릿</button>
            {' '}
            <button onClick={() => go?.('파트너 긴급 공지')} className="tab" role="tab" id="nt-partner" aria-selected="false" type="button">파트너 긴급 공지</button>
            {' '}
            <button onClick={() => go?.('홈 구성')} className="tab" role="tab" id="nt-home" aria-selected="false" type="button">홈 구성</button>
          </div>
          <div className="col" role="tabpanel" id="np-tpl" aria-labelledby="nt-tpl" style={{ gap: "12px" }}>
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
            <section className="widget" aria-labelledby="h-tpl">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-tpl">대기실 공지 템플릿</h2>
                <span className="actions t-xs muted">2개</span>
              </div>
              <div className="widget-body" style={{ padding: "12px" }}>
                {v.hasApproved ? (
                  <>
                    <ul className="col" style={{ gap: "10px" }} aria-label="대기실 공지 템플릿 2개(승인됨 1, 검토 중 1)">
                      <li className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                        <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <h3 className="t-md fw-b">결제 지연 안내</h3>
                          <span className="badge badge-warning">
                            <i className="ic ic-clock" aria-hidden="true" />
                            검토 중
                          </span>
                        </div>
                        <blockquote className="card-flat t-sm" style={{ padding: "10px 12px" }}>
                          결제 대행사 점검으로 결제가 잠시 늦어질 수 있습니다. 대기 순서는 그대로입니다.
                        </blockquote>
                        <p className="hint">ko·en·ja·zh 문구가 모두 있습니다. 승인 전 초안입니다</p>
                        <dl className="kv">
                          <dt>언어</dt>
                          <dd>
                            <span className="row" style={{ gap: "4px", justifyContent: "flex-end" }}>
                              <span className="badge badge-outline">ko</span>
                              <span className="badge badge-outline">en</span>
                              <span className="badge badge-outline">ja</span>
                              <span className="badge badge-outline">zh</span>
                            </span>
                          </dd>
                          <dt>승인자</dt>
                          <dd className="muted">commander 승인 대기</dd>
                          <dt>마지막 사용</dt>
                          <dd className="muted">없음</dd>
                        </dl>
                        <Link to="/notices" className="link-more" style={{ alignSelf: "flex-start" }} aria-label="결제 지연 안내 템플릿 보기">
                          템플릿 보기
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      </li>
                      <li className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                        <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <h3 className="t-md fw-b">입장 지연 안내</h3>
                          <span className="badge badge-success">
                            <i className="ic ic-check" aria-hidden="true" />
                            승인됨
                          </span>
                        </div>
                        <blockquote className="card-flat t-sm" style={{ padding: "10px 12px" }}>
                          접속이 많아 입장이 평소보다 늦어질 수 있습니다. 대기 순서는 그대로이며, 새로고침하지 않아도 자동으로 이어집니다.
                        </blockquote>
                        <dl className="kv">
                          <dt>언어</dt>
                          <dd>
                            <span className="row" style={{ gap: "4px", justifyContent: "flex-end" }}>
                              <span className="badge badge-outline">ko</span>
                              <span className="badge badge-outline">en</span>
                              <span className="badge badge-outline">ja</span>
                              <span className="badge badge-outline">zh</span>
                            </span>
                          </dd>
                          <dt>승인자</dt>
                          <dd>
                            수진(commander)
                            <span className="t-xs muted fw-r" style={{ display: "block" }}>10/13(화) 16:20 KST</span>
                          </dd>
                          <dt>마지막 사용</dt>
                          <dd className="muted">없음</dd>
                        </dl>
                        <Link to="/notices" className="link-more" style={{ alignSelf: "flex-start" }} aria-label="입장 지연 안내 템플릿 보기">
                          템플릿 보기
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      </li>
                    </ul>
                  </>
                ) : null}
                {' '}
                {v.noApproved ? (
                  <>
                    <ul className="col" style={{ gap: "10px" }} aria-label="대기실 공지 템플릿 2개(모두 검토 중)">
                      <li className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                        <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <h3 className="t-md fw-b">결제 지연 안내</h3>
                          <span className="badge badge-warning">
                            <i className="ic ic-clock" aria-hidden="true" />
                            검토 중
                          </span>
                        </div>
                        <blockquote className="card-flat t-sm" style={{ padding: "10px 12px" }}>
                          결제 대행사 점검으로 결제가 잠시 늦어질 수 있습니다. 대기 순서는 그대로입니다.
                        </blockquote>
                        <p className="hint">ko·en·ja·zh 문구가 모두 있습니다. 승인 전 초안입니다</p>
                        <dl className="kv">
                          <dt>언어</dt>
                          <dd>
                            <span className="row" style={{ gap: "4px", justifyContent: "flex-end" }}>
                              <span className="badge badge-outline">ko</span>
                              <span className="badge badge-outline">en</span>
                              <span className="badge badge-outline">ja</span>
                              <span className="badge badge-outline">zh</span>
                            </span>
                          </dd>
                          <dt>승인자</dt>
                          <dd className="muted">commander 승인 대기</dd>
                          <dt>마지막 사용</dt>
                          <dd className="muted">없음</dd>
                        </dl>
                        <Link to="/notices" className="link-more" style={{ alignSelf: "flex-start" }} aria-label="결제 지연 안내 템플릿 보기">
                          템플릿 보기
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      </li>
                      <li className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                        <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <h3 className="t-md fw-b">입장 지연 안내</h3>
                          <span className="badge badge-warning">
                            <i className="ic ic-clock" aria-hidden="true" />
                            검토 중
                          </span>
                        </div>
                        <blockquote className="card-flat t-sm" style={{ padding: "10px 12px" }}>
                          접속이 많아 입장이 평소보다 늦어질 수 있습니다. 대기 순서는 그대로이며, 새로고침하지 않아도 자동으로 이어집니다.
                        </blockquote>
                        <dl className="kv">
                          <dt>언어</dt>
                          <dd>
                            <span className="row" style={{ gap: "4px", justifyContent: "flex-end" }}>
                              <span className="badge badge-outline">ko</span>
                              <span className="badge badge-outline">en</span>
                              <span className="badge badge-outline">ja</span>
                              <span className="badge badge-outline">zh</span>
                            </span>
                          </dd>
                          <dt>승인자</dt>
                          <dd className="muted">commander 승인 대기</dd>
                          <dt>마지막 사용</dt>
                          <dd className="muted">없음</dd>
                        </dl>
                        <Link to="/notices" className="link-more" style={{ alignSelf: "flex-start" }} aria-label="입장 지연 안내 템플릿 보기">
                          템플릿 보기
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      </li>
                    </ul>
                  </>
                ) : null}
                <p className="hint" style={{ marginTop: "10px" }}>검토 중 템플릿은 운영 명령 7의 템플릿 목록에 나오지 않습니다.</p>
              </div>
            </section>
            <div className="banner banner-info bigscreen" role="note">
              <i className="ic ic-monitor" aria-hidden="true" />
              <div className="banner-body" style={{ flexBasis: "200px" }}>
                <span className="banner-title" id="bg-tpl">템플릿 작성·승인은 태블릿이나 데스크톱에서 합니다</span>
                휴대폰에서는 볼 수만 있습니다
              </div>
              <button onClick={copyLink} className="btn btn-outline btn-sm" type="button" aria-describedby="bg-tpl">
                <i className="ic ic-copy" aria-hidden="true" />
                링크 복사
              </button>
            </div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.partnerTab ? (
      <>
        <div className="col" style={{ gap: "12px" }}>
          <div className="tabs tabs-scroll" role="tablist" aria-label="공지 종류">
            <button onClick={() => go?.('템플릿')} className="tab" role="tab" id="nt-tpl2" aria-selected="false" type="button">대기실 공지 템플릿</button>
            {' '}
            <button onClick={() => go?.('파트너 긴급 공지')} className="tab is-active" role="tab" id="nt-partner2" aria-selected="true" aria-controls="np-partner" type="button">
              파트너 긴급 공지
            </button>
            {' '}
            <button onClick={() => go?.('홈 구성')} className="tab" role="tab" id="nt-home2" aria-selected="false" type="button">홈 구성</button>
          </div>
          <div className="col" role="tabpanel" id="np-partner" aria-labelledby="nt-partner2" style={{ gap: "12px" }}>
            <div className="banner banner-info bigscreen" role="note">
              <i className="ic ic-monitor" aria-hidden="true" />
              <div className="banner-body" style={{ flexBasis: "200px" }}>
                <span className="banner-title" id="bg-pn">파트너 긴급 공지 보내기는 태블릿이나 데스크톱에서 합니다</span>
                휴대폰에서는 볼 수만 있습니다
              </div>
              <button onClick={copyLink} className="btn btn-outline btn-sm" type="button" aria-describedby="bg-pn">
                <i className="ic ic-copy" aria-hidden="true" />
                링크 복사
              </button>
            </div>
            <section className="widget" aria-labelledby="h-ph">
              <div className="widget-head"><h2 className="t-sm fw-b" id="h-ph">발송 이력</h2></div>
              <div className="widget-body" style={{ padding: "12px" }}>
                <div className="state" style={{ padding: "24px 16px", gap: "8px" }}>
                  <span className="state-icon" style={{ width: "44px", height: "44px" }}><i className="ic ic-mail" aria-hidden="true" /></span>
                  <p className="t-sm muted">보낸 긴급 공지가 없습니다</p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.homeTab ? (
      <>
        <div className="col" style={{ gap: "12px" }}>
          <div className="tabs tabs-scroll" role="tablist" aria-label="공지 종류">
            <button onClick={() => go?.('템플릿')} className="tab" role="tab" id="nt-tpl3" aria-selected="false" type="button">대기실 공지 템플릿</button>
            {' '}
            <button onClick={() => go?.('파트너 긴급 공지')} className="tab" role="tab" id="nt-partner3" aria-selected="false" type="button">파트너 긴급 공지</button>
            {' '}
            <button onClick={() => go?.('홈 구성')} className="tab is-active" role="tab" id="nt-home3" aria-selected="true" aria-controls="np-home" type="button">홈 구성</button>
          </div>
          <div className="col" role="tabpanel" id="np-home" aria-labelledby="nt-home3" style={{ gap: "12px" }}>
            <div className="banner banner-info bigscreen" role="note">
              <i className="ic ic-monitor" aria-hidden="true" />
              <div className="banner-body" style={{ flexBasis: "200px" }}>
                <span className="banner-title" id="bg-home">홈 구성 편집·게시는 태블릿이나 데스크톱에서 합니다</span>
                휴대폰에서는 볼 수만 있습니다
              </div>
              <button onClick={copyLink} className="btn btn-outline btn-sm" type="button" aria-describedby="bg-home">
                <i className="ic ic-copy" aria-hidden="true" />
                링크 복사
              </button>
            </div>
            <section className="widget" aria-labelledby="h-hb">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-hb">배너</h2>
                <span className="actions t-xs muted fw-r">5장 · 최대 10장 [가정]</span>
              </div>
              <div className="widget-body" style={{ padding: "12px" }}>
                <ul className="col" style={{ gap: "10px" }} aria-label="홈 배너 5장(게시 중 2, 예정 1, 끝남 1, 노출 안 됨 1)">
                  <li className="card" style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div className="row" style={{ gap: "10px" }}>
                      <span className="num fw-b" style={{ minWidth: "16px" }}>1</span>
                      <span className="poster poster-lumen" role="img" aria-label="배너 이미지 미리보기: LUMEN 콘서트 2026 서울" style={{ aspectRatio: "1240/400", width: "96px", padding: "0", borderRadius: "6px" }} />
                      <span className="badge badge-success" style={{ marginLeft: "auto" }}>
                        <i className="ic ic-check" aria-hidden="true" />
                        게시 중
                      </span>
                    </div>
                    <h3 className="t-sm fw-b">LUMEN 콘서트 2026 서울</h3>
                    <p className="t-xs muted">대체 텍스트: LUMEN 콘서트 2026 서울, 10/25(일)~10/26(월) 피켓 아레나</p>
                    <p className="t-xs num">10/10(토) 00:00 ~ 10/26(월) 17:00 KST</p>
                  </li>
                  <li className="card" style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div className="row" style={{ gap: "10px" }}>
                      <span className="num fw-b" style={{ minWidth: "16px" }}>2</span>
                      <span className="poster poster-fanmeet" role="img" aria-label="배너 이미지 미리보기: 팬미팅" style={{ aspectRatio: "1240/400", width: "96px", padding: "0", borderRadius: "6px" }} />
                      <span className="badge badge-success" style={{ marginLeft: "auto" }}>
                        <i className="ic ic-check" aria-hidden="true" />
                        게시 중
                      </span>
                    </div>
                    <h3 className="t-sm fw-b">팬미팅</h3>
                    <p className="t-xs muted">대체 텍스트: 팬미팅, 10/28(수) 20:00 오픈</p>
                    <p className="t-xs num">10/14(수) 12:00 ~ 10/28(수) 20:00 KST</p>
                  </li>
                  <li className="card" style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div className="row" style={{ gap: "10px" }}>
                      <span className="num fw-b" style={{ minWidth: "16px" }}>3</span>
                      <span className="poster poster-fest" role="img" aria-label="배너 이미지 미리보기: 가을 야외 페스티벌" style={{ aspectRatio: "1240/400", width: "96px", padding: "0", borderRadius: "6px" }} />
                      <span className="badge badge-primary" style={{ marginLeft: "auto" }}>
                        <i className="ic ic-clock" aria-hidden="true" />
                        예정
                      </span>
                    </div>
                    <h3 className="t-sm fw-b">가을 야외 페스티벌</h3>
                    <p className="t-xs muted">대체 텍스트: 가을 야외 페스티벌, 11/7(토) 피켓 아레나</p>
                    <p className="t-xs num">10/16(금) 00:00 ~ 11/7(토) [시각] KST</p>
                  </li>
                  <li className="card" style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div className="row" style={{ gap: "10px" }}>
                      <span className="num fw-b muted" style={{ minWidth: "16px" }}>—</span>
                      <span className="poster poster-musical" role="img" aria-label="배너 이미지 미리보기: 소극장 뮤지컬" style={{ aspectRatio: "1240/400", width: "96px", padding: "0", borderRadius: "6px", opacity: ".6" }} />
                      <span className="badge" style={{ marginLeft: "auto" }}>끝남</span>
                    </div>
                    <h3 className="t-sm fw-b">소극장 뮤지컬</h3>
                    <p className="t-xs num muted">10/1(목) 00:00 ~ 10/12(월) 23:59 KST</p>
                  </li>
                  <li className="card" style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div className="row" style={{ gap: "10px" }}>
                      <span className="num fw-b muted" style={{ minWidth: "16px" }}>—</span>
                      <span className="poster poster-gala" role="img" aria-label="배너 이미지 미리보기: [공연명]" style={{ aspectRatio: "1240/400", width: "96px", padding: "0", borderRadius: "6px", opacity: ".6" }} />
                      <span className="badge badge-warning" style={{ marginLeft: "auto" }}>
                        <i className="ic ic-eye-off" aria-hidden="true" />
                        노출 안 됨
                      </span>
                    </div>
                    <h3 className="t-sm fw-b">[공연명]</h3>
                    <p className="t-xs muted">판매 승인이 풀림 · 홈에서 자동으로 빠졌습니다</p>
                  </li>
                </ul>
              </div>
            </section>
            <section className="widget" aria-labelledby="h-ht">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-ht">테마</h2>
                <span className="actions t-xs muted fw-r">3개</span>
              </div>
              <div className="widget-body" style={{ padding: "4px 14px 8px", gap: "0" }}>
                <ol className="col">
                  <li className="row between" style={{ gap: "8px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">1. [테마 이름 1]</span>
                      <span className="t-xs muted num">공연 6개 · 10/12(월) ~ 10/31(토)</span>
                    </span>
                    <span className="badge badge-success">
                      <i className="ic ic-check" aria-hidden="true" />
                      게시 중
                    </span>
                  </li>
                  <li className="row between" style={{ gap: "8px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">2. [테마 이름 2]</span>
                      <span className="t-xs muted num">공연 6개 · 10/14(수) ~ 11/7(토)</span>
                    </span>
                    <span className="badge badge-success">
                      <i className="ic ic-check" aria-hidden="true" />
                      게시 중
                    </span>
                  </li>
                  <li className="row between" style={{ gap: "8px", padding: "10px 0" }}>
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">3. [테마 이름 3]</span>
                      <span className="t-xs muted num">공연 4개 · 10/19(월) ~ 11/15(일)</span>
                    </span>
                    <span className="badge badge-primary">
                      <i className="ic ic-clock" aria-hidden="true" />
                      예정
                    </span>
                  </li>
                </ol>
              </div>
            </section>
            <section className="widget" aria-labelledby="h-hlog">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-hlog">변경 이력</h2>
                <span className="actions t-xs muted fw-r">마지막 게시 10/14(수) 12:00 KST</span>
              </div>
              <div className="widget-body" style={{ padding: "4px 14px 10px", gap: "0" }}>
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
                <Link to="/audit" className="link-more" style={{ paddingTop: "6px", fontSize: "12px" }}>
                  감사 로그에서 보기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            </section>
          </div>
        </div>
      </>
    ) : null}
    </>
  );
}

