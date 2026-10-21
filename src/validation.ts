import { z } from 'zod';
import { isThreadsHandle, isTossShareUrl, type Command } from './shared.js';
const id = z.string().min(1).max(200);
const text = z.string().max(40000);
const iso = z.iso.datetime({ offset: true });
const product = z.object({ id, name: z.string().min(1).max(500), sourceUrl: z.string().url().max(2000), price: z.string().max(100), soldOut: z.boolean(), checkedAt: iso, facts: z.string().max(12000), shareUrl: z.string().max(2000).refine(value => value === '' || isTossShareUrl(value)) }).strict();
const draft = z.object({ id, productId: id, channel: z.enum(['naver', 'threads']), title: z.string().max(300), body: text, version: z.number().int().nonnegative(), updatedAt: iso }).strict();
const schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state') }).strict(),
  z.object({ type: z.literal('openBrowser'), channel: z.enum(['toss', 'naver']) }).strict(),
  z.object({ type: z.literal('scanProducts') }).strict(),
  z.object({ type: z.literal('saveProduct'), product }).strict(),
  z.object({ type: z.literal('issueLink'), productId: id }).strict(),
  z.object({ type: z.literal('generate'), productId: id }).strict(),
  z.object({ type: z.literal('saveDraft'), draft }).strict(),
  z.object({ type: z.literal('approve'), draftId: id, scheduledAt: iso.nullable() }).strict(),
  z.object({ type: z.literal('runJob'), jobId: id }).strict(),
  z.object({ type: z.literal('checkJob'), jobId: id }).strict(),
  z.object({ type: z.literal('cancelJob'), jobId: id }).strict(),
  z.object({ type: z.literal('reconcile'), jobId: id, resultUrl: z.string().url().max(2000) }).strict(),
  z.object({ type: z.literal('confirmNotPublished'), jobId: id }).strict(),
  z.object({ type: z.literal('pause'), paused: z.boolean() }).strict(),
  z.object({ type: z.literal('saveSettings'), naverBlogId: z.string().max(50).refine(value => value === '' || (value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(value))), threadsHandle: z.string().max(31).refine(value => value === '' || isThreadsHandle(value.replace(/^@/, ''))).transform(value => value.replace(/^@/, '')), tone: z.string().max(2000), useWorkTabs: z.boolean() }).strict(),
  z.object({ type: z.literal('openResult'), jobId: id }).strict(),
]);
export function parseCommand(input: unknown): Command {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('요청 형식이 올바르지 않습니다. 입력값을 확인하세요.');
  return result.data;
}
export function validateResultUrl(value: string, channel: 'naver'|'threads', target?: string): string {
  if (!value.startsWith('https://') || /[\s\\]/u.test(value)) throw new Error('게시 주소가 올바르지 않습니다.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('게시 주소가 올바르지 않습니다.');
  if (channel === 'naver') {
    if (!['blog.naver.com', 'm.blog.naver.com'].includes(url.hostname)) throw new Error('네이버 게시 주소가 필요합니다.');
    const parts = url.pathname.split('/').filter(Boolean);
    const blog = url.searchParams.get('blogId') || parts[0];
    const post = url.searchParams.get('logNo') || parts[1];
    if (!blog || !post || !/^\d+$/.test(post) || (target && blog !== target)) throw new Error('대상 블로그의 게시 주소가 아닙니다.');
  } else {
    const post = /^\/@([A-Za-z0-9._]+)\/post\/[A-Za-z0-9_-]+\/?$/.exec(url.pathname);
    if (!['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net'].includes(url.hostname) || !post || !isThreadsHandle(post[1]!) || url.search) throw new Error('Threads 게시 주소가 필요합니다.');
    if (target !== undefined && post[1] !== target) throw new Error('승인한 대상 Threads 계정의 게시 주소가 아닙니다.');
  }
  return url.toString();
}
