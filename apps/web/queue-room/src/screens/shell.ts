// 셸(CMP-065). 대기실은 집중 셸(web-focus)과 같은 모양을 React 없이 그린다(docs/frontend.md §2.7, d5 §3.1).
// 굿즈 대기(/shop/[productId]/queue)는 캔버스 SCR-015 보드대로 일반 셸(web-default) 머리·바닥글을 쓴다.
import { links, WEB } from '../config';
import type { BaseCtx, Ctx, HeaderEvent } from '../ctx';
import { h, ic } from '../dom';
import { ACCOUNT } from '../fixtures';

function logoMark(): HTMLElement {
  return h('i', { class: 'logo-mark', 'aria-hidden': 'true' });
}

/** 계정 메뉴. 휴대폰·태블릿은 아이콘 버튼이 로그아웃 확인을 바로 열고, 데스크톱(lg)은 이름 버튼이 작은 메뉴를 연다(보드 SCR-007·008-d) */
function accountControls(c: BaseCtx): HTMLElement {
  // 퍼블리싱 화면(?state=)은 목업 이름을, 데이터 연결 화면은 이름 없이 '계정'을 보인다(대기실은 계정 요약을 받지 않는다, ADR-0207)
  const acct = 'state' in c ? ACCOUNT : null;
  const small = h('button', {
    class: 'icon-btn q-lt-lg',
    type: 'button',
    'aria-label': '계정 메뉴(로그아웃)',
    'aria-haspopup': 'dialog',
    onclick: () => c.open('logout', small),
  }, ic('user'));

  const menu = h('div', { class: 'menu q-acct-menu', role: 'menu', 'aria-label': '계정 메뉴', hidden: true });
  const toggle = h('button', {
    class: 'acct',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': acct ? `계정 메뉴 ${acct.name}(로그아웃)` : '계정 메뉴(로그아웃)',
  }, h('span', { class: 'avatar' }, acct ? acct.initial : ic('user')), acct ? acct.name : '계정', ic('chevron-down'));
  const hide = (focusToggle: boolean): void => {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outside, true);
    if (focusToggle) toggle.focus();
  };
  const outside = (e: Event): void => {
    if (!wrap.contains(e.target as Node)) hide(false);
  };
  const item = h('button', {
    class: 'menu-item',
    type: 'button',
    role: 'menuitem',
    'aria-haspopup': 'dialog',
    onclick: () => {
      hide(false);
      c.open('logout', toggle);
    },
  }, ic('logout'), '로그아웃');
  menu.append(item);
  toggle.addEventListener('click', () => {
    if (!menu.hidden) return hide(false);
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', outside, true);
    item.focus();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hide(true);
    }
  });
  const wrap = h('span', { class: 'q-acct q-lg' }, toggle, menu);
  c.onCleanup(() => document.removeEventListener('click', outside, true));
  return h('span', { class: 'q-acct-slot' }, small, wrap);
}

/** 집중 셸 머리: ( 닫기 › ) 공연명 · 회차 · 계정 메뉴(로그아웃). lg에서는 로고와 이름 버튼이 더해진다 */
export function focusHeader(c: BaseCtx & { ev: HeaderEvent }, closeLabel = '닫고 공연 상세로 가기(대기는 유지됩니다)'): HTMLElement {
  return h('header', { class: 'fh q-fh' },
    h('div', { class: 'q-fh-in' },
      h('a', { class: 'icon-btn', href: links.event(c.ev.id), 'aria-label': closeLabel }, ic('close')),
      h('span', { class: 'logo logo-sm q-lg' }, logoMark(), 'PEAKET'),
      h('span', { class: 'vdivider q-lg q-fh-div', 'aria-hidden': 'true' }),
      h('div', { class: 'fh-title' }, h('strong', null, c.ev.title), h('span', null, c.ev.when)),
      // 로그아웃은 대기실 CSP의 form-action이 웹 /logout 보내기를 막아 HOT-341이 잇는다. 그때까지 데이터 연결 화면은 계정 메뉴를 그리지 않는다(ADR-0207 결정 12)
      'state' in c ? accountControls(c) : null,
    ),
  );
}

/** 오프라인 띠 배너(CMP-017 offline). 머리 위에 붙는다 */
export function offlineStrip(text: string): HTMLElement {
  return h('div', { class: 'banner banner-offline banner-strip', role: 'status' }, ic('wifi-off'), h('div', { class: 'banner-body' }, text));
}

/** 일반 셸 머리(휴대폰 모양: 로고 · 검색 · 마이 티켓 · 메뉴). 굿즈 대기에서만 쓴다 */
export function defaultHeader(c: Ctx): HTMLElement {
  const menuBtn = h('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': '메뉴 열기(찜·전체 장르·주 메뉴·계정)',
    'aria-haspopup': 'dialog',
    onclick: () => c.open('menu', menuBtn),
  }, ic('menu'));
  return h('header', { class: 'wh q-wh' },
    h('a', { class: 'logo', href: links.home(), 'aria-label': 'PEAKET 홈' }, logoMark(), 'PEAKET'),
    h('a', { class: 'icon-btn', href: links.search(), 'aria-label': '검색' }, ic('search')),
    h('a', { class: 'icon-btn', href: links.tickets(), 'aria-label': '마이 티켓' }, ic('ticket')),
    menuBtn,
  );
}

/** 일반 셸 바닥글(CMP-058 footer). 중개자 고지와 구매안전서비스 줄은 d5 §3.1 문구 그대로 */
export function defaultFooter(): HTMLElement {
  return h('footer', { class: 'wf' },
    h('span', { class: 'logo logo-sm' }, logoMark(), 'PEAKET'),
    h('section', { 'aria-label': '통신판매중개자 고지' },
      h('p', { class: 'wf-notice' }, 'PEAKET은 통신판매중개자로서 공연과 상품 거래의 당사자가 아닙니다. 공연의 개최·변경·취소와 상품의 제공·품질에 따른 책임은 각 판매자에게 있고, 예매·주문 취소와 환불은 PEAKET이 처리합니다. 판매자 정보는 각 공연·상품 상세에 있습니다.'),
    ),
    h('p', null, 'PEAKET(피켓) · 대표 [대표자] · 사업자등록번호 [000-00-00000] · 통신판매업 신고 [제0000-서울○○-0000호] · 주소 [사업장 주소] · 고객센터 [0000-0000]'),
    h('p', null, '구매안전서비스: 굿즈 택배 주문은 토스페이먼츠 결제대금예치를 이용할 수 있습니다 ', h('a', { href: links.policy('escrow') }, '서비스 가입 사실 확인 ›')),
    h('nav', { class: 'wf-links', 'aria-label': '약관과 정책' },
      h('a', { href: links.policy('dispute') }, '분쟁 해결 기준'),
      h('a', { href: links.policy('terms') }, '이용약관'),
      h('a', { href: links.policy('privacy') }, '개인정보 처리방침'),
      h('a', { href: links.help() }, '고객센터'),
    ),
    h('div', { class: 'row wrap q-langs' },
      ic('globe', 'ic-16'),
      h('a', { href: links.home(), 'aria-current': 'true' }, '한국어'),
      h('a', { href: `${WEB}/en`, lang: 'en' }, 'English'),
      h('a', { href: `${WEB}/ja`, lang: 'ja' }, '日本語'),
      h('a', { href: `${WEB}/zh`, lang: 'zh' }, '中文'),
    ),
  );
}
