import type { Metadata } from 'next';

export { OpenInBrowserPage } from './ui/OpenInBrowserPage';
export { resolveTarget, type OpenInBrowserTarget } from './model/target';
export const metadata: Metadata = { title: '다른 브라우저로 열기', robots: { index: false, follow: false } };
