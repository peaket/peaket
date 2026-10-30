// SCR-015의 인기 MD 대기열(/shop/[productId]/queue). 캔버스 SCR-015-m 보드의 '인기 MD 대기열' 상태를 옮겼다(d5 §5.15).
// 보드는 휴대폰 하나뿐이라 태블릿·데스크톱은 같은 열을 가운데 480px로 모은다(추천안). 셸은 보드대로 일반 셸 머리·바닥글이다.
import { links } from '../config';
import type { GoodsCtx } from '../ctx';
import { h, ic, setVars } from '../dom';
import { aheadCount, etaText, fmt, progressPercent, queueSentence } from '../queue-math';
import { defaultFooter, defaultHeader } from './shell';

export function goodsQueueScreen(c: GoodsCtx): HTMLElement[] {
  const p = c.product;
  const ahead = aheadCount(p.myNumber, p.status);
  const pct = Math.round(progressPercent(p.initialAhead, ahead));
  const eta = etaText(ahead, p.status);
  const fill = h('span', { class: 'q-fill' });
  setVars(fill, { '--p': `${pct}%` });

  const notify = h('button', { class: 'btn btn-secondary btn-lg btn-block', type: 'button', 'aria-haspopup': 'dialog' }, ic('bell'), '차례 알림 받기');
  notify.addEventListener('click', () => c.open('notify', notify));
  const cancel = h('button', { class: 'btn btn-ghost btn-block', type: 'button', 'aria-haspopup': 'dialog', 'data-opens': 'cancel' }, '대기 취소');
  cancel.addEventListener('click', () => c.open('cancel', cancel));

  const main = h('main', { class: 'page-main q-goods-main', id: 'main' },
    h('div', { class: 'col q-goods' },
      h('a', { class: 'row t-sm muted q-back', href: links.shop() }, ic('chevron-left', 'ic-16'), '굿즈 스토어'),
      h('div', { class: 'col q-g4' },
        h('span', { class: 'eyebrow' }, '인기 MD 대기열'),
        h('h1', { class: 't-xl', tabindex: '-1' }, p.name),
        h('p', { class: 't-sm muted' }, p.meta),
      ),
      h('section', { class: 'card col q-goods-card', role: 'region', 'aria-label': '대기 상태' },
        h('span', { class: 't-sm muted' }, '내 앞 대기'),
        h('span', { class: 't-display', 'aria-live': 'polite' }, `${fmt(ahead)}명`),
        h('span', { class: 't-md' }, eta ? `예상 대기 ${eta}` : '예상 대기 잠시 멈춤'),
        h('div', {
          class: 'progress progress-lg q-bar',
          role: 'progressbar',
          'aria-label': '대기 진행',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': String(pct),
          'aria-valuetext': queueSentence(ahead, eta, false),
        }, fill),
        h('span', { class: 'row' }, h('span', { class: 'badge badge-success' }, p.saleBadge)),
      ),
      h('p', { class: 't-sm muted' }, '차례가 되면 상품 화면으로 넘어갑니다.'),
      notify,
      cancel,
    ),
  );
  return [defaultHeader(c), main, defaultFooter()];
}
