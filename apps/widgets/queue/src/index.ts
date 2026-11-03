// @peaket/widget-queue: 관제 원격 위젯(대기열 팀 주인, docs/frontend.md §4.5).
// 지금은 호스트가 workspace:로 이어 한 앱으로 빌드한다(ADR-0100 결정 6). Module Federation 원격 적재는 관제 단계에서 붙인다.
export { type WidgetBaseProps } from './common';
export { EntryThroughputWidget, type EntryThroughputWidgetProps, type EntryThroughputData, type EntrySeries } from './EntryThroughputWidget';
export { QueueFileWidget, type QueueFileWidgetProps, type QueueFileData } from './QueueFileWidget';
export { CdnEdgeWidget, type CdnEdgeWidgetProps, type CdnEdgeData } from './CdnEdgeWidget';
export { AdmissionRateWidget, type AdmissionRateWidgetProps, type AdmissionRateData } from './AdmissionRateWidget';
export { QueueOrderWidget, type QueueOrderWidgetProps, type QueueOrderData } from './QueueOrderWidget';

/** 위젯 정보(WidgetManifest의 퍼블리싱 판). 권한 이름은 frontend §4.5 예시 */
export const QUEUE_WIDGETS = [
  { name: 'queue-entry-throughput', title: '대기열 진입·입장 처리량', permissions: ['ops:read'] },
  { name: 'queue-file', title: '대기 상태 파일 신선도·셔플 게시', permissions: ['ops:read'] },
  { name: 'queue-cdn-edge', title: '상태 조회량·CDN·엣지', permissions: ['ops:read'] },
  { name: 'queue-admission-rate', title: '입장 비율·빈자리', permissions: ['ops:read'] },
  { name: 'queue-order', title: '대기 순서', permissions: ['ops:read'] },
] as const;
