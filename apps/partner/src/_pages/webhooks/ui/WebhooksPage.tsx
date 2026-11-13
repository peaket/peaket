// SCR-025 웹훅 연동(/settings/webhooks). 보드 SCR-025-m·t·d를 한 페이지 반응형으로 합쳤다(d5 §6.8, §3.9).
// 데스크톱(lg): [7열] 받는 주소와 서명 | [5열] 받는 서버에서 확인할 것 · 구독할 이벤트, 아래 보낸 이벤트 표 /
// 태블릿: 받는 주소와 서명 → 확인할 것·구독 2열 → 가로 스크롤 표 / 휴대폰: 보기만(꺼짐 상태 카드, 안내 카드, 이벤트 카드 목록).
// 실무자는 [주소 저장]·[재발급]·[구독 저장]·[다시 보내기](와 [다시 켜기])가 aria-disabled이고, 모두 머리 배너 하나를 가리킨다(d2 §3.6 여러 버튼 규칙).
import Link from 'next/link';
import { routes } from '@/shared/config/routes';
import { WEBHOOK_STATES } from '@/shared/config/states/scr025';
import { readParam, readPreview, type RouteProps } from '@/shared/lib/preview';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { Modal } from '@/shared/ui/Modal';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import {
  BAD_URL,
  DISABLED_INFO,
  DISABLED_LOG_COUNTS,
  ENDPOINT,
  EVENT_TYPES,
  LOG_COUNTS,
  deliveries,
  disabledDeliveries,
} from '../model/webhooks';
import { CopySecretButton } from './CopySecretButton';
import { DeliveryLog } from './DeliveryLog';
import { UseCases } from './UseCases';
import { LiveWebhooksPage } from './live/WebhooksLive';

type WebhookState = (typeof WEBHOOK_STATES)[number];

const MEMBER_WHY = 'wh-member-why';
const ROTATE_DIALOG = 'wh-rotate';

/** 실무자에게 막는 버튼의 속성(이유 글은 머리 배너) */
function blockedProps(isMember: boolean) {
  return isMember ? { 'aria-disabled': 'true' as const, 'aria-describedby': MEMBER_WHY } : {};
}

function withState(path: string, keep: Record<string, string | undefined>, state: WebhookState): string {
  const p = new URLSearchParams();
  if (state !== '기본') p.set('state', state);
  for (const [k, v] of Object.entries(keep)) if (v !== undefined) p.set(k, v);
  return `${path}?${p.toString()}`;
}

