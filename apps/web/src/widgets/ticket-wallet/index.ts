// SCR-013 마이 티켓(월렛) 본문. 목록 경로(_pages/my-tickets)와 티켓 펼침 경로(_pages/ticket-detail)가 같이 쓴다
// (페이지끼리 가져오지 않게 위젯으로 뺐다, docs/frontend.md §2.2 '층 의존').
export { Wallet } from './ui/Wallet';
export { T1, T2, T3, PAST, WALLET, WALLET_TICKET_IDS, walletView, type WalletState, type WalletView } from './model/wallet';
