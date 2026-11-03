// 디자인 캔버스 보드 SCR-028-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';
import type { MePrefs } from './prefs';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

function qrCells(seed: any): any {
    let n = 29, s = seed, out: any[] = [];
    let rnd = function () { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        let on: any;
        let fr = r < 7 ? r : (r >= n - 7 ? r - (n - 7) : -1);
        let fc = c < 7 ? c : (c >= n - 7 ? c - (n - 7) : -1);
        let finder = fr >= 0 && fc >= 0 && !(r >= n - 7 && c >= n - 7);
        let sep = !finder && ((r <= 7 && c <= 7) || (r <= 7 && c >= n - 8) || (r >= n - 8 && c <= 7));
        if (finder) on = fr === 0 || fr === 6 || fc === 0 || fc === 6 || (fr >= 2 && fr <= 4 && fc >= 2 && fc <= 4);
        else if (sep) on = false;
        else if (r === 6) on = c % 2 === 0;
        else if (c === 6) on = r % 2 === 0;
        else if (r >= 20 && r <= 24 && c >= 20 && c <= 24) { let ar = r - 20, ac = c - 20; on = ar === 0 || ar === 4 || ac === 0 || ac === 4 || (ar === 2 && ac === 2); }
        else on = rnd() > 0.52;
        out.push({ on: on ? 'on' : '' });
      }
    }
    return out;
  }

export const STATES_M = ["로그인", "TOTP 단계", "허용 IP 대역 밖", "반복 실패·시간 잠금", "보호 잠금", "역할 없음", "내 계정", "인증 앱 다시 등록", "유휴 만료 2분 전 경고", "유휴 만료", "초대 수락·인증 앱 등록", "초대 수락·패스키 등록", "잠금 해제 화면", "잠금 해제 · 코드 틀림", "잠금 해제 완료", "잠금 해제 · 쓸 수 없는 링크", "해제 링크 다시 받기 한도", "비밀번호를 바꿔 주세요", "비밀번호 바꾸기 · 거절", "비밀번호 바꾸기 · 확인할 수 없음", "세션 종료 · 권한 바뀜", "세션 종료 · 비밀번호 바뀜", "세션 종료 · 계정 삭제"] as const;
export const DEFAULT_M = "로그인";

