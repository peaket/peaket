// SCR-024 판매 정책 규칙(/events/[id]/policy). 보드 SCR-024-m·t·d를 한 페이지 반응형으로 합쳤다(d5 §6.7, §3.9).
// 데스크톱(lg): [좌 5] 등록 규칙 표 | [우 7] 규칙 편집 → 시뮬레이션 → 자격 명단 / 태블릿: 같은 순서로 한 줄로 쌓고 버튼을 크게 /
// 휴대폰: 규칙 카드 목록과 '큰 화면에서 합니다' 안내(편집·시뮬레이션·명단 올리기는 보기만).
// JSON 텍스트 편집기는 두지 않는다. 규칙은 종류별 폼으로만 고치고 JSON은 읽기 전용 대화상자로만 보인다(d5 §6.7, 기술 검토 낮음-110).
import Link from 'next/link';
import { requireProduction } from '@/entities/production';
import { routes } from '@/shared/config/routes';
import { POLICY_STATES } from '@/shared/config/states/scr024';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { AdminOnly } from '@/features/admin-only';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { Modal } from '@/shared/ui/Modal';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { EventContextHeader } from '@/widgets/event-context';
import {
  CASE_RESULT,
  FANCLUB_LIST,
  GENERAL_RULE,
  PRESALE_CASES,
  PRESALE_JSON,
  PRESALE_RULE,
  RATE_ERROR,
  REFUND_JSON,
  REFUND_RULE,
  RULE_KINDS,
  RULE_SCOPE,
  RULE_STATUS,
  type PolicyRuleRow,
} from '../model/policy';
import { CopyTextButton } from './CopyTextButton';

type PolicyState = (typeof POLICY_STATES)[number];

/** 태블릿(md~lg)은 보드처럼 버튼을 한 단계 크게(btn → btn-lg, btn-sm → btn) */
const TAB_LG = 'max-lg:min-h-[52px] max-lg:rounded-[var(--r-lg)] max-lg:px-5 max-lg:text-base';
const TAB_MD = 'max-lg:min-h-10 max-lg:px-4 max-lg:text-sm';
const JSON_DIALOG = 'policy-json';

function withState(path: string, keep: Record<string, string | undefined>, state?: PolicyState): string {
  const p = new URLSearchParams();
  if (state && state !== '기본') p.set('state', state);
  for (const [k, v] of Object.entries(keep)) if (v !== undefined) p.set(k, v);
  const q = p.toString();
  return q ? `${path}?${q}` : path;
}

