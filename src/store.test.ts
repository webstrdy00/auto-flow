import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { DISCLOSURE, type Channel, type Draft, type JobStatus, type Product, type Settings } from './shared.js';
import { Store } from './store.js';

const NOW = Date.parse('2026-06-10T03:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const settings: Settings = {
  naverBlogId: 'my_blog', threadsHandle: 'person',
  tone: '확인한 사실만 작성합니다.', useWorkTabs: true,
};

function clock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
}

function memory(t: TestContext): Store {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}

function disk(t: TestContext, initialize?: (path: string) => void): { store: Store; path: string; open: () => Store } {
  const directory = mkdtempSync(join(tmpdir(), 'auto-flow-store-'));
  const path = join(directory, 'state.sqlite');
  initialize?.(path);
  const stores: Store[] = [];
  const open = () => {
    const store = new Store(path);
    stores.push(store);
    return store;
  };
  const store = open();
  t.after(() => { for (const instance of stores) instance.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, open };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: '123', name: '확인한 상품', sourceUrl: 'https://sharelink.toss.im/links/products/123',
    price: '12,000원', soldOut: false, checkedAt: new Date().toISOString(),
    facts: '판매 페이지에서 확인한 사실입니다.', shareUrl: 'https://toss.im/example-link', ...overrides,
  };
}

function draft(channel: Channel = 'naver', overrides: Partial<Draft> = {}): Draft {
  return {
    id: `draft-${channel}`, productId: '123', channel, title: channel === 'naver' ? '확인한 상품 소개' : '',
    body: `${DISCLOSURE}\n확인한 상품입니다.\nhttps://toss.im/example-link`,
    version: 0, updatedAt: new Date().toISOString(), ...overrides,
  };
}

function seed(store: Store, channel: Channel = 'naver'): void {
  store.saveSettings(settings);
  store.saveProduct(product());
  store.saveDraft(draft(channel));
}

function status(store: Store, jobId: string): JobStatus {
  return store.state().jobs.find(job => job.id === jobId)!.status;
}

test('fresh browser storage has no legacy API metadata and requires explicit account approval', t => {
  clock(t);
  const { store, path } = disk(t);
  const external = new DatabaseSync(path);
  try {
    const tables = external.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    assert.ok(!tables.includes('settings'));
    assert.ok(!tables.includes('jobs'));
    for (const table of ['browser_preferences', 'browser_jobs', 'aside_sessions']) {
      assert.ok(tables.includes(table));
      const columns = external.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
      assert.ok(columns.every(column => !/token|secret|ai_key|ai_model|threads_user_id/.test(column)));
    }
  } finally { external.close(); }
  store.saveProduct(product());
  store.saveDraft(draft());
  store.saveDraft(draft('threads'));
  assert.throws(() => store.approve('draft-naver', null), /블로그/);
  assert.throws(() => store.approveThreadsDraft('draft-threads'), /핸들/);
  assert.equal(store.state().settings.naverBlogId, '');
  assert.equal(store.state().settings.threadsHandle, '');
  assert.equal(store.state().settings.useWorkTabs, true);
  assert.match(store.state().settings.tone, /다양하게/);
  assert.match(store.state().settings.tone, /후기.*만들지/);
  assert.match(store.state().settings.tone, /확인사항.*짧게/);
});

