'use client';
// SCR-050 ②~⑤: 수락 조건 안내, 두 동의 카드(CMP-009 ConsentCheckbox ×2, 따로 체크), [초대 수락하기]·[수락하지 않기].
// 두 동의에 모두 체크해야 수락 버튼이 켜진다(이유 있는 비활성: aria-disabled + 위 안내 글, ADR-0051). 받는 자 상호를 읽지 못했으면(blocked) 체크해도 꺼진다(ADR-0362 결정 3).
// [수락하지 않기]는 ⑤ 아래에 거절 확인 줄을 연다. [거절]은 거절을 보내고 [취소]는 아무 요청도 보내지 않는다(d5 §5.26 '거절 확인', ADR-0362 결정 5).
// 휴대폰은 버튼을 세로로 쌓아 화면 아래(margin-top:auto)에 두고, md부터 한 줄에 반씩 나눈다(보드 SCR-050-t·d).
// 실제 흐름은 onAccept·onReject를 받는다. 미리보기는 같은 경로의 '수락 완료'·'거절함' 상태로 간다.
// 고지 줄은 글자로만 그린다(서버 원문을 HTML로 해석하지 않는다, ADR-0362 결정 2, ASVS 3.2.2).
import { useRouter } from 'next/navigation';
import { Fragment, useState, type ReactNode } from 'react';
import { ConsentCheckbox } from '@peaket/ds/ConsentCheckbox';
import type { ConsentRow } from '../model/invitation';

export interface InviteConsentFormProps {
  collectRows: readonly ConsentRow[];
  provideRows: readonly ConsentRow[];
  defaultCollect: boolean;
  defaultProvide: boolean;
  /** 422(동의 누락) 뒤: 파트너 제공 동의에 오류를 보인다(체크하면 사라진다) */
  provideError: boolean;
  /** 받는 자(파트너 상호)를 읽지 못해 수락을 막는다(d5 §5.26 '파트너 이름을 읽지 못함') */
  blocked?: boolean;
  /** 거절 확인 줄을 연 채로 시작(미리보기 '거절 확인') */
  defaultConfirmReject?: boolean;
  /** 미리보기: 수락·거절 뒤 갈 주소(같은 경로의 상태) */
  acceptedHref?: string;
  rejectedHref?: string;
  /** 실제 흐름: 수락·거절을 보낸다(처리 중에는 busy) */
  onAccept?: () => void;
  onReject?: () => void;
  busy?: boolean;
  /** 실제 흐름에서 수락·거절이 일시 장애로 실패했을 때의 그 자리 안내 */
  notice?: string | null;
}

const PROVIDE_ERROR = '파트너 제공 동의에 체크해야 수락할 수 있습니다.';

export function InviteConsentForm({
  collectRows,
  provideRows,
  defaultCollect,
  defaultProvide,
  provideError,
  blocked = false,
  defaultConfirmReject = false,
  acceptedHref,
  rejectedHref,
  onAccept,
  onReject,
  busy = false,
  notice = null,
}: InviteConsentFormProps) {
  const router = useRouter();
  const [collect, setCollect] = useState(defaultCollect);
  const [provide, setProvide] = useState(defaultProvide);
  const [confirming, setConfirming] = useState(defaultConfirmReject);
  const canAccept = collect && provide && !blocked && !busy;

  return (
    <div className="col flex-1 gap-6">
      <div className="banner banner-info">
        <i className="ic ic-info" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">수락 조건</span>
          휴대폰 본인확인을 마쳤고, 이 계정의 검증된 이메일이 초대 이메일과 같아야 받을 수 있습니다.
        </div>
      </div>

      <div className="col" style={{ gap: 16 }}>
        <ConsentCard headingId="cs1-h" title="수집·이용 동의" rows={collectRows}>
          <ConsentCheckbox id="cs1" label="수집·이용에 동의합니다" checked={collect} onCheckedChange={setCollect} />
        </ConsentCard>
        <ConsentCard headingId="cs2-h" title="파트너 제공 동의" rows={provideRows}>
          <ConsentCheckbox
            id="cs2"
            label="파트너 제공에 동의합니다"
            checked={provide}
            onCheckedChange={setProvide}
            error={provideError && !provide ? PROVIDE_ERROR : undefined}
          />
        </ConsentCard>
      </div>

      <div className="col mt-auto gap-2 md:mt-0 md:gap-[10px]">
        {notice ? (
          <p className="t-sm tx-danger" role="alert">
            {notice}
          </p>
        ) : null}
        {canAccept || busy ? null : (
          <p className="hint" id="acc-why">
            {blocked
              ? '초대한 파트너 정보를 불러와야 수락할 수 있습니다. 받는 자를 확인하지 못한 채 파트너 제공 동의를 받지 않습니다.'
              : '두 동의에 모두 체크해야 수락할 수 있습니다. 동의하지 않으면 현장 스태프로 배정되지 않습니다.'}
          </p>
        )}
        <div className="col gap-2 md:flex-row md:gap-3">
          <button
            className="btn btn-primary btn-lg btn-block md:flex-1"
            type="button"
            aria-disabled={canAccept ? undefined : true}
            aria-busy={busy || undefined}
            aria-describedby={canAccept || busy ? undefined : 'acc-why'}
            onClick={() => {
              if (!canAccept) return;
              if (onAccept) onAccept();
              else if (acceptedHref) router.push(acceptedHref);
            }}
          >
            초대 수락하기
          </button>
          <button
            className="btn btn-secondary btn-lg btn-block md:flex-1"
            type="button"
            aria-expanded={confirming}
            aria-controls="rej-confirm"
            onClick={() => {
              if (!busy) setConfirming(true);
            }}
          >
            수락하지 않기
          </button>
        </div>
        {confirming ? (
          <div className="card-flat col gap-3 px-4 py-3.5 md:p-4" id="rej-confirm" role="group" aria-labelledby="rej-q">
            <p className="t-sm" id="rej-q">
              이 초대를 거절할까요? 거절하면 이 링크로 다시 수락할 수 없습니다
            </p>
            <div className="row gap-2">
              <button
                className="btn btn-danger"
                type="button"
                aria-busy={busy || undefined}
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (busy) return;
                  if (onReject) onReject();
                  else if (rejectedHref) router.push(rejectedHref);
                }}
              >
                거절
              </button>
              {/* 취소는 아무 요청도 보내지 않는다(ADR-0362 결정 5) */}
              <button className="btn btn-ghost" type="button" onClick={() => setConfirming(false)}>
                취소
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 동의 카드 하나: 제목 · 고지 항목 표(dt·dd) · 구분선 · 체크박스. 항목 칸 폭은 보드대로 휴대폰 80 · 태블릿 96 · 데스크톱 104 */
function ConsentCard({ headingId, title, rows, children }: { headingId: string; title: string; rows: readonly ConsentRow[]; children: ReactNode }) {
  return (
    <section className="card col gap-[14px] p-4 md:p-5 lg:px-6" aria-labelledby={headingId}>
      <h2 className="t-md fw-b" id={headingId}>
        {title}
      </h2>
      <dl className="t-sm grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-2 md:grid-cols-[96px_minmax(0,1fr)] lg:grid-cols-[104px_minmax(0,1fr)]">
        {rows.map((r, i) => (
          <Fragment key={`${i}-${r.term}`}>
            <dt className="muted">{r.term}</dt>
            <dd>{r.detail}</dd>
          </Fragment>
        ))}
      </dl>
      <hr className="divider" />
      {children}
    </section>
  );
}