export function valsM(state: string) {
    let st = state || '로그인';
    let ul = st === '잠금 해제 화면' || st === '잠금 해제 · 코드 틀림';
    let ulDone = st === '잠금 해제 완료';
    let ulBad = st === '잠금 해제 · 쓸 수 없는 링크';
    let lim = st === '해제 링크 다시 받기 한도';
    let pc = st === '비밀번호를 바꿔 주세요' || st === '비밀번호 바꾸기 · 거절' || st === '비밀번호 바꾸기 · 확인할 수 없음';
    let endR = st === '세션 종료 · 권한 바뀜';
    let endP = st === '세션 종료 · 비밀번호 바뀜';
    let endD = st === '세션 종료 · 계정 삭제';
    let ended = endR || endP || endD;
    return {
      isAuth: st === '로그인' || st === 'TOTP 단계' || st === '허용 IP 대역 밖' || st === '반복 실패·시간 잠금' || st === '보호 잠금' || st === '역할 없음' || st === '유휴 만료' || st === '초대 수락·인증 앱 등록' || st === '초대 수락·패스키 등록' || ul || ulDone || ulBad || lim || pc || ended,
      isLogin: st === '로그인',
      isNoRole: st === '역할 없음',
      isExpired: st === '유휴 만료',
      isInvite: st === '초대 수락·인증 앱 등록' || st === '초대 수락·패스키 등록',
      ivTotp: st === '초대 수락·인증 앱 등록',
      ivPk: st === '초대 수락·패스키 등록',
      isTotp: st === 'TOTP 단계',
      isOutside: st === '허용 IP 대역 밖',
      isLocked: st === '반복 실패·시간 잠금' || st === '보호 잠금' || lim,
      isLockTime: st === '반복 실패·시간 잠금' || lim,
      isUnlock: ul,
      ulOk: st === '잠금 해제 화면',
      ulBad: st === '잠금 해제 · 코드 틀림',
      isUnlockDone: ulDone,
      isUnlockBad: ulBad,
      linkOk: st === '반복 실패·시간 잠금',
      linkLimit: lim,
      isPwChange: pc,
      pcPlain: st === '비밀번호를 바꿔 주세요',
      pcReject: st === '비밀번호 바꾸기 · 거절',
      pcUnavail: st === '비밀번호 바꾸기 · 확인할 수 없음',
      isEnded: ended,
      endMsg: endR ? '계정 권한이 바뀌어 로그아웃되었습니다. 다시 로그인해 주세요' : (endP ? '비밀번호가 바뀌어 이 기기에서 로그아웃되었습니다. 다시 로그인해 주세요' : '계정이 삭제되어 로그아웃되었습니다'),
      endSub: endD ? '업무용 이메일과 비밀번호를 입력한 뒤 인증 앱의 6자리 코드를 입력합니다.' : '다시 로그인하면 보던 화면으로 돌아갑니다.',
      endEmail: endD ? '' : 'sujin@ops.peaket.example',
      isLockProt: st === '보호 잠금',
      isShell: st === '내 계정' || st === '인증 앱 다시 등록' || st === '유휴 만료 2분 전 경고',
      isReauth: st === '내 계정',
      isTotpReg: st === '인증 앱 다시 등록',
      isIdle: st === '유휴 만료 2분 전 경고',
      qr: qrCells(st === '초대 수락·인증 앱 등록' || st === '초대 수락·패스키 등록' ? 41 : 23)
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:1900px;display:block"}

/** /login: 로그인·잠금·초대·세션 종료 카드(셸 없음). 보드의 main#main-login 그대로 */
export function AuthM({ v, close }: { v: V; close?: () => void }) {
  void v; void close;
  return (
    <>
          <main className="col" id="main-login" style={{ flex: "1", gap: "24px", padding: "40px 20px 32px" }}>
            {v.isLogin ? (
              <>
                <section className="col" aria-labelledby="lg-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="col" style={{ gap: "6px" }}>
                    <h1 className="t-xl" id="lg-t">운영자 로그인</h1>
                    <p className="t-sm muted">업무용 이메일과 비밀번호를 입력한 뒤 인증 앱의 6자리 코드를 입력합니다.</p>
                  </div>
                  <nav className="stepper" aria-label="로그인 단계">
                    <span className="step is-current" aria-current="step">
                      <span className="step-num">1</span>
                      이메일·비밀번호
                    </span>
                    <span className="step-line" />
                    {' '}
                    <span className="step">
                      <span className="step-num">2</span>
                      인증 앱 코드
                    </span>
                  </nav>
                  <form className="col" style={{ gap: "16px" }} onSubmit={prevent}>
                    <div className="field">
                      <label className="label" htmlFor="lg-email">업무용 이메일</label>
                      <input className="input" id="lg-email" type="email" inputMode="email" autoComplete="username" defaultValue="sujin@ops.peaket.example" />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="lg-pw">비밀번호</label>
                      <div className="input-group is-focus">
                        <input id="lg-pw" type="password" autoComplete="current-password" defaultValue="example-passphrase-01" aria-describedby="lg-pw-h" />
                        <button className="icon-btn icon-btn-sm" type="button" aria-label="비밀번호 보기" aria-pressed="false">
                          <i className="ic ic-eye" aria-hidden="true" />
                        </button>
                      </div>
                      <span className="hint" id="lg-pw-h">15자 이상입니다. 비밀번호 관리자의 자동 입력과 붙여넣기를 쓸 수 있습니다.</span>
                    </div>
                    <button className="btn btn-primary btn-lg btn-block" type="submit">다음: 인증 앱 코드 입력</button>
                  </form>
                  <div className="divider" />
                  <ul className="col t-xs muted" style={{ gap: "10px" }}>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <i className="ic ic-key ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                      <span>패스키는 인증 앱을 대신하지 않습니다. 위험 명령과 승인을 할 때 한 번 더 확인하는 데 씁니다.</span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <i className="ic ic-mail ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                      <span>
                        초대를 받았다면 초대 이메일의 링크로 들어와 비밀번호 만들기(15자 이상, 조합 규칙 없음, 유출된 비밀번호 제외) → 인증 앱 등록 → 패스키 등록(operator·commander는 필수) → 복구 코드 확인 순서로 계정을 만듭니다. 휴대폰에서 인증 앱을 등록할 때는 같은 기기로 QR을 찍을 수 없으므로 설정 키를 복사해 인증 앱에 넣습니다.
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <i className="ic ic-shield ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                      <span>이 화면은 허용된 사내 네트워크와 VPN에서만 열립니다. 휴대폰은 사내 VPN 프로필로 접속합니다.</span>
                    </li>
                  </ul>
                </section>
              </>
            ) : null}
            {' '}
            {v.isTotp ? (
              <>
                <section className="col" aria-labelledby="tp-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="col" style={{ gap: "6px" }}>
                    <h1 className="t-xl" id="tp-t">운영자 로그인</h1>
                    <p className="t-sm muted">휴대폰 인증 앱에 보이는 숫자 6자리를 입력합니다.</p>
                  </div>
                  <nav className="stepper" aria-label="로그인 단계">
                    <span className="step is-done">
                      <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                      이메일·비밀번호
                    </span>
                    <span className="step-line is-done" />
                    {' '}
                    <span className="step is-current" aria-current="step">
                      <span className="step-num">2</span>
                      인증 앱 코드
                    </span>
                  </nav>
                  <div className="row t-sm" style={{ gap: "8px" }}>
                    <i className="ic ic-user ic-16 muted" aria-hidden="true" />
                    <span className="fw-b ellipsis">sujin@ops.peaket.example</span>
                    <button className="btn btn-text" type="button">이메일 바꾸기</button>
                  </div>
                  <form className="col" style={{ gap: "16px" }} onSubmit={prevent}>
                    <div className="field">
                      <label className="label" id="tp-l" htmlFor="tp-otp">인증 앱의 6자리 코드</label>
                      {' '}
                      <input className="otp-input is-focus" id="tp-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" aria-describedby="tp-h" defaultValue="4819" />
                      {' '}
                      <span className="hint" id="tp-h">휴대폰을 쓸 수 없으면 계정을 만들 때 받은 복구 코드로 로그인합니다.</span>
                    </div>
                    <Link to="/login" className="link-more">
                      복구 코드로 로그인
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </Link>
                    <div className="row" style={{ gap: "8px" }}>
                      <button className="btn btn-secondary btn-lg" type="button">이전 단계</button>
                      <button className="btn btn-primary btn-lg grow" type="submit">관제 콘솔에 로그인</button>
                    </div>
                  </form>
                  <div className="divider" />
                  <p className="row t-xs muted" style={{ gap: "8px", alignItems: "flex-start" }}>
                    <i className="ic ic-key ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                    <span>패스키는 인증 앱을 대신하지 않습니다. 위험 명령과 승인을 할 때 한 번 더 확인하는 데 씁니다.</span>
                  </p>
                </section>
              </>
            ) : null}
            {' '}
            {v.isOutside ? (
              <>
                <section className="col" role="alert" aria-labelledby="ip-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="state" style={{ padding: "24px 0 0", gap: "14px" }}>
                    <span className="state-icon is-danger"><i className="ic ic-ban" aria-hidden="true" /></span>
                    <h1 className="t-xl" id="ip-t">허용된 네트워크에서만 접속할 수 있습니다</h1>
                    <p className="t-sm muted">관제 콘솔은 사내 고정 IP 대역과 전용 VPN에서만 열립니다. VPN에 연결한 뒤 이 주소를 다시 열어 주세요.</p>
                  </div>
                  <div className="card-flat row" style={{ gap: "10px", alignItems: "flex-start", padding: "14px 16px" }}>
                    <i className="ic ic-phone" aria-hidden="true" style={{ marginTop: "1px" }} />
                    <p className="t-sm">휴대폰은 사내 VPN 프로필로 접속합니다. VPN 프로필을 켠 뒤 다시 확인하세요.</p>
                  </div>
                  <p className="t-xs muted" style={{ textAlign: "center" }}>허용 대역 밖의 접속 시도는 접속기록에 남습니다.</p>
                  <button className="btn btn-secondary btn-lg btn-block" type="button">
                    <i className="ic ic-refresh" aria-hidden="true" />
                    VPN 연결 뒤 다시 확인하기
                  </button>
                </section>
              </>
            ) : null}
            {' '}
            {v.isNoRole ? (
              <>
                <section className="col" role="alert" aria-labelledby="nr-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="state" style={{ padding: "24px 0 0", gap: "14px" }}>
                    <span className="state-icon is-warning"><i className="ic ic-user" aria-hidden="true" /></span>
                    <h1 className="t-xl" id="nr-t">관제 역할이 없는 계정입니다</h1>
                    <p className="t-sm muted">로그인은 되었지만 이 계정에는 관제 역할이 없어 관제 화면을 열 수 없습니다. 역할이 필요하면 계정·세션 관리를 맡은 운영자에게 요청해 주세요.</p>
                  </div>
                  <button className="btn btn-secondary btn-lg btn-block" type="button">
                    <i className="ic ic-logout" aria-hidden="true" />
                    로그아웃
                  </button>
                </section>
              </>
            ) : null}
            {' '}
            {v.isExpired ? (
              <>
                <section className="col" aria-labelledby="ex-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="col" style={{ gap: "6px" }}>
                    <h1 className="t-xl" id="ex-t">세션이 끝났습니다</h1>
                    <p className="t-sm muted" id="ex-d">1시간 동안 동작이 없어 보안을 위해 세션을 끝냈습니다. 비밀번호와 인증 앱 코드로 다시 로그인하면 보던 화면(내 계정)으로 돌아갑니다.</p>
                  </div>
                  <div className="row t-sm" style={{ gap: "8px" }}>
                    <i className="ic ic-user ic-16 muted" aria-hidden="true" />
                    <span className="fw-b ellipsis">sujin@ops.peaket.example</span>
                  </div>
                  <form className="col" style={{ gap: "16px" }} aria-describedby="ex-d" onSubmit={prevent}>
                    <div className="field">
                      <label className="label" htmlFor="ex-pw">비밀번호</label>
                      <input className="input is-focus" id="ex-pw" type="password" autoComplete="current-password" defaultValue="" />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="ex-otp">인증 앱의 6자리 코드</label>
                      <input className="input" id="ex-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" defaultValue="" aria-describedby="ex-otp-h" />
                      <span className="hint" id="ex-otp-h">휴대폰을 잃을 때 로그인과 인증 앱 코드를 함께 잃지 않도록, 인증 앱은 이 휴대폰이 아닌 다른 기기에 두기를 권합니다.</span>
                    </div>
                    <button className="btn btn-primary btn-lg btn-block" type="submit">다시 로그인하고 돌아가기</button>
                  </form>
                  <Link to="/login" className="btn btn-text" style={{ alignSelf: "center" }}>다른 계정으로 로그인</Link>
                </section>
              </>
            ) : null}
            {' '}
            {v.isInvite ? (
              <>
                <section className="col" aria-labelledby="iv-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="col" style={{ gap: "6px" }}>
                    <h1 className="t-xl" id="iv-t">운영자 초대 수락</h1>
                    <p className="t-sm muted">new-operator@peaket.example 계정의 관제 콘솔 초대입니다(역할 viewer). 초대 링크는 24시간 동안 한 번 쓸 수 있습니다.</p>
                  </div>
                  {v.ivTotp ? (
                    <>
                      <nav className="stepper" aria-label="초대 수락 단계" style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: "0", alignItems: "start" }}>
                        <span className="step is-done" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", whiteSpace: "normal" }}>
                          <span className="row" style={{ gap: "6px" }}>
                            <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                            <span className="step-line is-done" style={{ marginRight: "6px" }} />
                          </span>
                          <span>
                            비밀번호 만들기
                            <span className="sr-only">(완료)</span>
                          </span>
                        </span>
                        {' '}
                        <span className="step is-current" aria-current="step" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", whiteSpace: "normal" }}>
                          <span className="row" style={{ gap: "6px" }}>
                            <span className="step-num">2</span>
                            <span className="step-line" style={{ marginRight: "6px" }} />
                          </span>
                          <span>인증 앱 등록</span>
                        </span>
                        {' '}
                        <span className="step" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", whiteSpace: "normal" }}>
                          <span className="row" style={{ gap: "6px" }}>
                            <span className="step-num">3</span>
                            <span className="step-line" style={{ marginRight: "6px" }} />
                          </span>
                          <span>패스키 등록</span>
                        </span>
                        {' '}
                        <span className="step" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", whiteSpace: "normal" }}>
                          <span className="row" style={{ gap: "6px" }}><span className="step-num">4</span></span>
                          <span>복구 코드 확인</span>
                        </span>
                      </nav>
                      <section className="col" style={{ gap: "12px" }} aria-labelledby="iv-h2">
                        <h2 className="t-lg" id="iv-h2">인증 앱 등록</h2>
                        <section className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }} aria-labelledby="iv-key-t">
                          <h3 className="t-sm fw-b" id="iv-key-t">이 휴대폰의 인증 앱에 넣기</h3>
                          <p className="t-xs muted" id="iv-key-d">같은 휴대폰의 카메라로는 QR을 찍을 수 없습니다. 설정 키를 복사해 인증 앱에 붙여넣으세요.</p>
                          <div className="row" style={{ gap: "8px" }}>
                            <span className="mono t-sm fw-b grow">[설정 키 자리 표시]</span>
                            <button className="btn btn-outline btn-sm" type="button" aria-describedby="iv-key-d">
                              <i className="ic ic-copy" aria-hidden="true" />
                              설정 키 복사
                            </button>
                          </div>
                        </section>
                        <section className="card-flat row" style={{ gap: "12px", padding: "12px 14px", alignItems: "flex-start" }} aria-labelledby="iv-qr-t">
                          <div className="qr-wrap" role="img" aria-label="인증 앱 등록 QR" style={{ width: "96px", padding: "6px", flex: "none" }}>
                            <div className="qr">
                              {v.qr.map((m: any, i0: number) => (
                                <Fragment key={i0}>
                                  <i className={m.on} />
                                </Fragment>
                              ))}
                            </div>
                          </div>
                          <div className="col" style={{ gap: "4px" }}>
                            <h3 className="t-sm fw-b" id="iv-qr-t">다른 기기의 인증 앱으로 찍기</h3>
                            <p className="t-xs muted">인증 앱을 다른 기기에 두었다면 그 기기의 카메라로 이 QR을 찍습니다.</p>
                          </div>
                        </section>
                        <p className="row t-xs muted" style={{ gap: "6px", alignItems: "flex-start" }}>
                          <i className="ic ic-info ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                          <span>휴대폰으로 로그인해 승인할 예정이라면, 휴대폰을 잃을 때 인증 앱까지 함께 잃지 않도록 인증 앱은 다른 기기에 등록하기를 권합니다.</span>
                        </p>
                      </section>
                      <form className="col" style={{ gap: "16px" }} aria-label="인증 앱 등록 확인" onSubmit={prevent}>
                        <div className="field">
                          <label className="label" id="iv-otp-l" htmlFor="iv-otp">인증 앱의 6자리 코드</label>
                          {' '}
                          <input className="otp-input is-focus" id="iv-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" aria-describedby="iv-otp-h" defaultValue="" />
                          {' '}
                          <span className="hint" id="iv-otp-h">등록한 인증 앱에 보이는 코드로 확인합니다</span>
                        </div>
                        <button className="btn btn-primary btn-lg btn-block" type="submit">인증 앱 등록하기</button>
                        {' '}
                        <button className="btn btn-ghost btn-block" type="button">이전 단계</button>
                        <p className="t-xs muted">다음 단계에서 패스키를 등록합니다.</p>
                      </form>
                    </>
                  ) : null}
                  {' '}
                  {v.ivPk ? (
                    <>
                      <nav className="stepper" aria-label="초대 수락 단계" style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: "0", alignItems: "start" }}>
                        <span className="step is-done" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", whiteSpace: "normal" }}>
                          <span className="row" style={{ gap: "6px" }}>
                            <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                            <span className="step-line is-done" style={{ marginRight: "6px" }} />
                          </span>
                          <span>
                            비밀번호 만들기
                            <span className="sr-only">(완료)</span>
                          </span>
                        </span>
                        {' '}
                        <span className="step is-done" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", whiteSpace: "normal" }}>
                          <span className="row" style={{ gap: "6px" }}>
                            <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                            <span className="step-line is-done" style={{ marginRight: "6px" }} />
                          </span>
                          <span>
                            인증 앱 등록
                            <span className="sr-only">(완료)</span>
                          </span>
                        </span>
                        {' '}
                        <span className="step is-current" aria-current="step" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", whiteSpace: "normal" }}>
                          <span className="row" style={{ gap: "6px" }}>
                            <span className="step-num">3</span>
                            <span className="step-line" style={{ marginRight: "6px" }} />
                          </span>
                          <span>패스키 등록</span>
                        </span>
                        {' '}
                        <span className="step" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", whiteSpace: "normal" }}>
                          <span className="row" style={{ gap: "6px" }}><span className="step-num">4</span></span>
                          <span>복구 코드 확인</span>
                        </span>
                      </nav>
                      <section className="col" style={{ gap: "14px" }} aria-labelledby="iv-pk-h">
                        <div className="col" style={{ gap: "6px" }}>
                          <h2 className="t-lg" id="iv-pk-h">패스키 등록</h2>
                          <p className="t-sm muted">패스키는 인증 앱을 대신하지 않습니다. 위험 명령과 승인을 할 때 한 번 더 확인하는 데 씁니다.</p>
                        </div>
                        <div className="banner banner-info">
                          <i className="ic ic-key" aria-hidden="true" />
                          <div className="banner-body">operator·commander는 이 단계를 마쳐야 계정이 활성화됩니다. 이 계정의 역할(viewer)은 나중에 내 계정에서 등록할 수 있습니다.</div>
                        </div>
                        <button className="btn btn-primary btn-lg btn-block is-focus" type="button" aria-describedby="iv-pk-d">
                          <i className="ic ic-key" aria-hidden="true" />
                          패스키 등록
                        </button>
                        <p className="t-xs muted" id="iv-pk-d">[패스키 등록]을 누르면 브라우저의 패스키 창이 뜹니다. 다음 단계에서 복구 코드를 받아 보관합니다.</p>
                        <a href="#" className="link-more">
                          나중에 등록
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </a>
                      </section>
                    </>
                  ) : null}
                </section>
              </>
            ) : null}
            {' '}
            {v.isLocked ? (
              <>
                <section className="col" aria-labelledby="rf-t" style={{ gap: "18px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <h1 className="t-xl" id="rf-t">운영자 로그인</h1>
                  <div className="error-summary" role="alert">
                    <strong className="row" style={{ gap: "6px", color: "var(--danger)" }}>
                      <i className="ic ic-alert-circle ic-16" aria-hidden="true" />
                      로그인하지 못했습니다(4회 실패)
                    </strong>
                    {' '}
                    <span>이메일, 비밀번호, 인증 앱 코드 중 맞지 않는 것이 있습니다. 다시 입력해 주세요.</span>
                    {' '}
                    <a href="#rf-otp1">인증 앱 코드 다시 입력하기</a>
                  </div>
                  <div className="center" role="region" aria-label="사람 확인" style={{ minHeight: "72px", padding: "12px", border: "1px dashed var(--border-input)", borderRadius: "var(--r-md)", textAlign: "center" }}>
                    <span className="t-sm muted">사람 확인 창이 이 자리에 열립니다</span>
                  </div>
                  <p className="t-xs muted">로그인 실패가 반복되어 사람 확인을 합니다. 5회 실패하면 계정이 잠깁니다.</p>
                  <form className="col" style={{ gap: "18px" }} onSubmit={prevent}>
                    <div className="field">
                      <label className="label" id="rf-l" htmlFor="rf-otp1">인증 앱의 6자리 코드</label>
                      {' '}
                      <input className="otp-input is-focus" id="rf-otp1" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" aria-invalid="true" defaultValue="" />
                    </div>
                    <div className="row" style={{ gap: "8px" }}>
                      <button className="btn btn-secondary btn-lg" type="button">이전 단계</button>
                      <button className="btn btn-primary btn-lg grow" type="submit">관제 콘솔에 로그인</button>
                    </div>
                  </form>
                </section>
                <div className="center muted" aria-hidden="true"><i className="ic ic-chevron-down ic-24" /></div>
                <section className="col" role="alert" aria-labelledby="lk-t" style={{ gap: "20px", paddingTop: "24px", borderTop: "1px solid var(--border)" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="state" style={{ padding: "12px 0 0", gap: "14px" }}>
                    <span className="state-icon is-danger"><i className="ic ic-lock" aria-hidden="true" /></span>
                    <h2 className="t-xl" id="lk-t">계정이 잠겼습니다</h2>
                    {v.isLockTime ? (
                      <>
                        <p className="t-md">로그인 실패가 반복되어 계정이 15분 동안 잠겼습니다. 업무 이메일로 보낸 링크에서 인증 앱 코드를 넣으면 바로 풀 수 있습니다</p>
                        <p className="t-sm muted">sujin@ops.peaket.example로 잠금 해제 링크를 보냈습니다. 링크는 30분 동안 한 번 쓸 수 있고, 15분이 지나면 링크 없이도 다시 로그인할 수 있습니다.</p>
                      </>
                    ) : null}
                    {' '}
                    {v.isLockProt ? (
                      <>
                        <p className="t-md">보안을 위해 계정을 잠갔습니다. 운영자에게 재초대를 요청하세요</p>
                        <p className="t-sm muted">잠긴 동안에는 비밀번호와 인증 앱 코드로 로그인할 수 없습니다. 운영자가 본인인지 확인한 뒤 보내는 재초대 이메일의 링크로만 다시 계정을 엽니다.</p>
                      </>
                    ) : null}
                  </div>
                  {v.isLockTime ? (
                    <>
                      {v.linkOk ? (
                        <>
                          <button className="btn btn-outline btn-lg btn-block" type="button">해제 링크 다시 받기</button>
                        </>
                      ) : null}
                      {' '}
                      {v.linkLimit ? (
                        <>
                          <div className="col" style={{ gap: "8px" }}>
                            <button className="btn btn-outline btn-lg btn-block" type="button" aria-disabled="true" aria-describedby="lk-lim">
                              해제 링크 다시 받기
                            </button>
                            <p className="error-msg" id="lk-lim" role="alert">
                              <i className="ic ic-alert-circle" aria-hidden="true" />
                              해제 링크는 1시간에 3번까지 다시 받을 수 있습니다. 20:31 KST 뒤에 다시 시도하세요
                            </p>
                          </div>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {' '}
                  <Link to="/login" className="btn btn-secondary btn-lg btn-block">다른 계정으로 로그인</Link>
                </section>
              </>
            ) : null}
            {' '}
            {v.isUnlock ? (
              <>
                <section className="col" aria-labelledby="ul-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="col" style={{ gap: "6px" }}>
                    <h1 className="t-xl" id="ul-t">계정 잠금 풀기</h1>
                    <p className="t-sm muted" id="ul-d">인증 앱의 6자리 코드나 복구 코드를 넣으면 잠금이 풀립니다. 그 뒤 비밀번호와 인증 앱 코드로 로그인합니다.</p>
                  </div>
                  <form className="col" style={{ gap: "16px" }} aria-describedby="ul-d" onSubmit={prevent}>
                    <div className="field">
                      <label className="label" htmlFor="ul-otp">인증 앱의 6자리 코드</label>
                      {' '}
                      {v.ulOk ? (
                        <>
                          <input className="otp-input is-focus" id="ul-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" aria-describedby="ul-h" defaultValue="4819" />
                        </>
                      ) : null}
                      {' '}
                      {v.ulBad ? (
                        <>
                          <input className="otp-input is-focus" id="ul-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" aria-invalid="true" aria-describedby="ul-e ul-h" defaultValue="207315" />
                          <p className="error-msg" id="ul-e" role="alert">
                            <i className="ic ic-alert-circle" aria-hidden="true" />
                            코드가 맞지 않습니다. 이 링크로 2번 더 시도할 수 있습니다
                          </p>
                        </>
                      ) : null}
                      {' '}
                      <span className="hint" id="ul-h">휴대폰을 잃을 때 로그인과 인증 앱 코드를 함께 잃지 않도록, 인증 앱은 이 휴대폰이 아닌 다른 기기에 두기를 권합니다.</span>
                    </div>
                    <a href="#" className="link-more">
                      복구 코드로 풀기
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </a>
                    {' '}
                    <button className="btn btn-primary btn-lg btn-block" type="submit">잠금 풀기</button>
                  </form>
                  <div className="divider" />
                  <p className="row t-xs muted" style={{ gap: "8px", alignItems: "flex-start" }}>
                    <i className="ic ic-shield ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                    <span>이 화면도 허용된 사내 네트워크와 VPN에서만 열립니다. 휴대폰은 사내 VPN 프로필로 접속합니다.</span>
                  </p>
                </section>
              </>
            ) : null}
            {' '}
            {v.isUnlockDone ? (
              <>
                <section className="col" role="status" aria-labelledby="ud-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="state" style={{ padding: "12px 0 0", gap: "14px" }}>
                    <span className="state-icon is-success"><i className="ic ic-check-circle" aria-hidden="true" /></span>
                    <h1 className="t-xl" id="ud-t">잠금을 풀었습니다</h1>
                    <p className="t-sm muted">다시 로그인해 주세요</p>
                  </div>
                  <Link to="/login" className="btn btn-primary btn-lg btn-block">로그인</Link>
                </section>
              </>
            ) : null}
            {' '}
            {v.isUnlockBad ? (
              <>
                <section className="col" role="alert" aria-labelledby="ub-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="state" style={{ padding: "12px 0 0", gap: "14px" }}>
                    <span className="state-icon is-warning"><i className="ic ic-link" aria-hidden="true" /></span>
                    <h1 className="t-xl" id="ub-t">이 링크는 더 쓸 수 없습니다</h1>
                    <p className="t-sm muted">로그인 화면에서 [해제 링크 다시 받기]를 누르세요</p>
                  </div>
                  <Link to="/login" className="btn btn-secondary btn-lg btn-block">로그인 화면으로</Link>
                </section>
              </>
            ) : null}
            {' '}
            {v.isPwChange ? (
              <>
                <section className="col" aria-labelledby="pc-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="col" style={{ gap: "6px" }}>
                    <h1 className="t-xl" id="pc-t">비밀번호를 바꿔 주세요</h1>
                    <p className="t-sm muted" id="pc-d">이 계정의 비밀번호가 다른 곳에 노출되었을 수 있어, 비밀번호를 바꾼 뒤에 콘솔을 쓸 수 있습니다. 바꾸면 이 계정의 다른 로그인 세션은 모두 끝납니다.</p>
                  </div>
                  <div className="row t-sm" style={{ gap: "8px" }}>
                    <i className="ic ic-user ic-16 muted" aria-hidden="true" />
                    <span className="fw-b ellipsis">sujin@ops.peaket.example</span>
                  </div>
                  <form className="col" style={{ gap: "16px" }} aria-describedby="pc-d" onSubmit={prevent}>
                    <div className="field">
                      <label className="label" htmlFor="pc-cur">지금 비밀번호</label>
                      <div className="input-group">
                        <input id="pc-cur" type="password" autoComplete="current-password" defaultValue="example-passphrase-01" />
                        <button className="icon-btn icon-btn-sm" type="button" aria-label="지금 비밀번호 보기" aria-pressed="false">
                          <i className="ic ic-eye" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="pc-new">새 비밀번호</label>
                      {' '}
                      {v.pcPlain ? (
                        <>
                          <div className="input-group is-focus">
                            <input id="pc-new" type="password" autoComplete="new-password" defaultValue="" aria-describedby="pc-new-h" />
                            <button className="icon-btn icon-btn-sm" type="button" aria-label="새 비밀번호 보기" aria-pressed="false">
                              <i className="ic ic-eye" aria-hidden="true" />
                            </button>
                          </div>
                          <span className="hint" id="pc-new-h">15자 이상입니다. 비밀번호 관리자의 자동 입력과 붙여넣기를 쓸 수 있습니다.</span>
                        </>
                      ) : null}
                      {' '}
                      {v.pcReject ? (
                        <>
                          <div className="input-group is-error">
                            <input id="pc-new" type="text" autoComplete="new-password" spellCheck="false" defaultValue="PeaketOps2026!!!" aria-invalid="true" aria-describedby="pc-new-e pc-new-g" />
                            <button className="icon-btn icon-btn-sm" type="button" aria-label="새 비밀번호 가리기" aria-pressed="true">
                              <i className="ic ic-eye-off" aria-hidden="true" />
                            </button>
                          </div>
                          <p className="error-msg" id="pc-new-e" role="alert">
                            <i className="ic ic-alert-circle" aria-hidden="true" />
                            서비스·회사·계정 이름에 숫자나 기호만 붙인 비밀번호는 쓸 수 없습니다
                          </p>
                          <span className="hint" id="pc-new-g">서로 관계없는 낱말 여러 개를 이은 문장이나 비밀번호 관리자가 만든 값을 쓰세요</span>
                        </>
                      ) : null}
                      {' '}
                      {v.pcUnavail ? (
                        <>
                          <div className="input-group">
                            <input id="pc-new" type="password" autoComplete="new-password" defaultValue="river-lantern-quiet-oak" aria-describedby="pc-new-e pc-new-h" />
                            <button className="icon-btn icon-btn-sm" type="button" aria-label="새 비밀번호 보기" aria-pressed="false">
                              <i className="ic ic-eye" aria-hidden="true" />
                            </button>
                          </div>
                          <p className="error-msg" id="pc-new-e" role="alert">
                            <i className="ic ic-alert-circle" aria-hidden="true" />
                            지금은 비밀번호를 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요
                          </p>
                          <span className="hint" id="pc-new-h">15자 이상입니다. 비밀번호 관리자의 자동 입력과 붙여넣기를 쓸 수 있습니다.</span>
                        </>
                      ) : null}
                    </div>
                    <div className="row" style={{ gap: "8px" }}>
                      <button className="btn btn-secondary btn-lg" type="button">
                        <i className="ic ic-logout" aria-hidden="true" />
                        로그아웃
                      </button>
                      <button className="btn btn-primary btn-lg grow" type="submit">비밀번호 바꾸기</button>
                    </div>
                  </form>
                </section>
              </>
            ) : null}
            {' '}
            {v.isEnded ? (
              <>
                <section className="col" aria-labelledby="se-t" style={{ gap: "20px" }}>
                  <div className="row between">
                    <span className="logo logo-sm">
                      <i className="logo-mark" aria-hidden="true" />
                      PEAKET
                    </span>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-inverse">관제</span>
                      <span className="badge badge-outline">운영 환경</span>
                    </span>
                  </div>
                  <div className="banner banner-info" role="status">
                    <i className="ic ic-logout" aria-hidden="true" />
                    <div className="banner-body">{v.endMsg}</div>
                  </div>
                  <div className="col" style={{ gap: "6px" }}>
                    <h1 className="t-xl" id="se-t">운영자 로그인</h1>
                    <p className="t-sm muted">{v.endSub}</p>
                  </div>
                  <form className="col" style={{ gap: "16px" }} onSubmit={prevent}>
                    <div className="field">
                      <label className="label" htmlFor="se-email">업무용 이메일</label>
                      <input className="input" id="se-email" type="email" inputMode="email" autoComplete="username" defaultValue={v.endEmail} />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="se-pw">비밀번호</label>
                      <div className="input-group is-focus">
                        <input id="se-pw" type="password" autoComplete="current-password" defaultValue="" />
                        <button className="icon-btn icon-btn-sm" type="button" aria-label="비밀번호 보기" aria-pressed="false">
                          <i className="ic ic-eye" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    <button className="btn btn-primary btn-lg btn-block" type="submit">다음: 인증 앱 코드 입력</button>
                  </form>
                  <Link to="/login" className="btn btn-text" style={{ alignSelf: "center" }}>다른 계정으로 로그인</Link>
                </section>
              </>
            ) : null}
          </main>
    </>
  );
}

/** /me 본문 간격(보드의 <main class="cs-main" style>) */
export const ME_MAIN_STYLE_M = {gap: "16px"};

/** /me: 관제 셸 안 본문(내 계정)과 겹침(재인증·인증 앱 다시 등록·유휴 만료 경고) */
export function MeM({ v, close, prefs }: { v: V; close?: () => void; prefs: MePrefs }) {
  void v; void close;
  return (
    <>
            <div className="col" style={{ gap: "4px" }}>
              <h1 className="t-lg">내 계정</h1>
              <p className="t-sm muted">관제 역할과 보안 설정, 로그인한 기기를 봅니다.</p>
            </div>
            <section className="card pad col" style={{ gap: "12px" }} aria-labelledby="me-acc">
              <h2 className="t-md fw-b" id="me-acc">계정</h2>
              <dl className="kv">
                <dt>이름</dt>
                <dd>수진</dd>
                <dt>업무용 이메일</dt>
                <dd className="mono" style={{ fontSize: "13px" }}>sujin@ops.peaket.example</dd>
                <dt>역할</dt>
                <dd><span className="badge badge-outline">commander</span></dd>
              </dl>
              <div className="col" style={{ gap: "4px" }}>
                <span className="t-sm muted">쓸 수 있는 일</span>
                <p className="t-sm">대시보드 읽기·결정 기록 · 명령 3·11 1인 실행 · 2인 명령 요청과 승인 · 법정 조치 실행과 보안 사고 판단 · 승인 업무 2인 승인 · 회차 취소 판정</p>
              </div>
              <p className="t-xs muted">역할 부여와 회수는 계정·세션 관리에서 합니다. commander 역할은 다른 commander가 승인합니다.</p>
            </section>
            <section className="card pad col" style={{ gap: "12px" }} aria-labelledby="me-sec">
              <h2 className="t-md fw-b" id="me-sec">보안 설정</h2>
              <p className="row t-sm muted" id="me-sec-d" style={{ gap: "8px", alignItems: "flex-start" }}>
                <i className="ic ic-lock ic-16" aria-hidden="true" style={{ marginTop: "2px" }} />
                <span>바꾸기 전에 비밀번호와 인증 앱 코드로 다시 인증합니다. 인증은 5분 동안 한 번 쓸 수 있습니다.</span>
              </p>
              <ul className="col" style={{ borderTop: "1px solid var(--border)" }}>
                <li className="li">
                  <div className="col grow" style={{ gap: "2px" }}>
                    <span className="li-title fw-b">비밀번호</span>
                    <span className="li-sub">15자 이상 · 마지막 변경 09/30 10:00 KST</span>
                  </div>
                  <button className="btn btn-outline btn-sm" type="button" aria-describedby="me-sec-d">비밀번호 바꾸기</button>
                </li>
                <li className="li">
                  <div className="col grow" style={{ gap: "4px" }}>
                    <span className="li-title fw-b">인증 앱</span>
                    <span className="row li-sub" style={{ gap: "6px" }}>
                      <span className="badge badge-success">
                        <i className="ic ic-check" aria-hidden="true" />
                        등록됨
                      </span>
                      1개
                    </span>
                  </div>
                  <button className="btn btn-outline btn-sm" type="button" aria-describedby="me-sec-d">인증 앱 다시 등록</button>
                </li>
                <li className="col" style={{ gap: "8px", padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="col" style={{ gap: "2px" }}>
                    <span className="li-title fw-b">패스키</span>
                    <span className="li-sub">1개 · 위험 명령·승인 때 한 번 더 확인</span>
                  </div>
                  <div className="row" style={{ gap: "6px" }}>
                    <button className="btn btn-outline btn-sm" type="button" aria-describedby="me-sec-d">패스키 등록</button>
                    <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="me-pk-why">지우기</button>
                  </div>
                  <span className="hint" id="me-pk-why">위험 명령을 하는 역할은 패스키가 하나 이상 있어야 합니다. 다른 패스키를 먼저 등록하세요</span>
                </li>
                <li className="li" style={{ borderBottom: "0" }}>
                  <div className="col grow" style={{ gap: "2px" }}>
                    <span className="li-title fw-b">복구 코드</span>
                    <span className="li-sub">8개 남음 · 한 번 쓴 코드는 다시 쓸 수 없습니다</span>
                  </div>
                  <button className="btn btn-outline btn-sm" type="button" aria-describedby="me-sec-d">복구 코드 다시 만들기</button>
                </li>
              </ul>
            </section>
            <section className="card pad col" style={{ gap: "12px" }} aria-labelledby="me-dev">
              <div className="row between">
                <h2 className="t-md fw-b" id="me-dev">로그인한 기기</h2>
                <span className="badge">2 / 최대 2대</span>
              </div>
              <p className="t-sm muted">관리 계정은 두 기기까지 동시에 로그인합니다. 1시간 동안 동작이 없으면 세션이 끝나고, 세션은 최대 24시간입니다.</p>
              <ul className="col" style={{ borderTop: "1px solid var(--border)" }}>
                <li className="col" style={{ gap: "10px", padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row" style={{ gap: "12px", alignItems: "flex-start" }}>
                    <i className="ic ic-phone muted" aria-hidden="true" />
                    <div className="col grow" style={{ gap: "2px" }}>
                      <span className="li-title row wrap" style={{ gap: "6px" }}>
                        업무용 휴대폰 · Safari
                        <span className="badge badge-primary">이 기기</span>
                      </span>
                      <span className="li-sub">시작 10/14 19:58 KST · 마지막 활동 20:04 KST</span>
                    </div>
                  </div>
                  <button className="btn btn-outline btn-sm" type="button" style={{ alignSelf: "flex-start", marginLeft: "32px" }}>이 기기에서 로그아웃</button>
                </li>
                <li className="col" style={{ gap: "10px", padding: "12px 0" }}>
                  <div className="row" style={{ gap: "12px", alignItems: "flex-start" }}>
                    <i className="ic ic-monitor muted" aria-hidden="true" />
                    <div className="col grow" style={{ gap: "2px" }}>
                      <span className="li-title">관제실 단말 · Chrome</span>
                      <span className="li-sub">시작 10/14 19:05 KST · 마지막 활동 20:03 KST</span>
                    </div>
                  </div>
                  <button className="btn btn-outline btn-sm" type="button" style={{ alignSelf: "flex-start", marginLeft: "32px" }} aria-label="관제실 단말 · Chrome 세션 로그아웃">
                    그 기기 로그아웃
                  </button>
                </li>
              </ul>
              <p className="t-xs muted">다른 기기를 로그아웃해도 이 기기의 세션은 그대로입니다.</p>
            </section>
            <section className="card pad col" style={{ gap: "12px" }} aria-labelledby="me-ui">
              <h2 className="t-md fw-b" id="me-ui">화면 설정</h2>
              <p className="t-sm muted" id="me-ui-d">이 브라우저에만 남습니다. 다시 인증하지 않고 바로 바뀝니다.</p>
              <ul className="col" style={{ borderTop: "1px solid var(--border)" }}>
                <li className="li">
                  <div className="col grow" style={{ gap: "2px" }}>
                    <label className="li-title fw-b" htmlFor="me-keys">한 글자 단축키 쓰기</label>
                    <span className="li-sub" id="me-keys-h">처음에는 꺼져 있습니다. 켜도 글 입력 칸에 초점이 있으면 동작하지 않습니다.</span>
                  </div>
                  <input className="sw" type="checkbox" role="switch" id="me-keys" aria-describedby="me-keys-h me-ui-d" checked={prefs.singleKey} onChange={(e) => prefs.setSingleKey(e.target.checked)} />
                </li>
                <li className="li" style={{ borderBottom: "0", alignItems: "flex-start" }}>
                  <fieldset className="col grow" style={{ gap: "8px", border: "0", margin: "0", padding: "0", minWidth: "0" }} aria-describedby="me-theme-h me-ui-d">
                    <legend className="li-title fw-b" style={{ padding: "0", marginBottom: "8px" }}>화면 테마</legend>
                    <div className="row wrap" style={{ gap: "16px" }}>
                      <label className="check-row" htmlFor="me-th-a">
                        <input className="rd" id="me-th-a" type="radio" name="me-theme" checked={prefs.theme === 'auto'} onChange={() => prefs.setTheme('auto')} />
                        자동
                      </label>
                      <label className="check-row" htmlFor="me-th-d">
                        <input className="rd" id="me-th-d" type="radio" name="me-theme" checked={prefs.theme === 'dark'} onChange={() => prefs.setTheme('dark')} />
                        다크
                      </label>
                      <label className="check-row" htmlFor="me-th-l">
                        <input className="rd" id="me-th-l" type="radio" name="me-theme" checked={prefs.theme === 'light'} onChange={() => prefs.setTheme('light')} />
                        라이트
                      </label>
                    </div>
                    <span className="li-sub" id="me-theme-h">자동은 데스크톱 배치에서 다크, 휴대폰·태블릿 배치에서 기기 설정을 따릅니다.</span>
                  </fieldset>
                </li>
              </ul>
            </section>
    {v.isReauth ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="ra-t" aria-describedby="ra-d">
            <span className="sheet-handle" aria-hidden="true" />
            <div className="row" style={{ gap: "12px" }}>
              <span className="state-icon is-primary" style={{ width: "44px", height: "44px" }}><i className="ic ic-lock" aria-hidden="true" /></span>
              <h2 className="t-lg" id="ra-t">다시 인증합니다</h2>
            </div>
            <p className="t-sm muted" id="ra-d">비밀번호를 바꾸기 전에 비밀번호와 인증 앱의 6자리 코드를 다시 입력합니다. 인증은 5분 동안 한 번 쓸 수 있습니다.</p>
            <div className="field">
              <label className="label" htmlFor="ra-pw">비밀번호</label>
              <input className="input is-focus" id="ra-pw" type="password" autoComplete="current-password" defaultValue="" />
            </div>
            <div className="field">
              <label className="label" htmlFor="ra-otp">인증 앱의 6자리 코드</label>
              <input className="input" id="ra-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} defaultValue="" aria-describedby="ra-otp-h" />
              <span className="hint" id="ra-otp-h">휴대폰을 잃을 때 로그인과 인증 앱 코드를 함께 잃지 않도록, 인증 앱은 이 휴대폰이 아닌 다른 기기에 두기를 권합니다.</span>
            </div>
            <button className="btn btn-primary btn-lg btn-block" type="button">인증하고 비밀번호 바꾸기</button>
            {' '}
            <button className="btn btn-ghost btn-block" type="button">그만두기</button>
          </div>
        </Overlay>
      </>
    ) : null}
    {v.isTotpReg ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="tr-t" aria-describedby="tr-d" style={{ gap: "10px" }}>
            <span className="sheet-handle" aria-hidden="true" />
            <p className="row t-sm tx-success" style={{ gap: "6px", alignItems: "flex-start" }}>
              <i className="ic ic-check-circle ic-16" aria-hidden="true" style={{ marginTop: "2px" }} />
              <span>다시 인증했습니다. 인증은 5분 동안 한 번 쓸 수 있습니다</span>
            </p>
            <h2 className="t-lg" id="tr-t">인증 앱 다시 등록</h2>
            <p className="t-sm muted" id="tr-d">새 설정을 인증 앱에 추가하고 앱에 보이는 6자리 코드로 확인합니다. 확인하면 이전 설정은 쓸 수 없습니다.</p>
            <section className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }} aria-labelledby="tr-key-t">
              <h3 className="t-sm fw-b" id="tr-key-t">이 휴대폰의 인증 앱에 넣기</h3>
              <p className="t-xs muted" id="tr-key-d">같은 휴대폰의 카메라로는 QR을 찍을 수 없습니다. 설정 키를 복사해 인증 앱에 붙여넣으세요.</p>
              <div className="row" style={{ gap: "8px" }}>
                <span className="mono t-sm fw-b grow" id="tr-key">PKET DEMO 7Q2M X4KA(예시)</span>
                <button className="btn btn-outline btn-sm" type="button" aria-describedby="tr-key-d">
                  <i className="ic ic-copy" aria-hidden="true" />
                  설정 키 복사
                </button>
              </div>
            </section>
            <section className="card-flat row" style={{ gap: "12px", padding: "12px 14px", alignItems: "flex-start" }} aria-labelledby="tr-qr-t">
              <div className="qr-wrap" role="img" aria-label="인증 앱 등록 QR" style={{ width: "96px", padding: "6px", flex: "none" }}>
                <div className="qr">
                  {v.qr.map((m: any, i0: number) => (
                    <Fragment key={i0}>
                      <i className={m.on} />
                    </Fragment>
                  ))}
                </div>
              </div>
              <div className="col" style={{ gap: "4px" }}>
                <h3 className="t-sm fw-b" id="tr-qr-t">다른 기기의 인증 앱으로 찍기</h3>
                <p className="t-xs muted">인증 앱을 다른 기기에 두었다면 그 기기의 카메라로 이 QR을 찍습니다.</p>
              </div>
            </section>
            <p className="row t-xs muted" style={{ gap: "6px", alignItems: "flex-start" }}>
              <i className="ic ic-info ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
              <span>휴대폰으로 로그인해 승인할 예정이라면, 휴대폰을 잃을 때 인증 앱까지 함께 잃지 않도록 인증 앱은 다른 기기에 등록하기를 권합니다.</span>
            </p>
            <div className="field">
              <label className="label" id="tr-l" htmlFor="tr-otp">인증 앱의 6자리 코드</label>
              {' '}
              <input className="otp-input is-focus" id="tr-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" defaultValue="" />
            </div>
            <button className="btn btn-primary btn-lg btn-block" type="button">새 설정으로 등록합니다</button>
            {' '}
            <button className="btn btn-ghost btn-block" type="button">그만두기</button>
          </div>
        </Overlay>
      </>
    ) : null}
    {v.isIdle ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="id-t" aria-describedby="id-d">
            <span className="sheet-handle" aria-hidden="true" />
            <div className="row between">
              <span className="state-icon is-warning" style={{ width: "44px", height: "44px" }}><i className="ic ic-clock" aria-hidden="true" /></span>
              <span className="timer is-warning" role="timer" aria-label="자동 잠금까지 1분 58초">
                <i className="ic ic-clock" aria-hidden="true" />
                1:58
              </span>
            </div>
            <h2 className="t-lg" id="id-t">2분 뒤 자동으로 잠깁니다</h2>
            <p className="t-sm" id="id-d">1시간 동안 동작이 없으면 보안을 위해 세션이 끝납니다. 계속 쓰려면 아래 버튼을 누르세요. 잠긴 뒤에는 비밀번호와 인증 앱 코드로 다시 로그인하면 이 화면으로 돌아옵니다.</p>
            <p className="t-xs muted">계속 사용해도 세션의 최대 수명 24시간은 늘어나지 않습니다.</p>
            <button className="btn btn-primary btn-lg btn-block is-focus" type="button">계속 사용</button>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