test('legacy settings and jobs remain untouched and unimported while products, drafts, and events survive', t => {
  clock(t);
  let legacySettings: unknown;
  let legacyJobs: unknown;
  const savedProduct = product();
  const savedDraft = draft('naver', { version: 1 });
  const { store, path, open } = disk(t, path => {
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        CREATE TABLE products (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, source_url TEXT NOT NULL, price TEXT NOT NULL,
          sold_out INTEGER NOT NULL, checked_at TEXT NOT NULL, facts TEXT NOT NULL, share_url TEXT NOT NULL
        ) STRICT;
        CREATE TABLE drafts (
          id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), channel TEXT NOT NULL,
          title TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id), version INTEGER NOT NULL,
          channel TEXT NOT NULL, target TEXT NOT NULL, scheduled_at TEXT, status TEXT NOT NULL,
          result_url TEXT NOT NULL, message TEXT NOT NULL, updated_at TEXT NOT NULL,
          product_snapshot TEXT NOT NULL, token_present INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY, naver_blog_id TEXT NOT NULL, threads_user_id TEXT NOT NULL,
          ai_model TEXT NOT NULL, tone TEXT NOT NULL, has_ai_key INTEGER NOT NULL,
          has_threads_token INTEGER NOT NULL, paused INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL
        ) STRICT;
        INSERT INTO settings VALUES (1, 'legacy_blog', '123456789012345', 'legacy-model', '기존 문체', 1, 1, 1);
      `);
      legacy.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(savedProduct.id, savedProduct.name, savedProduct.sourceUrl, savedProduct.price, 0, savedProduct.checkedAt, savedProduct.facts, savedProduct.shareUrl);
      legacy.prepare('INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?)').run(savedDraft.id, savedDraft.productId, savedDraft.channel, savedDraft.title, savedDraft.body, savedDraft.version, savedDraft.updatedAt);
      legacy.prepare("INSERT INTO jobs VALUES ('legacy-running', ?, 1, 'naver', 'legacy_blog', NULL, 'running', '', '기존 실행 정보', ?, '기존 스냅샷', 1)").run(savedDraft.id, new Date().toISOString());
      legacy.prepare("INSERT INTO events (job_id, message, at) VALUES ('legacy-running', '기존 기록', ?)").run(new Date().toISOString());
      legacySettings = legacy.prepare('SELECT * FROM settings').all();
      legacyJobs = legacy.prepare('SELECT * FROM jobs').all();
    } finally { legacy.close(); }
  });
  const state = store.state();
  assert.deepEqual(state.products, [savedProduct]);
  assert.deepEqual(state.drafts.map(row => ({ ...row })), [savedDraft]);
  assert.deepEqual(state.jobs, []);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0]!.message, '기존 기록');
  assert.equal(state.settings.naverBlogId, '');
  assert.equal(state.settings.threadsHandle, '');
  assert.equal(state.paused, false);
  assert.throws(() => store.approve(savedDraft.id, null), /블로그/);
  assert.throws(() => store.claim('legacy-running'), /찾을 수 없습니다/);
  store.saveSettings(settings);
  const fresh = store.approve(savedDraft.id, null);
  assert.notEqual(fresh.id, 'legacy-running');
  assert.equal(fresh.status, 'approved');
  assert.equal(fresh.asideSessionId, '');
  store.close();
  const reopened = open();
  assert.equal(status(reopened, fresh.id), 'approved');
  const external = new DatabaseSync(path);
  try {
    assert.deepEqual(external.prepare('SELECT * FROM settings').all(), legacySettings);
    assert.deepEqual(external.prepare('SELECT * FROM jobs').all(), legacyJobs);
    assert.equal(external.prepare('SELECT count(*) AS count FROM browser_jobs').get()!.count, 1);
    assert.equal(external.prepare('SELECT count(*) AS count FROM aside_sessions').get()!.count, 0);
  } finally { external.close(); }
});

test('approval requires visible leading disclosure and a supported single-line title', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  const original = store.state().drafts[0]!;
  store.saveDraft({ ...original, body: `상품 소개\n${original.body}` });
  assert.throws(() => store.approve(original.id, null), /첫머리/);
  store.saveDraft({ ...store.state().drafts[0]!, body: original.body, title: 'x'.repeat(201) });
  assert.throws(() => store.approve(original.id, null), /200자/);
});

test('Threads approval rejects punctuation and additional links before any publication', t => {
  clock(t);
  const store = memory(t);
  seed(store, 'threads');
  const original = store.state().drafts[0]!;
  for (const suffix of ['.', ')', '\nhttps://toss.im/another']) {
    const current = store.state().drafts[0]!;
    store.saveDraft({ ...current, body: original.body + suffix });
    assert.throws(() => store.approveThreadsDraft(original.id), /쉐어링크/);
  }
  store.saveDraft({ ...store.state().drafts[0]!, body: original.body });
  assert.equal(store.approveThreadsDraft(original.id).status, 'approved');
});

test('product fields are validated before any stored data is replaced', t => {
  clock(t);
  const store = memory(t);
  store.saveProduct(product());
  const original = store.state();
  const invalid: Partial<Product>[] = [
    { id: '123\n' }, { id: 'abc' }, { id: '0' }, { name: ' ' }, { name: 'x'.repeat(501) },
    { sourceUrl: 'http://sharelink.toss.im/links/products/123' },
    { sourceUrl: 'https://sharelink.toss.im.evil.test/links/products/123' },
    { sourceUrl: 'https://sharelink.toss.im/links/products/456' },
    { sourceUrl: 'https://sharelink.toss.im/links/products/not-numeric' },
    { sourceUrl: 'https://sharelink.toss.im/products/123' },
    { sourceUrl: 'https://user:password@sharelink.toss.im/links/products/123' },
    { sourceUrl: 'https://sharelink.toss.im:8443/links/products/123' },
    { sourceUrl: 'https://sharelink.toss.im/links/products/123#private' },
    { shareUrl: 'https://toss.im.evil.test/link' }, { shareUrl: 'http://toss.im/link' },
    { shareUrl: 'https://evil-toss.im/link' }, { shareUrl: 'https://user:password@toss.im/link' },
    { shareUrl: 'https://toss.im/' }, { shareUrl: 'https://toss.im/link\n' },
    { shareUrl: 'https://toss.im\\@evil.test/link' }, { shareUrl: 'https:toss.im/link' },
    { price: 12000 as unknown as string }, { price: 'x'.repeat(101) },
    { soldOut: 0 as unknown as boolean }, { facts: 'x\u0000y' }, { facts: '\uD800' },
    { facts: 'x'.repeat(12001) }, { checkedAt: 'not-a-date' },
    { checkedAt: '2026-06-10T03:00:00' }, { checkedAt: '2026-02-30T03:00:00Z' },
    { checkedAt: '2026-06-10T25:00:00Z' }, { checkedAt: '2026-06-10T03:00:00+14:01' },
    { checkedAt: new Date(NOW + 1).toISOString() },
  ];
  for (const patch of invalid) {
    assert.throws(() => store.saveProduct(product(patch)), /[가-힣]/);
    assert.deepEqual(store.state(), original);
  }
});

test('observed Toss Shopping links are preserved and approved on both channels', t => {
  clock(t);
  const store = memory(t);
  store.saveProduct(product({
    sourceUrl: 'https://sharelink.toss.im/links/products/123/?originSurface=home&originSectionCode=best',
    shareUrl: 'https://toss.shopping/_m/Example_123', checkedAt: '2026-06-10T12:00:00+09:00',
  }));
  const saved = store.state().products[0]!;
  assert.equal(saved.sourceUrl, 'https://sharelink.toss.im/links/products/123');
  assert.equal(saved.shareUrl, 'https://toss.shopping/_m/Example_123');
  assert.equal(saved.checkedAt, new Date(NOW).toISOString());
  store.saveSettings(settings);
  store.saveDraft(draft('naver', { body: `${DISCLOSURE}\n${saved.shareUrl}` }));
  assert.equal(store.approve('draft-naver', null).status, 'approved');
  store.saveDraft(draft('threads', { body: `${DISCLOSURE}\n${saved.shareUrl}` }));
  assert.equal(store.approveThreadsDraft('draft-threads').status, 'approved');
  assert.throws(() => store.saveProduct(product({ shareUrl: 'https://shop.toss.im/shared-item' })));
});

test('draft revisions and timestamps come from the store and running revisions cannot be edited', t => {
  clock(t);
  const store = memory(t);
  store.saveSettings(settings);
  store.saveProduct(product());
  store.saveDraft(draft('naver', { version: 999, updatedAt: '2020-01-01T00:00:00Z' }));
  assert.equal(store.state().drafts[0]!.version, 1);
  assert.equal(store.state().drafts[0]!.updatedAt, new Date(NOW).toISOString());
  const approved = store.approve('draft-naver', null);
  store.saveDraft(draft('naver', { version: 0, title: '수정한 제목' }));
  assert.equal(store.state().drafts[0]!.version, 2);
  assert.equal(status(store, approved.id), 'needs_attention');
  assert.throws(() => store.claim(approved.id), /승인/);
  const next = store.approve('draft-naver', null);
  store.claim(next.id);
  const before = store.state();
  assert.throws(() => store.saveDraft(draft()), /발행 중/);
  assert.deepEqual(store.state(), before);
});

test('invalid draft fields and identity changes are rejected without invalidating approvals', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  const approved = store.approve('draft-naver', null);
  const invalid: Partial<Draft>[] = [
    { id: '' }, { productId: 'missing' }, { channel: 'other' as Channel },
    { title: 'x'.repeat(301) }, { title: '한 줄\n두 줄' },
    { body: 'x'.repeat(40001) }, { body: '본문\u0000' },
    { version: NaN }, { version: Infinity }, { version: 1.5 }, { version: -1 },
    { updatedAt: '2026-02-30T00:00:00Z' }, { channel: 'threads' },
  ];
  for (const patch of invalid) assert.throws(() => store.saveDraft(draft('naver', patch)), /[가-힣]/);
  assert.equal(store.state().drafts[0]!.version, 1);
  assert.equal(status(store, approved.id), 'approved');
});

test('approval requires disclosure, an exact share link, title, availability, and a configured target', t => {
  clock(t);
  const invalidBodies = [
    '', '본문만 있습니다.', 'https://toss.im/example-link',
    `${DISCLOSURE}\nhttps://toss.im/example-link-evil`,
    `${DISCLOSURE}\nhttps://toss.im/example-link?other=1`,
    `${DISCLOSURE}\nhttps://evil.test/?redirect=https://toss.im/example-link`,
  ];
  for (const body of invalidBodies) {
    const store = memory(t);
    seed(store);
    store.saveDraft(draft('naver', { body }));
    assert.throws(() => store.approve('draft-naver', null), /본문/);
    assert.equal(store.state().jobs.length, 0);
  }
  const store = memory(t);
  seed(store);
  store.saveDraft(draft('naver', { title: ' ' }));
  assert.throws(() => store.approve('draft-naver', null), /제목/);
  store.saveDraft(draft());
  store.saveProduct(product({ soldOut: true }));
  assert.throws(() => store.approve('draft-naver', null), /품절/);
  store.saveProduct(product({ shareUrl: '' }));
  assert.throws(() => store.approve('draft-naver', null), /쉐어링크/);
  store.saveProduct(product());
  store.saveSettings({ ...settings, naverBlogId: '' });
  assert.throws(() => store.approve('draft-naver', null), /블로그/);
  store.saveSettings(settings);
  store.saveDraft(draft('naver', { body: `${DISCLOSURE}\n[상품 링크](https://toss.im/example-link)` }));
  assert.equal(store.approve('draft-naver', null).status, 'approved');
});

