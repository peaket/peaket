// 디자인 캔버스 보드 SCR-059-console-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';
import { copyLink } from '@/shared/lib/clipboard';

const prevent = (e: FormEvent) => e.preventDefault();
const reload = () => window.location.reload();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_M = ["500", "404", "429", "미지원", "미지원(인앱 브라우저)", "화면 불러오기 실패", "화면 불러오기 실패(새 버전)"] as const;
export const DEFAULT_M = "500";

export function valsM(state: string) {
    let st = state || '500';
    return {
      is500: st === '500',
      is404: st === '404',
      is429: st === '429',
      isUnsupported: st === '미지원',
      isInApp: st === '미지원(인앱 브라우저)',
      isChunk: st === '화면 불러오기 실패',
      isChunkNew: st === '화면 불러오기 실패(새 버전)',
      isChunkAny: st === '화면 불러오기 실패' || st === '화면 불러오기 실패(새 버전)',
      notChunk: !(st === '화면 불러오기 실패' || st === '화면 불러오기 실패(새 버전)')
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:820px"}

// <main class="cs-main" id="main" style="justify-content:center">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="col" style={{ width: "100%" }}>
      {v.is500 ? (
        <>
          <section className="card">
            <div className="state" role="alert" style={{ padding: "32px 20px" }}>
              <span className="state-icon is-danger" style={{ width: "56px", height: "56px" }}>
                <i className="ic ic-alert-circle" aria-hidden="true" />
              </span>
              <h1 className="t-lg">일시적인 오류입니다</h1>
              <p className="t-sm muted">잠시 후 다시 시도해 주세요</p>
              <div className="col" style={{ gap: "8px", alignItems: "center", marginTop: "4px" }}>
                <button onClick={reload} className="btn btn-primary btn-lg" type="button">
                  <i className="ic ic-refresh" aria-hidden="true" />
                  다시 시도
                </button>
                {' '}
                <Link to="/dashboard" className="link-more" style={{ minHeight: "44px" }}>
                  대시보드로 가기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </section>
        </>
      ) : null}
      {' '}
      {v.is404 ? (
        <>
          <section className="card">
            <div className="state" style={{ padding: "32px 20px" }}>
              <span className="state-icon" style={{ width: "56px", height: "56px" }}><i className="ic ic-search" aria-hidden="true" /></span>
              <h1 className="t-lg">찾을 수 없습니다</h1>
              <p className="t-sm muted">주소를 다시 확인하거나 메뉴에서 찾아 주세요.</p>
              <Link to="/dashboard" className="btn btn-secondary btn-lg" style={{ marginTop: "4px" }}>
                <i className="ic ic-home" aria-hidden="true" />
                대시보드로 가기
              </Link>
            </div>
          </section>
        </>
      ) : null}
      {' '}
      {v.is429 ? (
        <>
          <section className="card">
            <div className="state" style={{ padding: "32px 20px" }}>
              <span className="state-icon is-warning" style={{ width: "56px", height: "56px" }}><i className="ic ic-clock" aria-hidden="true" /></span>
              <h1 className="t-lg">요청이 많아 잠시 기다려야 합니다</h1>
              <p className="t-md" role="timer">
                <strong className="num">18초</strong>
                {' '}뒤 자동으로 다시 시도합니다
              </p>
              <p className="t-sm muted">이 화면을 그대로 두면 됩니다.</p>
            </div>
          </section>
        </>
      ) : null}
      {' '}
      {v.isUnsupported ? (
        <>
          <section className="card">
            <div className="state" style={{ padding: "32px 20px" }}>
              <span className="state-icon is-warning" style={{ width: "56px", height: "56px" }}><i className="ic ic-globe" aria-hidden="true" /></span>
              <h1 className="t-lg">지원하지 않는 브라우저입니다</h1>
              <p className="t-sm muted">iPhone·iPad는 Safari(iOS·iPadOS 16.4 이상), Android는 Chrome·삼성 인터넷에서 열어 주세요</p>
              <button onClick={copyLink} className="btn btn-secondary btn-lg" type="button" style={{ marginTop: "4px" }}>
                <i className="ic ic-copy" aria-hidden="true" />
                주소 복사
              </button>
            </div>
          </section>
        </>
      ) : null}
      {' '}
      {v.isInApp ? (
        <>
          <section className="card">
            <div className="state" style={{ padding: "32px 20px" }}>
              <span className="state-icon is-warning" style={{ width: "56px", height: "56px" }}>
                <i className="ic ic-external" aria-hidden="true" />
              </span>
              <h1 className="t-lg">지원하지 않는 브라우저입니다</h1>
              <p className="t-sm muted">이 앱 안의 브라우저에서는 콘솔을 열 수 없습니다</p>
              <p className="t-xs muted">iPhone·iPad는 Safari(iOS·iPadOS 16.4 이상), Android는 Chrome·삼성 인터넷에서 열어 주세요</p>
              <div className="col" style={{ gap: "10px", width: "100%", marginTop: "4px" }}>
                <button onClick={copyLink} className="btn btn-primary btn-lg btn-block" type="button" aria-describedby="ia-h">
                  <i className="ic ic-external" aria-hidden="true" />
                  다른 브라우저로 열기
                </button>
                {' '}
                <button onClick={copyLink} className="btn btn-secondary btn-lg btn-block" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  주소 복사
                </button>
              </div>
              <p className="hint" id="ia-h">Android는 바로 열고, iPhone은 여는 방법을 안내합니다</p>
            </div>
          </section>
        </>
      ) : null}
      {' '}
      {v.isChunkNew ? (
        <>
          <div className="banner banner-info" role="status" style={{ alignItems: "center", marginBottom: "16px" }}>
            <i className="ic ic-info" aria-hidden="true" />
            <div className="banner-body"><span className="banner-title">새 버전이 있습니다</span></div>
            <button onClick={reload} className="btn btn-primary btn-sm" type="button">
              <i className="ic ic-refresh" aria-hidden="true" />
              새로고침
            </button>
          </div>
        </>
      ) : null}
      {' '}
      {v.isChunkAny ? (
        <>
          <section className="card">
            <div className="state" role="alert" style={{ padding: "32px 20px" }}>
              <span className="state-icon is-warning" style={{ width: "56px", height: "56px" }}><i className="ic ic-alert" aria-hidden="true" /></span>
              <h1 className="t-lg">화면을 불러오지 못했습니다</h1>
              <p className="t-sm muted">위 상태 바와 경보는 그대로 받습니다</p>
              <div className="col" style={{ gap: "8px", width: "100%", marginTop: "4px" }}>
                {v.isChunk ? (
                  <>
                    <button onClick={reload} className="btn btn-primary btn-lg btn-block" type="button">
                      <i className="ic ic-refresh" aria-hidden="true" />
                      다시 시도
                    </button>
                  </>
                ) : null}
                {' '}
                {v.isChunkNew ? (
                  <>
                    <button onClick={reload} className="btn btn-secondary btn-lg btn-block" type="button">
                      <i className="ic ic-refresh" aria-hidden="true" />
                      다시 시도
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
    </>
  );
}

