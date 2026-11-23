// 접은 원격 위젯은 머리만 그린다(F-03-2 OPS-360 T15, FE-T26 '접은 위젯은 머리만 그린다').
// 정본: docs/frontend.md §4.5 '구독 수명과 보이기'(collapsed가 참이면 머리(제목·상태 점·핵심 숫자 한 줄)만 그린다), d5 §3.3·§7.2 '접은 위젯',
// ADR-0361 결정 8(접기 손잡이는 호스트가 맡는다: onCollapsedChange). 실제 값으로 잇는 원격 위젯 둘(입장 비율·빈자리, 결제사)을 서버 그리기로 본다.
// 접어도 구독이 그대로인지(핵심 숫자가 계속 바뀜)는 같은 키 흐름 시험(src/shared/api/live/widget-lifecycle.test.mjs T15)과 브라우저 확인이 본다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./board.test.resolve.mjs', import.meta.url);
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { AdmissionRateWidget } = await import('@peaket/widget-queue');
const { PgStatusWidget } = await import('@peaket/widget-purchase');

const ADMISSION = { rate: '87.5%', vacancy: { value: '1,204석', meta: '입장 자리 4,000 중' }, coming: '312명', soon: '1,020명', soonP99: '41초', formula: 'serving 증가 = 빈자리 × 입장 비율' };
const PG = {
  primary: { name: '토스페이먼츠', approval: '99.2%', callP99: '1.4초', confirmP99: '2.1초', limitUse: '61%', overLimit: '0건', state: { text: '정상' } },
  fallback: { name: '포트원', status: '대기' },
};
const html = (el) => renderToStaticMarkup(el);
const DETAIL = 'https://grafana.ops.peaket.example/d/onsale';

test('F-03-2 T15 FE-T26 ① 접은 입장 비율·결제사 위젯은 머리 한 줄(제목·핵심 숫자)만 그리고 본문 칸이 없다', () => {
  for (const [Widget, data, title, key, bodyOnly] of [
    [AdmissionRateWidget, ADMISSION, '입장 비율·빈자리', ['87.5%', '1,204석'], '곧 입장 대기 p99'],
    [PgStatusWidget, PG, '결제사', ['99.2%'], '토스페이먼츠'],
  ]) {
    const open = html(createElement(Widget, { data, detailHref: DETAIL, collapsed: false }));
    const folded = html(createElement(Widget, { data, detailHref: DETAIL, collapsed: true }));
    // 짝 확인: 펼친 그림에는 본문이 있다(아무것도 못 찾는 단언이 늘 통과하지 않게)
    assert.match(open, /widget-body/, `${title} 펼침`);
    assert.ok(open.includes(bodyOnly), `${title} 펼침 본문`);
    assert.doesNotMatch(folded, /widget-body/, `${title} 접힘에 본문이 있다`);
    assert.ok(!folded.includes(bodyOnly), `${title} 접힘에 본문 글이 있다`);
    assert.match(folded, /^<details class="widget"[^>]*><summary class="widget-head"/, `${title} 접힘은 머리 줄 하나`);
    assert.ok(folded.includes(`<span>${title}</span>`), `${title} 제목`);
    for (const k of key) assert.ok(folded.includes(k), `${title} 핵심 숫자 ${k}`);
  }
});

test('F-03-2 T15 FE-T26 ② 호스트가 접기를 맡으면(onCollapsedChange) 펼친 머리에 [접기], 접힌 줄에 펼치기 이름이 있다', () => {
  const onCollapsedChange = () => undefined;
  const open = html(createElement(AdmissionRateWidget, { data: ADMISSION, detailHref: DETAIL, collapsed: false, onCollapsedChange }));
  const folded = html(createElement(AdmissionRateWidget, { data: ADMISSION, detailHref: DETAIL, collapsed: true, onCollapsedChange }));
  assert.match(open, /aria-label="입장 비율·빈자리 접기"/);
  assert.match(folded, /aria-label="입장 비율·빈자리 펼치기"/);
  // 손잡이가 없으면(퍼블리싱) 접기 단추를 그리지 않는다
  assert.doesNotMatch(html(createElement(AdmissionRateWidget, { data: ADMISSION, detailHref: DETAIL })), /접기"/);
});