test('Threads uses Unicode code points, allows an empty title, and requires its exact account handle without tokens', t => {
  clock(t);
  const store = memory(t);
  seed(store, 'threads');
  const prefix = `${DISCLOSURE}\nhttps://toss.im/example-link\n`;
  const body = prefix + '😀'.repeat(500 - Array.from(prefix).length);
  store.saveDraft(draft('threads', { body }));
  const approved = store.approveThreadsDraft('draft-threads');
  store.cancel(approved.id);
  store.saveDraft(draft('threads', { body: `${body}😀` }));
  assert.throws(() => store.approveThreadsDraft('draft-threads'), /500/);
  store.saveDraft(draft('threads', { body }));
  store.saveSettings({ ...settings, threadsHandle: '' });
  assert.throws(() => store.approveThreadsDraft('draft-threads'), /핸들/);
  store.saveSettings({ ...settings, threadsHandle: '@person', useWorkTabs: false });
  const next = store.approveThreadsDraft('draft-threads');
  assert.equal(next.target, 'person');
  assert.equal(store.claim(next.id).status, 'running');
});

test('product fact changes invalidate approvals but a checkedAt-only refresh does not', t => {
  clock(t);
  const patches: Partial<Product>[] = [
    { name: '다른 표시 상품명' }, { price: '13,000원' }, { facts: '갱신한 사실' },
    { soldOut: true }, { shareUrl: 'https://toss.im/another-link' },
  ];
  for (const patch of patches) {
    const store = memory(t);
    seed(store);
    const approved = store.approve('draft-naver', null);
    store.saveProduct(product(patch));
    assert.equal(status(store, approved.id), 'needs_attention');
    assert.throws(() => store.claim(approved.id), /승인/);
  }
  const store = memory(t);
  seed(store);
  const approved = store.approve('draft-naver', null);
  t.mock.timers.setTime(NOW + 1000);
  store.saveProduct(product());
  assert.equal(status(store, approved.id), 'approved');
  assert.equal(store.claim(approved.id).status, 'running');
});

test('target changes invalidate only relevant approvals and tone changes preserve them', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  store.saveDraft(draft('threads'));
  const naver = store.approve('draft-naver', null);
  const threads = store.approveThreadsDraft('draft-threads');
  const edited = { ...settings, tone: '다른 문체' };
  store.saveSettings(edited);
  assert.equal(status(store, naver.id), 'approved');
  assert.equal(status(store, threads.id), 'approved');
  store.saveSettings({ ...edited, naverBlogId: 'other_blog' });
  assert.equal(status(store, naver.id), 'needs_attention');
  assert.equal(status(store, threads.id), 'approved');
  store.saveSettings({ ...edited, naverBlogId: 'other_blog', threadsHandle: 'another.person' });
  assert.equal(status(store, threads.id), 'needs_attention');
});

