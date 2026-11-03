// 디자인 캔버스 보드 SCR-059-console.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
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

export const STATES_D = ["500", "404", "429", "미지원", "화면 불러오기 실패", "화면 불러오기 실패(새 버전)"] as const;
export const DEFAULT_D = "500";

export function valsD(state: string) {
    let st = state || '500';
    return {
      is500: st === '500',
      is404: st === '404',
      is429: st === '429',
      isUnsupported: st === '미지원',
      isChunk: st === '화면 불러오기 실패',
      isChunkNew: st === '화면 불러오기 실패(새 버전)',
      isChunkAny: st === '화면 불러오기 실패' || st === '화면 불러오기 실패(새 버전)',
      notChunk: !(st === '화면 불러오기 실패' || st === '화면 불러오기 실패(새 버전)')
    };
  }

type V = ReturnType<typeof valsD>;

// 보드 루트: {"class": "pk dark cs", "style": "width:100%;min-height:800px;grid-template-rows:auto 1fr"}

// <main class="cs-main" id="main" style="justify-content:center;align-items:center;padding:40px 20px">
export function MainD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="col" style={{ width: "100%", maxWidth: "560px" }}>
      {v.is500 ? (
        <>
          <section className="card">
            <div className="state" role="alert" style={{ padding: "48px 32px" }}>
              <span className="state-icon is-danger"><i className="ic ic-alert-circle" aria-hidden="true" /></span>
              <h1 className="t-xl">일시적인 오류입니다</h1>
              <p className="t-md muted">잠시 후 다시 시도해 주세요</p>
              <div className="row wrap" style={{ gap: "12px 20px", justifyContent: "center", marginTop: "8px" }}>
                <button onClick={reload} className="btn btn-primary" type="button">
                  <i className="ic ic-refresh" aria-hidden="true" />
                  다시 시도
                </button>
                {' '}
                <Link to="/dashboard" className="link-more">
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
            <div className="state" style={{ padding: "48px 32px" }}>
              <span className="state-icon"><i className="ic ic-search" aria-hidden="true" /></span>
              <h1 className="t-xl">찾을 수 없습니다</h1>
              <p className="t-md muted">주소를 다시 확인하거나 왼쪽 메뉴에서 찾아 주세요.</p>
              <Link to="/dashboard" className="btn btn-secondary" style={{ marginTop: "8px" }}>
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
            <div className="state" style={{ padding: "48px 32px" }}>
              <span className="state-icon is-warning"><i className="ic ic-clock" aria-hidden="true" /></span>
              <h1 className="t-xl">요청이 많아 잠시 기다려야 합니다</h1>
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
            <div className="state" style={{ padding: "48px 32px" }}>
              <span className="state-icon is-warning"><i className="ic ic-globe" aria-hidden="true" /></span>
              <h1 className="t-xl">지원하지 않는 브라우저입니다</h1>
              <p className="t-md muted">Chrome·Edge·Whale이나 Mac의 Safari에서 열어 주세요</p>
              <button onClick={copyLink} className="btn btn-secondary" type="button" style={{ marginTop: "8px" }}>
                <i className="ic ic-copy" aria-hidden="true" />
                이 주소 복사하기
              </button>
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
            <div className="state" role="alert" style={{ padding: "48px 32px" }}>
              <span className="state-icon is-warning"><i className="ic ic-alert" aria-hidden="true" /></span>
              <h1 className="t-xl">화면을 불러오지 못했습니다</h1>
              <p className="t-md muted">위 상태 바와 경보는 그대로 받습니다</p>
              <div className="row wrap" style={{ gap: "12px 20px", justifyContent: "center", marginTop: "8px" }}>
                {v.isChunk ? (
                  <>
                    <button onClick={reload} className="btn btn-primary" type="button">
                      <i className="ic ic-refresh" aria-hidden="true" />
                      다시 시도
                    </button>
                  </>
                ) : null}
                {' '}
                {v.isChunkNew ? (
                  <>
                    <button onClick={reload} className="btn btn-secondary" type="button">
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
