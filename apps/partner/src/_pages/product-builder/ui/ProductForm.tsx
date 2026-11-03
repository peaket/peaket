// SCR-023 [상품 만들기] 탭: 굿즈 입력 칸(상태 '굿즈'·'저장 중')과 티켓 연동 부가 상품 입력 칸(상태 '티켓 연동 부가 상품').
// 데스크톱은 12열의 반씩(보드 grid-12 span-6), 태블릿은 2열(보드 SCR-023-t), 휴대폰은 범위 밖이라 안내 카드만 둔다(d5 §3.9).
import Link from 'next/link';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { ADDON_REFUND_RULE, GOODS_REFUND_RULE } from '../model/products';

export interface ProductFormProps {
  kind: '굿즈' | '티켓 연동 부가 상품';
  saving: boolean;
  /** 고치기(/products/[id])면 제목이 '상품 고치기' */
  editingName?: string;
  listHref: string;
}

const GRID = 'grid grid-cols-2 gap-x-4 gap-y-5 lg:gap-x-6';

function Select({ id, options, selected, describedBy, focus }: { id: string; options: readonly (string | { group: string; items: string[] })[]; selected: string; describedBy?: string; focus?: boolean }) {
  return (
    <div className={`input-group${focus ? ' is-focus' : ''}`}>
      <select id={id} defaultValue={selected} aria-describedby={describedBy}>
        {options.map((o) =>
          typeof o === 'string' ? (
            <option key={o}>{o}</option>
          ) : (
            <optgroup key={o.group} label={o.group}>
              {o.items.map((it) => (
                <option key={it}>{it}</option>
              ))}
            </optgroup>
          ),
        )}
      </select>
      <i className="ic ic-chevron-down" aria-hidden="true" />
    </div>
  );
}

const TYPE_OPTIONS = [
  { group: '공식 굿즈', items: ['공식 MD 굿즈(응원봉·의류·포토카드 등)'] },
  { group: '티켓 연동 부가 상품', items: ['공연장 주차권', 'VIP 패키지'] },
];

