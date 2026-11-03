// SCR-020 설정 › 팀 계정(/settings/team, d5 §6.1 ⑨, 보드 SCR-020 isTeam 구역). 파트너 관리자만 본다.
// 데스크톱·태블릿은 표, 휴대폰은 카드 목록(d5 §3.9). 실무자로 열면 표 대신 권한 안내(추천안: 보드에 없어 CMP-046 모양으로).
import { PARTNER_ROLE_LABEL } from '@/entities/partner-user';
import { stellaOrg } from '@/entities/partner-org';
import { routes } from '@/shared/config/routes';
import { TEAM_STATES } from '@/shared/config/states/scr020-settings';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { teamRows } from '../model/settings';
import { SettingsFrame } from './SettingsFrame';

const STATUS_BADGE: Record<string, string> = { 활성: 'badge badge-success', '초대 대기': 'badge badge-warning', 잠김: 'badge badge-danger' };

export default async function TeamPage({ searchParams }: RouteProps) {
  const pv = readPreview(await searchParams, TEAM_STATES, '팀 계정');
  const caption = `${stellaOrg.name} 파트너 계정 ${teamRows.length}개의 이름, 가린 이메일, 역할, 상태, 마지막 접속`;

  return (
    <>
      <SettingsFrame current="team" isMember={pv.isMember} keep={pv.keep}>
        <div className="page-head">
          <h1>팀 계정</h1>
          <span className="badge badge-outline">파트너 관리자만 봅니다</span>
        </div>

        {pv.isMember ? (
          <section className="card" aria-labelledby="h-denied">
            <div className="state" style={{ padding: '48px 24px' }}>
              <span className="state-icon is-warning">
                <i className="ic ic-lock" aria-hidden="true" />
              </span>
              <h2 className="t-lg" id="h-denied">
                팀 계정은 파트너 관리자만 볼 수 있습니다
              </h2>
              <p className="t-sm muted">계정 추가·삭제·역할 변경은 파트너 관리자가 PEAKET 운영자에게 요청합니다.</p>
            </div>
          </section>
        ) : (
          <>
            <div className="table-wrap max-md:hidden">
              <table className="table dense">
                <caption className="sr-only">{caption}</caption>
                <thead>
                  <tr>
                    <th scope="col">이름</th>
                    <th scope="col">이메일</th>
                    <th scope="col">역할</th>
                    <th scope="col">상태</th>
                    <th scope="col">마지막 접속</th>
                  </tr>
                </thead>
                <tbody>
                  {teamRows.map((r) => (
                    <tr key={r.id}>
                      <td className="fw-b">
                        {r.name}
                        {r.isMe && <span className="t-xs muted fw-r"> (나)</span>}
                      </td>
                      <td className="mono">{r.emailMasked}</td>
                      <td>{PARTNER_ROLE_LABEL[r.role]}</td>
                      <td>
                        <span className={STATUS_BADGE[r.status]}>{r.status}</span>
                      </td>
                      <td className="num">{r.lastSeenAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="col md:hidden" style={{ gap: 12 }} aria-label={caption}>
              {teamRows.map((r) => (
                <li key={r.id} className="card col" style={{ padding: '14px 16px', gap: 8 }}>
                  <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <h2 className="t-md fw-b">
                      {r.name}
                      {r.isMe && <span className="t-xs muted fw-r"> (나)</span>}
                    </h2>
                    <span className={STATUS_BADGE[r.status]}>{r.status}</span>
                  </div>
                  <dl className="kv">
                    <dt>이메일</dt>
                    <dd className="mono">{r.emailMasked}</dd>
                    <dt>역할</dt>
                    <dd>{PARTNER_ROLE_LABEL[r.role]}</dd>
                    <dt>마지막 접속</dt>
                    <dd>{r.lastSeenAt}</dd>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="banner banner-info">
          <i className="ic ic-info" aria-hidden="true" />
          <div className="banner-body">계정 추가·삭제·역할 변경은 PEAKET 운영자에게 요청하세요</div>
        </div>
      </SettingsFrame>
      <PreviewStateSwitcher path={routes.settingsTeam()} states={TEAM_STATES} current={pv.state} keep={pv.keep} />
    </>
  );
}
