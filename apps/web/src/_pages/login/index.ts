import type { Metadata } from 'next';
import { languageAlternates } from '@/shared/i18n/catalog';

export { LoginPage } from './ui/LoginPage';
export const metadata: Metadata = { title: '로그인', alternates: { languages: languageAlternates('/login') } };