test('work-tab changes invalidate approvals on both channels and require fresh approval', t => {
  clock(t);
  for (const useWorkTabs of [true, false]) {
    const store = memory(t);
    seed(store);
    store.saveSettings({ ...settings, useWorkTabs });
    store.saveDraft(draft('threads'));
    const jobs = [store.approve('draft-naver', null), store.approveThreadsDraft('draft-threads')];
    store.saveSettings({ ...settings, useWorkTabs: !useWorkTabs });
    for (const job of jobs) {
      assert.equal(status(store, job.id), 'needs_attention');
      assert.throws(() => store.claim(job.id), /승인/);
    }
    assert.equal(store.claim(store.approveThreadsDraft('draft-threads').id).status, 'running');
  }
});

test('settings reject invalid identifiers, non-boolean work-tab choices, and unsafe strings', t => {
  clock(t);
  const store = memory(t);
  store.saveSettings(settings);
  const invalid: Partial<Settings>[] = [
    { naverBlogId: '_leading' }, { naverBlogId: 'blog/name' }, { naverBlogId: 'x'.repeat(51) },
    { threadsHandle: '@' }, { threadsHandle: '@@handle' }, { threadsHandle: '한글' }, { threadsHandle: 'handle-name' },
    { threadsHandle: '1'.repeat(31) }, { threadsHandle: '.person' }, { threadsHandle: 'person.' },
    { threadsHandle: 'per..son' }, { threadsHandle: 'person/name' }, { threadsHandle: 'person\n' },
    { tone: 'x\u0000' }, { tone: 'x'.repeat(2001) },
    { useWorkTabs: 'yes' as unknown as boolean }, { useWorkTabs: 1 as unknown as boolean },
  ];
  for (const patch of invalid) {
    assert.throws(() => store.saveSettings({ ...settings, ...patch }), /[가-힣]/);
    assert.deepEqual(store.state().settings, settings);
  }
});

test('settings normalize a single optional @ and preserve ordinary numeric handles without guessing identity', t => {
  clock(t);
  const store = memory(t);
  seed(store, 'threads');
  for (const threadsHandle of ['@person', 'person.name_1', '_person', '12345', '1.5', '0', `@${'a'.repeat(30)}`]) {
    store.saveSettings({ ...settings, threadsHandle });
    const expected = threadsHandle.replace(/^@/, '');
    assert.equal(store.state().settings.threadsHandle, expected);
    const approved = store.approveThreadsDraft('draft-threads');
    assert.equal(approved.target, expected);
    store.cancel(approved.id);
  }
});

test('duplicate active approvals and published versions cannot be retried', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  const approved = store.approve('draft-naver', null);
  assert.throws(() => store.approve('draft-naver', null), /이미 승인/);
  store.claim(approved.id);
  assert.throws(() => store.approve('draft-naver', null), /진행 중/);
  assert.throws(() => store.cancel(approved.id), /취소할 수 없습니다/);
  store.finish(approved.id, 'published', '확인했습니다.', 'https://blog.naver.com/my_blog/987');
  assert.throws(() => store.approve('draft-naver', null), /이미 발행/);
  assert.throws(() => store.cancel(approved.id), /취소할 수 없습니다/);
  assert.throws(() => store.claim(approved.id), /승인/);
  store.saveDraft(draft('naver', { body: `${draft().body}\n검토 후 수정했습니다.` }));
  assert.equal(store.approve('draft-naver', null).version, 2);
});

test('new draft IDs cannot bypass an active approval for the same product and channel', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  store.saveDraft(draft('naver', { id: 'another-draft' }));
  store.saveDraft(draft('threads'));
  const original = store.approve('draft-naver', null);
  assert.throws(() => store.approve('another-draft', null), /이미 승인/);
  assert.equal(store.approveThreadsDraft('draft-threads').status, 'approved');
  store.claim(original.id);
  assert.throws(() => store.approve('another-draft', null), /진행 중/);
  store.finish(original.id, 'uncertain', '게시 여부를 확인해야 합니다.');
  store.saveDraft(draft('naver', { title: '새로 검토할 제목' }));
  assert.throws(() => store.approve('another-draft', null), /불명확/);
  store.confirmNotPublished(original.id);
  assert.equal(store.approve('another-draft', null).status, 'approved');
  assert.throws(() => store.approve('draft-naver', null), /이미 승인/);
});

test('stale product checks require renewed inspection at claim, with a 24-hour boundary', t => {
  clock(t);
  const fresh = memory(t);
  seed(fresh);
  fresh.saveProduct(product({ checkedAt: new Date(NOW - DAY).toISOString() }));
  assert.equal(fresh.claim(fresh.approve('draft-naver', null).id).status, 'running');
  const stale = memory(t);
  seed(stale);
  const approved = stale.approve('draft-naver', null);
  t.mock.timers.setTime(NOW + DAY + 1);
  assert.throws(() => stale.claim(approved.id), /24시간/);
  assert.equal(status(stale, approved.id), 'needs_attention');
  stale.saveProduct(product());
  assert.equal(stale.claim(stale.approve('draft-naver', null).id).status, 'running');
});

test('scheduled approval is future-only and a job cannot be claimed before its due time', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  for (const schedule of ['not-a-date', '2026-02-30T00:00:00Z', new Date(NOW).toISOString(), new Date(NOW - 1).toISOString()]) {
    assert.throws(() => store.approve('draft-naver', schedule), /날짜|시각/);
  }
  const approved = store.approve('draft-naver', '2026-06-10T12:01:00+09:00');
  assert.equal(approved.scheduledAt, new Date(NOW + 60000).toISOString());
  assert.throws(() => store.claim(approved.id), /예약 시각/);
  assert.equal(status(store, approved.id), 'approved');
  t.mock.timers.setTime(NOW + 60000);
  assert.equal(store.claim(approved.id).status, 'running');
});

test('pausing blocks later claims without cancelling or preventing completion of in-flight work', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  const job = store.approve('draft-naver', null);
  store.setPaused(true);
  assert.throws(() => store.claim(job.id), /일시 중지/);
  assert.equal(status(store, job.id), 'approved');
  assert.throws(() => store.setPaused('yes' as unknown as boolean), /확인/);
  store.setPaused(false);
  store.claim(job.id);
  store.setPaused(true);
  assert.equal(status(store, job.id), 'running');
  store.finish(job.id, 'published', '확인했습니다.', 'https://blog.naver.com/my_blog/987');
  assert.equal(status(store, job.id), 'published');
});

