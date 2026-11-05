// 대기실의 시트·대화상자 내용. 휴대폰은 아래 시트(.sheet), md 이상은 대화상자(.dialog)로 보드 SCR-008 m·t·d를 따른다.
import { AUTO_ASSIGN_TEXT, KEEP_QUEUE, LEGAL_POL024, LOGOUT_TEXT, ORDERING_TEXT } from '../copy';
import { links } from '../config';
import type { AlertApi, AlertResult, ModalKey, PrefApi } from '../ctx';
import { defaultPreference } from '../live/preference.ts';
import { prefEditor } from './preference';
import { cx, h, ic, type Child } from '../dom';
import { ACCOUNT, type EventFixture, type Ordering } from '../fixtures';
import type { ModalBuild, ModalCtx } from '../ui/modal';

/** 시트·대화상자 겉모양. 제목 id로 이름을 잇는다 */
function box(m: ModalCtx, titleId: string, opts: { describedBy?: string; wideClass?: string }, ...children: Child[]): HTMLElement {
  return h('div', {
    class: m.wide ? cx('dialog', opts.wideClass) : 'sheet',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': opts.describedBy,
  }, !m.wide && h('span', { class: 'sheet-handle', 'aria-hidden': 'true' }), children);
}

function title(m: ModalCtx, id: string, text: string): HTMLElement {
  return h('h2', { class: m.wide ? 'dialog-title' : 't-lg', id }, text);
}

/** 버튼 둘: 휴대폰은 주 버튼이 위(꽉 찬 폭), 대화상자는 [보조] [주] 순서로 오른쪽 정렬(보드 그대로) */
function actions(m: ModalCtx, primary: HTMLElement, secondary?: HTMLElement): Child {
  if (m.wide) {
    primary.classList.remove('btn-block');
    secondary?.classList.remove('btn-block');
    return h('div', { class: 'dialog-actions' }, secondary, primary);
  }
  return [primary, secondary];
}

/** 희망 조건 칸(CMP-057 preference). 로비 카드와 대기열 시트가 같이 쓴다. 이 기기에만 저장된다(목업이라 저장하지 않는다) */
export function prefFields(ev: EventFixture, idp: string, wide = false): HTMLElement[] {
  const p = ev.pref;
  const out = h('output', null, String(p.qty));
  let qty = p.qty;
  const minus = h('button', { type: 'button', 'aria-label': '매수 줄이기' }, ic('minus', 'ic-16'));
  const plus = h('button', { type: 'button', 'aria-label': '매수 늘리기' }, ic('plus', 'ic-16'));
  // 이유 있는 비활성은 aria-disabled + 이유 글(안내 문구를 aria-describedby로 잇는다)
  const sync = (): void => {
    out.textContent = String(qty);
    for (const [btn, off] of [[minus, qty <= 1], [plus, qty >= p.maxQty]] as const) {
      btn.setAttribute('aria-disabled', String(off));
      btn.classList.toggle('tx-disabled', off);
    }
  };
  minus.addEventListener('click', () => {
    if (qty > 1) qty--;
    sync();
  });
  plus.addEventListener('click', () => {
    if (qty < p.maxQty) qty++;
    sync();
  });
  sync();
  return [
    h('div', { class: 'col q-g10' },
      h('span', { class: 'label', id: `${idp}-tier-l` }, '1순위 등급'),
      h('div', { class: 'row q-g20', role: 'radiogroup', 'aria-labelledby': `${idp}-tier-l` },
        p.tiers.map((t) => h('label', { class: 'check-row' }, h('input', { class: 'rd', type: 'radio', name: `${idp}-tier`, value: t, checked: t === p.tier }), t)),
      ),
    ),
    h('div', { class: 'col q-g6' },
      h('div', { class: 'row between' },
        h('span', { class: 'label', id: `${idp}-qty-l` }, '매수'),
        h('div', { class: 'stepper-num', role: 'group', 'aria-labelledby': `${idp}-qty-l`, 'aria-describedby': `${idp}-qty-h` }, minus, out, plus),
      ),
      h('p', { class: 'hint', id: `${idp}-qty-h` }, `한 공연에서 최대 ${p.maxQty}매까지 구매할 수 있습니다`),
    ),
    h('label', { class: 'check-row' }, h('input', { class: 'cb', type: 'checkbox', checked: p.wheelchair }), '휠체어석이 필요합니다'),
    h('div', { class: 'row between wrap q-g12' },
      h('label', { class: 'label', for: `${idp}-2nd` }, '2순위 등급 ', h('span', { class: 'opt' }, '(선택)')),
      h('div', { class: cx('input-group input-group-sm', wide ? 'q-w160' : 'q-w136') },
        h('select', { id: `${idp}-2nd` },
          h('option', { value: '' }, '고르지 않음'),
          p.tiers.filter((t) => t !== p.tier).map((t) => h('option', { value: t, selected: t === p.second }, t)),
        ),
        ic('chevron-down'),
      ),
    ),
    h('label', { class: 'check-row' },
      h('input', { class: 'cb', type: 'checkbox', checked: p.allowSplit }),
      h('span', null, '연석이 없으면 분리 좌석도 받습니다 ', h('span', { class: 'muted' }, '(선택)')),
    ),
  ];
}

