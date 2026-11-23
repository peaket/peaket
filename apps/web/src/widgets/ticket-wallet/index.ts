// SCR-013 마이 티켓(월렛) 본문. 목록 경로(_pages/my-tickets)와 티켓 펼침 경로(_pages/ticket-detail)가 같이 쓴다
// (페이지끼리 가져오지 않게 위젯으로 뺐다, docs/frontend.md §2.2 '층 의존').
export { Wallet } from './ui/Wallet';
// 실제 화면(FIX-wallet-tickets): 서버 셸이 첫 HTML(불러오는 중·QR 뼈대)을 그리고 WalletLive에 넘긴다
export { WalletLiveShell } from './ui/WalletLiveShell';
export { T1, T2, T3, PAST, WALLET, WALLET_TICKET_IDS, walletView, type WalletState, type WalletView } from './model/wallet';
