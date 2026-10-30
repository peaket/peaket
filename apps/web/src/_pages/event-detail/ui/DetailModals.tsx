'use client';
// SCR-002 위의 겹침 창들(보드 SCR-002 모달 상태, d5 §5.2 ⑯·상태 표). 휴대폰은 아래 시트, 태블릿·데스크톱은 대화상자다.
// - 안내 모달 셋(CMP-019 info): 예매 안내사항(접는 항목) · 취소·환불 안내사항 · 판매자 정보
// - 다른 기기·탭에서 대기 중 → ( 처음 기기를 쓸 수 없나요? › ) → 다시 참가 확인
// - 후기 쓰기 이유 대화상자: 자격 없음 · 비로그인
// 여는 버튼은 DetailModalTrigger(같은 Provider 안 어디서나). 후기 전체·쓰기·신고 모달(SCR-016)은 discovery 담당의 위젯이다.
import Link from 'next/link';
import { createContext, useContext, useId, useState, type CSSProperties, type ReactNode } from 'react';
import { WebShellModal, webModalButtonClass } from '@peaket/ds/WebShell';
import type { Seller } from '@/entities/seller';
import { CANCEL_FEES, LEGAL_RESALE_NOTICE, brokerNotice } from '../model/content';
import type { DetailModal } from '../model/view';

const OpenContext = createContext<(m: DetailModal) => void>(() => {});

export interface DetailModalsProps {
  initial: DetailModal | null;
  seller: Seller;
  /** 대기실과 순번(정렬 방식 표준 문구) */
  sortText: string;
  perPerson: number;
  loginHref: string;
  children: ReactNode;
}

