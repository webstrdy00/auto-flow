import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DISCLOSURE, isThreadsHandle, isTossShareUrl, validateThreadsBody, type AppState, type Channel, type Draft, type Job, type JobStatus, type Product, type Settings } from './shared.js';

const DAY = 24 * 60 * 60 * 1000;
const NUMERIC_ID = /^[1-9]\d{0,29}$/;
const BLOG_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;
const PRODUCT_COLUMNS = 'id, name, source_url AS sourceUrl, price, sold_out AS soldOut, checked_at AS checkedAt, facts, share_url AS shareUrl';
const DRAFT_COLUMNS = 'id, product_id AS productId, channel, title, body, version, updated_at AS updatedAt';
const JOB_COLUMNS = "id, draft_id AS draftId, version, channel, target, scheduled_at AS scheduledAt, status, result_url AS resultUrl, message, updated_at AS updatedAt, COALESCE((SELECT session_id FROM aside_sessions WHERE job_id = browser_jobs.id), '') AS asideSessionId";

type ProductRow = Omit<Product, 'soldOut'> & { soldOut: number };
type JobRow = Job & { productSnapshot: string; useWorkTabs: number };

function text(value: unknown, label: string, max: number, required = false, multiline = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${label}을(를) 확인하세요.`);
  const controls = multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/ : /[\u0000-\u001F\u007F-\u009F]/;
  if (controls.test(value)) throw new Error(`${label}에 허용되지 않는 문자가 있습니다.`);
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw new Error(`${label}에 올바르지 않은 문자가 있습니다.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 200, true);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error(`${label} 형식이 올바르지 않습니다.`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}을(를) 확인하세요.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 40, true);
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(result);
  if (!match) throw new Error(`${label}은(는) 시간대가 포함된 ISO 날짜여야 합니다.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offset = match[7]!;
  const time = Date.parse(result);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]! || !Number.isFinite(time) || (/^[+-]14:/.test(offset) && !offset.endsWith(':00'))) throw new Error(`${label}이(가) 올바른 날짜가 아닙니다.`);
  return new Date(time).toISOString();
}

function httpsUrl(value: unknown, label: string): URL {
  const result = text(value, label, 2000, true);
  if (!result.startsWith('https://') || result !== result.trim() || /[\s\\]/u.test(result)) throw new Error(`${label}을(를) 확인하세요.`);
  let url: URL;
  try { url = new URL(result); } catch { throw new Error(`${label}이(가) 올바른 주소가 아닙니다.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error(`${label}은(는) 인증 정보가 없는 HTTPS 주소여야 합니다.`);
  return url;
}

function sourceUrl(value: unknown, productId: string): string {
  const url = httpsUrl(value, '상품 주소');
  const match = /^\/links\/products\/([1-9]\d{0,29})\/?$/.exec(url.pathname);
  if (url.hostname !== 'sharelink.toss.im' || !match || match[1] !== productId) throw new Error('토스 상품 주소와 상품 ID가 일치해야 합니다.');
  return `https://sharelink.toss.im/links/products/${productId}`;
}

function shareUrl(value: unknown): string {
  const result = text(value, '쉐어링크', 2000);
  if (!result) return '';
  if (!isTossShareUrl(result)) throw new Error('토스에서 발급한 HTTPS 쉐어링크(toss.im 또는 toss.shopping/_m/)가 필요합니다.');
  return result;
}

function resultUrl(value: unknown, channel: Channel, target: string): string {
  const url = httpsUrl(value, '게시 주소');
  if (channel === 'naver') {
    if (!['blog.naver.com', 'm.blog.naver.com'].includes(url.hostname)) throw new Error('네이버 블로그 게시 주소가 필요합니다.');
    const path = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,49})\/([1-9]\d{0,29})\/?$/.exec(url.pathname);
    if (path && path[1] === target && !url.search) return `https://blog.naver.com/${target}/${path[2]}`;
    const allowed = ['blogId', 'logNo', 'Redirect', 'redirect', 'from', 'trackingCode', 'proxyReferer'];
    const postId = url.searchParams.get('logNo') ?? '';
    if (url.pathname === '/PostView.naver' && url.searchParams.getAll('blogId').length === 1 && url.searchParams.get('blogId') === target && url.searchParams.getAll('logNo').length === 1 && NUMERIC_ID.test(postId) && [...url.searchParams.keys()].every(key => allowed.includes(key))) return `https://blog.naver.com/${target}/${postId}`;
    throw new Error('승인한 대상 블로그의 공개 게시 주소가 필요합니다.');
  }
  const post = /^\/@([A-Za-z0-9._]+)\/post\/[A-Za-z0-9_-]+\/?$/.exec(url.pathname);
  if (!['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'].includes(url.hostname) || !post || !isThreadsHandle(post[1]!) || url.search) throw new Error('Threads 공개 게시 주소가 필요합니다.');
  if (post[1] !== target) throw new Error('승인한 대상 Threads 계정의 공개 게시 주소가 필요합니다.');
  return url.toString();
}