export default async function WebhooksPage({ searchParams }: RouteProps) {
  const sp = await searchParams;
  const pv = readPreview(sp, WEBHOOK_STATES, '기본');
  if (readParam(sp, 'state') === undefined) return <LiveWebhooksPage isMember={pv.isMember} />;
  const st = pv.state;
  const off = st === '계속 실패해 꺼짐';
  const noSub = st === '구독 없음';
  const path = routes.settingsWebhooks();

  return (
    <>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>웹훅 연동</h1>
          <p className="t-sm muted">판매 이벤트를 파트너사 서버로 보냅니다. 시각은 모두 KST입니다.</p>
        </div>
      </div>

      <div className="banner banner-info" role="note">
        <i className="ic ic-info" aria-hidden="true" />
        <div className="banner-body">
          웹훅은 판매·취소·매진·정산 같은 일이 생기면 피켓이 파트너 회사의 서버 주소로 바로 알려 주는 기능입니다. 회계 시스템이나 사내 메신저가 콘솔을 계속
          확인하지 않아도 됩니다. 이름·연락처·좌석 번호는 보내지 않습니다. 쓰지 않아도 판매와 정산에는 영향이 없습니다.
        </div>
      </div>

      {pv.isMember && (
        <div className="banner banner-warning" role="note">
          <i className="ic ic-lock" aria-hidden="true" />
          <div className="banner-body" id={MEMBER_WHY}>
            웹훅 등록·서명 비밀 재발급·다시 보내기는 파트너 관리자만 할 수 있습니다
          </div>
        </div>
      )}

      <UseCases />

      {/* 휴대폰: 보기만 */}
      <section className="col md:hidden" style={{ gap: 12 }} aria-labelledby="h-setup-m">
        <h2 className="t-lg" id="h-setup-m">
          받는 주소와 서명
        </h2>
        {off && (
          <div className="card col" style={{ padding: '14px 16px', gap: 10 }}>
            <div className="row between wrap" style={{ gap: 8 }}>
              <h3 className="t-md fw-b">받는 주소</h3>
              <OffBadge />
            </div>
            <p className="t-sm mono" style={{ wordBreak: 'break-all' }}>
              {ENDPOINT.url}
            </p>
            <div className="banner banner-danger" role="status">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">{DISABLED_INFO.title}</span>
                {DISABLED_INFO.detail}
              </div>
            </div>
          </div>
        )}
        {noSub && <NoSubscription />}
        <BigScreenNotice
          title={off ? '주소 저장·비밀 재발급·다시 켜기는 태블릿이나 데스크톱에서 합니다' : '주소 저장과 비밀 재발급은 태블릿이나 데스크톱에서 합니다'}
          copyLabel="주소 저장 링크 복사"
        />
      </section>

      {/* 태블릿·데스크톱 */}
      <div className="grid-12 max-md:hidden max-lg:flex max-lg:flex-col max-lg:gap-5" style={{ rowGap: 20, alignItems: 'start' }}>
        <section className="span-7 card col" style={{ padding: 24, gap: 24 }} aria-labelledby="h-setup">
          <h2 className="t-lg" id="h-setup">
            받는 주소와 서명
          </h2>
          <UrlBlock state={st} isMember={pv.isMember} />
          <SecretBlock state={st} isMember={pv.isMember} />
        </section>

        <div className="span-5 flex flex-col gap-5 md:max-lg:grid md:max-lg:grid-cols-2 md:max-lg:items-start md:max-lg:gap-4">
          <aside className="card-flat col p-5 lg:px-6" style={{ gap: 12 }} aria-labelledby="h-guide">
            <h2 className="t-md fw-b" id="h-guide">
              받는 서버에서 확인할 것
            </h2>
            <ol className="col" style={{ gap: 12 }}>
              <li className="row t-sm" style={{ gap: 10, alignItems: 'flex-start' }}>
                <span className="step-num" aria-hidden="true">
                  1
                </span>
                <span>
                  <span className="mono">webhook-timestamp</span>가 지금과 5분 넘게 다르면 받지 않습니다.
                </span>
              </li>
              <li className="row t-sm" style={{ gap: 10, alignItems: 'flex-start' }}>
                <span className="step-num" aria-hidden="true">
                  2
                </span>
                <span>
                  <span className="mono">webhook-id</span>로 이미 받은 이벤트를 거릅니다. 다시 보낼 때도 같은 값입니다.
                </span>
              </li>
              <li className="row t-sm" style={{ gap: 10, alignItems: 'flex-start' }}>
                <span className="step-num" aria-hidden="true">
                  3
                </span>
                <span>
                  받은 본문을 다시 직렬화하지 말고 그대로 <span className="mono">webhook-signature</span>를 검증합니다.
                </span>
              </li>
            </ol>
            <p className="t-xs muted">서명은 Standard Webhooks 형식(HMAC-SHA256)입니다. 비밀을 바꾸는 24시간 동안에는 서명 헤더에 두 값이 공백으로 이어 옵니다.</p>
          </aside>

          <section className="card col p-5 lg:px-6" style={{ gap: 12 }} aria-labelledby="h-sub">
            <h2 className="t-md fw-b" id="h-sub">
              구독할 이벤트
            </h2>
            {noSub && <NoSubscription />}
            <fieldset className="col" style={{ gap: 12 }}>
              <legend className="sr-only">보낼 이벤트 고르기</legend>
              {EVENT_TYPES.map((e) => (
                <label key={e.type} className="check-row">
                  <input className="cb" type="checkbox" defaultChecked={!noSub && e.checked} />
                  <span className="col" style={{ gap: 2 }}>
                    <span>
                      {e.label} <span className="t-xs muted mono">{e.type}</span>
                    </span>
                    <span className="t-sm muted">{e.desc}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" type="button" {...blockedProps(pv.isMember)}>
                구독 저장
              </button>
            </div>
          </section>
        </div>
      </div>

      <section className="col" style={{ gap: 12 }} aria-labelledby="h-log">
        <div className="section-title">
          <h2 id="h-log">보낸 이벤트와 재시도</h2>
          <span className="t-sm muted max-md:text-xs">{off ? '10/9(금)~10/14(수) · 최근 5건' : '10/14(수) · 최근 5건'}</span>
        </div>
        <p className="t-sm muted">
          받는 서버가 실패로 응답하면 간격을 늘려 가며 다시 보냅니다. 끝내 받지 못한 이벤트는 DLQ(실패 보관함)로 옮깁니다. DLQ와 성공한 이벤트는 여기서 다시 보낼 수
          있습니다.
        </p>
        <DeliveryLog
          key={st}
          rows={off ? disabledDeliveries : deliveries}
          counts={off ? DISABLED_LOG_COUNTS : LOG_COUNTS}
          initial={st === 'DLQ만 보기' ? 'dlq' : 'all'}
          off={off}
          memberReasonId={pv.isMember ? MEMBER_WHY : undefined}
        />
      </section>

      <Modal id={ROTATE_DIALOG} defaultOpen={st === '비밀 재발급 확인'} labelledBy="rk-t" describedBy="rk-d" maxWidth={460}>
        <h2 className="dialog-title" id="rk-t">
          서명 비밀을 새로 만듭니다
        </h2>
        <div className="col" id="rk-d" style={{ gap: 10 }}>
          <p className="t-sm">새 비밀은 만든 직후에 한 번만 전체를 보여 드립니다. 이전 비밀은 24시간 동안 함께 유효합니다.</p>
          <ul className="col t-sm muted" style={{ gap: 6 }}>
            <li className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <i className="ic ic-check ic-16" aria-hidden="true" style={{ marginTop: 2 }} />
              <span>24시간 안에 받는 서버의 비밀을 새 비밀로 바꾸세요.</span>
            </li>
            <li className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <i className="ic ic-check ic-16" aria-hidden="true" style={{ marginTop: 2 }} />
              <span>24시간이 지나면 새 비밀로만 서명해 보냅니다.</span>
            </li>
          </ul>
        </div>
        <div className="dialog-actions">
          <button className="btn btn-outline" type="button" data-modal-close="">
            지금 비밀 그대로 두기
          </button>
          {/* 퍼블리싱: 만들면 '새 비밀 한 번 보기' 상태로 간다 */}
          <Link className="btn btn-primary" href={withState(path, pv.keep, '새 비밀 한 번 보기')}>
            새 비밀 만들기
          </Link>
        </div>
      </Modal>

      <PreviewStateSwitcher path={path} states={WEBHOOK_STATES} current={st} keep={pv.keep} />
    </>
  );
}

function OffBadge() {
  return (
    <span className="badge badge-danger">
      <i className="ic ic-pause" aria-hidden="true" />
      꺼짐 · 계속 실패
    </span>
  );
}

/** 구독 없음(d5 §6.8 상태 표, 보드에 없어 더함) */
function NoSubscription() {
  return (
    <div className="banner banner-warning" role="status">
      <i className="ic ic-alert" aria-hidden="true" />
      <div className="banner-body">고른 이벤트가 없어 보내지 않습니다</div>
    </div>
  );
}

/* ---------- ① 받는 주소 ---------- */

function UrlBlock({ state, isMember }: { state: WebhookState; isMember: boolean }) {
  const off = state === '계속 실패해 꺼짐';
  const bad = state === 'http 입력 오류' ? BAD_URL.http : state === '주소 거절' ? BAD_URL.rejected : null;
  const saveBtn = (
    <button className="btn btn-primary" type="button" style={{ height: 48, marginTop: 25 }} {...blockedProps(isMember)}>
      주소 저장
    </button>
  );
  return (
    <div className="col" style={{ gap: 10 }}>
      {off ? (
        <div className="row between wrap" style={{ gap: 8 }}>
          <h3 className="t-md fw-b">받는 주소</h3>
          <OffBadge />
        </div>
      ) : (
        <h3 className="t-md fw-b">받는 주소</h3>
      )}
      {bad ? (
        <div className="col" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <div className="field grow">
              <label className="label" htmlFor="wh-url-x">
                웹훅 주소 (필수)
              </label>
              <input
                className="input is-error"
                id="wh-url-x"
                type="url"
                inputMode="url"
                defaultValue={bad.value}
                aria-invalid="true"
                aria-describedby="wh-url-x-e"
              />
              <span className="error-msg" id="wh-url-x-e" role="alert">
                <i className="ic ic-alert-circle" aria-hidden="true" />
                {bad.message}
              </span>
            </div>
            {saveBtn}
          </div>
          <p className="t-xs muted">저장하지 않았습니다. 지금은 이전 주소 {ENDPOINT.url}로 계속 보냅니다.</p>
        </div>
      ) : (
        <div className="col" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <div className="field grow">
              <label className="label" htmlFor="wh-url">
                웹훅 주소 (필수)
              </label>
              <input className="input" id="wh-url" type="url" inputMode="url" defaultValue={ENDPOINT.url} aria-describedby="wh-url-h" />
              <span className="hint" id="wh-url-h">
                https로 시작하는 주소만 받습니다
              </span>
            </div>
            {saveBtn}
          </div>
          <p className="row t-xs muted" style={{ gap: 6 }}>
            <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
            저장됨 · {ENDPOINT.savedAt}
          </p>
          {off && (
            <div className="banner banner-danger" role="status">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              <div className="banner-body col" style={{ gap: 8 }}>
                <span className="banner-title">{DISABLED_INFO.title}</span>
                <p>{DISABLED_INFO.detail}</p>
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  style={{ alignSelf: 'flex-start' }}
                  aria-disabled={isMember ? 'true' : undefined}
                  aria-describedby={isMember ? `${MEMBER_WHY} wh-on-h` : 'wh-on-h'}
                >
                  다시 켜기
                </button>
                <p className="t-xs" id="wh-on-h">
                  다시 켜면 그 뒤에 생긴 일부터 보냅니다.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- ② 서명 비밀 ---------- */

function SecretBlock({ state, isMember }: { state: WebhookState; isMember: boolean }) {
  if (state === '새 비밀 한 번 보기')
    return (
      <div className="col" style={{ gap: 10 }}>
        <div className="row between wrap" style={{ gap: 8 }}>
          <h3 className="t-md fw-b">서명 비밀</h3>
          <span className="badge badge-success">
            <i className="ic ic-check" aria-hidden="true" />
            새로 발급됨 {ENDPOINT.newSecretIssued}
          </span>
        </div>
        <div className="banner banner-warning" role="status">
          <i className="ic ic-eye" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">지금 한 번만 보입니다</span>이 화면을 벗어나면 다시 볼 수 없습니다. 복사해서 받는 서버에 넣으세요.
          </div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'stretch' }}>
          <div className="code grow" style={{ fontSize: 14 }}>
            {ENDPOINT.newSecret}
          </div>
          <CopySecretButton secret={ENDPOINT.newSecret} />
        </div>
        <div className="banner banner-info">
          <i className="ic ic-history" aria-hidden="true" />
          <div className="banner-body">
            이전 비밀은 24시간 동안 함께 유효합니다. {ENDPOINT.oldSecretUntil}까지 이전 비밀과 새 비밀로 함께 서명해 보냅니다.
          </div>
        </div>
      </div>
    );
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row between">
        <h3 className="t-md fw-b">서명 비밀</h3>
        <span className="badge badge-success">
          <i className="ic ic-check" aria-hidden="true" />
          발급됨 {ENDPOINT.secretIssued}
        </span>
      </div>
      <div className="field">
        <label className="label" htmlFor="wh-secret">
          현재 비밀(가려 둠)
        </label>
        <div className="row" style={{ gap: 8 }}>
          <div className="input-group is-disabled grow">
            <i className="ic ic-key" aria-hidden="true" />
            <input className="mono" id="wh-secret" type="text" readOnly value={ENDPOINT.secretMasked} aria-describedby="wh-secret-h" />
          </div>
          <button
            className="icon-btn icon-btn-outline"
            type="button"
            aria-label="서명 비밀 재발급"
            aria-haspopup="dialog"
            data-modal-open={ROTATE_DIALOG}
            style={{ width: 48, height: 48 }}
            {...blockedProps(isMember)}
          >
            <i className="ic ic-refresh" aria-hidden="true" />
          </button>
        </div>
        <span className="hint" id="wh-secret-h">
          비밀은 발급하거나 재발급한 직후에 한 번만 전체를 보여 드리고, 다시 볼 수 없습니다.
        </span>
      </div>
      <p className="row t-sm" style={{ gap: 8, alignItems: 'flex-start' }}>
        <i className="ic ic-history ic-16 muted" aria-hidden="true" style={{ marginTop: 2 }} />
        <span>재발급하면 이전 비밀은 24시간 동안 함께 유효합니다. 그동안 두 비밀로 함께 서명해 보냅니다.</span>
      </p>
    </div>
  );
}