export function DetailModalsProvider({ initial, seller, sortText, perPerson, loginHref, children }: DetailModalsProps) {
  const [open, setOpen] = useState<DetailModal | null>(initial);
  const close = () => setOpen(null);
  const ids = useId();
  return (
    <OpenContext.Provider value={setOpen}>
      {children}

      <WebShellModal
        open={open === 'dup'}
        onClose={close}
        title="다른 기기나 탭에서 이미 대기 중입니다"
        icon={<i className="ic ic-device" aria-hidden="true" />}
        iconTone="warning"
        describedBy={`${ids}-dup`}
        actionsSpread
        actions={
          <>
            <button className={webModalButtonClass('primary')} type="button" onClick={close}>
              닫기
            </button>
            <button className={webModalButtonClass('text')} type="button" aria-haspopup="dialog" onClick={() => setOpen('rejoin')}>
              처음 기기를 쓸 수 없나요?
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </button>
          </>
        }
      >
        <p className="t-md muted" id={`${ids}-dup`}>
          처음 기기에서 계속하세요
        </p>
      </WebShellModal>

      <WebShellModal
        open={open === 'rejoin'}
        onClose={close}
        title="이 기기에서 다시 참가합니다"
        icon={<i className="ic ic-refresh" aria-hidden="true" />}
        iconTone="danger"
        describedBy={`${ids}-rj`}
        maxWidth={460}
        actions={
          <>
            <button className={webModalButtonClass('danger')} type="button" onClick={close}>
              처음 기기 참가를 취소하고 다시 참가
            </button>
            <button className={webModalButtonClass('ghost')} type="button" onClick={close}>
              닫기
            </button>
          </>
        }
      >
        <p className="t-md" id={`${ids}-rj`}>
          처음 기기의 참가는 취소되고, 순서는 오픈 때 정해지므로 불리하지 않습니다
        </p>
      </WebShellModal>

      <WebShellModal
        open={open === 'guide'}
        onClose={close}
        title="예매 안내사항"
        closeLabel="예매 안내사항 닫기"
        maxWidth={560}
        scroll
        actions={
          <button className={webModalButtonClass('secondary')} type="button" onClick={close}>
            닫기
          </button>
        }
      >
        <Accordion
          defaultOpen={1}
          items={[
            {
              q: '예매 전 확인',
              a: `휴대폰 본인확인은 계정당 한 번만 합니다. 한 사람은 한 계정으로만 예매할 수 있습니다. 한 회차에 한 사람은 순번 하나만 받고(1인 1순번), 한 번에 ${perPerson}매까지 예매할 수 있습니다. 예매 전에 사람 확인을 합니다. 오픈 전에 확인을 마쳐 두세요. 확인은 15분 동안 유효하고 그동안 조용히 갱신됩니다.`,
            },
            { q: '대기실과 순번', a: sortText },
            {
              q: '모바일 티켓과 입장용 휴대폰 등록',
              a: '티켓은 마이 티켓에서 모바일 티켓으로 받습니다. 입장할 휴대폰에 입장 키를 받아 두면 공연장에서 인터넷이 없어도 입장 QR을 열 수 있습니다.',
            },
            {
              q: '양도',
              a: '양도는 결제한 분만 할 수 있고, 받는 분이 수락해야 끝납니다. 양도 마감은 공연 시작 2시간 전과 입장 시작 중 이른 때입니다.',
            },
            { q: '부정구매·부정판매 처벌·과징금', a: LEGAL_RESALE_NOTICE },
          ]}
        />
      </WebShellModal>

      <WebShellModal
        open={open === 'refund'}
        onClose={close}
        title="취소·환불 안내사항"
        closeLabel="취소·환불 안내사항 닫기"
        maxWidth={640}
        scroll
        actions={
          <button className={webModalButtonClass('secondary')} type="button" onClick={close}>
            닫기
          </button>
        }
      >
        <section className="col" style={{ gap: 8 }} aria-labelledby={`${ids}-rf1`}>
          <h3 className="t-md fw-b" id={`${ids}-rf1`}>
            취소 기준
          </h3>
          <div className="table-wrap">
            <table className="table dense">
              <caption className="sr-only">취소 시점별 공제율</caption>
              <thead>
                <tr>
                  <th scope="col">취소 시점</th>
                  <th className="r" scope="col">
                    공제
                  </th>
                </tr>
              </thead>
              <tbody>
                {CANCEL_FEES.map(([when, fee]) => (
                  <tr key={when}>
                    <td>{when}</td>
                    <td className="r">{fee}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="t-xs muted">예매 후 24시간 안 취소는 관람일 3일 전까지만 해당하고, 주말·공휴일은 24시간 계산에서 뺍니다. 근거: 소비자분쟁해결기준</p>
        </section>
        <InfoBlock id={`${ids}-rf2`} title="취소 방법과 기한">
          <p className="t-sm">마이 티켓에서 공연 시작 전까지 티켓 단위로 취소할 수 있습니다.</p>
          <p className="t-sm">입장이 시작된 뒤 취소하면 티켓은 바로 쓸 수 없게 되고, 환급은 입장 기록 마감 뒤 입장하지 않은 것이 확인되면 실행합니다</p>
        </InfoBlock>
        <InfoBlock id={`${ids}-rf3`} title="환급 수단과 기한">
          <p className="t-sm">결제하신 수단으로 3영업일 안에 결제 취소를 마치며, 카드사나 은행에 따라 실제로 돌려받는 날은 이보다 늦을 수 있습니다.</p>
        </InfoBlock>
        <InfoBlock id={`${ids}-rf4`} title="회차 취소·연기">
          <p className="t-sm">
            공연이 취소되면 공제 없이 전액 환급합니다. 일정이 바뀌면 바뀐 공연 시작 전까지 공제 없이 전액 환급을 신청할 수 있습니다. 소비자분쟁해결기준의 배상 대상으로 판정되면 배상금(실제 결제 금액의 10%)을 판매자를 대신해 피켓이 먼저 지급합니다.
          </p>
        </InfoBlock>
        <InfoBlock id={`${ids}-rf5`} title="미성년자 계약 취소">
          <p className="t-sm">
            만 19세 미만 미성년자가 법정대리인(부모 등)의 동의 없이 결제하면, 미성년자 본인이나 법정대리인이 이 계약을 취소할 수 있습니다.{' '}
            <Link className="link-more" href="/help">
              미성년자 계약 취소 안내
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          </p>
        </InfoBlock>
      </WebShellModal>

      <WebShellModal
        open={open === 'seller'}
        onClose={close}
        title="판매자 정보"
        closeLabel="판매자 정보 닫기"
        maxWidth={520}
        actions={
          <button className={webModalButtonClass('secondary')} type="button" onClick={close}>
            닫기
          </button>
        }
      >
        <dl className="kv card" style={{ padding: 16, columnGap: 12, fontSize: 13, lineHeight: '18px' }}>
          <dt>상호</dt>
          <dd>{seller.name}</dd>
          <dt>대표자</dt>
          <dd>{seller.representative}</dd>
          <dt>주소</dt>
          <dd>{seller.address}</dd>
          <dt>전화</dt>
          <dd>{seller.phone}</dd>
          <dt>전자우편</dt>
          <dd>{seller.email}</dd>
          <dt>사업자등록번호</dt>
          <dd>{seller.businessNo}</dd>
          <dt>통신판매업 신고번호</dt>
          <dd>{seller.mailOrderNo}</dd>
        </dl>
        <div className="banner banner-legal">
          <i className="ic ic-building" aria-hidden="true" />
          <div className="banner-body">
            <span className="legal-tag">법정 고지</span>
            {brokerNotice(seller.name)}
          </div>
        </div>
      </WebShellModal>

      <WebShellModal
        open={open === 'revNo'}
        onClose={close}
        title="공연이 끝난 뒤 이 회차를 예매하신 분만 후기를 쓸 수 있습니다"
        icon={<i className="ic ic-edit" aria-hidden="true" />}
        actions={
          <button className={webModalButtonClass('primary')} type="button" onClick={close}>
            닫기
          </button>
        }
      />

      <WebShellModal
        open={open === 'revGuest'}
        onClose={close}
        title="로그인하면 후기를 쓸 수 있습니다"
        icon={<i className="ic ic-user" aria-hidden="true" />}
        actions={
          <>
            <Link className={webModalButtonClass('primary')} href={loginHref}>
              로그인
            </Link>
            <button className={webModalButtonClass('ghost')} type="button" onClick={close}>
              닫기
            </button>
          </>
        }
      />
    </OpenContext.Provider>
  );
}

/** 같은 Provider 안에서 겹침 창 하나를 여는 버튼 */
export function DetailModalTrigger({
  modal,
  className,
  style,
  children,
}: {
  modal: DetailModal;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const open = useContext(OpenContext);
  return (
    <button className={className} style={style} type="button" aria-haspopup="dialog" onClick={() => open(modal)}>
      {children}
    </button>
  );
}

function InfoBlock({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="col" style={{ gap: 6 }} aria-labelledby={id}>
      <h3 className="t-md fw-b" id={id}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 접는 항목(키트 .acc). 머리 버튼에 aria-expanded·aria-controls, 내용은 role="region" */
function Accordion({ items, defaultOpen }: { items: readonly { q: string; a: string }[]; defaultOpen?: number }) {
  const [openIdx, setOpenIdx] = useState<number | null>(defaultOpen ?? null);
  const base = useId();
  return (
    <div className="acc">
      {items.map((it, i) => {
        const expanded = openIdx === i;
        return (
          <div key={it.q}>
            <h3>
              <button
                className="acc-btn"
                type="button"
                id={`${base}-q${i}`}
                aria-expanded={expanded}
                aria-controls={`${base}-a${i}`}
                onClick={() => setOpenIdx(expanded ? null : i)}
              >
                {it.q}
                <i className={`ic ${expanded ? 'ic-chevron-up' : 'ic-chevron-down'}`} aria-hidden="true" />
              </button>
            </h3>
            <div className="acc-panel" id={`${base}-a${i}`} role="region" aria-labelledby={`${base}-q${i}`} hidden={!expanded}>
              <p>{it.a}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
