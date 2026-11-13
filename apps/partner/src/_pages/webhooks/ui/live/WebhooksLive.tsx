'use client';
// SCR-025 웹훅 연동 실제 API 판(openapi list/create/updatePartnerWebhook·secret-rotations·deliveries·redeliveries).
// 비밀 원문은 등록·재발급 응답에만 한 번 보이고, 목록에는 발급 시각만 있다.
import { useEffect, useState } from 'react';
import {
  createWebhook,
  listWebhookDeliveries,
  listWebhooks,
  redeliverWebhook,
  rotateWebhookSecret,
  updateWebhook,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEventType,
} from '@/shared/api/partner-live';
import { problemMessage } from '@/shared/api/problem';
import { EmptyCard, ErrorCard, LoadingCard, useAsync } from '@/shared/ui/Async';
import { Modal } from '@/shared/ui/Modal';
import {
  EVENT_TYPE_OPTIONS,
  checkWebhookUrl,
  deliveryResult,
  deliveryView,
  deliveryWhen,
  endpointView,
  eventTypeLabel,
  secretMasked,
  subscriptionText,
  toggleEvent,
} from '../../model/live';

function EventPicker({ selected, onChange, disabled }: { selected: WebhookEventType[]; onChange: (next: WebhookEventType[]) => void; disabled?: boolean }) {
  return (
    <fieldset className="col" style={{ gap: 12 }} disabled={disabled}>
      <legend className="sr-only">보낼 이벤트 고르기</legend>
      {EVENT_TYPE_OPTIONS.map((e) => (
        <label key={e.type} className="check-row">
          <input className="cb" type="checkbox" checked={selected.includes(e.type)} onChange={() => onChange(toggleEvent(selected, e.type))} />
          <span className="col" style={{ gap: 2 }}>
            <span>
              {e.label} <span className="t-xs muted mono">{e.type}</span>
            </span>
            <span className="t-sm muted">{e.desc}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function DeliveryTable({ rows, isMember, onRedeliver, busy }: { rows: WebhookDelivery[]; isMember: boolean; onRedeliver: (d: WebhookDelivery) => void; busy: string | null }) {
  if (rows.length === 0) return <EmptyCard title="보낸 이벤트가 없습니다" />;
  return (
    <div className="table-wrap table-scroll" role="region" aria-label="보낸 이벤트와 재시도 표" tabIndex={0}>
      <table className="table dense" style={{ minWidth: 760 }}>
        <caption className="sr-only">웹훅 발송 기록: 사건, 응답, 시도 횟수, 시각, 상태</caption>
        <thead>
          <tr>
            <th scope="col">사건</th>
            <th scope="col">응답</th>
            <th scope="col" className="r">
              시도
            </th>
            <th scope="col">시각(KST)</th>
            <th scope="col">상태</th>
            <th scope="col">
              <span className="sr-only">다시 보내기</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const view = deliveryView(d);
            return (
              <tr key={d.deliveryId}>
                <td>
                  <div className="col" style={{ gap: 2 }}>
                    <span className="fw-m">{eventTypeLabel(d.eventType)}</span>
                    <span className="t-xs muted mono">{d.webhookId}</span>
                  </div>
                </td>
                <td className={d.lastHttpStatus && d.lastHttpStatus >= 400 ? 'tx-danger' : undefined}>{deliveryResult(d)}</td>
                <td className="r">{d.attemptCount}</td>
                <td className="num">{deliveryWhen(d)}</td>
                <td>
                  <span className={view.badge}>{view.label}</span>
                </td>
                <td>
                  {view.canRedeliver && !isMember ? (
                    <button className="btn btn-outline btn-sm" type="button" disabled={busy === d.deliveryId} onClick={() => onRedeliver(d)}>
                      다시 보내기
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function LiveWebhooksPage({ isMember }: { isMember: boolean }) {
  const endpoints = useAsync('webhooks', (signal) => listWebhooks(signal));
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = endpoints.status === 'ready' ? endpoints.data : [];
  const endpoint = creating ? null : (list.find((e) => e.endpointId === endpointId) ?? list[0] ?? null);
  const [url, setUrl] = useState('');
  const [eventTypes, setEventTypes] = useState<WebhookEventType[]>([]);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [newSecret, setNewSecret] = useState<{ secret: string; previousValidUntil?: string } | null>(null);
  const [deliveryFilter, setDeliveryFilter] = useState<'all' | 'RETRYING' | 'DEAD' | 'SUCCEEDED'>('all');
  const [redelivering, setRedelivering] = useState<string | null>(null);
  const deliveries = useAsync(`deliveries:${endpoint?.endpointId ?? 'none'}|${deliveryFilter}`, (signal) =>
    endpoint
      ? listWebhookDeliveries(endpoint.endpointId, { ...(deliveryFilter === 'all' ? {} : { status: [deliveryFilter] }), limit: 50 }, signal)
      : Promise.resolve({ items: [], nextCursor: null }),
  );

  useEffect(() => {
    if (!endpoint) {
      setUrl('');
      setEventTypes([]);
      return;
    }
    setUrl(endpoint.url);
    setEventTypes(endpoint.eventTypes);
  }, [endpoint]);

  const view = endpoint ? endpointView(endpoint) : null;

  async function save() {
    const check = checkWebhookUrl(url);
    if (!check.ok) {
      setUrlError(check.message ?? '주소를 확인해 주세요');
      return;
    }
    setUrlError(null);
    setSaving(true);
    setMessage(null);
    try {
      if (endpoint) {
        await updateWebhook(endpoint.endpointId, { url: url.trim(), eventTypes }, endpoint.version);
        setMessage({ kind: 'ok', text: '웹훅 주소와 구독을 저장했습니다.' });
      } else {
        const created = await createWebhook({ url: url.trim(), eventTypes });
        setNewSecret({ secret: created.secret });
        setEndpointId(created.endpointId);
        setCreating(false);
        setMessage({ kind: 'ok', text: '웹훅을 등록했습니다. 서명 비밀은 지금 한 번만 보입니다.' });
      }
      endpoints.reload();
    } catch (e) {
      setMessage({ kind: 'error', text: problemMessage(e, '웹훅을 저장하지 못했습니다.') });
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus() {
    if (!endpoint) return;
    setSaving(true);
    setMessage(null);
    try {
      await updateWebhook(endpoint.endpointId, { status: endpoint.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }, endpoint.version);
      setMessage({ kind: 'ok', text: endpoint.status === 'ACTIVE' ? '웹훅을 껐습니다.' : '웹훅을 다시 켰습니다.' });
      endpoints.reload();
    } catch (e) {
      setMessage({ kind: 'error', text: problemMessage(e, '웹훅 상태를 바꾸지 못했습니다.') });
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    if (!endpoint) return;
    setRotating(true);
    setMessage(null);
    try {
      const r = await rotateWebhookSecret(endpoint.endpointId);
      setNewSecret({ secret: r.secret, previousValidUntil: r.previousSecretValidUntil });
      setRotateOpen(false);
      endpoints.reload();
    } catch (e) {
      setMessage({ kind: 'error', text: problemMessage(e, '서명 비밀을 재발급하지 못했습니다.') });
    } finally {
      setRotating(false);
    }
  }

  async function redeliver(d: WebhookDelivery) {
    setRedelivering(d.deliveryId);
    setMessage(null);
    try {
      await redeliverWebhook(d.deliveryId);
      setMessage({ kind: 'ok', text: '같은 webhook-id로 다시 보냅니다.' });
      deliveries.reload();
    } catch (e) {
      setMessage({ kind: 'error', text: problemMessage(e, '다시 보내지 못했습니다.') });
    } finally {
      setRedelivering(null);
    }
  }

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
          웹훅은 판매·취소·매진·정산 같은 일이 생기면 피켓이 파트너 회사의 서버 주소로 바로 알려 주는 기능입니다. 이름·연락처·좌석 번호는 보내지 않습니다.
        </div>
      </div>
      {isMember ? (
        <div className="banner banner-warning" role="note">
          <i className="ic ic-lock" aria-hidden="true" />
          <div className="banner-body">웹훅 등록·서명 비밀 재발급·다시 보내기는 파트너 관리자만 할 수 있습니다</div>
        </div>
      ) : null}
      {message ? (
        <div className={message.kind === 'ok' ? 'banner banner-success' : 'banner banner-danger'} role={message.kind === 'ok' ? 'status' : 'alert'}>
          <i className={message.kind === 'ok' ? 'ic ic-check-circle' : 'ic ic-alert-circle'} aria-hidden="true" />
          <div className="banner-body">{message.text}</div>
        </div>
      ) : null}

      {endpoints.status === 'loading' ? <LoadingCard label="웹훅 설정을 불러오는 중입니다" /> : null}
      {endpoints.status === 'error' ? <ErrorCard error={endpoints.error} onRetry={endpoints.reload} fallback="웹훅 설정을 불러오지 못했습니다" /> : null}

      {endpoints.status === 'ready' ? (
        <div className="grid-12 max-lg:flex max-lg:flex-col max-lg:gap-5" style={{ rowGap: 20, alignItems: 'start' }}>
          <section className="span-7 card col" style={{ padding: 24, gap: 24 }} aria-labelledby="h-setup">
            <div className="row between wrap" style={{ gap: 8 }}>
              <h2 className="t-lg" id="h-setup">
                받는 주소와 서명
              </h2>
              {view ? <span className={view.badge}>{view.label}</span> : null}
            </div>
            {!creating && list.length > 1 ? (
              <div className="field">
                <label className="label" htmlFor="wh-endpoint">
                  관리할 웹훅 주소
                </label>
                <div className="input-group">
                  <select id="wh-endpoint" value={endpoint?.endpointId ?? ''} onChange={(e) => setEndpointId(e.target.value)}>
                    {list.map((e) => (
                      <option key={e.endpointId} value={e.endpointId}>
                        {e.url}
                      </option>
                    ))}
                  </select>
                  <i className="ic ic-chevron-down" aria-hidden="true" />
                </div>
              </div>
            ) : null}
            {!isMember ? (
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                {creating ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setEndpointId(list[0]?.endpointId ?? null);
                    }}
                  >
                    등록 취소
                  </button>
                ) : (
                  <button
                    className="btn btn-outline btn-sm"
                    type="button"
                    onClick={() => {
                      setCreating(true);
                      setNewSecret(null);
                      setEndpointId(null);
                    }}
                  >
                    <i className="ic ic-plus" aria-hidden="true" />
                    새 웹훅 추가
                  </button>
                )}
              </div>
            ) : null}
            <div className="col" style={{ gap: 8 }}>
              <label className="label" htmlFor="wh-url">
                웹훅 주소 (필수)
              </label>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <div className="field grow">
                  <input
                    className={urlError ? 'input is-error' : 'input'}
                    id="wh-url"
                    type="url"
                    inputMode="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    aria-invalid={urlError ? 'true' : undefined}
                    aria-describedby="wh-url-h wh-url-e"
                  />
                  <span className="hint" id="wh-url-h">
                    https로 시작하는 443 포트 주소만 받습니다
                  </span>
                  {urlError ? (
                    <span className="error-msg" id="wh-url-e" role="alert">
                      <i className="ic ic-alert-circle" aria-hidden="true" />
                      {urlError}
                    </span>
                  ) : null}
                </div>
                <button className="btn btn-primary" type="button" style={{ height: 48 }} disabled={saving || isMember} onClick={() => void save()}>
                  {saving ? <span className="spinner" aria-hidden="true" /> : null}
                  {endpoint ? '주소 저장' : '웹훅 등록'}
                </button>
              </div>
              {endpoint ? (
                <div className="row between wrap" style={{ gap: 8 }}>
                  <p className="row t-xs muted" style={{ gap: 6 }}>
                    <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                    저장됨 · 발급 {secretMasked(endpoint.secretIssuedAt)}
                  </p>
                  {!isMember ? (
                    <button className="btn btn-outline btn-sm" type="button" disabled={saving} onClick={() => void toggleStatus()}>
                      {endpoint.status === 'ACTIVE' ? '웹훅 끄기' : '다시 켜기'}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="col" style={{ gap: 10 }}>
              <div className="row between">
                <h3 className="t-md fw-b">서명 비밀</h3>
                {endpoint ? (
                  <span className="badge badge-success">
                    <i className="ic ic-check" aria-hidden="true" />
                    발급됨 {secretMasked(endpoint.secretIssuedAt)}
                  </span>
                ) : null}
              </div>
              {newSecret ? (
                <>
                  <div className="banner banner-warning" role="status">
                    <i className="ic ic-eye" aria-hidden="true" />
                    <div className="banner-body">
                      <span className="banner-title">지금 한 번만 보입니다</span>이 화면을 벗어나면 다시 볼 수 없습니다. 복사해서 받는 서버에 넣으세요.
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8, alignItems: 'stretch' }}>
                    <div className="code grow" style={{ fontSize: 14, wordBreak: 'break-all' }}>
                      {newSecret.secret}
                    </div>
                    <button className="btn btn-outline" type="button" onClick={() => void navigator.clipboard?.writeText(newSecret.secret).catch(() => undefined)}>
                      복사
                    </button>
                  </div>
                  <p className="t-xs muted">
                    {newSecret.previousValidUntil
                      ? `이전 비밀은 ${newSecret.previousValidUntil}까지 함께 유효합니다.`
                      : '이전 비밀은 24시간 동안 함께 유효합니다.'}
                  </p>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn btn-ghost btn-sm" type="button" onClick={() => setNewSecret(null)}>
                      비밀을 확인했습니다
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="input-group is-disabled">
                    <i className="ic ic-key" aria-hidden="true" />
                    <input className="mono" type="text" readOnly value={secretMasked(endpoint?.secretIssuedAt ?? null)} />
                  </div>
                  <div className="row between wrap" style={{ gap: 8 }}>
                    <p className="t-xs muted">비밀은 발급하거나 재발급한 직후에 한 번만 전체를 보여 드립니다.</p>
                    {endpoint && !isMember ? (
                      <button className="btn btn-outline btn-sm" type="button" onClick={() => setRotateOpen(true)}>
                        <i className="ic ic-refresh" aria-hidden="true" />
                        서명 비밀 재발급
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </div>
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
            </aside>

            <section className="card col p-5 lg:px-6" style={{ gap: 12 }} aria-labelledby="h-sub">
              <h2 className="t-md fw-b" id="h-sub">
                구독할 이벤트
              </h2>
              {eventTypes.length === 0 ? (
                <div className="banner banner-warning" role="status">
                  <i className="ic ic-alert" aria-hidden="true" />
                  <div className="banner-body">고른 이벤트가 없어 보내지 않습니다</div>
                </div>
              ) : null}
              <EventPicker selected={eventTypes} onChange={setEventTypes} disabled={isMember || saving} />
              <p className="t-xs muted">{subscriptionText(eventTypes)}</p>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-outline btn-sm" type="button" disabled={saving || isMember} onClick={() => void save()}>
                  구독 저장
                </button>
              </div>
            </section>
          </div>
        </div>
      ) : null}

      {endpoint ? (
        <section className="col" style={{ gap: 12 }} aria-labelledby="h-log">
          <div className="section-title">
            <h2 id="h-log">보낸 이벤트와 재시도</h2>
            <span className="t-sm muted max-md:text-xs">최근 50건</span>
          </div>
          <div className="row wrap" style={{ gap: 8 }} role="group" aria-label="발송 상태로 거르기">
            {[
              { value: 'all', label: '전체' },
              { value: 'RETRYING', label: '재시도 중' },
              { value: 'DEAD', label: 'DLQ' },
              { value: 'SUCCEEDED', label: '성공' },
            ].map((f) => (
              <button key={f.value} className={deliveryFilter === f.value ? 'chip is-selected' : 'chip'} type="button" aria-pressed={deliveryFilter === f.value} onClick={() => setDeliveryFilter(f.value as typeof deliveryFilter)}>
                {f.label}
              </button>
            ))}
          </div>
          {deliveries.status === 'loading' ? <LoadingCard label="발송 기록을 불러오는 중입니다" /> : null}
          {deliveries.status === 'error' ? <ErrorCard error={deliveries.error} onRetry={deliveries.reload} fallback="발송 기록을 불러오지 못했습니다" /> : null}
          {deliveries.status === 'ready' ? <DeliveryTable rows={deliveries.data.items} isMember={isMember} onRedeliver={(d) => void redeliver(d)} busy={redelivering} /> : null}
        </section>
      ) : null}

      {rotateOpen && endpoint ? (
        <Modal id="wh-rotate-live" defaultOpen labelledBy="rk-t" describedBy="rk-d" maxWidth={460}>
          <h2 className="dialog-title" id="rk-t">
            서명 비밀을 새로 만듭니다
          </h2>
          <div className="col" id="rk-d" style={{ gap: 10 }}>
            <p className="t-sm">새 비밀은 만든 직후에 한 번만 전체를 보여 드립니다. 이전 비밀은 24시간 동안 함께 유효합니다.</p>
            <ul className="col t-sm muted" style={{ gap: 6 }}>
              <li>24시간 안에 받는 서버의 비밀을 새 비밀로 바꾸세요.</li>
              <li>24시간이 지나면 새 비밀로만 서명해 보냅니다.</li>
            </ul>
          </div>
          <div className="dialog-actions">
            <button className="btn btn-outline" type="button" onClick={() => setRotateOpen(false)}>
              지금 비밀 그대로 두기
            </button>
            <button className="btn btn-primary" type="button" disabled={rotating} onClick={() => void rotate()}>
              {rotating ? <span className="spinner" aria-hidden="true" /> : null}
              새 비밀 만들기
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
