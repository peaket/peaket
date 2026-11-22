// 구매 팀 원격의 노출 모듈('./widgets', Module Federation, ADR-0100 결정 6, ADR-0360). 호스트가 위젯 정보를 읽고 load로 위젯을 늦게 싣는다.
// 실제 값으로 잇는 위젯은 원천이 지금 있는 '결제사' 하나다. 나머지 셋은 원천 기능이 위젯 키를 더할 때 여기에 더한다(ADR-0360 결정 9).
// 한 앱 빌드는 같은 파일을 작업 공간 패키지(@peaket/widget-purchase/remote)로 묶는다.
import { CONTRACT_MAJOR, defineWidget, type MessageKey, type Permission, type WidgetManifest } from '@peaket/console-contract';

const OPS_READ = 'ops:read' as Permission;

export const widgets: readonly WidgetManifest[] = [
  defineWidget({
    name: 'purchase-pg-status',
    contractMajor: CONTRACT_MAJOR,
    title: '결제사' as MessageKey,
    permissions: [OPS_READ],
    refresh: 'subscription',
    load: () => import(/* webpackChunkName: "w-purchase-pg-status" */ './PgStatusRemote'),
  }),
];