test('defer is approved-only and explicitly reviewed jobs can be reapproved or cancelled', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  const approved = store.approve('draft-naver', new Date(NOW + 1000).toISOString());
  t.mock.timers.setTime(NOW + 121001);
  store.defer(approved.id, '예약 시각이 지나 재검토가 필요합니다.');
  assert.equal(status(store, approved.id), 'needs_attention');
  assert.throws(() => store.defer(approved.id, '다시 보류'), /승인 대기/);
  assert.throws(() => store.claim(approved.id), /승인/);
  const next = store.approve('draft-naver', null);
  store.cancel(next.id);
  assert.equal(status(store, next.id), 'cancelled');
  const running = store.approve('draft-naver', null);
  store.claim(running.id);
  assert.throws(() => store.defer(running.id, '중단'), /승인 대기/);
  store.finish(running.id, 'needs_attention', '외부 게시 요청 전에 중단했습니다.');
  assert.equal(status(store, running.id), 'needs_attention');
  store.cancel(running.id);
  assert.equal(status(store, running.id), 'cancelled');
});

test('finish accepts only claimed outcomes and validates channel-specific public result addresses', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  const job = store.approve('draft-naver', null);
  assert.throws(() => store.finish(job.id, 'published', '확인', 'https://blog.naver.com/my_blog/987'), /실행 중/);
  store.claim(job.id);
  for (const invalid of ['approved', 'cancelled', 'draft', 'running'] as JobStatus[]) assert.throws(() => store.finish(job.id, invalid, '확인'), /상태/);
  for (const url of [undefined, 'https://blog.naver.com/other/987', 'https://blog.naver.com/my_blog', 'https://blog.naver.com/my_blog/not-numeric', 'https://threads.com/@person/post/abc', 'http://blog.naver.com/my_blog/987', 'https://blog.naver.com.evil.test/my_blog/987', 'https://user:password@blog.naver.com/my_blog/987', 'https://blog.naver.com/PostView.naver?blogId=my_blog&blogId=other&logNo=987']) {
    assert.throws(() => store.finish(job.id, 'published', '확인', url), /[가-힣]/);
    assert.equal(status(store, job.id), 'running');
  }
  assert.throws(() => store.finish(job.id, 'uncertain', '불명확', 'https://blog.naver.com/my_blog/987'), /게시 주소/);
  store.finish(job.id, 'published', '확인했습니다.', 'https://m.blog.naver.com/PostView.naver?blogId=my_blog&logNo=987&redirect=Dlog');
  assert.equal(store.state().jobs[0]!.resultUrl, 'https://blog.naver.com/my_blog/987');
  assert.throws(() => store.finish(job.id, 'uncertain', '다시 완료'), /실행 중/);
});

test('legacy uncertain results never retry and only a matching public URL reconciles them', t => {
  clock(t);
  const { store, path } = disk(t);
  seed(store, 'threads');
  const job = store.approveThreadsDraft('draft-threads');
  store.claim(job.id);
  const external = new DatabaseSync(path);
  try { external.prepare('DELETE FROM threads_draft_intents WHERE job_id = ?').run(job.id); } finally { external.close(); }
  store.finish(job.id, 'uncertain', '연결이 끊겨 실제 게시 여부를 확인해야 합니다.');
  assert.throws(() => store.claim(job.id), /승인/);
  assert.throws(() => store.cancel(job.id), /취소할 수 없습니다/);
  assert.throws(() => store.approveThreadsDraft('draft-threads'), /불명확/);
  store.saveDraft(draft('threads', { body: `${draft('threads').body}\n변경` }));
  assert.throws(() => store.approveThreadsDraft('draft-threads'), /불명확/);
  const invalid = [
    'https://blog.naver.com/my_blog/987', 'https://threads.com/@person',
    'https://threads.com/@person/post/', 'https://threads.com/@person/post/abc/extra',
    'https://threads.com.evil.test/@person/post/abc', 'http://threads.com/@person/post/abc',
    'https://www.threads.net/@person/post/abc?token=private',
    'https://threads.com/@other/post/abc', 'https://threads.com/@person.extra/post/abc',
    'https://threads.com/@Person/post/abc',
  ];
  for (const url of invalid) assert.throws(() => store.reconcile(job.id, url), /[가-힣]/);
  store.reconcile(job.id, 'https://www.threads.net/@person/post/Ab_c-123');
  assert.equal(status(store, job.id), 'published');
  assert.throws(() => store.reconcile(job.id, 'https://threads.com/@person/post/other'), /불명확/);
  const reviewedRevision = store.approveThreadsDraft('draft-threads');
  assert.equal(reviewedRevision.version, 2);
});

test('explicit confirmation of no publication resolves only uncertain jobs and requires a fresh approval', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  const job = store.approve('draft-naver', null);
  assert.throws(() => store.confirmNotPublished(job.id), /불명확/);
  store.claim(job.id);
  assert.throws(() => store.confirmNotPublished(job.id), /불명확/);
  store.finish(job.id, 'uncertain', '실제 게시 여부를 확인해야 합니다.');
  store.confirmNotPublished(job.id);
  assert.equal(status(store, job.id), 'cancelled');
  assert.equal(store.state().jobs.length, 1);
  assert.equal(store.state().events[0]!.message, '사용자가 대상 채널에서 미게시를 확인했습니다. 재발행은 별도 승인이 필요합니다.');
  assert.throws(() => store.claim(job.id), /승인/);
  assert.throws(() => store.confirmNotPublished(job.id), /불명확/);
  const approvedAgain = store.approve('draft-naver', null);
  assert.notEqual(approvedAgain.id, job.id);
  assert.equal(approvedAgain.status, 'approved');
  store.claim(approvedAgain.id);
  store.finish(approvedAgain.id, 'published', '게시를 확인했습니다.', 'https://blog.naver.com/my_blog/987');
  assert.throws(() => store.confirmNotPublished(approvedAgain.id), /불명확/);
  store.saveDraft(draft('naver', { title: '새 버전' }));
  const deferred = store.approve('draft-naver', null);
  store.defer(deferred.id, '재검토가 필요합니다.');
  assert.throws(() => store.confirmNotPublished(deferred.id), /불명확/);
});

