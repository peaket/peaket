'use client';
// SCR-051 ④~⑥: 내 배정(하나면 카드, 둘 이상이면 고르기 콤보박스) → ⑥ 대리 승인 칸(현장 책임자에게만) → 대리 승인 경고 → [승인]·[거부].
// 대리 승인 칸을 켜면 버튼 글이 '동문-03에 대리 로그인 승인'으로 바뀌고 위에 경고가 뜬다(경고가 버튼보다 먼저 읽힌다, d3 SCR-051).
// 배정을 아직 고르지 않았으면 승인 버튼은 이유 있는 비활성(aria-disabled + 위 안내 글)이다.
// 휴대폰은 버튼을 세로로 쌓아 화면 아래(margin-top:auto)에 두고, md부터 한 줄에 반씩 나눈다(보드 SCR-051-t·d).
// 퍼블리싱 단계라 승인·거부는 같은 경로의 '승인됨'·'거부함' 상태로 간다.
import { useRouter } from 'next/navigation';
import { useState, type KeyboardEvent } from 'react';
import { Checkbox } from '@peaket/ds/Checkbox';

export interface ApproveFormProps {
  deviceName: string;
  /** 내 배정이 하나: 첫 줄(공연명·회차 또는 짧은 줄)과 둘째 줄(역할·유효 시간, 공개 요약을 못 읽었으면 없음) */
  single?: { title: string; meta?: string };
  /** 내 유효 배정이 둘 이상: 고르기 후보 */
  options?: { id: string; label: string }[];
  /** 대리 승인 칸을 보인다(현장 책임자에게만, 배정이 하나일 때) */
  canProxy: boolean;
  defaultProxy: boolean;
  /** 대리 승인 경고의 '내 계정(하늘)' */
  accountName: string;
  approvedHref: string;
  rejectedHref: string;
}

export function ApproveForm({ deviceName, single, options, canProxy, defaultProxy, accountName, approvedHref, rejectedHref }: ApproveFormProps) {
  const router = useRouter();
  const [proxy, setProxy] = useState(defaultProxy);
  const [picked, setPicked] = useState<string | null>(null);
  const multi = !single && !!options;
  const canApprove = !multi || picked !== null;
  const useProxy = canProxy && proxy;

  return (
    <>
      {single ? (
        <section className="col" aria-labelledby="as-h" style={{ gap: 8 }}>
          <h2 className="t-md fw-b" id="as-h">
            내 배정
          </h2>
          <div className="card row items-start gap-3 px-4 py-[14px] md:px-5 md:py-4 lg:px-6">
            <i className="ic ic-calendar" aria-hidden="true" style={{ marginTop: 2 }} />
            <div className="col grow" style={{ gap: 4 }}>
              <span className="t-md fw-b">{single.title}</span>
              {single.meta ? <span className="t-sm muted">{single.meta}</span> : null}
            </div>
          </div>
        </section>
      ) : null}

      {!single && options ? <AssignmentPicker options={options} value={picked} onChange={setPicked} /> : null}

      {single && canProxy ? (
        <Checkbox
          id="px"
          label="휴대폰 없는 스태프 대신 승인(일반 스태프 권한)"
          hint="체크하면 이 스캐너는 일반 스태프 권한으로 로그인하고, 스캔 기록은 내 계정으로 남습니다."
          checked={proxy}
          onCheckedChange={setProxy}
        />
      ) : null}

      <div className="col mt-auto gap-2 md:mt-0 md:gap-5">
        {useProxy ? (
          <div className="banner banner-warning mb-1 md:mb-0" role="status">
            <i className="ic ic-alert" aria-hidden="true" />
            <div className="banner-body fw-b">
              대리 승인하면 이 스캐너는 내 계정({accountName})으로 로그인되지만 권한은 일반 스태프로 낮아집니다. 이 스캐너의 스캔 기록은 내 계정으로 남습니다
            </div>
          </div>
        ) : null}
        {canApprove ? null : (
          <p className="hint" id="ap-why">
            내 배정을 고르면 승인할 수 있습니다.
          </p>
        )}
        <div className="col gap-2 md:mt-1 md:flex-row md:gap-3">
          <button
            className="btn btn-primary btn-lg btn-block md:flex-1"
            type="button"
            aria-disabled={canApprove ? undefined : true}
            aria-describedby={canApprove ? undefined : 'ap-why'}
            onClick={() => {
              if (canApprove) router.push(approvedHref);
            }}
          >
            {useProxy ? `${deviceName}에 대리 로그인 승인` : `${deviceName}에 로그인 승인`}
          </button>
          <button className="btn btn-secondary btn-lg btn-block md:flex-1" type="button" onClick={() => router.push(rejectedHref)}>
            거부
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * 내 배정 고르기(CMP-010 Select의 보드 모양: .input-group 콤보박스 + .menu 목록). 보드 '배정 고르기'처럼 열린 채로 시작한다.
 * 초점은 콤보박스에 두고 aria-activedescendant로 후보를 가리킨다. ↑↓ 후보 이동, Enter·Space 고르기, Esc 닫기.
 */
function AssignmentPicker({ options, value, onChange }: { options: { id: string; label: string }[]; value: string | null; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState(-1);
  const selected = options.find((o) => o.id === value);

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    onChange(o.id);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      if (!open) setOpen(true);
      setActive((i) => (i < 0 ? (step > 0 ? 0 : options.length - 1) : (i + step + options.length) % options.length));
    } else if ((e.key === 'Enter' || e.key === ' ') && open && active >= 0) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="field">
      <span className="label" id="as-lbl">
        내 배정 <span className="opt">(필수)</span>
      </span>
      <button
        className={open ? 'input-group is-focus' : 'input-group'}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls="as-list"
        aria-labelledby="as-lbl"
        aria-describedby="as-hint"
        aria-activedescendant={open && active >= 0 ? `as-opt-${active}` : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className={selected ? 'grow' : 'grow muted'} style={{ textAlign: 'left' }}>
          {selected ? selected.label : '근무할 배정을 고르세요'}
        </span>
        <i className={open ? 'ic ic-chevron-up' : 'ic ic-chevron-down'} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="menu" id="as-list" role="listbox" aria-labelledby="as-lbl" style={{ boxShadow: 'var(--shadow-md)' }}>
          {options.map((o, i) => (
            <li
              key={o.id}
              id={`as-opt-${i}`}
              className={i === active ? 'menu-item is-active' : 'menu-item'}
              role="option"
              aria-selected={o.id === value}
              style={{ height: 'auto', padding: '8px 10px', lineHeight: '20px' }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      ) : null}
      <span className="hint" id="as-hint">
        지금 유효한 배정이 둘 이상입니다. 이 스캐너로 근무할 회차를 고르세요.
      </span>
    </div>
  );
}