export interface ModalDeps {
  /** 순번 안내(정렬 방식·자동 배정)와 희망 조건(목업 공연만 pref가 있다)이 읽는 공연 값 */
  ev?: { ordering: Ordering; autoAssign: boolean; pref?: EventFixture['pref'] };
  /** 대기 취소 API(데이터 연결 화면, ADR-0207). 없으면 목업처럼 cancelTo로 간다 */
  cancel?: () => Promise<boolean>;
  /** 대기 취소를 확인하면 가는 곳(공연 상세 SCR-002, 굿즈는 상품 상세) */
  cancelTo: string;
  /** 다른 기기 참가: 이 기기에서 다시 참가를 고른 뒤(시연은 사람 확인 중으로) */
  onRejoin?: () => void;
  /** 메뉴 시트에서 로그아웃을 고르면 로그아웃 확인으로 바꾼다 */
  openLogout?: () => void;
  /** 희망 조건(자동 배정 공연, ADR-0212). 있으면 'pref' 시트가 실제 값을 고치고 저장한 뒤 onSaved를 부른다 */
  pref?: PrefApi & { onSaved(): void };
  /** [차례 알림 받기](ADR-0212 결정 4). 있으면 'notify' 시트가 실제로 켠다 */
  alerts?: AlertApi;
  /** 로그아웃(데이터 연결 화면, ADR-0208 결정 7). wallet은 '이 기기의 입장 키도 지우기'. 성공하면 홈으로 가고, 실패면 'failed' */
  logout?: (wallet: boolean) => Promise<'ok' | 'failed'>;
}