function Footer({ saving, note, listHref }: { saving: boolean; note: string; listHref: string }) {
  return (
    <div className="row between wrap" style={{ gap: 12, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      {saving ? (
        <p className="row t-sm grow" role="status" style={{ gap: 8 }}>
          <span className="spinner" aria-hidden="true" style={{ color: 'var(--link)' }} />
          상품 정보를 저장하고 있습니다
        </p>
      ) : (
        <p className="t-sm muted grow">{note}</p>
      )}
      <div className="row" style={{ gap: 8 }}>
        <Link className="btn btn-ghost" href={listHref}>
          목록으로
        </Link>
        {saving ? (
          <button className="btn btn-primary" type="button" aria-busy="true" aria-disabled="true">
            <span className="spinner" aria-hidden="true" />
            저장하는 중
          </button>
        ) : (
          <button className="btn btn-primary" type="button">
            스토어에 게시하기
          </button>
        )}
      </div>
    </div>
  );
}

function GoodsFields() {
  return (
    <div className={GRID}>
      <div className="field">
        <label className="label" htmlFor="g-type">
          상품 유형 (필수)
        </label>
        <Select id="g-type" options={TYPE_OPTIONS} selected="공식 MD 굿즈(응원봉·의류·포토카드 등)" describedBy="g-type-h" />
        <span className="hint" id="g-type-h">
          유형을 바꾸면 아래 입력 칸이 바뀝니다
        </span>
      </div>
      <div style={{ alignSelf: 'center' }}>
        <div className="banner banner-info" role="status" aria-live="polite">
          <i className="ic ic-bag" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">공식 굿즈 입력 칸입니다</span>로그인한 회원이면 티켓 예매와 관계없이 삽니다.
          </div>
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="g-name">
          상품명 (필수)
        </label>
        <input className="input" id="g-name" type="text" defaultValue="LUMEN 공식 응원봉" />
      </div>
      <div className="field">
        <label className="label" htmlFor="g-event">
          연결 공연 <span className="opt">(선택)</span>
        </label>
        <Select id="g-event" options={['LUMEN 콘서트 2026 서울', '연결하지 않음']} selected="LUMEN 콘서트 2026 서울" />
      </div>
      <div className="field">
        <label className="label" htmlFor="g-opt">
          옵션 <span className="opt">(선택)</span>
        </label>
        <input className="input" id="g-opt" type="text" defaultValue="색상: 인디고, 화이트" aria-describedby="g-opt-h" />
        <span className="hint" id="g-opt-h">
          옵션 이름 뒤에 값을 쉼표로 나눠 적습니다
        </span>
      </div>
      <fieldset className="col" style={{ gap: 10 }}>
        <legend className="label" style={{ marginBottom: 10 }}>
          수령 방식 (필수)
        </legend>
        <label className="check-row">
          <input className="cb" type="checkbox" defaultChecked />
          택배 배송
        </label>
        <label className="check-row">
          <input className="cb" type="checkbox" defaultChecked />
          현장 수령(공연 당일)
        </label>
      </fieldset>
      <div className="field">
        <span className="label" id="g-refund-l">
          취소·반품 기준 (PEAKET 공통, 바꿀 수 없음)
        </span>
        <p className="card-flat t-sm" aria-labelledby="g-refund-l" style={{ padding: '10px 12px' }}>
          {GOODS_REFUND_RULE}
        </p>
      </div>
      <div className="field">
        <label className="label" htmlFor="g-ship">
          배송비(편도) <span className="opt">(필수, 택배 배송을 켤 때)</span>
        </label>
        <div className="input-group">
          <span className="muted fw-b">₩</span>
          <input id="g-ship" type="text" inputMode="numeric" defaultValue="3,000" />
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="g-rship">
          단순 변심 반품 배송비(편도) (필수)
        </label>
        <div className="input-group">
          <span className="muted fw-b">₩</span>
          <input id="g-rship" type="text" inputMode="numeric" defaultValue="3,000" />
        </div>
      </div>
      <div className="field col-span-2">
        <label className="label" htmlFor="g-raddr">
          반품 받을 주소 (필수)
        </label>
        <input className="input" id="g-raddr" type="text" defaultValue="[예시]" />
      </div>
      <div className="col" style={{ gap: 8 }}>
        <span className="label">티켓 소지자 혜택</span>
        <label className="check-row" style={{ alignItems: 'center' }}>
          <input className="sw" id="g-holder" type="checkbox" role="switch" defaultChecked aria-describedby="g-holder-h" />
          티켓 소지자 전용 현장 수령 시간대
        </label>
        <span className="hint" id="g-holder-h">
          티켓을 가진 분에게 전용 수령 시간대를 더 엽니다. 구매 자격이 아니라 혜택입니다.
        </span>
      </div>
      <div className="field">
        <label className="label" htmlFor="g-price">
          가격 (필수)
        </label>
        <div className="input-group">
          <span className="muted fw-b">₩</span>
          <input id="g-price" type="text" inputMode="numeric" defaultValue="45,000" />
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="g-stock">
          한정 수량 (필수)
        </label>
        <div className="input-group">
          <input id="g-stock" type="text" inputMode="numeric" defaultValue="120" aria-describedby="g-stock-h" />
          <span className="muted">개</span>
        </div>
        <span className="hint" id="g-stock-h">
          결제 직전에 재고를 확정해 정한 수량보다 많이 팔지 않습니다
        </span>
      </div>
      <div className="field col-span-2">
        <label className="label" htmlFor="g-desc">
          상품 설명 <span className="opt">(선택)</span>
        </label>
        <textarea
          className="textarea"
          id="g-desc"
          style={{ minHeight: 96 }}
          aria-describedby="g-desc-c"
          defaultValue="LUMEN 콘서트 2026 서울 공식 응원봉입니다. 건전지는 들어 있지 않습니다."
        />
        <span className="counter" id="g-desc-c" aria-live="polite">
          45자
        </span>
      </div>
    </div>
  );
}

function AddonFields() {
  return (
    <div className={GRID}>
      <div className="field">
        <label className="label" htmlFor="a-type">
          상품 유형 (필수)
        </label>
        <Select id="a-type" options={TYPE_OPTIONS} selected="VIP 패키지" describedBy="a-type-h" focus />
        <span className="hint" id="a-type-h">
          유형을 바꾸면 아래 입력 칸이 바뀝니다
        </span>
      </div>
      <div style={{ alignSelf: 'center' }}>
        <div className="banner banner-announce" role="status" aria-live="polite">
          <i className="ic ic-ticket" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">티켓 연동 부가 상품 입력 칸으로 바꿨습니다</span>연결 회차, 포함 특전, 양도 칸이 생겼고 옵션 칸은
            빠졌습니다.
          </div>
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="a-name">
          상품명 (필수)
        </label>
        <input className="input" id="a-name" type="text" defaultValue="VIP 패키지 · R석" />
      </div>
      <div className="field">
        <label className="label" htmlFor="a-round">
          연결 회차 (필수)
        </label>
        <Select
          id="a-round"
         
          options={['LUMEN 콘서트 2026 서울 · 10/25(일) 18:00 KST', 'LUMEN 콘서트 2026 서울 · 10/26(월) 17:00 KST']}
          selected="LUMEN 콘서트 2026 서울 · 10/25(일) 18:00 KST"
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="a-perk">
          포함 특전 <span className="opt">(선택)</span>
        </label>
        <div className="row" style={{ gap: 8 }}>
          <input className="input" id="a-perk" type="text" placeholder="[특전 내용]" />
          <button className="btn btn-outline" type="button" style={{ height: 48, flex: 'none' }}>
            <i className="ic ic-plus" aria-hidden="true" />
            특전 더하기
          </button>
        </div>
      </div>
      <fieldset className="col" style={{ gap: 10 }}>
        <legend className="label" style={{ marginBottom: 10 }}>
          수령 방식 (필수)
        </legend>
        <label className="check-row">
          <input className="cb" type="checkbox" defaultChecked />
          현장 수령(공연 당일)
        </label>
        <label className="check-row">
          <input className="cb" type="checkbox" />
          월렛 이용권
        </label>
        <span className="hint">실물을 보내려면 굿즈로 따로 등록하세요</span>
      </fieldset>
      <div className="field">
        <span className="label" id="a-refund-l">
          취소·반품 기준 (PEAKET 공통, 바꿀 수 없음)
        </span>
        <p className="card-flat t-sm" aria-labelledby="a-refund-l" style={{ padding: '10px 12px' }}>
          {ADDON_REFUND_RULE}
        </p>
      </div>
      <div className="col" style={{ gap: 8 }}>
        <span className="label">판매·양도 조건</span>
        <label className="check-row" style={{ alignItems: 'center' }}>
          <input className="sw" id="a-holder" type="checkbox" role="switch" defaultChecked disabled aria-describedby="a-holder-h" />
          티켓 소지자 전용 판매
        </label>
        <span className="hint" id="a-holder-h">
          유효 티켓을 가진 분만 마이 티켓에서 삽니다. 끌 수 없습니다.
        </span>
        <label className="check-row" style={{ alignItems: 'center', marginTop: 4 }}>
          <input className="sw" id="a-transfer" type="checkbox" role="switch" aria-describedby="a-transfer-h" />
          티켓과 함께 양도 허용
        </label>
        <span className="hint" id="a-transfer-h">
          VIP 패키지는 양도 불가가 기본입니다
        </span>
      </div>
      <div className="field">
        <label className="label" htmlFor="a-price">
          가격 (필수)
        </label>
        <div className="input-group">
          <span className="muted fw-b">₩</span>
          <input id="a-price" type="text" inputMode="numeric" defaultValue="88,000" />
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="a-stock">
          한정 수량 (필수)
        </label>
        <div className="input-group">
          <input id="a-stock" type="text" inputMode="numeric" defaultValue="120" aria-describedby="a-stock-h" />
          <span className="muted">개</span>
        </div>
        <span className="hint" id="a-stock-h">
          결제 직전에 재고를 확정해 정한 수량보다 많이 팔지 않습니다
        </span>
      </div>
      <div className="field col-span-2">
        <label className="label" htmlFor="a-desc">
          상품 설명 <span className="opt">(선택)</span>
        </label>
        <textarea className="textarea" id="a-desc" style={{ minHeight: 96 }} aria-describedby="a-desc-c" placeholder="패키지 구성과 이용 방법을 적습니다" />
        <span className="counter" id="a-desc-c" aria-live="polite">
          0자
        </span>
      </div>
    </div>
  );
}

export function ProductForm({ kind, saving, editingName, listHref }: ProductFormProps) {
  const title = editingName ? '상품 고치기' : '새 상품';
  const goods = kind === '굿즈';
  return (
    <>
      {/* 휴대폰: 범위 밖 안내(보드 SCR-023-m '상품 만들기') */}
      <section className="col md:hidden" style={{ gap: 12 }} aria-labelledby="h-new-m">
        <h2 className="t-lg" id="h-new-m">
          {title}
        </h2>
        <BigScreenNotice title="상품 만들기·게시는 태블릿이나 데스크톱에서 합니다" />
        <Link className="link-more" href={listHref} style={{ alignSelf: 'flex-start', minHeight: 44 }}>
          상품 목록 보기
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      </section>

      <form className="card col max-md:hidden" style={{ padding: 24, gap: 20 }} action={listHref} aria-labelledby="h-new">
        <div className="row between wrap" style={{ gap: 8 }}>
          <h2 className="t-lg" id="h-new">
            {title}
            {editingName ? <span className="sr-only"> · {editingName}</span> : null}
          </h2>
          <span className="t-xs muted">(필수) 칸을 채워야 게시할 수 있습니다</span>
        </div>
        {goods ? <GoodsFields /> : <AddonFields />}
        <Footer
          saving={saving}
          listHref={listHref}
          note={goods ? '게시하면 굿즈 스토어에 바로 보입니다.' : '게시하면 굿즈 스토어와 마이 티켓의 연동 부가 상품에 바로 보입니다.'}
        />
      </form>
    </>
  );
}
