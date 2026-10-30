'use client';
// SCR-050 ②~⑤: 수락 조건 안내, 두 동의 카드(CMP-009 ConsentCheckbox ×2, 따로 체크), [초대 수락하기]·[수락하지 않기].
// 두 동의에 모두 체크해야 수락 버튼이 켜진다(이유 있는 비활성: aria-disabled + 위 안내 글, ADR-0051).
// 휴대폰은 버튼을 세로로 쌓아 화면 아래(margin-top:auto)에 두고, md부터 한 줄에 반씩 나눈다(보드 SCR-050-t·d).
// 퍼블리싱 단계라 수락은 같은 경로의 '수락 완료' 상태로 간다. '수락하지 않기'는 API 없이 닫는다(d5 §5.26, 초대 거절 API가 없다).
import Link from 'next/link';
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
  /** 수락 뒤 갈 주소(퍼블리싱: '수락 완료' 상태) */
  acceptedHref: string;
  /** 닫기(수락하지 않기) 주소 */
  closeHref: string;
}

const PROVIDE_ERROR = '파트너 제공 동의에 체크해야 수락할 수 있습니다.';

export function InviteConsentForm({
  collectRows,
  provideRows,
  defaultCollect,
  defaultProvide,
  provideError,
  acceptedHref,
  closeHref,
}: InviteConsentFormProps) {
  const router = useRouter();
  const [collect, setCollect] = useState(defaultCollect);
  const [provide, setProvide] = useState(defaultProvide);
  const canAccept = collect && provide;

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
        {canAccept ? null : (
          <p className="hint" id="acc-why">
            두 동의에 모두 체크해야 수락할 수 있습니다. 동의하지 않으면 현장 스태프로 배정되지 않습니다.
          </p>
        )}
        <div className="col gap-2 md:flex-row md:gap-3">
          <button
            className="btn btn-primary btn-lg btn-block md:flex-1"
            type="button"
            aria-disabled={canAccept ? undefined : true}
            aria-describedby={canAccept ? undefined : 'acc-why'}
            onClick={() => {
              if (canAccept) router.push(acceptedHref);
            }}
          >
            초대 수락하기
          </button>
          <Link className="btn btn-secondary btn-lg btn-block md:flex-1" href={closeHref}>
            수락하지 않기
          </Link>
        </div>
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
        {rows.map((r) => (
          <Fragment key={r.term}>
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