export function modalBuild(key: ModalKey, d: ModalDeps): ModalBuild {
  switch (key) {
    case 'logout':
      return (m) => {
        const key = h('input', { class: 'cb', id: 'lo-key', type: 'checkbox' }) as HTMLInputElement;
        const err = h('p', { class: 't-sm tx-danger', role: 'alert', hidden: true }, '로그아웃을 마치지 못했습니다. 다시 시도해 주세요');
        const go = h('button', {
          class: 'btn btn-primary btn-lg btn-block',
          type: 'button',
          onclick: () => {
            if (!d.logout) return location.assign(links.home());
            // 끝날 때까지 다시 누르지 못하게 하고, 실패하면 대화상자 안에 알린다(성공하면 홈으로 간다)
            go.setAttribute('aria-busy', 'true');
            (go as HTMLButtonElement).disabled = true;
            err.hidden = true;
            void d.logout(key.checked).then((r) => {
              if (r === 'ok') return;
              go.removeAttribute('aria-busy');
              (go as HTMLButtonElement).disabled = false;
              err.hidden = false;
            });
          },
        }, '로그아웃');
        const cancel = h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: m.close }, '취소');
        if (m.wide) go.classList.remove('btn-lg');
        return box(m, 'lo-t', { describedBy: 'lo-d', wideClass: 'q-dlg-480' },
          title(m, 'lo-t', LOGOUT_TEXT.title),
          h('p', { class: 't-sm', id: 'lo-d' }, LOGOUT_TEXT.body),
          h('label', { class: 'check-row', for: 'lo-key' }, key, LOGOUT_TEXT.check),
          h('p', { class: 't-xs muted' }, LOGOUT_TEXT.checkHint),
          err,
          actions(m, go, cancel),
        );
      };
    case 'notify':
      if (d.alerts) return notifySheet(d.alerts);
      // CMP-068 push. 보드가 없어 SCR-001 '알림 권한 안내' 시트 모양에 차례 알림 문장을 넣었다(추천안). 권한 요청은 데이터 연결 단계에서 붙인다
      return (m) => box(m, 'np-t', {},
        h('span', { class: 'state-icon is-primary q-icon-56' }, ic('bell')),
        title(m, 'np-t', '차례 알림을 이 기기로 받습니다'),
        h('p', { class: 't-sm muted' }, '차례가 가까워지면 탭 제목에 남은 시간을 보이고 알림음을 냅니다. 아래 버튼을 누른 뒤에만 브라우저가 알림 권한을 묻습니다.'),
        h('p', { class: 't-sm muted' }, '권한을 거부하거나 지원하지 않는 브라우저라면 탭 제목과 알림음으로 알려 드립니다.'),
        actions(m,
          h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: m.close }, '알림 켜기'),
          h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: m.close }, '닫기'),
        ),
      );
    case 'cancel':
      return (m) => {
        const err = h('p', { class: 't-sm tx-danger', role: 'alert', hidden: true }, '대기를 취소하지 못했습니다. 다시 시도해 주세요');
        const yes = h('button', {
          class: 'btn btn-danger btn-lg btn-block',
          type: 'button',
          onclick: () => {
            if (!d.cancel) return location.assign(d.cancelTo);
            // 취소가 끝날 때까지 다시 누르지 못하게 하고, 실패하면 대화상자 안에 알린다(성공하면 공연 상세로 간다)
            yes.setAttribute('aria-busy', 'true');
            (yes as HTMLButtonElement).disabled = true;
            err.hidden = true;
            void d.cancel().then((ok) => {
              if (ok) return;
              yes.removeAttribute('aria-busy');
              (yes as HTMLButtonElement).disabled = false;
              err.hidden = false;
            });
          },
        }, '대기를 취소합니다');
        const no = h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: m.close, 'data-autofocus': true }, '계속 기다리기');
        if (m.wide) yes.classList.remove('btn-lg');
        return box(m, 'cx-t', {},
          h('span', { class: cx('state-icon is-danger q-icon-56', !m.wide && 'q-self-start') }, ic('alert')),
          title(m, 'cx-t', '대기를 취소하면 이 순번은 사라집니다'),
          err,
          actions(m, yes, no),
        );
      };
    case 'info':
      return (m) => {
        const ev = d.ev;
        const ord = ORDERING_TEXT[ev?.ordering ?? 'HYBRID'];
        const close = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: m.close, 'data-autofocus': true }, '닫기');
        return box(m, 'qi-t', { wideClass: 'q-dlg-560' },
          title(m, 'qi-t', '순번 안내'),
          h('div', { class: 'banner banner-info' },
            ic('info'),
            h('div', { class: 'banner-body col q-g8' },
              h('span', { class: 'badge badge-primary q-self-start' }, ord.badge),
              ord.body.map((t) => h('p', null, t)),
              ev?.autoAssign && h('p', { class: 'fw-b' }, AUTO_ASSIGN_TEXT),
            ),
          ),
          h('div', { class: 'banner banner-legal' }, ic('scale'), h('div', { class: 'banner-body' }, h('span', { class: 'legal-tag' }, '법정 고지'), LEGAL_POL024)),
          h('p', { class: 't-sm muted' }, KEEP_QUEUE),
          actions(m, close),
        );
      };
    case 'pref':
      if (d.pref) return prefSheet(d.pref);
      return (m) => {
        const ev = d.ev as EventFixture;
        const save = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: m.close }, '희망 조건 저장하기');
        const hint = h('p', { class: 'hint' }, '차례 전까지 바꿀 수 있고 이 기기에만 저장됩니다');
        return box(m, 'pf-t', { wideClass: 'q-dlg-480' },
          h('div', { class: 'row between' },
            title(m, 'pf-t', '희망 조건'),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': m.wide ? '희망 조건 창 닫기' : '희망 조건 시트 닫기', onclick: m.close }, ic('close')),
          ),
          prefFields(ev, 'pfs', m.wide),
          m.wide ? [hint, actions(m, save)] : [save, hint],
        );
      };
    case 'rejoin':
      return (m) => {
        const yes = h('button', {
          class: 'btn btn-danger btn-lg btn-block q-btn-wrap',
          type: 'button',
          onclick: () => {
            m.close();
            d.onRejoin?.();
          },
        }, '처음 기기의 참가를 취소하고 이 기기에서 다시 참가합니다');
        const no = h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: m.close }, '닫고 처음 기기에서 계속하기');
        return box(m, 'rj-t', { describedBy: 'rj-d' },
          h('span', { class: cx('state-icon is-primary q-icon-56', !m.wide && 'q-self-start') }, ic('device')),
          title(m, 'rj-t', '이 기기에서 다시 참가합니다'),
          h('p', { class: 't-sm muted', id: 'rj-d' }, '처음 기기의 참가는 취소되고, 순서는 오픈 때 정해지므로 불리하지 않습니다'),
          actions(m, yes, no),
        );
      };
    case 'menu':
      // 일반 셸 메뉴 시트(d5 §3.1 sm 메뉴 시트, 로그인 뒤). 보드가 없어 d5 그림의 항목만 옮겼다
      return (m) => {
        const item = (href: string, text: string): HTMLElement =>
          h('li', null, h('a', { class: 'q-menu-link', href }, h('span', { class: 'grow' }, text), ic('chevron-right', 'muted')));
        return box(m, 'mn-t', { wideClass: 'q-dlg-480' },
          h('div', { class: 'row between' },
            title(m, 'mn-t', '메뉴'),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': '메뉴 닫기', onclick: m.close }, ic('close')),
          ),
          h('div', { class: 'row q-g10' },
            h('span', { class: 'avatar' }, ACCOUNT.initial),
            h('span', { class: 't-md fw-b' }, ACCOUNT.name),
            h('span', { class: 'badge badge-success' }, '본인확인 완료'),
          ),
          h('nav', { 'aria-label': '주 메뉴' },
            h('ul', { class: 'col' },
              item(links.tickets(), '마이 티켓'),
              item(links.orders(), '예매·주문 내역'),
              item(links.likes(), '관심 공연·알림'),
              item(links.settings(), '계정 설정'),
              item(links.help(), '고객센터'),
            ),
          ),
          h('button', { class: 'btn btn-outline btn-block', type: 'button', 'aria-haspopup': 'dialog', onclick: () => d.openLogout?.() }, '로그아웃'),
        );
      };
  }
}

