// 희망 조건 칸(CMP-057 preference, d5 §5.7 ⑧·§5.8 ⑧, ADR-0212 결정 1). 로비 카드와 대기열 [바꾸기] 시트가 같이 쓴다.
// 등급은 공연 공개 요약의 priceTiers, 매수 상한은 perPersonLimit이다. 값은 이 기기에만 저장된다(live/preference.ts).
import { cx, h, ic } from '../dom';
import type { Preference, Tier } from '../live/preference.ts';

export function prefEditor(o: { idp: string; tiers: readonly Tier[]; max: number; value: Preference; wide?: boolean; onChange(p: Preference): void }): HTMLElement[] {
  let p: Preference = { ...o.value };
  const emit = () => o.onChange({ ...p });
  const out = h('output', null, String(p.count));
  const minus = h('button', { type: 'button', 'aria-label': '매수 줄이기' }, ic('minus', 'ic-16'));
  const plus = h('button', { type: 'button', 'aria-label': '매수 늘리기' }, ic('plus', 'ic-16'));
  const syncCount = (): void => {
    out.textContent = String(p.count);
    for (const [btn, off] of [[minus, p.count <= 1], [plus, p.count >= o.max]] as const) {
      btn.setAttribute('aria-disabled', String(off));
      btn.classList.toggle('tx-disabled', off);
    }
  };
  minus.addEventListener('click', () => {
    if (p.count <= 1) return;
    p = { ...p, count: p.count - 1 };
    syncCount();
    emit();
  });
  plus.addEventListener('click', () => {
    if (p.count >= o.max) return;
    p = { ...p, count: p.count + 1 };
    syncCount();
    emit();
  });
  syncCount();
  const second = h('select', { id: `${o.idp}-2nd` }) as HTMLSelectElement;
  const fillSecond = (): void => {
    second.replaceChildren(
      h('option', { value: '' }, '고르지 않음'),
      ...o.tiers.filter((t) => t.id !== p.firstTierId).map((t) => h('option', { value: t.id, selected: t.id === p.secondTierId }, t.name)),
    );
  };
  fillSecond();
  second.addEventListener('change', () => {
    p = { ...p, ...(second.value ? { secondTierId: second.value } : {}) };
    if (!second.value) delete p.secondTierId;
    emit();
  });
  const radios = o.tiers.map((t) =>
    h('label', { class: 'check-row' },
      h('input', {
        class: 'rd',
        type: 'radio',
        name: `${o.idp}-tier`,
        value: t.id,
        checked: t.id === p.firstTierId,
        onchange: () => {
          p = { ...p, firstTierId: t.id };
          // 2순위는 1순위와 같을 수 없다
          if (p.secondTierId === t.id) delete p.secondTierId;
          fillSecond();
          emit();
        },
      }),
      t.name,
    ),
  );
  const check = (label: Node | string, checked: boolean, set: (v: boolean) => void): HTMLElement =>
    h('label', { class: 'check-row' }, h('input', { class: 'cb', type: 'checkbox', checked, onchange: (e: Event) => { set((e.target as HTMLInputElement).checked); emit(); } }), label);
  return [
    h('div', { class: 'col q-g10' },
      h('span', { class: 'label', id: `${o.idp}-tier-l` }, '1순위 등급'),
      h('div', { class: 'row wrap q-g20', role: 'radiogroup', 'aria-labelledby': `${o.idp}-tier-l` }, radios),
    ),
    h('div', { class: 'col q-g6' },
      h('div', { class: 'row between' },
        h('span', { class: 'label', id: `${o.idp}-qty-l` }, '매수'),
        h('div', { class: 'stepper-num', role: 'group', 'aria-labelledby': `${o.idp}-qty-l`, 'aria-describedby': `${o.idp}-qty-h` }, minus, out, plus),
      ),
      h('p', { class: 'hint', id: `${o.idp}-qty-h` }, `한 공연에서 최대 ${o.max}매까지 구매할 수 있습니다`),
    ),
    check('휠체어석이 필요합니다', p.wheelchair, (v) => (p = { ...p, wheelchair: v })),
    h('div', { class: 'row between wrap q-g12' },
      h('label', { class: 'label', for: `${o.idp}-2nd` }, '2순위 등급 ', h('span', { class: 'opt' }, '(선택)')),
      h('div', { class: cx('input-group input-group-sm', o.wide ? 'q-w160' : 'q-w136') }, second, ic('chevron-down')),
    ),
    check(h('span', null, '연석이 없으면 분리 좌석도 받습니다 ', h('span', { class: 'muted' }, '(선택)')), p.allowSplit, (v) => (p = { ...p, allowSplit: v })),
  ];
}

/** ⑧ 한 줄 요약: '희망 R석 2매' */
export function prefSummary(p: Preference, tiers: readonly Tier[]): string {
  const name = tiers.find((t) => t.id === p.firstTierId)?.name ?? '';
  return `${name} ${p.count}매`;
}