function productSnapshot(product: Product): string {
  return JSON.stringify([product.id, product.name, product.sourceUrl, product.price, product.soldOut, product.facts, product.shareUrl]);
}

function includesExactUrl(body: string, url: string): boolean {
  const links = body.match(/https?:\/\/[^\s<>"']+/gu) ?? [];
  return links.some(link => link === url || link.replace(/[),.!;:\]}，。！？、]+$/u, '') === url);
}

function validatedProduct(product: Product): Product {
  if (!product || typeof product !== 'object') throw new Error('상품 정보를 확인하세요.');
  const id = identifier(product.id, '상품 ID');
  if (!NUMERIC_ID.test(id)) throw new Error('상품 ID는 올바른 숫자여야 합니다.');
  const checkedAt = timestamp(product.checkedAt, '상품 확인 시각');
  if (Date.parse(checkedAt) > Date.now()) throw new Error('상품 확인 시각은 미래일 수 없습니다.');
  return {
    id,
    name: text(product.name, '상품명', 500, true),
    sourceUrl: sourceUrl(product.sourceUrl, id),
    price: text(product.price, '가격', 100),
    soldOut: boolean(product.soldOut, '품절 여부'),
    checkedAt,
    facts: text(product.facts, '상품 사실', 12000, false, true),
    shareUrl: shareUrl(product.shareUrl),
  };
}

function validatedSettings(settings: Settings): Settings {
  if (!settings || typeof settings !== 'object') throw new Error('설정 정보를 확인하세요.');
  const naverBlogId = text(settings.naverBlogId, '블로그 ID', 50);
  const rawHandle = text(settings.threadsHandle, 'Threads 계정 핸들', 31);
  const threadsHandle = rawHandle.replace(/^@/, '');
  if (naverBlogId && !BLOG_ID.test(naverBlogId)) throw new Error('블로그 ID 형식을 확인하세요.');
  if (rawHandle && !isThreadsHandle(threadsHandle)) throw new Error('Threads 계정 핸들 형식을 확인하세요.');
  return {
    naverBlogId, threadsHandle,
    tone: text(settings.tone, '문체', 2000, false, true),
    useWorkTabs: boolean(settings.useWorkTabs, '새 작업 탭 사용 여부'),
  };
}

