// Module Federation 빌드에서 local-widgets.ts 대신 싣는 빈 자리(webpack NormalModuleReplacementPlugin). 원격은 load-remote가 실행 중에 받는다.
import type { WidgetManifest } from '@peaket/console-contract';

export async function loadLocalWidgets(name: 'queue' | 'purchase'): Promise<readonly WidgetManifest[]> {
  throw new Error(`Module Federation 빌드는 원격을 받는다: ${name}`);
}