export default async function SalePolicyPage({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const pv = readPreview(await searchParams, POLICY_STATES, '기본');
  const production = requireProduction(id);
  const st = pv.state;
  /** 취소 공제율 초안을 고른 상태(입력 오류·상한 위반) */
  const fee = st === '입력 오류' || st === '상한 위반';
  const path = routes.eventTab(id, 'policy');

  return (
    <>
      <EventContextHeader production={production} current="policy" />

      <div className="banner banner-warning">
        <i className="ic ic-alert" aria-hidden="true" />
        <div className="banner-body">승인 뒤 가격·회차·좌석 등급·좌석맵·판매 정책을 바꾸면 다시 판매 승인을 받고, 오픈 전이면 오픈 예약이 멈춥니다</div>
      </div>

      <div className="grid items-start gap-4 md:gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="col min-w-0 gap-4 md:gap-5">
          <RulesTable fee={fee} path={path} keep={pv.keep} />
          <RulesCards cap={st === '상한 위반'} />
          <BigScreenNotice
            title="규칙 편집과 시뮬레이션은 태블릿이나 데스크톱에서 합니다"
            body="새 규칙 만들기도 큰 화면에서 합니다. 휴대폰에서는 볼 수만 있습니다"
          />
        </div>

        <div className="col min-w-0 gap-4 md:gap-5">
          <RuleEditor state={st} />
          {(st === '기본' || st === 'JSON 보기') && <PresaleSimulation />}
          {st === '상한 위반' && <RefundSimulation />}
          {st === '자격 명단' && <EligibilityList isMember={pv.isMember} />}
        </div>
      </div>

      <Modal id={JSON_DIALOG} defaultOpen={st === 'JSON 보기'} labelledBy="js-t" describedBy="js-d" maxWidth={640}>
        <div className="row" style={{ gap: 12 }}>
          <span className="state-icon is-primary" style={{ width: 44, height: 44 }}>
            <i className="ic ic-code" aria-hidden="true" />
          </span>
          <h2 className="dialog-title" id="js-t">
            규칙 JSON · {fee ? REFUND_RULE.name : PRESALE_RULE.name}
          </h2>
        </div>
        <p className="t-sm" id="js-d">
          읽기 전용입니다. 고칠 수 없고, 지원 문의나 검토에 규칙을 그대로 붙여 넣을 때 복사합니다. 규칙은 규칙 편집 폼으로 바꿉니다.
        </p>
        <pre
          className="code"
          tabIndex={0}
          aria-label={`${fee ? REFUND_RULE.name : PRESALE_RULE.name} 규칙 JSON, 읽기 전용`}
          style={{ whiteSpace: 'pre', overflowX: 'auto', padding: '12px 14px', fontSize: 13, lineHeight: '20px', margin: 0 }}
        >
          {fee ? REFUND_JSON : PRESALE_JSON}
        </pre>
        <div className="dialog-actions">
          <CopyTextButton className={`btn btn-outline ${TAB_LG}`} text={fee ? REFUND_JSON : PRESALE_JSON} />
          <button className={`btn btn-primary ${TAB_LG}`} type="button" data-modal-close="">
            닫기
          </button>
        </div>
      </Modal>

      <PreviewStateSwitcher path={path} states={POLICY_STATES} current={st} keep={pv.keep} />
    </>
  );
}

/* ---------- 등록 규칙 ---------- */

function RuleName({ rule, selected, href }: { rule: PolicyRuleRow; selected: boolean; href?: string }) {
  // 일반 예매는 보드에 편집 폼이 없어 퍼블리싱에서는 고르는 링크로 잇지 않는다(이름만 보인다)
  if (!href) return <>{rule.name}</>;
  return (
    <Link href={href} aria-current={selected ? 'true' : undefined} scroll={false}>
      {rule.name}
    </Link>
  );
}

function RulesTable({ fee, path, keep }: { fee: boolean; path: string; keep: Record<string, string | undefined> }) {
  const rows = fee ? [PRESALE_RULE, GENERAL_RULE, REFUND_RULE] : [PRESALE_RULE, GENERAL_RULE];
  const selected = fee ? REFUND_RULE.id : PRESALE_RULE.id;
  const hrefOf = (r: PolicyRuleRow) =>
    r.id === PRESALE_RULE.id ? withState(path, keep) : r.id === REFUND_RULE.id ? withState(path, keep, '상한 위반') : undefined;
  return (
    <section className="card col max-md:hidden" style={{ overflow: 'hidden' }} aria-labelledby="h-rules">
      <div className="row between" style={{ padding: '16px 16px 12px' }}>
        <h2 className="t-md fw-b" id="h-rules">
          등록 규칙
        </h2>
        <button className={`btn btn-outline btn-sm ${TAB_MD}`} type="button">
          <i className="ic ic-plus" aria-hidden="true" />새 규칙
        </button>
      </div>
      <table className="table dense">
        <caption className="sr-only">등록 규칙 {rows.length}개의 이름, 대상, 조건 요약, 상태</caption>
        <thead>
          <tr>
            <th scope="col">규칙 이름</th>
            <th scope="col">대상</th>
            <th scope="col">조건 요약</th>
            <th scope="col">상태</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.id === selected ? 'is-selected' : undefined}>
              <td className="fw-b">
                <RuleName rule={r} selected={r.id === selected} href={hrefOf(r)} />
              </td>
              <td className="nowrap">{r.target}</td>
              <td>{r.summary}</td>
              <td>
                <span className={RULE_STATUS[r.status].cls}>{RULE_STATUS[r.status].label}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** 휴대폰: 규칙 카드(보기 전용). 상한 위반이면 초안 카드에 넘은 항목을 보인다 */
function RulesCards({ cap }: { cap: boolean }) {
  const rows = cap ? [PRESALE_RULE, GENERAL_RULE, REFUND_RULE] : [PRESALE_RULE, GENERAL_RULE];
  return (
    <section className="col md:hidden" style={{ gap: 12 }} aria-labelledby="h-rules-m">
      <div className="section-title">
        <h2 id="h-rules-m">등록 규칙</h2>
        <span className="t-sm muted num">{rows.length}개</span>
      </div>
      <ul className="col" style={{ gap: 12 }}>
        {rows.map((r) => {
          const over = cap && r.id === REFUND_RULE.id;
          return (
            <li key={r.id} className="card col" style={{ padding: '14px 16px', gap: over ? 10 : 8 }}>
              <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
                <h3 className="t-md fw-b">{r.name}</h3>
                <span className="row" style={{ gap: 6 }}>
                  <span className={RULE_STATUS[r.status].cls}>{RULE_STATUS[r.status].label}</span>
                  {over && <span className="badge badge-danger">상한 넘음</span>}
                </span>
              </div>
              <p className="t-sm">{r.summary}</p>
              <p className="t-xs muted">{RULE_SCOPE}</p>
              {over && (
                <>
                  <div className="banner banner-danger" role="note">
                    <i className="ic ic-alert-circle" aria-hidden="true" />
                    <div className="banner-body">
                      <span className="banner-title">판매 승인 상한을 넘습니다</span>
                      넘은 항목: 관람일 7~9일 전 공제율 20%
                      <br />
                      허용 범위: 10% 이하(POL-032, 소비자분쟁해결기준 공연업)
                    </div>
                  </div>
                  <p className="t-xs">공제율 상한(POL-032)이나 양도 규칙(POL-017)을 넘는 규칙은 승인되지 않습니다</p>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ---------- 규칙 편집 ---------- */

function KindPicker({ name, checked }: { name: string; checked: 'presale' | 'refund' }) {
  return (
    <fieldset className="col">
      <legend className="label" style={{ marginBottom: 8 }}>
        규칙 종류 <span className="opt">(필수)</span>
      </legend>
      <div className="row wrap" style={{ gap: '8px 20px' }}>
        {RULE_KINDS.map((k) => (
          <label key={k.value} className="check-row" style={{ fontSize: 14, alignItems: 'center' }}>
            <input className="rd" type="radio" name={name} value={k.value} defaultChecked={k.value === checked} />
            {k.label}
          </label>
        ))}
      </div>
      <span className="hint">종류마다 맞는 폼 칸만 보입니다. 규칙은 폼으로만 고칩니다</span>
    </fieldset>
  );
}

function Select({ options, ...rest }: { options: readonly string[]; id?: string; 'aria-label'?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string }) {
  return (
    <select {...rest}>
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );
}

function JsonLink() {
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button
        className="link-more"
        type="button"
        aria-haspopup="dialog"
        data-modal-open={JSON_DIALOG}
        style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}
      >
        JSON 보기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </button>
      <span className="t-xs muted">읽기 전용 · 복사할 수 있습니다</span>
    </div>
  );
}

function AddCondition({ depth }: { depth: number }) {
  return (
    <div className="row between" style={{ gap: 8 }}>
      <button className="btn btn-text max-lg:min-h-11" type="button">
        <i className="ic ic-plus" aria-hidden="true" />
        조건 넣기
      </button>
      <span className="t-xs muted num">중첩 깊이 {depth} / 최대 3 [가정]</span>
    </div>
  );
}

function PresaleForm() {
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div className="field">
          <label className="label" htmlFor="r-name">
            규칙 이름 <span className="opt">(필수)</span>
          </label>
          <input className="input input-sm" id="r-name" type="text" defaultValue={PRESALE_RULE.name} />
        </div>
        <div className="field">
          <label className="label" htmlFor="r-round">
            대상 회차
          </label>
          <div className="input-group input-group-sm">
            <Select id="r-round" options={['전 회차(2개)', '10/25(일) 18:00', '10/26(월) 17:00']} />
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
        </div>
      </div>
      <div className="field">
        <span className="label" id="r-win-l">
          적용 기간(KST) <span className="opt">(필수)</span>
        </span>
        <div className="row" style={{ gap: 8 }} role="group" aria-labelledby="r-win-l">
          <div className="input-group input-group-sm grow">
            <i className="ic ic-calendar" aria-hidden="true" />
            <input type="text" defaultValue="10/13(화) 20:00" aria-label="적용 시작" />
          </div>
          <span className="muted" aria-hidden="true">
            ~
          </span>
          <div className="input-group input-group-sm grow">
            <i className="ic ic-calendar" aria-hidden="true" />
            <input type="text" defaultValue="10/13(화) 22:00" aria-label="적용 끝" />
          </div>
        </div>
      </div>
      <div className="field">
        <span className="label" id="r-cond-l">
          조건 · 모두 맞을 때
        </span>
        <div className="row" style={{ gap: 8 }} role="group" aria-labelledby="r-cond-l">
          <div className="input-group input-group-sm" style={{ flex: 1.2, minWidth: 0 }}>
            <Select aria-label="조건 1 항목" options={['구매자 자격', '회차', '좌석 등급', '매수']} />
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
          <div className="input-group input-group-sm" style={{ flex: 0.8, minWidth: 0 }}>
            <Select aria-label="조건 1 비교" options={['명단에 있음', '명단에 없음']} />
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
          <div className="input-group input-group-sm" style={{ flex: 1.2, minWidth: 0 }}>
            <Select aria-label="조건 1 값" aria-describedby="r-fan-h" options={[`${FANCLUB_LIST.name}(${FANCLUB_LIST.count})`]} />
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
          <button className="icon-btn icon-btn-sm max-lg:h-11 max-lg:w-11" type="button" aria-label="조건 1 빼기">
            <i className="ic ic-trash" aria-hidden="true" />
          </button>
        </div>
        <span className="hint" id="r-fan-h">
          팬클럽 회원 여부는 판매자가 올린 자격 명단(팬이 팬클럽에 알려 준 PEAKET 회원 코드)으로 판정합니다. 팬 쪽에는 자격 확인 화면이 따로 없고, 공연
          상세에서 선예매 대상인지 보입니다.
        </span>
        <AddCondition depth={2} />
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div className="field">
          <span className="label" id="r-then-l">
            맞으면
          </span>
          <div className="row" style={{ gap: 8 }} role="group" aria-labelledby="r-then-l">
            <div className="input-group input-group-sm grow">
              <Select aria-label="맞을 때 결과" options={['1인 한도', '구매 허용']} />
              <i className="ic ic-chevron-down" aria-hidden="true" />
            </div>
            <div className="input-group input-group-sm" style={{ width: 76, flex: 'none' }}>
              <input type="text" inputMode="numeric" defaultValue="2" aria-label="1인 한도 매수" />
              <span className="t-sm muted">매</span>
            </div>
          </div>
        </div>
        <div className="field">
          <span className="label" id="r-else-l">
            아니면
          </span>
          <div className="input-group input-group-sm">
            <Select aria-labelledby="r-else-l" options={['예매 제한(선예매 기간)']} />
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
        </div>
      </div>
      <JsonLink />
    </div>
  );
}

function RefundForm({ error }: { error: 'input' | 'cap' }) {
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div className="field">
          <label className="label" htmlFor="f-name">
            규칙 이름 <span className="opt">(필수)</span>
          </label>
          <input className="input input-sm" id="f-name" type="text" defaultValue={REFUND_RULE.name} />
        </div>
        <div className="field">
          <label className="label" htmlFor="f-round">
            대상 회차
          </label>
          <div className="input-group input-group-sm">
            <Select id="f-round" options={['전 회차(2개)']} />
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
        </div>
      </div>
      <div className="field">
        <span className="label" id="f-cond-l">
          조건
        </span>
        <div className="row" style={{ gap: 8 }} role="group" aria-labelledby="f-cond-l">
          <div className="input-group input-group-sm grow">
            <Select aria-label="조건 항목" options={['취소 시점']} />
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
          <div className="input-group input-group-sm grow">
            <Select aria-label="취소 시점 값" options={['관람일 7~9일 전']} />
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
        </div>
      </div>
      <div className="field">
        <span className="label" id="f-then-l">
          결과
        </span>
        <div className="row" style={{ gap: 8 }} role="group" aria-labelledby="f-then-l">
          <div className="input-group input-group-sm grow">
            <Select aria-label="결과 항목" options={['공제율']} />
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
          <div className="input-group input-group-sm is-error" style={{ width: 96, flex: 'none' }}>
            <input id="f-rate" type="text" inputMode="numeric" defaultValue="20" aria-label="공제율(%)" aria-invalid="true" aria-describedby="f-rate-e" />
            <span className="t-sm muted">%</span>
          </div>
        </div>
        <span className="error-msg" id="f-rate-e">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          {RATE_ERROR[error]}
        </span>
        <AddCondition depth={1} />
      </div>
      <JsonLink />
    </div>
  );
}

function RuleEditor({ state }: { state: PolicyState }) {
  const input = state === '입력 오류';
  const cap = state === '상한 위반';
  const fee = input || cap;
  return (
    <section className="card col max-md:hidden p-6" style={{ gap: 16, minWidth: 0 }} aria-labelledby="h-edit">
      <div className="section-title">
        <h2 id="h-edit">규칙 편집</h2>
        <span className="row" style={{ gap: 6 }}>
          {input ? <span className="badge badge-danger">입력 오류</span> : cap ? <span className="badge">초안</span> : <span className="badge badge-success">승인</span>}
        </span>
      </div>
      <KindPicker name={fee ? 'f-kind' : 'r-kind'} checked={fee ? 'refund' : 'presale'} />

      {input && (
        <div className="error-summary" role="alert" aria-labelledby="r-err-t">
          <strong className="row" id="r-err-t" style={{ gap: 6 }}>
            <i className="ic ic-alert-circle tx-danger" aria-hidden="true" />
            입력 오류 1개를 고쳐야 저장할 수 있습니다
          </strong>
          <a href="#f-rate">공제율: {RATE_ERROR.input}</a>
        </div>
      )}
      {cap && (
        <div className="banner banner-warning" role="alert">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">공제율 상한(POL-032)이나 양도 규칙(POL-017)을 넘는 규칙은 승인되지 않습니다</span>
            넘은 항목: 관람일 7~9일 전 공제율 20%
            <br />
            허용 범위: 10% 이하(POL-032, 소비자분쟁해결기준 공연업)
          </div>
        </div>
      )}

      {fee ? <RefundForm error={input ? 'input' : 'cap'} /> : <PresaleForm />}

      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button className={`btn btn-ghost ${TAB_LG}`} type="button">
          편집 내용 되돌리기
        </button>
        {input ? (
          <button className={`btn btn-primary ${TAB_LG}`} type="button" aria-disabled="true" aria-describedby="r-err-t">
            규칙 저장
          </button>
        ) : (
          <button className={`btn btn-primary ${TAB_LG}`} type="button">
            규칙 저장
          </button>
        )}
      </div>
    </section>
  );
}

/* ---------- 시뮬레이션 ---------- */

const SIM_CARD = 'card col max-md:hidden p-6 lg:p-4';

function PresaleSimulation() {
  return (
    <section className={SIM_CARD} role="region" aria-labelledby="h-sim" style={{ gap: 14 }}>
      <div className="row between" style={{ gap: 8 }}>
        <h2 className="t-md fw-b" id="h-sim">
          시뮬레이션 · {PRESALE_RULE.name}
        </h2>
      </div>
      <div className="col" style={{ gap: 4 }}>
        <span className="eyebrow">적용 대상</span>
        <p className="t-sm">
          <span className="fw-b num">회차 2개</span>(10/25(일) 18:00, 10/26(월) 17:00 KST) · <span className="fw-b num">좌석 2,400석</span>
        </p>
      </div>
      <div className="col" style={{ gap: 8 }}>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px] gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_64px] lg:gap-2">
          <div className="field" style={{ gap: 4 }}>
            <label className="label" htmlFor="s-who">
              구매자
            </label>
            <div className="input-group input-group-sm">
              <Select id="s-who" options={['팬클럽 회원 A', '일반 회원 B']} />
              <i className="ic ic-chevron-down" aria-hidden="true" />
            </div>
          </div>
          <div className="field" style={{ gap: 4 }}>
            <label className="label" htmlFor="s-at">
              시각(KST)
            </label>
            <input className="input input-sm" id="s-at" type="text" defaultValue="10/13(화) 20:30" />
          </div>
          <div className="field" style={{ gap: 4 }}>
            <label className="label" htmlFor="s-qty">
              매수
            </label>
            <input className="input input-sm" id="s-qty" type="text" inputMode="numeric" defaultValue="3" />
          </div>
        </div>
        <div className="banner banner-danger" aria-live="polite">
          <i className="ic ic-x-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">거부</span>
            팬클럽 회원 A가 3매를 담으면 → 거부(1인 2매)
          </div>
        </div>
        <div className="table-wrap">
          <table className="table dense">
            <caption className="sr-only">다른 경우 {PRESALE_CASES.length}개의 시뮬레이션 결과</caption>
            <thead>
              <tr>
                <th scope="col">다른 경우</th>
                <th scope="col">결과</th>
              </tr>
            </thead>
            <tbody>
              {PRESALE_CASES.map((c) => (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td className="nowrap">
                    <span className={CASE_RESULT[c.result].cls}>{CASE_RESULT[c.result].label}</span>
                    {c.note ? <span className="t-xs muted"> {c.note}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function RefundSimulation() {
  return (
    <section className={SIM_CARD} role="region" aria-labelledby="h-sim" style={{ gap: 14 }}>
      <div className="row between" style={{ gap: 8 }}>
        <h2 className="t-md fw-b" id="h-sim">
          시뮬레이션 · {REFUND_RULE.name}
        </h2>
        <span className="badge badge-danger">상한 넘음</span>
      </div>
      <div className="col" style={{ gap: 4 }}>
        <span className="eyebrow">적용 대상</span>
        <p className="t-sm">
          <span className="fw-b num">회차 2개</span> · <span className="fw-b num">좌석 2,400석</span>
        </p>
      </div>
      <div className="col" style={{ gap: 8 }}>
        <div className="grid grid-cols-2 gap-3 lg:gap-2">
          <div className="field" style={{ gap: 4 }}>
            <label className="label" htmlFor="c-tier">
              좌석 등급
            </label>
            <div className="input-group input-group-sm">
              <Select id="c-tier" options={['R석 ₩154,000', 'S석 ₩132,000', 'A석 ₩110,000']} />
              <i className="ic ic-chevron-down" aria-hidden="true" />
            </div>
          </div>
          <div className="field" style={{ gap: 4 }}>
            <label className="label" htmlFor="c-when">
              취소 시점
            </label>
            <input className="input input-sm" id="c-when" type="text" defaultValue="관람일 8일 전" />
          </div>
        </div>
        <div className="banner banner-warning" aria-live="polite">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            R석 ₩154,000을 관람일 8일 전에 취소하면 → 공제 ₩30,800(20%) · 환급 ₩123,200
            <br />
            <span className="t-xs muted">상한 10%로는 공제 ₩15,400 · 환급 ₩138,600 · 예매 뒤 24시간이 지난 취소로 계산했습니다</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- 자격 명단 ---------- */

function EligibilityList({ isMember }: { isMember: boolean }) {
  const L = FANCLUB_LIST;
  return (
    <section className="card col gap-3 p-4 md:gap-4 md:p-6" style={{ minWidth: 0 }} aria-labelledby="h-elig">
      <div className="section-title">
        <h2 id="h-elig" className="max-md:text-base">
          자격 명단
        </h2>
        <div className="col max-md:hidden" style={{ gap: 4, alignItems: 'flex-end' }}>
          <AdminOnly isMember={isMember} id="el-up" className={`btn btn-outline btn-sm ${TAB_MD}`} describedBy="el-up-h">
            <i className="ic ic-upload" aria-hidden="true" />
            명단 올리기
          </AdminOnly>
          {!isMember && (
            <span className="t-xs muted" id="el-up-h">
              파트너 관리자
            </span>
          )}
        </div>
      </div>
      <div className="card-flat pad col" style={{ gap: 10 }}>
        <div className="flex flex-col gap-2.5 md:flex-row md:items-start md:justify-between md:gap-2">
          <span className="t-md fw-b">{L.name}</span>
          <div className="row wrap md:justify-end" style={{ gap: 4 }}>
            <span className="badge badge-success">{L.count}</span>
            <span className="badge">
              <i className="ic ic-lock" aria-hidden="true" />
              {L.lockedAt}
            </span>
          </div>
        </div>
        <dl className="kv">
          <dt>규칙에서 쓰는 키</dt>
          <dd className="mono">{L.key}</dd>
          <dt>쓰는 규칙</dt>
          <dd>{L.usedBy}</dd>
          <dt>올린 사람 · 때</dt>
          <dd>{L.uploadedBy}</dd>
        </dl>
      </div>
      <div className="col" style={{ gap: 8 }} role="status" aria-labelledby="el-res-t">
        <span className="eyebrow" id="el-res-t">
          올린 결과
        </span>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          <div className="stat col-span-2 md:col-span-1">
            <span className="stat-label">반영</span>
            <span className="t-lg num">{L.result.applied}</span>
          </div>
          <div className="stat">
            <span className="stat-label">형식 오류</span>
            <span className="t-lg num tx-warning">{L.result.badFormat.count}</span>
            <span className="stat-meta">{L.result.badFormat.rows}</span>
          </div>
          <div className="stat">
            <span className="stat-label">없는 코드</span>
            <span className="t-lg num tx-warning">{L.result.unknown.count}</span>
            <span className="stat-meta">{L.result.unknown.rows}</span>
          </div>
        </div>
        <p className="t-xs muted">계정 이름·연락처는 보이지 않습니다.</p>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <span className="eyebrow">공연 상세에서 팬에게 보이는 문구</span>
        <p className="t-sm">
          <span className="badge badge-primary">명단에 있음</span> 팬클럽 선예매 대상입니다. 10/13(화) 20:00부터 1인 2매까지 예매할 수 있습니다
        </p>
        <p className="t-sm">
          <span className="badge">명단에 없음</span> 이 회차의 선예매 대상이 아닙니다. 일반 예매는 10/14(수) 20:00부터입니다
        </p>
      </div>
      <div className="banner banner-info">
        <i className="ic ic-lock" aria-hidden="true" />
        <div className="banner-body">
          명단은 그 규칙의 판매 시작 24시간 전 [가정]까지 바꿀 수 있고 그 뒤 잠급니다. 명단 내용을 바꾸는 것은 재승인을 부르지 않습니다(규칙 자체를 바꾸면
          재승인). 올린 파일은 저장하지 않고 자격 집합만 두며, 판매 기간이 끝나고 1일 [가정] 뒤 지웁니다.
        </div>
      </div>
      <BigScreenNotice title="명단 올리기는 태블릿이나 데스크톱에서 합니다" body="파트너 관리자가 올립니다. 휴대폰에서는 볼 수만 있습니다" copyLabel="명단 올리기 링크 복사" />
    </section>
  );
}
