import type { Metadata } from 'next';

export { NotFoundScreen } from './ui/NotFoundScreen';
export { ErrorScreen } from './ui/ErrorScreen';
export { SystemNoticeCard, SystemNoticeMain, STATUS_PAGE_URL, type SystemNoticeCardProps } from './ui/SystemNoticeCard';
export { SystemNoticePage } from './ui/SystemNoticePage';
export const metadata: Metadata = { title: '시스템 안내', robots: { index: false, follow: false } };
