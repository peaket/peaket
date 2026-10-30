// [스태프] 하위 탭(보드 SCR-037 isStaffTab): 현장 스태프 초대 폼 · 배정 명단 · 스캔·예외 통과 요약.
// 데스크톱: 초대 폼 7:5 · 명단은 카드 안 표 / 태블릿: 초대 폼 2열 · 명단은 가로 스크롤 표 / 휴대폰: 한 열 · 명단은 카드 목록.
import { StatTile } from '@peaket/ds/StatTile';
import { inviteErrors, INVITE_FAIL_TEXT, STAFF_STATUS_BADGE, staffRows, staffSummary, type StaffRow } from '../model/fixtures';
import { revokeDialogId } from './Dialogs';

/** 카드 상자(데스크톱)를 태블릿·휴대폰에서 벗긴다(보드 SCR-037-t·m은 머리글이 상자 밖) */
const CARD_LG_ONLY = 'card max-lg:overflow-visible max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent';

export interface StaffPanelProps {
  roundLabel: string;
  inviteFail: boolean;
  empty: boolean;
}

export function StaffPanel({ roundLabel, inviteFail, empty }: StaffPanelProps) {
  return (
    <>
      <InviteForm inviteFail={inviteFail} />
      <Roster roundLabel={roundLabel} empty={empty} />
      {!empty && (
        <section className="col" style={{ gap: 10 }} aria-labelledby="sum-h">
          <h3 className="t-md fw-b" id="sum-h">
            스캔·예외 통과 요약
          </h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {staffSummary.map((s) => (
              <StatTile key={s.label} label={s.label} value={s.value} meta={s.meta} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/* ---------- 초대 폼 ---------- */

function InviteForm({ inviteFail }: { inviteFail: boolean }) {
  const hint = '한 줄에 하나씩 적습니다. 한 번에 최대 200명 [가정]';
  return (
    <section className="card col gap-4 p-4 md:p-6" aria-labelledby="inv-h">
      <h3 className="t-md fw-b" id="inv-h">
        현장 스태프 초대
      </h3>
      <form className="grid gap-4 md:grid-cols-2 md:items-start md:gap-5 lg:grid-cols-12 lg:gap-x-6 lg:gap-y-4" aria-labelledby="inv-h">
        <div className="col lg:col-span-7" style={{ gap: 12 }}>
          {inviteFail ? (
            <div className="field">
              <label className="label" htmlFor="inv-emails">
                초대할 이메일 (필수)
              </label>
              <textarea
                className="input textarea is-error min-h-32 md:min-h-[136px]"
                id="inv-emails"
                inputMode="email"
                autoComplete="off"
                aria-invalid="true"
                aria-describedby="inv-err inv-hint"
                defaultValue={INVITE_FAIL_TEXT}
              />
              <span className="hint" id="inv-hint">
                {hint}
              </span>
            </div>
          ) : (
            <div className="field">
              <label className="label" htmlFor="inv-emails">
                초대할 이메일 (필수)
              </label>
              <textarea
                className="textarea min-h-32 md:min-h-[136px]"
                id="inv-emails"
                inputMode="email"
                autoComplete="off"
                aria-describedby="inv-hint"
                placeholder="staff1@example.com"
              />
              <span className="hint" id="inv-hint">
                {hint}
              </span>
            </div>
          )}
        </div>
        <div className="col lg:col-span-5" style={{ gap: 14 }}>
          <fieldset className="col">
            <legend className="label" style={{ marginBottom: 10 }}>
              역할 (필수)
            </legend>
            <div className="col" style={{ gap: 12 }}>
              <label className="check-row" htmlFor="role-staff">
                <input className="rd" id="role-staff" type="radio" name="inv-role" defaultChecked />
                <span className="col" style={{ gap: 2 }}>
                  <span className="fw-b">현장 스태프</span>
                  <span className="t-xs muted">티켓 스캔과 판정</span>
                </span>
              </label>
              <label className="check-row" htmlFor="role-lead">
                <input className="rd" id="role-lead" type="radio" name="inv-role" />
                <span className="col" style={{ gap: 2 }}>
                  <span className="fw-b">현장 책임자</span>
                  <span className="t-xs muted">기기 배치, 예외 통과, 이상 표시 확인, 부스 재발급 허용, 확인 스캔까지</span>
                </span>
              </label>
            </div>
          </fieldset>
          <p className="t-xs muted">
            초대는 24시간 동안 한 번 쓸 수 있습니다. 본인확인을 마치고 검증된 이메일이 초대 이메일과 같은 계정만 수락합니다. 이미 배정된 계정인지는 초대받은 분이
            수락할 때 확인합니다. 권한은 입장 시작 3시간 전부터 공연 종료 2시간 뒤까지입니다.
          </p>
          <button
            className="btn btn-primary max-md:min-h-[52px] max-md:w-full max-md:rounded-[var(--r-lg)] max-md:text-base md:self-start"
            type="button"
          >
            <i className="ic ic-mail" aria-hidden="true" />
            초대 보내기
          </button>
        </div>
        {inviteFail && <InviteErrors />}
      </form>
    </section>
  );
}

function InviteErrors() {
  return (
    <div className="col md:col-span-2 lg:col-span-12" style={{ gap: 10 }} id="inv-err" role="alert">
      <div className="banner banner-danger">
        <i className="ic ic-alert-circle" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">형식이 맞지 않는 행이 있어 아무도 초대하지 않았습니다(2건)</span>
          아래 행을 고친 뒤 다시 보내 주세요.
        </div>
      </div>
      <div className="table-wrap table-scroll max-md:hidden">
        <table className="table dense md:max-lg:min-w-[480px]">
          <caption className="sr-only">초대 형식 오류 행</caption>
          <thead>
            <tr>
              <th scope="col" className="r">
                행
              </th>
              <th scope="col">입력</th>
              <th scope="col">이유</th>
            </tr>
          </thead>
          <tbody>
            {inviteErrors.map((e) => (
              <tr key={e.line}>
                <td className="r">{e.line}</td>
                <td className="mono">{e.input}</td>
                <td>{e.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="col md:hidden" style={{ gap: 8 }} aria-label="초대 형식 오류 행">
        {inviteErrors.map((e) => (
          <li key={e.line} className="card-flat col" style={{ padding: '10px 14px', gap: 2 }}>
            <span className="t-xs muted">{e.line}행</span>
            <span className="t-sm mono">{e.input}</span>
            <span className="t-sm tx-danger">{e.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- 배정 명단 ---------- */

function StatusCell({ row }: { row: StaffRow }) {
  if (!row.statusNote) return <span className={STAFF_STATUS_BADGE[row.status]}>{row.status}</span>;
  return (
    <div className="col" style={{ gap: 2 }}>
      <span className={STAFF_STATUS_BADGE[row.status]} style={{ alignSelf: 'flex-start' }}>
        {row.status}
      </span>
      <span className="t-xs muted num">{row.statusNote}</span>
    </div>
  );
}

function ResendButton({ row, className }: { row: StaffRow; className: string }) {
  return (
    <button className={className} type="button" aria-label={`${row.target} 재발송`}>
      재발송
    </button>
  );
}

function RevokeButton({ row, className }: { row: StaffRow; className: string }) {
  const named = row.nickname !== null;
  return (
    <button
      className={className}
      type="button"
      aria-haspopup="dialog"
      data-modal-open={revokeDialogId(row)}
      aria-label={named ? undefined : `${row.target} 권한 해제`}
    >
      {named ? `${row.nickname} 권한 해제` : '권한 해제'}
    </button>
  );
}

function Pager() {
  return (
    <nav className="pager" aria-label="배정 명단 쪽">
      <button className="pg" type="button" aria-label="이전 쪽" disabled>
        <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
      </button>
      <button className="pg" type="button" aria-current="page">
        1
      </button>
      <button className="pg" type="button">
        2
      </button>
      <button className="pg" type="button">
        3
      </button>
      <button className="pg" type="button" aria-label="다음 쪽">
        <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
      </button>
    </nav>
  );
}

function Roster({ roundLabel, empty }: { roundLabel: string; empty: boolean }) {
  return (
    <section className={`${CARD_LG_ONLY} col gap-2.5 lg:gap-0 lg:overflow-hidden`} aria-labelledby="ros-h">
      <div className="row between wrap max-md:flex-col max-md:items-start gap-x-3 gap-y-1 max-md:gap-0.5 lg:gap-2 lg:px-5 lg:py-4">
        <h3 className="t-md fw-b" id="ros-h">
          배정 명단
        </h3>
        <span className="t-xs muted">{roundLabel} 회차 · 개인정보 없이 닉네임·역할·수락 여부·건수만 보입니다</span>
      </div>
      {empty ? (
        <div className="card lg:rounded-none lg:border-0 lg:bg-transparent">
          <div className="state max-md:px-5 max-md:py-8">
            <span className="state-icon">
              <i className="ic ic-users" aria-hidden="true" />
            </span>
            <h4 className="t-md fw-b">배정된 현장 스태프가 없습니다</h4>
            <p className="t-sm muted">위의 초대 폼에서 이메일로 초대합니다. 수락한 분은 입장 시작 3시간 전부터 스캐너에 로그인할 수 있습니다.</p>
          </div>
        </div>
      ) : (
        <>
          {/* 태블릿·데스크톱: 표(태블릿은 가로 스크롤 상자) */}
          <div className="table-wrap table-scroll max-md:hidden lg:rounded-none lg:border-0" role="region" aria-label="배정 명단 표" tabIndex={0}>
            <table className="table dense md:max-lg:min-w-[700px]">
              <caption className="sr-only">현장 스태프 배정 명단(닉네임·역할·수락 여부·권한 유효 시간·스캔 수·예외 통과 수)</caption>
              <thead>
                <tr>
                  <th scope="col">닉네임</th>
                  <th scope="col">역할</th>
                  <th scope="col">상태</th>
                  <th scope="col">권한 유효 시간</th>
                  <th scope="col" className="r">
                    스캔 수
                  </th>
                  <th scope="col" className="r">
                    예외 통과 수
                  </th>
                  <th scope="col">관리</th>
                </tr>
              </thead>
              <tbody>
                {staffRows.map((r) => (
                  <tr key={r.id}>
                    <td className={r.nickname ? 'fw-b' : 'muted'}>{r.nickname ?? '수락 전'}</td>
                    <td>{r.role}</td>
                    <td>
                      <StatusCell row={r} />
                    </td>
                    <td className="num">{r.validity}</td>
                    <td className={r.scans === null ? 'r muted' : 'r'}>{r.scans ?? '—'}</td>
                    <td className={r.exceptions === null ? 'r muted' : 'r'}>{r.exceptions ?? '—'}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {r.canResend && <ResendButton row={r} className="btn btn-outline btn-sm" />}
                        {r.canRevoke && <RevokeButton row={r} className="btn btn-danger-outline btn-sm" />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 휴대폰: 카드 목록 */}
          <ul className="col md:hidden" style={{ gap: 8 }} aria-label="현장 스태프 배정 명단(닉네임·역할·수락 여부·권한 유효 시간·스캔 수·예외 통과 수)">
            {staffRows.map((r) => (
              <li key={r.id} className="card col" style={{ padding: 14, gap: 8 }}>
                <div className="row between" style={{ gap: 8 }}>
                  <span className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                    <span className={r.nickname ? 't-md fw-b' : 't-md muted'}>{r.nickname ?? '수락 전'}</span>
                    <span className="t-sm muted">{r.role}</span>
                  </span>
                  <span className={STAFF_STATUS_BADGE[r.status]}>{r.status}</span>
                </div>
                {r.statusNote ? <p className="t-xs muted num">{r.statusNote}</p> : null}
                <p className="t-xs muted">
                  권한 유효 시간 <span className="num">{r.validity}</span>
                </p>
                {r.scans === null ? (
                  <p className="t-sm muted">스캔 — · 예외 통과 —</p>
                ) : (
                  <p className="t-sm">
                    스캔 <span className="fw-b num">{r.scans}</span>
                    <span className="muted"> · </span>예외 통과 <span className="fw-b num">{r.exceptions}</span>
                  </p>
                )}
                {r.canResend && r.canRevoke ? (
                  <div className="row" style={{ gap: 8 }}>
                    <ResendButton row={r} className="btn btn-outline grow" />
                    <RevokeButton row={r} className="btn btn-danger-outline grow" />
                  </div>
                ) : r.canResend ? (
                  <ResendButton row={r} className="btn btn-outline self-start" />
                ) : r.canRevoke ? (
                  <RevokeButton row={r} className="btn btn-danger-outline self-start" />
                ) : null}
              </li>
            ))}
          </ul>

          <div className="row between wrap max-md:flex-col max-md:items-stretch gap-2.5 md:gap-2 lg:px-5 lg:py-2.5">
            <span className="t-xs muted">명단 9명 · 상태: 대기 · 수락 · 만료 · 해제 · 종료(권한 유효 끝)</span>
            <div className="max-md:self-center">
              <Pager />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
