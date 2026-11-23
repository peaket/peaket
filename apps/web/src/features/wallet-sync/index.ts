// 월렛 목록 받기·카드(FIX-wallet-tickets, docs/frontend.md §4.2.4 '월렛 목록 세부'). 화면(widgets/ticket-wallet의 WalletLive)이 쓴다.
// 받기(sync.ts: 팬 API·IndexedDB·계약 검사)는 무거워 첫 화면 묶음에 넣지 않는다. 화면은 `import('@/features/wallet-sync/sync')`로 늦게 싣고,
// 여기서는 순수 규칙(model.ts)과 타입만 낸다(BAT-177 T6 ⑦).
export { walletCardOf, walletQrLabel, walletScreenOf, type WalletBadge, type WalletCard, type WalletScreen, type WalletSyncFailure, type WalletSyncResult } from './model';