const ALERT_TEXT: Record<AlertResult, string> = {
  granted: '차례가 가까워지면 알림과 알림음으로 알려 드립니다',
  denied: '알림 권한이 없어 탭 제목과 알림음으로 알려 드립니다',
  unsupported: '이 브라우저는 알림을 지원하지 않아 탭 제목과 알림음으로 알려 드립니다',
  'ios-install': 'iPhone·iPad는 홈 화면에 추가한 앱에서만 알림을 받을 수 있습니다. 공유 버튼의 [홈 화면에 추가]로 추가한 뒤 그 앱에서 다시 켜 주세요. 지금은 탭 제목과 알림음으로 알려 드립니다',
};

/**
 * CMP-068 push(ADR-0212 결정 4): 왜 필요한지 먼저 말하고, [알림 켜기]를 누른 뒤에만 오디오를 열고 권한을 묻는다.
 * 상태(idle·requesting·granted·denied·unsupported)는 role="status"로 알린다. iOS·iPadOS의 홈 화면 앱이 아니면 추가 방법을 먼저 안내한다
 */
function notifySheet(a: AlertApi): ModalBuild {
  return (m) => {
    const last = a.last();
    const status = h('p', { class: 't-sm', role: 'status' }, last ? ALERT_TEXT[last] : '');
    const done = (btn: HTMLElement) => {
      // 초점이 있는 버튼이라 disabled 대신 aria-disabled로 둔다(초점이 body로 빠지지 않게)
      btn.setAttribute('aria-disabled', 'true');
      btn.textContent = '알림 켜짐';
    };
    const on = h('button', {
      class: 'btn btn-primary btn-lg btn-block',
      type: 'button',
      onclick: () => {
        if (on.getAttribute('aria-disabled') === 'true') return;
        on.setAttribute('aria-busy', 'true');
        status.textContent = '알림 권한을 묻는 중입니다';
        void a
          .enable()
          .catch((): AlertResult => 'unsupported')
          .then((r) => {
            on.removeAttribute('aria-busy');
            done(on);
            status.textContent = ALERT_TEXT[r];
          });
      },
    }, '알림 켜기');
    if (a.on()) done(on);
    return box(m, 'np-t', { describedBy: 'np-d' },
      h('span', { class: 'state-icon is-primary q-icon-56' }, ic('bell')),
      title(m, 'np-t', '차례 알림을 이 기기로 받습니다'),
      a.iosInstall() && h('p', { class: 't-sm' }, ALERT_TEXT['ios-install']),
      h('p', { class: 't-sm muted', id: 'np-d' }, '차례가 가까워지면 알림음을 내고, 다른 탭을 보고 있으면 알림을 띄웁니다. 아래 버튼을 누른 뒤에만 브라우저가 알림 권한을 묻습니다.'),
      h('p', { class: 't-sm muted' }, '권한을 거부하거나 지원하지 않는 브라우저라면 탭 제목과 알림음으로 알려 드립니다. 창을 닫으면 알림이 오지 않습니다.'),
      status,
      actions(m, on, h('button', { class: 'btn btn-ghost btn-block', type: 'button', onclick: m.close }, '닫기')),
    );
  };
}