test('a running job retains its approved target even when settings change', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  const job = store.approve('draft-naver', null);
  store.claim(job.id);
  store.saveSettings({ ...settings, naverBlogId: 'other_blog' });
  assert.equal(status(store, job.id), 'running');
  assert.throws(() => store.finish(job.id, 'published', '확인', 'https://blog.naver.com/other_blog/987'), /대상 블로그/);
  store.finish(job.id, 'published', '승인한 대상의 게시물을 확인했습니다.', 'https://blog.naver.com/my_blog/987');
  assert.equal(store.state().jobs[0]!.target, 'my_blog');
});

test('Threads completion is bound to the approved handle even after account and work-tab settings change', t => {
  clock(t);
  const store = memory(t);
  seed(store, 'threads');
  const job = store.approveThreadsDraft('draft-threads');
  store.claim(job.id);
  store.bindAsideSession(job.id, 'Draft_saved_session');
  store.markThreadsDraftSaved(job.id, 'visible');
  store.saveSettings({ ...settings, threadsHandle: 'other', useWorkTabs: false });
  for (const target of ['other', 'person.extra', 'Person']) {
    assert.throws(() => store.completeThreadsPublication(job.id, `https://threads.com/@${target}/post/abc`), /대상 Threads/);
    assert.equal(status(store, job.id), 'awaiting_publication');
  }
  store.completeThreadsPublication(job.id, 'https://www.threads.com/@person/post/abc');
  assert.equal(store.state().jobs[0]!.target, 'person');
  assert.equal(store.state().jobs[0]!.resultUrl, 'https://www.threads.com/@person/post/abc');
});

test('Aside sessions bind only once to running jobs and reject invalid IDs without overwriting state', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  const job = store.approve('draft-naver', null);
  assert.equal(job.asideSessionId, '');
  assert.throws(() => store.bindAsideSession(job.id, 'Session_123'), /실행 중/);
  assert.equal(store.claim(job.id).asideSessionId, '');
  for (const sessionId of ['', '_leading', 'with space', 'path/to/session', 'x\n', 'x'.repeat(129)]) {
    assert.throws(() => store.bindAsideSession(job.id, sessionId), /Aside 작업 ID/);
    assert.equal(store.state().jobs[0]!.asideSessionId, '');
  }
  store.bindAsideSession(job.id, 'Session_123');
  const bound = store.state();
  assert.equal(bound.jobs[0]!.asideSessionId, 'Session_123');
  store.bindAsideSession(job.id, 'Session_123');
  assert.deepEqual(store.state(), bound);
  assert.throws(() => store.bindAsideSession(job.id, 'Different_456'), /변경할 수 없습니다/);
  assert.deepEqual(store.state(), bound);
  store.finish(job.id, 'uncertain', '같은 Aside 작업의 결과를 확인하세요.');
  assert.throws(() => store.bindAsideSession(job.id, 'Different_456'), /실행 중/);
  assert.equal(store.state().jobs[0]!.asideSessionId, 'Session_123');
  store.reconcile(job.id, 'https://blog.naver.com/my_blog/987');
  assert.equal(store.state().jobs[0]!.asideSessionId, 'Session_123');
});

test('independent SQLite connections cannot replace the first bound Aside session', t => {
  clock(t);
  const { store, open } = disk(t);
  seed(store);
  const job = store.approve('draft-naver', null);
  const second = open();
  store.claim(job.id);
  store.bindAsideSession(job.id, 'First_session');
  second.bindAsideSession(job.id, 'First_session');
  assert.throws(() => second.bindAsideSession(job.id, 'Second_session'), /변경할 수 없습니다/);
  assert.equal(second.state().jobs[0]!.asideSessionId, 'First_session');
  assert.equal(store.state().jobs[0]!.asideSessionId, 'First_session');
});

test('independent SQLite connections competing for an approval claim it exactly once', async t => {
  clock(t);
  const { store, open } = disk(t);
  seed(store);
  const job = store.approve('draft-naver', null);
  const second = open();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => store.claim(job.id)),
    Promise.resolve().then(() => second.claim(job.id)),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(status(store, job.id), 'running');
  assert.equal(store.state().events.filter(event => event.jobId === job.id && event.message === '승인 작업의 실행을 시작했습니다.').length, 1);
});

test('claim independently checks saved revision, product facts, and target snapshots', t => {
  clock(t);
  for (const sql of [
    'UPDATE drafts SET version = version + 1',
    "UPDATE products SET price = '변경된 가격'",
    "UPDATE products SET sold_out = 1",
    "UPDATE browser_preferences SET naver_blog_id = 'other_blog'",
    'UPDATE browser_preferences SET use_work_tabs = 0',
  ]) {
    const { store, path } = disk(t);
    seed(store);
    const job = store.approve('draft-naver', null);
    const external = new DatabaseSync(path);
    try { external.exec(sql); } finally { external.close(); }
    assert.throws(() => store.claim(job.id), /변경|품절/);
    assert.equal(status(store, job.id), 'needs_attention');
  }
});

test('claim rejects malformed persisted freshness values and changed Threads account or work-tab approval', t => {
  clock(t);
  for (const sql of ["UPDATE products SET checked_at = 'invalid'", "UPDATE browser_preferences SET threads_handle = 'other'", 'UPDATE browser_preferences SET use_work_tabs = 0']) {
    const { store, path } = disk(t);
    seed(store, 'threads');
    const job = store.approveThreadsDraft('draft-threads');
    const external = new DatabaseSync(path);
    try { external.exec(sql); } finally { external.close(); }
    assert.throws(() => store.claim(job.id), /시각|변경/);
    assert.equal(status(store, job.id), 'needs_attention');
  }
});

