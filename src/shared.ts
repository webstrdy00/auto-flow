export type Channel = 'naver' | 'threads';
export type JobStatus = 'draft' | 'approved' | 'running' | 'published' | 'needs_attention' | 'uncertain' | 'cancelled';
export interface Product {
  id: string;
  name: string;
  sourceUrl: string;
  price: string;
  soldOut: boolean;
  checkedAt: string;
  facts: string;
  shareUrl: string;
}
export interface Draft {
  id: string;
  productId: string;
  channel: Channel;
  title: string;
  body: string;
  version: number;
  updatedAt: string;
}
export interface Job {
  id: string;
  draftId: string;
  version: number;
  channel: Channel;
  target: string;
  scheduledAt: string | null;
  status: JobStatus;
  resultUrl: string;
  message: string;
  updatedAt: string;
  asideSessionId: string;
}
export interface Settings {
  naverBlogId: string;
  threadsHandle: string;
  tone: string;
  useWorkTabs: boolean;
}
export interface EventEntry { id: number; jobId: string; message: string; at: string }
export interface ScanSummary {
  status: 'running' | 'complete' | 'failed';
  saved: number;
  skipped: Array<{ name: string; reason: 'missing' }>;
  message: string;
}
export interface AppState { products: Product[]; drafts: Draft[]; jobs: Job[]; settings: Settings; events: EventEntry[]; paused: boolean; scan?: ScanSummary }
export type Command =
  | { type: 'state' }
  | { type: 'openBrowser'; channel: 'toss' | 'naver' }
  | { type: 'scanProducts' }
  | { type: 'saveProduct'; product: Product }
  | { type: 'issueLink'; productId: string }
  | { type: 'generate'; productId: string }
  | { type: 'saveDraft'; draft: Draft }
  | { type: 'approve'; draftId: string; scheduledAt: string | null }
  | { type: 'runJob'; jobId: string }
  | { type: 'checkJob'; jobId: string }
  | { type: 'cancelJob'; jobId: string }
  | { type: 'reconcile'; jobId: string; resultUrl: string }
  | { type: 'confirmNotPublished'; jobId: string }
  | { type: 'pause'; paused: boolean }
  | { type: 'saveSettings'; naverBlogId: string; threadsHandle: string; tone: string; useWorkTabs: boolean }
  | { type: 'openResult'; jobId: string };
export interface AppApi { execute(command: Command): Promise<AppState> }
export const DISCLOSURE = '[광고] 토스쇼핑 쉐어링크 활동으로, 링크 구매 시 수수료를 지급받습니다.';

export function isThreadsHandle(value: string): boolean {
  return value === value.trim() && /^[A-Za-z0-9_](?:[A-Za-z0-9._]{0,28}[A-Za-z0-9_])?$/.test(value) && !value.includes('..');
}

export function isTossShareUrl(value: string): boolean {
  if (!value || value.length > 2048 || /[\s\\]/u.test(value)) return false;
  return /^https:\/\/(?:toss\.im\/[A-Za-z0-9_/-]+|toss\.shopping\/_m\/[A-Za-z0-9_-]+)$/.test(value);
}

export function validateThreadsBody(body: string, expectedShareUrl?: string): string {
  if (!body.trim() || Array.from(body).length > 500 || !body.startsWith(DISCLOSURE)) {
    throw new Error('Threads 원고는 첫머리 광고 문구를 포함한 500자 이내여야 합니다.');
  }
  const links = body.match(/https?:\/\/[^\s<>"']+/g) ?? [];
  if (links.length !== 1) throw new Error('Threads 원고에는 쉐어링크 하나만 넣으세요.');
  if (!isTossShareUrl(links[0]!) || (expectedShareUrl !== undefined && links[0] !== expectedShareUrl)) {
    throw new Error('Threads 쉐어링크는 원문 그대로 단독 줄에 넣고 뒤에 문장부호를 붙이지 마세요.');
  }
  return links[0]!;
}