/** CMP-057 preference 시트(대기열 ⑧ [바꾸기], ADR-0212 결정 1): 고친 값은 [희망 조건 저장하기]를 눌러야 저장된다 */
function prefSheet(p: PrefApi & { onSaved(): void }): ModalBuild {
  return (m) => {
    let value = p.read() ?? defaultPreference(p.tiers);
    const err = h('p', { class: 't-sm tx-danger', role: 'alert', hidden: true }, '이 브라우저에 저장하지 못했습니다. 다시 시도해 주세요');
    const save = h('button', {
      class: 'btn btn-primary btn-lg btn-block',
      type: 'button',
      onclick: () => {
        if (!p.save(value)) {
          err.hidden = false;
          return;
        }
        m.close();
        p.onSaved();
      },
    }, '희망 조건 저장하기');
    const hint = h('p', { class: 'hint' }, '차례 전까지 바꿀 수 있고 이 기기에만 저장됩니다');
    return box(m, 'pf-t', { wideClass: 'q-dlg-480' },
      h('div', { class: 'row between' },
        title(m, 'pf-t', '희망 조건'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': m.wide ? '희망 조건 창 닫기' : '희망 조건 시트 닫기', onclick: m.close }, ic('close')),
      ),
      prefEditor({ idp: 'pfs', tiers: p.tiers, max: p.max, value, wide: m.wide, onChange: (v) => (value = v) }),
      err,
      m.wide ? [hint, actions(m, save)] : [save, hint],
    );
  };
}
