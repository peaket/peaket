// 한 앱 빌드(PEAKET_CONSOLE_BUILD=single, ADR-0100 결정 6 기준선·FE-T29)의 원격 대신: 같은 위젯 소스를 작업 공간 패키지로 늦게 싣는다.
// Module Federation 빌드는 webpack 설정이 이 파일을 local-widgets.stub.ts로 바꿔(NormalModuleReplacementPlugin) 위젯 소스가 호스트 묶음에 들지 않는다.
import type { WidgetManifest } from '@peaket/console-contract';

export async function loadLocalWidgets(name: 'queue' | 'purchase'): Promise<readonly WidgetManifest[]> {
  const mod = name === 'queue' ? await import(/* webpackChunkName: "widgets-queue" */ '@peaket/widget-queue/remote') : await import(/* webpackChunkName: "widgets-purchase" */ '@peaket/widget-purchase/remote');
  return mod.widgets;
}