export class Store {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    text(path, '저장소 경로', 32767, true);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path);
      this.db = database;
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, source_url TEXT NOT NULL, price TEXT NOT NULL,
          sold_out INTEGER NOT NULL CHECK (sold_out IN (0, 1)), checked_at TEXT NOT NULL,
          facts TEXT NOT NULL, share_url TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS drafts (
          id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
          channel TEXT NOT NULL CHECK (channel IN ('naver', 'threads')), title TEXT NOT NULL,
          body TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0), updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS drafts_product_channel ON drafts(product_id, channel);
        CREATE TABLE IF NOT EXISTS browser_jobs (
          id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), version INTEGER NOT NULL,
          channel TEXT NOT NULL CHECK (channel IN ('naver', 'threads')), target TEXT NOT NULL,
          scheduled_at TEXT, status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'running', 'published', 'needs_attention', 'uncertain', 'cancelled')),
          result_url TEXT NOT NULL, message TEXT NOT NULL, updated_at TEXT NOT NULL,
          product_snapshot TEXT NOT NULL, use_work_tabs INTEGER NOT NULL CHECK (use_work_tabs IN (0, 1))
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS browser_jobs_active_draft ON browser_jobs(draft_id) WHERE status IN ('approved', 'running', 'uncertain');
        CREATE UNIQUE INDEX IF NOT EXISTS browser_jobs_published_version ON browser_jobs(draft_id, version) WHERE status = 'published';
        CREATE TABLE IF NOT EXISTS aside_sessions (
          job_id TEXT PRIMARY KEY REFERENCES browser_jobs(id), session_id TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS browser_preferences (
          id INTEGER PRIMARY KEY CHECK (id = 1), naver_blog_id TEXT NOT NULL, threads_handle TEXT NOT NULL,
          tone TEXT NOT NULL, use_work_tabs INTEGER NOT NULL CHECK (use_work_tabs IN (0, 1)),
          paused INTEGER NOT NULL CHECK (paused IN (0, 1))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL
        ) STRICT;
      `);
      this.db.prepare('INSERT OR IGNORE INTO browser_preferences VALUES (1, ?, ?, ?, 1, 0)').run('', '', '친근하고 자연스러운 해요체로 소개해요. 짧은 문단에 상품 구성과 가격을 쉽게 전달하고, 도입과 마무리는 상품마다 다양하게 써요. 단가 계산은 늘어놓지 않고 필요한 확인사항만 짧게 덧붙여요. 직접 써 본 듯한 후기·검증되지 않은 효능·거짓 긴급성은 만들지 않아요.');
      this.atomic(() => {
        const jobs = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM browser_jobs WHERE status = 'running' OR (status = 'approved' AND scheduled_at IS NOT NULL AND scheduled_at <= ?)`).all(new Date().toISOString()) as unknown as Job[];
        for (const job of jobs) {
          if (job.status === 'running') this.transition(job.id, 'uncertain', '앱이 종료되어 게시 결과를 확인할 수 없습니다. 실제 게시 여부를 확인하세요.', '', '중단된 실행을 결과 불명확 상태로 복구했습니다.');
          else this.transition(job.id, 'needs_attention', '예약 시각이 지났습니다. 확인 후 다시 승인하세요.', '', '지난 예약의 자동 실행을 차단했습니다.');
        }
      });
    } catch {
      try { database?.close(); } catch { /* Preserve the opening or recovery failure. */ }
      throw new Error('저장소를 열거나 복구하지 못했습니다. 저장 경로와 다른 실행 중인 앱을 확인하세요.');
    }
  }

  private atomic<T>(operation: () => T): T {
    this.assertOpen();
    try { this.db.exec('BEGIN IMMEDIATE'); } catch { throw new Error('저장소를 사용할 수 없습니다. 다른 작업이 끝난 후 다시 시도하세요.'); }
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('ERR_SQLITE')) throw new Error('저장소 작업을 완료하지 못했습니다. 입력값과 저장 공간을 확인하세요.');
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('이미 닫힌 저장소입니다.');
  }

  private product(id: string): Product {
    const row = this.db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`).get(id) as unknown as ProductRow | undefined;
    if (!row) throw new Error('상품을 찾을 수 없습니다.');
    return { ...row, soldOut: row.soldOut === 1 };
  }

  private draft(id: string): Draft {
    const row = this.db.prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ?`).get(id) as unknown as Draft | undefined;
    if (!row) throw new Error('초안을 찾을 수 없습니다.');
    return row;
  }

  private job(id: string): JobRow {
    const row = this.db.prepare(`SELECT ${JOB_COLUMNS}, product_snapshot AS productSnapshot, use_work_tabs AS useWorkTabs FROM browser_jobs WHERE id = ?`).get(id) as unknown as JobRow | undefined;
    if (!row) throw new Error('작업을 찾을 수 없습니다.');
    return row;
  }

  private publicJob(id: string): Job {
    const row = this.db.prepare(`SELECT ${JOB_COLUMNS} FROM browser_jobs WHERE id = ?`).get(id) as unknown as Job | undefined;
    if (!row) throw new Error('작업을 찾을 수 없습니다.');
    return row;
  }

  private settings(): Settings {
    const row = this.db.prepare('SELECT naver_blog_id AS naverBlogId, threads_handle AS threadsHandle, tone, use_work_tabs AS useWorkTabs FROM browser_preferences WHERE id = 1').get() as unknown as Omit<Settings, 'useWorkTabs'> & { useWorkTabs: number };
    return { ...row, useWorkTabs: row.useWorkTabs === 1 };
  }

  private event(jobId: string, message: string): void {
    this.db.prepare('INSERT INTO events (job_id, message, at) VALUES (?, ?, ?)').run(jobId, message, new Date().toISOString());
  }

  recordScanResult(saved: number, skipped: number, failure?: 'identity' | 'price' | 'sleeping' | 'connection' | 'other'): void {
    if (![saved, skipped].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('수집 기록의 건수가 올바르지 않습니다.');
    const reasons = {
      identity: '상품명 또는 ID를 명확하게 식별하지 못했습니다.',
      price: '현재 판매 가격을 명확하게 확인하지 못했습니다.',
      sleeping: '대상 탭을 직접 깨우고 로딩 완료 후 다시 시도하세요.',
      connection: '로그인·권한 또는 연결 상태를 확인하세요.',
      other: '수집 화면 또는 연결 오류가 발생했습니다.',
    };
    if (failure !== undefined && !Object.hasOwn(reasons, failure)) throw new Error('수집 기록의 오류 유형이 올바르지 않습니다.');
    this.event('', failure
      ? `상품 수집 오류 · 저장 ${saved}개 · ${reasons[failure]} 이전에 확인한 상품은 보존했습니다.`
      : `상품 수집 완료 · 저장 ${saved}개 · 목록에서 사라져 건너뛴 상품 ${skipped}개`);
  }

  private transition(id: string, status: JobStatus, message: string, url: string, event: string): void {
    this.db.prepare('UPDATE browser_jobs SET status = ?, message = ?, result_url = ?, updated_at = ? WHERE id = ?').run(status, message, url, new Date().toISOString(), id);
    this.event(id, event);
  }

  private invalidate(ids: string[], message: string): void {
    for (const id of ids) this.transition(id, 'needs_attention', message, '', '승인 조건 변경으로 재검토가 필요합니다.');
  }

  state(): AppState {
    return this.atomic(() => ({
      products: (this.db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products ORDER BY rowid`).all() as unknown as ProductRow[]).map(row => ({ ...row, soldOut: row.soldOut === 1 })),
      drafts: this.db.prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts ORDER BY rowid`).all() as unknown as Draft[],
      jobs: this.db.prepare(`SELECT ${JOB_COLUMNS} FROM browser_jobs ORDER BY rowid DESC`).all() as unknown as Job[],
      settings: this.settings(),
      events: this.db.prepare('SELECT id, job_id AS jobId, message, at FROM events ORDER BY id DESC').all() as unknown as AppState['events'],
      paused: this.db.prepare('SELECT paused FROM browser_preferences WHERE id = 1').get()!.paused === 1,
    }));
  }

  saveProduct(input: Product): void {
    const product = validatedProduct(input);
    this.atomic(() => {
      const existing = this.db.prepare('SELECT id FROM products WHERE id = ?').get(product.id);
      const changed = existing && productSnapshot(this.product(product.id)) !== productSnapshot(product);
      this.db.prepare(`INSERT INTO products (id, name, source_url, price, sold_out, checked_at, facts, share_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, source_url = excluded.source_url, price = excluded.price, sold_out = excluded.sold_out, checked_at = excluded.checked_at, facts = excluded.facts, share_url = excluded.share_url`).run(product.id, product.name, product.sourceUrl, product.price, Number(product.soldOut), product.checkedAt, product.facts, product.shareUrl);
      if (changed) {
        const jobs = this.db.prepare("SELECT browser_jobs.id FROM browser_jobs JOIN drafts ON drafts.id = browser_jobs.draft_id WHERE drafts.product_id = ? AND browser_jobs.status = 'approved'").all(product.id);
        this.invalidate(jobs.map(row => String(row.id)), '상품 정보가 변경되었습니다. 상품과 원고를 다시 확인하고 승인하세요.');
      }
      this.event('', '상품 정보를 저장했습니다.');
    });
  }

  saveDraft(input: Draft): void {
    if (!input || typeof input !== 'object') throw new Error('초안 정보를 확인하세요.');
    const id = identifier(input.id, '초안 ID');
    const productId = identifier(input.productId, '상품 ID');
    if (input.channel !== 'naver' && input.channel !== 'threads') throw new Error('발행 채널을 확인하세요.');
    const title = text(input.title, '제목', 300);
    const body = text(input.body, '본문', 40000, false, true);
    if (!Number.isSafeInteger(input.version) || input.version < 0) throw new Error('초안 버전을 확인하세요.');
    timestamp(input.updatedAt, '초안 수정 시각');
    this.atomic(() => {
      this.product(productId);
      const existing = this.db.prepare(`SELECT ${DRAFT_COLUMNS} FROM drafts WHERE id = ?`).get(id) as unknown as Draft | undefined;
      if (existing && (existing.productId !== productId || existing.channel !== input.channel)) throw new Error('기존 초안의 상품과 채널은 변경할 수 없습니다. 새 초안을 만드세요.');
      if (this.db.prepare("SELECT id FROM browser_jobs WHERE draft_id = ? AND status = 'running'").get(id)) throw new Error('발행 중인 초안은 수정할 수 없습니다.');
      const version = (existing?.version ?? 0) + 1;
      if (!Number.isSafeInteger(version)) throw new Error('초안 버전 한도를 초과했습니다.');
      this.db.prepare(`INSERT INTO drafts (id, product_id, channel, title, body, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, version = excluded.version, updated_at = excluded.updated_at`).run(id, productId, input.channel, title, body, version, new Date().toISOString());
      const jobs = this.db.prepare("SELECT id FROM browser_jobs WHERE draft_id = ? AND status = 'approved'").all(id);
      this.invalidate(jobs.map(row => String(row.id)), '초안이 수정되었습니다. 최신 원고를 다시 승인하세요.');
      this.event('', '초안을 저장했습니다.');
    });
  }

  private validatePublication(draft: Draft, product: Product, settings: Settings): string {
    if (product.soldOut) throw new Error('품절 상품은 승인하거나 발행할 수 없습니다.');
    if (!product.shareUrl || !shareUrl(product.shareUrl)) throw new Error('상품 쉐어링크를 먼저 발급하고 확인하세요.');
    if (!draft.body.trim() || !draft.body.startsWith(DISCLOSURE) || !includesExactUrl(draft.body, product.shareUrl)) throw new Error('본문 첫머리에 광고 문구를 넣고 정확한 상품 쉐어링크를 포함하세요.');
    if (draft.channel === 'naver') {
      if (!draft.title.trim() || draft.title.length > 200 || /[\r\n]/.test(draft.title)) throw new Error('네이버 제목은 줄바꿈 없이 200자 이내여야 합니다.');
      if (!settings.naverBlogId || !BLOG_ID.test(settings.naverBlogId)) throw new Error('대상 네이버 블로그 ID를 설정하세요.');
      return settings.naverBlogId;
    }
    validateThreadsBody(draft.body, product.shareUrl);
    if (!settings.threadsHandle || !isThreadsHandle(settings.threadsHandle)) throw new Error('Threads 대상 계정 핸들을 설정하세요.');
    return settings.threadsHandle;
  }

  approve(draftId: string, scheduledAt: string | null): Job {
    identifier(draftId, '초안 ID');
    const schedule = scheduledAt === null ? null : timestamp(scheduledAt, '예약 시각');
    return this.atomic(() => {
      if (schedule !== null && Date.parse(schedule) <= Date.now()) throw new Error('예약 시각은 미래여야 합니다.');
      const draft = this.draft(draftId);
      const product = this.product(draft.productId);
      const settings = this.settings();
      const target = this.validatePublication(draft, product, settings);
      if (this.db.prepare("SELECT browser_jobs.id FROM browser_jobs JOIN drafts ON drafts.id = browser_jobs.draft_id WHERE drafts.product_id = ? AND browser_jobs.channel = ? AND browser_jobs.status IN ('running', 'uncertain')").get(draft.productId, draft.channel)) throw new Error('같은 상품과 채널의 진행 중이거나 결과가 불명확한 작업을 먼저 확인하세요. 자동 재시도하지 않습니다.');
      if (this.db.prepare("SELECT browser_jobs.id FROM browser_jobs JOIN drafts ON drafts.id = browser_jobs.draft_id WHERE drafts.product_id = ? AND browser_jobs.channel = ? AND browser_jobs.status = 'approved'").get(draft.productId, draft.channel)) throw new Error('같은 상품과 채널에 이미 승인된 작업이 있습니다.');
      if (this.db.prepare("SELECT id FROM browser_jobs WHERE draft_id = ? AND version = ? AND status = 'published'").get(draftId, draft.version)) throw new Error('이미 발행한 원고 버전은 다시 승인할 수 없습니다.');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO browser_jobs (id, draft_id, version, channel, target, scheduled_at, status, result_url, message, updated_at, product_snapshot, use_work_tabs)
        VALUES (?, ?, ?, ?, ?, ?, 'approved', '', ?, ?, ?, ?)`).run(id, draft.id, draft.version, draft.channel, target, schedule, '승인한 원고만 발행합니다.', new Date().toISOString(), productSnapshot(product), Number(settings.useWorkTabs));
      this.event(id, '원고 버전과 발행 대상을 승인했습니다.');
      return this.publicJob(id);
    });
  }

  claim(jobId: string): Job {
    identifier(jobId, '작업 ID');
    const result = this.atomic((): Job | string => {
      const job = this.job(jobId);
      if (job.status !== 'approved') throw new Error('승인 대기 중인 작업만 실행할 수 있습니다.');
      if (this.db.prepare('SELECT paused FROM browser_preferences WHERE id = 1').get()!.paused === 1) throw new Error('자동 실행이 일시 중지되어 있습니다.');
      const now = Date.now();
      if (job.scheduledAt && Date.parse(job.scheduledAt) > now) throw new Error('아직 예약 시각이 되지 않았습니다.');
      const draft = this.draft(job.draftId);
      const product = this.product(draft.productId);
      const settings = this.settings();
      const checkedAt = Date.parse(product.checkedAt);
      let reason = '';
      if (job.version !== draft.version || job.channel !== draft.channel || job.productSnapshot !== productSnapshot(product)) reason = '승인한 원고 또는 상품 정보가 변경되었습니다. 다시 확인하고 승인하세요.';
      else if (!Number.isFinite(checkedAt) || now - checkedAt > DAY || checkedAt > now) reason = '상품 확인 후 24시간이 지났거나 확인 시각이 잘못되었습니다. 다시 확인하고 승인하세요.';
      else {
        try {
          const target = this.validatePublication(draft, product, settings);
          if (job.target !== target || job.useWorkTabs !== Number(settings.useWorkTabs)) reason = '승인한 발행 대상 또는 작업 탭 설정이 변경되었습니다. 다시 승인하세요.';
        } catch (error) { reason = error instanceof Error ? error.message : '발행 조건을 다시 확인하세요.'; }
      }
      if (reason) {
        this.transition(jobId, 'needs_attention', reason, '', '실행 전 검증에 실패하여 자동 실행을 차단했습니다.');
        return reason;
      }
      const changed = this.db.prepare("UPDATE browser_jobs SET status = 'running', message = ?, updated_at = ? WHERE id = ? AND status = 'approved'").run('발행을 실행 중입니다. 자동 재시도하지 않습니다.', new Date().toISOString(), jobId);
      if (changed.changes !== 1) throw new Error('다른 작업이 이미 실행을 시작했습니다.');
      this.event(jobId, '승인 작업의 실행을 시작했습니다.');
      return this.publicJob(jobId);
    });
    if (typeof result === 'string') throw new Error(result);
    return result;
  }

  bindAsideSession(jobId: string, sessionId: string): void {
    identifier(jobId, '작업 ID');
    text(sessionId, 'Aside 작업 ID', 128, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new Error('Aside 작업 ID 형식을 확인하세요.');
    this.atomic(() => {
      const job = this.job(jobId);
      if (job.status !== 'running') throw new Error('실행 중인 작업에만 Aside 작업을 연결할 수 있습니다.');
      if (job.asideSessionId) {
        if (job.asideSessionId !== sessionId) throw new Error('이미 연결한 Aside 작업 ID는 변경할 수 없습니다.');
        return;
      }
      this.db.prepare('INSERT INTO aside_sessions (job_id, session_id) VALUES (?, ?)').run(jobId, sessionId);
      this.event(jobId, 'Aside 작업을 연결했습니다. 결과 확인 시 같은 작업을 사용합니다.');
    });
  }

  finish(jobId: string, status: JobStatus, message: string, url?: string): void {
    identifier(jobId, '작업 ID');
    const safeMessage = text(message, '결과 메시지', 1000, true, true);
    if (status !== 'published' && status !== 'uncertain' && status !== 'needs_attention') throw new Error('허용되지 않는 실행 결과 상태입니다.');
    this.atomic(() => {
      const job = this.job(jobId);
      if (job.status !== 'running') throw new Error('실행 중인 작업만 완료 처리할 수 있습니다.');
      const publicUrl = status === 'published' ? resultUrl(url, job.channel, job.target) : '';
      if (status !== 'published' && url !== undefined && url !== '') throw new Error('게시 완료를 확인한 작업에만 게시 주소를 저장할 수 있습니다.');
      const event = status === 'published' ? '공개 게시 주소를 확인하여 발행 완료로 기록했습니다.' : status === 'uncertain' ? '게시 결과가 불명확하여 수동 확인이 필요합니다.' : '실행을 중단하여 재검토가 필요합니다.';
      this.transition(jobId, status, safeMessage, publicUrl, event);
    });
  }

  defer(jobId: string, message: string): void {
    identifier(jobId, '작업 ID');
    const safeMessage = text(message, '중단 사유', 1000, true, true);
    this.atomic(() => {
      if (this.job(jobId).status !== 'approved') throw new Error('승인 대기 중인 작업만 보류할 수 있습니다.');
      this.transition(jobId, 'needs_attention', safeMessage, '', '예약 또는 실행 조건 확인을 위해 작업을 보류했습니다.');
    });
  }

  cancel(jobId: string): void {
    identifier(jobId, '작업 ID');
    this.atomic(() => {
      const job = this.job(jobId);
      if (!['draft', 'approved', 'needs_attention'].includes(job.status)) throw new Error('실행 중이거나 결과가 불명확하거나 완료된 작업은 취소할 수 없습니다. 실제 게시 여부를 확인하세요.');
      this.transition(jobId, 'cancelled', '사용자가 작업을 취소했습니다.', '', '실행 전 작업을 취소했습니다.');
    });
  }

  reconcile(jobId: string, url: string): void {
    identifier(jobId, '작업 ID');
    this.atomic(() => {
      const job = this.job(jobId);
      if (job.status !== 'uncertain') throw new Error('게시 결과가 불명확한 작업만 수동 확인할 수 있습니다.');
      const publicUrl = resultUrl(url, job.channel, job.target);
      this.transition(jobId, 'published', '사용자가 공개 게시 주소를 확인했습니다.', publicUrl, '공개 게시 주소를 수동 확인하여 발행 완료로 기록했습니다.');
    });
  }

  confirmNotPublished(jobId: string): void {
    identifier(jobId, '작업 ID');
    this.atomic(() => {
      if (this.job(jobId).status !== 'uncertain') throw new Error('게시 결과가 불명확한 작업만 미게시를 확인할 수 있습니다.');
      const message = '사용자가 대상 채널에서 미게시를 확인했습니다. 재발행은 별도 승인이 필요합니다.';
      this.transition(jobId, 'cancelled', message, '', message);
    });
  }

  saveSettings(input: Settings): void {
    const settings = validatedSettings(input);
    this.atomic(() => {
      const previous = this.settings();
      this.db.prepare('UPDATE browser_preferences SET naver_blog_id = ?, threads_handle = ?, tone = ?, use_work_tabs = ? WHERE id = 1').run(settings.naverBlogId, settings.threadsHandle, settings.tone, Number(settings.useWorkTabs));
      const channels: Channel[] = [];
      if (previous.naverBlogId !== settings.naverBlogId || previous.useWorkTabs !== settings.useWorkTabs) channels.push('naver');
      if (previous.threadsHandle !== settings.threadsHandle || previous.useWorkTabs !== settings.useWorkTabs) channels.push('threads');
      for (const channel of channels) {
        const jobs = this.db.prepare("SELECT id FROM browser_jobs WHERE channel = ? AND status = 'approved'").all(channel);
        this.invalidate(jobs.map(row => String(row.id)), '발행 대상 또는 작업 탭 설정이 변경되었습니다. 다시 승인하세요.');
      }
      this.event('', '설정을 저장했습니다.');
    });
  }

  setPaused(paused: boolean): void {
    boolean(paused, '일시 중지 여부');
    this.atomic(() => {
      this.db.prepare('UPDATE browser_preferences SET paused = ? WHERE id = 1').run(Number(paused));
      this.event('', paused ? '이후 작업의 자동 실행을 일시 중지했습니다.' : '이후 작업의 자동 실행을 재개했습니다.');
    });
  }

  close(): void {
    if (this.closed) return;
    try { this.db.close(); } catch { throw new Error('저장소를 닫지 못했습니다.'); }
    this.closed = true;
  }
}