test('restart persists state, quarantines in-flight jobs, and stops missed schedules without replay', t => {
  clock(t);
  const { store, open } = disk(t);
  seed(store);
  for (const id of ['124', '125', '126']) store.saveProduct(product({ id, sourceUrl: `https://sharelink.toss.im/links/products/${id}` }));
  store.saveDraft(draft('naver', { id: 'scheduled', productId: '124' }));
  store.saveDraft(draft('naver', { id: 'immediate', productId: '125' }));
  store.saveDraft(draft('naver', { id: 'future', productId: '126' }));
  const running = store.approve('draft-naver', null);
  const overdue = store.approve('scheduled', new Date(NOW + 1000).toISOString());
  const immediate = store.approve('immediate', null);
  const future = store.approve('future', new Date(NOW + 60000).toISOString());
  store.claim(running.id);
  store.bindAsideSession(running.id, 'Persisted_session');
  store.setPaused(true);
  const before = store.state();
  store.close();
  t.mock.timers.setTime(NOW + 2000);
  const reopened = open();
  assert.deepEqual(reopened.state().products, before.products);
  assert.deepEqual(reopened.state().drafts, before.drafts);
  assert.deepEqual(reopened.state().settings, before.settings);
  assert.equal(reopened.state().paused, true);
  assert.equal(status(reopened, running.id), 'uncertain');
  assert.equal(reopened.state().jobs.find(job => job.id === running.id)!.asideSessionId, 'Persisted_session');
  assert.throws(() => reopened.bindAsideSession(running.id, 'Replacement_session'), /실행 중/);
  assert.equal(status(reopened, overdue.id), 'needs_attention');
  assert.equal(status(reopened, immediate.id), 'approved');
  assert.equal(status(reopened, future.id), 'approved');
  assert.ok(reopened.state().events.length > before.events.length);
  assert.throws(() => reopened.cancel(running.id), /취소할 수 없습니다/);
  assert.throws(() => reopened.approve('draft-naver', null), /불명확/);
  assert.throws(() => reopened.reconcile(running.id, 'https://blog.naver.com/other_blog/987'), /대상 블로그/);
  reopened.reconcile(running.id, 'https://m.blog.naver.com/my_blog/987');
  assert.equal(status(reopened, running.id), 'published');
  assert.equal(reopened.state().jobs.find(job => job.id === running.id)!.asideSessionId, 'Persisted_session');
  assert.throws(() => reopened.approve('draft-naver', null), /이미 발행/);
  const recovered = reopened.state();
  reopened.close();
  const again = open();
  assert.deepEqual(again.state(), recovered);
});

test('events never include raw drafts, product facts, supplied result messages, or query material', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  assert.throws(() => store.saveProduct(product({ shareUrl: 'https://toss.im/example-link?tracking=unique-query' })));
  store.saveProduct(product({
    facts: '상품 비공개 내용 고유 표식',
    sourceUrl: 'https://sharelink.toss.im/links/products/123?tracking=unique-query',
    shareUrl: 'https://toss.shopping/_m/Example_123',
  }));
  store.saveDraft(draft('naver', { body: `${DISCLOSURE}\n원고 내용 고유 표식\nhttps://toss.shopping/_m/Example_123` }));
  const job = store.approve('draft-naver', null);
  store.claim(job.id);
  store.finish(job.id, 'uncertain', '호출자가 전달한 오류 고유 표식');
  const events = JSON.stringify(store.state().events);
  for (const raw of ['상품 비공개 내용 고유 표식', '원고 내용 고유 표식', '호출자가 전달한 오류 고유 표식', 'unique-query', DISCLOSURE, 'https://']) assert.ok(!events.includes(raw));
  assert.ok(store.state().events.some(event => event.jobId === job.id));
});

test('closed stores reject operations without reopening or altering persisted state', t => {
  clock(t);
  const store = memory(t);
  seed(store);
  store.close();
  store.close();
  assert.throws(() => store.state(), /닫힌 저장소/);
  assert.throws(() => store.saveProduct(product()), /닫힌 저장소/);
  assert.throws(() => store.saveSettings(settings), /닫힌 저장소/);
});

test('saved Threads drafts project awaiting publication after reopen without changing the job table schema', t => {
  clock(t);
  const { store, path, open } = disk(t);
  seed(store, 'threads');
  const external = new DatabaseSync(path);
  try {
    const schema = external.prepare("SELECT sql FROM sqlite_master WHERE name = 'browser_jobs'").get()!.sql;
    const job = store.approveThreadsDraft('draft-threads');
    assert.equal(job.operation, 'threads_draft');
    assert.equal(job.scheduledAt, null);
    store.claim(job.id);
    assert.throws(() => store.markThreadsDraftSaved(job.id, 'visible'), /Aside/);
    store.bindAsideSession(job.id, 'Saved_session');
    assert.throws(() => store.finish(job.id, 'published', '잘못된 완료', 'https://threads.com/@person/post/abc'), /공개 게시 완료가 아닙니다/);
    store.markThreadsDraftSaved(job.id, 'visible');
    const saved = store.state();
    assert.equal(saved.jobs[0]!.status, 'awaiting_publication');
    assert.equal(saved.jobs[0]!.resultUrl, '');
    assert.match(saved.jobs[0]!.message, /아직 공개 게시되지/);
    const receipt = external.prepare('SELECT * FROM threads_draft_intents WHERE job_id = ?').get(job.id);
    assert.equal(external.prepare('SELECT status FROM browser_jobs WHERE id = ?').get(job.id)!.status, 'needs_attention');
    assert.equal(external.prepare("SELECT sql FROM sqlite_master WHERE name = 'browser_jobs'").get()!.sql, schema);
    t.mock.timers.setTime(NOW + 1000);
    store.markThreadsDraftSaved(job.id, 'visible');
    assert.deepEqual(store.state(), saved);
    assert.deepEqual(external.prepare('SELECT * FROM threads_draft_intents WHERE job_id = ?').get(job.id), receipt);
    assert.throws(() => store.markThreadsDraftSaved(job.id, 'unavailable'), /변경/);
    assert.throws(() => store.cancel(job.id), /취소할 수 없습니다/);
    store.close();
    assert.deepEqual(open().state(), saved);
  } finally { external.close(); }
});

test('Threads draft handoff freezes approved content and blocks duplicate owners across draft IDs and versions', t => {
  clock(t);
  const { store, open } = disk(t);
  seed(store, 'threads');
  const approvedProduct = store.state().products[0]!;
  store.saveDraft(draft('threads', { id: 'another-version', version: 99 }));
  const second = open();
  const job = store.approveThreadsDraft('draft-threads');
  assert.throws(() => second.approveThreadsDraft('another-version'), /이미 승인/);
  store.claim(job.id);
  assert.throws(() => store.saveDraft(draft('threads')), /수정할 수 없습니다/);
  assert.throws(() => second.approveThreadsDraft('another-version'), /진행 중/);
  store.bindAsideSession(job.id, 'Immutable_session');
  store.finish(job.id, 'uncertain', '저장 결과를 확인하세요.');
  assert.throws(() => store.saveDraft(draft('threads')), /수정할 수 없습니다/);
  assert.throws(() => store.confirmNotPublished(job.id), /초안 없음/);
  assert.throws(() => store.reconcile(job.id, 'https://threads.com/@person/post/abc'), /별도로 확인/);
  assert.throws(() => second.approveThreadsDraft('another-version'), /불명확/);
  store.markThreadsDraftSaved(job.id, 'unavailable');
  store.saveProduct(product({ price: '15,000원', shareUrl: 'https://toss.im/changed', soldOut: true }));
  store.saveSettings({ ...settings, threadsHandle: 'other', useWorkTabs: false });
  assert.deepEqual(store.threadsDraftProduct(job.id), approvedProduct);
  assert.equal(status(store, job.id), 'awaiting_publication');
  assert.throws(() => store.saveDraft(draft('threads')), /수정할 수 없습니다/);
  store.saveDraft(draft('threads', { id: 'another-version', body: `${DISCLOSURE}\nhttps://toss.im/changed` }));
  store.saveProduct(product({ price: '15,000원', shareUrl: 'https://toss.im/changed' }));
  assert.throws(() => second.approveThreadsDraft('another-version'), /게시 대기/);
  assert.throws(() => store.confirmDraftNotSaved(job.id), /불명확/);
  assert.throws(() => store.completeThreadsPublication(job.id, 'https://threads.com/@other/post/abc'), /대상 Threads/);
  t.mock.timers.setTime(NOW + DAY * 2);
  store.completeThreadsPublication(job.id, 'https://threads.com/@person/post/abc');
  assert.equal(status(store, job.id), 'published');
  assert.equal(store.state().jobs[0]!.asideSessionId, 'Immutable_session');
});

test('uncertain draft cancellation retains sessions and only unsaved reviewed drafts may be reapproved', t => {
  clock(t);
  const store = memory(t);
  seed(store, 'threads');
  const job = store.approveThreadsDraft('draft-threads');
  assert.throws(() => store.completeThreadsPublication(job.id, 'https://threads.com/@person/post/abc'), /게시 대기/);
  assert.throws(() => store.confirmDraftNotSaved(job.id), /불명확/);
  store.claim(job.id);
  store.bindAsideSession(job.id, 'Cancelled_session');
  store.finish(job.id, 'uncertain', '저장 여부를 확인하세요.');
  store.confirmDraftNotSaved(job.id);
  assert.equal(status(store, job.id), 'cancelled');
  assert.equal(store.state().jobs[0]!.asideSessionId, 'Cancelled_session');
  store.saveDraft(draft('threads'));
  const next = store.approveThreadsDraft('draft-threads');
  store.claim(next.id);
  store.finish(next.id, 'needs_attention', '저장 요청 전 검증에서 중단했습니다.');
  store.saveDraft(draft('threads'));
  assert.equal(store.approveThreadsDraft('draft-threads').status, 'approved');
});

test('legacy Threads approvals never execute and startup preserves uncertain published rows and sessions', t => {
  clock(t);
  const { store, path, open } = disk(t);
  seed(store, 'threads');
  for (const id of ['124', '125']) {
    store.saveProduct(product({ id, sourceUrl: `https://sharelink.toss.im/links/products/${id}` }));
    store.saveDraft(draft('threads', { id: `legacy-${id}`, productId: id }));
  }
  const approved = store.approveThreadsDraft('draft-threads');
  const uncertain = store.approveThreadsDraft('legacy-124');
  const published = store.approveThreadsDraft('legacy-125');
  const external = new DatabaseSync(path);
  try {
    external.exec('DELETE FROM threads_draft_intents');
    external.prepare("UPDATE browser_jobs SET status = 'uncertain', message = '원래 불명확 기록' WHERE id = ?").run(uncertain.id);
    external.prepare("UPDATE browser_jobs SET status = 'published', result_url = 'https://threads.com/@person/post/existing', message = '원래 공개 기록' WHERE id = ?").run(published.id);
    external.prepare('INSERT INTO aside_sessions VALUES (?, ?)').run(uncertain.id, 'Legacy_session');
    const original = external.prepare('SELECT * FROM browser_jobs WHERE id IN (?, ?) ORDER BY id').all(uncertain.id, published.id);
    assert.throws(() => store.claim(approved.id), /이전 Threads/);
    assert.equal(status(store, approved.id), 'needs_attention');
    external.prepare("UPDATE browser_jobs SET status = 'approved', scheduled_at = ? WHERE id = ?").run(new Date(NOW + DAY).toISOString(), approved.id);
    store.close();
    const reopened = open();
    assert.equal(status(reopened, approved.id), 'needs_attention');
    assert.deepEqual(external.prepare('SELECT * FROM browser_jobs WHERE id IN (?, ?) ORDER BY id').all(uncertain.id, published.id), original);
    assert.equal(reopened.state().jobs.find(row => row.id === uncertain.id)!.asideSessionId, 'Legacy_session');
    assert.throws(() => reopened.approve('draft-threads', null), /별도로 승인/);
    assert.throws(() => reopened.approve('draft-threads', new Date(NOW + DAY).toISOString()), /별도로 승인/);
    assert.equal(reopened.approveThreadsDraft('draft-threads').operation, 'threads_draft');
  } finally { external.close(); }
});
