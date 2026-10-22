import assert from 'node:assert/strict';
import test from 'node:test';
import type { Product } from '../shared.js';
import { wrapAsideScript, type AsideRunner } from './aside-client.js';
import { buildOpenScript, buildProductScript, buildScanScript, buildScanPlanScript } from './aside-scripts.js';
import { BrowserAutomation, isNaverHomeUrl, isNaverPostUrl, isThreadsPostUrl, isTossShareUrl, parseDisplayedPrice, parseNaverPostUrl, parseTossProductUrl } from './browser.js';

const product: Product = {
  id: '8638671', name: '검증 상품', price: '14,900원', soldOut: false,
  sourceUrl: 'https://sharelink.toss.im/links/products/8638671',
  shareUrl: 'https://toss.im/_m/example', checkedAt: '2026-10-18T00:00:00Z', facts: '사용자가 확인한 상품 설명',
};









test('Toss product URLs yield observed numeric IDs and discard only known tracking', () => {
  assert.deepEqual(parseTossProductUrl(`${product.sourceUrl}?originSurface=home&originSectionCode=BEST`), { id: '8638671', url: product.sourceUrl });
  assert.deepEqual(parseTossProductUrl(`${product.sourceUrl}?originSurface=home&originSectionCode=TODAY_DEAL&originPosition=1&originPage=1&originRank=2`), { id: '8638671', url: product.sourceUrl });
  for (const url of [
    'http://sharelink.toss.im/links/products/8638671',
    'https://sharelink.toss.im.evil.test/links/products/8638671',
    'https://sharelink.toss.im@evil.test/links/products/8638671',
    'https://user:password@sharelink.toss.im/links/products/8638671',
    'https://sharelink.toss.im:8443/links/products/8638671',
    'https://sharelink.toss.im/links/products/not-an-id',
    'https://sharelink.toss.im/links/products/0',
    'https://sharelink.toss.im/home',
    `${product.sourceUrl}?token=secret`, `${product.sourceUrl}#fragment`, ` ${product.sourceUrl}`,
  ]) assert.equal(parseTossProductUrl(url), null, url);
});

test('Toss copied URLs reject wrong domains, credentials, query secrets and non-public protocols', () => {
  assert.equal(isTossShareUrl(product.shareUrl), true);
  for (const url of [
    'https://toss.im/', 'http://toss.im/a', 'https://toss.im.evil.test/a', 'https://sharelink.toss.im/a',
    'https://u:p@toss.im/a', 'https://toss.im/a?token=secret', 'https://toss.im/a#x',
    'javascript:alert(1)', 'https://toss.im\\@evil.test/a', 'https://toss.im/a\n',
  ]) assert.equal(isTossShareUrl(url), false, url);
});

test('actual Toss Shopping short links pass strict origin and path validation', () => {
  assert.equal(isTossShareUrl('https://toss.shopping/_m/Example_123'), true);
  for (const url of [
    'https://toss.shopping/Example_123', 'https://toss.shopping/_m/',
    'https://toss.shopping/_m/a/b', 'https://www.toss.shopping/_m/abc',
    'https://toss.shopping.evil.test/_m/abc', 'https://toss.shopping:443/_m/abc',
    'https://user@toss.shopping/_m/abc', 'https://toss.shopping/_m/abc?token=secret',
    'https://toss.shopping/_m/abc#secret', 'https://toss.shopping/_m/abc.',
    'http://toss.shopping/_m/abc', 'https://toss.shopping/_m/abc\n',
  ]) assert.equal(isTossShareUrl(url), false, url);
});

test('price parsing separates observed commission text without discarding the actual price on the same line', () => {
  assert.equal(parseDisplayedPrice('선착순특가 개당 2,160원 수익 지금 30일 내 최저가 예요 27,000원'), '27,000원');
  assert.equal(parseDisplayedPrice('27,000원 예상 수익금 2,160원'), '27,000원');
  assert.equal(parseDisplayedPrice('27,000원\n배송비 3,000원'), '27,000원');
  assert.equal(parseDisplayedPrice('상세 정보 [상품명] 원산지: 상세페이지 참조 74 % 32,160원 선착순특가 1 정 당 179원 · 무료배송 수수료 8 %'), '32,160원');
  assert.equal(parseDisplayedPrice('1 정 당 179원'), null);
  assert.equal(parseDisplayedPrice('상세 정보 [상품명] 33 % 17,950원 최대할인가 10 m 당 100원 · 무료배송 수수료 8 %'), '17,950원');
  assert.equal(parseDisplayedPrice('10 m 당 100원'), null);
  assert.equal(parseDisplayedPrice('17,950원 18,000원 10 m 당 100원'), null);
  assert.equal(parseDisplayedPrice('27,000원 29,000원'), null, 'Unmarked original and sale prices must not be guessed');
  assert.equal(parseDisplayedPrice('27,00원'), null, 'Malformed prices must not be partially parsed');
  assert.equal(parseDisplayedPrice('27 , 000원'), null, 'Separated numeric fragments must not become a false price');
  assert.equal(parseDisplayedPrice('개당 2,160원 수익'), null, 'Commission is not a sale price');
});

test('Naver section host is allowed only for its known account-selection home URL', () => {
  assert.equal(isNaverHomeUrl('https://blog.naver.com/'), true);
  assert.equal(isNaverHomeUrl('https://section.blog.naver.com/BlogHome.naver?directoryNo=0&currentPage=1&groupId=0'), true);
  for (const url of [
    'https://section.blog.naver.com/PostWriteForm.naver?blogId=approved_blog',
    'https://section.blog.naver.com/approved_blog/123',
    'https://section.blog.naver.com/BlogHome.naver?redirect=https://evil.test/',
    'https://section.blog.naver.com.evil.test/BlogHome.naver',
    'https://secret@section.blog.naver.com/BlogHome.naver',
  ]) assert.equal(isNaverHomeUrl(url), false, url);
});

// Execute generated scripts only against injected in-memory Aside globals, never a live browser.
function scriptRunner(globals: Record<string, unknown>): AsideRunner {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
  const environment = { chrome: { tabs: { query: async () => {
    const tabs = await (globals.listBrowserTabs as () => Promise<Array<Record<string, unknown>>>)();
    return tabs.map(tab => ({ ...tab, discarded: false, status: 'complete' }));
  } } }, ...globals };
  return async <T>(script: string): Promise<T> => await new AsyncFunction(...Object.keys(environment), script)(...Object.values(environment)) as T;
}

interface TossOptions {
  tabs?: Array<{ targetId: string; url: string; active?: boolean; focusedWindow?: boolean; windowId?: number }>;
  initialUrl?: string;
  redirectUrl?: string;
  name?: string;
  priceText?: string;
  soldOut?: boolean;
  copied?: string;
  clipboardDenied?: boolean;
  attachError?: Error;
  noProductHref?: boolean;
  snapshotTree?: string;
  discarded?: boolean;
  status?: string;
}

function tossSandbox(options: TossOptions = {}) {
  const navigationToken = '00000000-0000-4000-8000-000000000001';
  let currentUrl = options.initialUrl ?? product.sourceUrl;
  const events: string[] = [];
  const page = {
    url: () => currentUrl,
    title: async () => '토스 쇼핑 쉐어링크',
    getByRole: (_role: string, control: { name: string; exact: boolean }) => {
      assert.equal(control.name, '링크 발급');
      assert.equal(control.exact, true);
      return { first: () => ({ waitFor: async () => {} }) };
    },
    goto: async (url: string) => { events.push('goto'); currentUrl = options.redirectUrl ?? url; },

    evaluate: async (fn: (...args: never[]) => unknown, arg?: { detail?: boolean; expectedName?: string }) => {
      if (arg && 'detail' in arg) {
        events.push('read-product');
        return [{ name: options.name ?? product.name, priceText: options.priceText ?? product.price,
          soldOut: options.soldOut ?? false, hrefs: options.noProductHref ? [] : [product.sourceUrl],
          sectionName: '', navigationName: options.name ?? product.name, navigationHasName: true,
          navigationToken, canNavigate: true, issueIndex: 1, enabled: true }];
      }
      if (fn.toString().includes('crypto.randomUUID')) {
        events.push('clipboard-write');
        if (options.clipboardDenied) throw new Error('NotAllowedError');
        return 'auto-flow-fresh';
      }
      if (fn.toString().includes('navigator.clipboard.readText')) {
        events.push('clipboard-read');
        return options.copied ?? `${product.name}\n${product.shareUrl}`;
      }
      assert.fail('Unexpected browser evaluation');
    },
    locator: (selector: string) => {
      if (selector === 'button, [role="button"]') return {
        nth: (index: number) => ({ click: async () => {
          assert.equal(selector, 'button, [role="button"]');
          assert.equal(index, 1);
          events.push('issue');
        } }),
      };
      assert.ok(selector === 'main' || selector === `main [data-auto-flow-control="${navigationToken}"]`,
        'Product lookup must use the verified node token in a page-level CSS selector');
      return {
        count: async () => 1,
        click: async () => {
          assert.equal(selector, `main [data-auto-flow-control="${navigationToken}"]`);
          events.push('open-detail');
          currentUrl = product.sourceUrl;
        },
      };
    },
  };
  const runner = scriptRunner({
    listBrowserTabs: async () => options.tabs ?? [{ targetId: 'toss', url: currentUrl }],
    chrome: { tabs: { query: async () => (options.tabs ?? [{ targetId: 'toss', url: currentUrl }]).map(tab => ({
      ...tab, discarded: options.discarded ?? false, status: options.status ?? 'complete',
    })) } },
    attachBrowserTab: async (targetId: string) => {
      events.push(`attach:${targetId}`);
      if (options.attachError) throw options.attachError;
      return page;
    },
    openTab: async (url: string) => { events.push('open-tab'); currentUrl = url; return page; },
    snapshot: async () => { events.push('snapshot'); return { tree: options.snapshotTree ?? '', diff: '' }; },
    injected: () => assert.fail('JSON data must never become JavaScript'),
  });
  return { runner, events };
}

test('Aside attaches one existing tab, opens only when absent, and never duplicates a failed attachment', async () => {
  const existing = tossSandbox();
  await new BrowserAutomation(existing.runner).open('toss');
  assert.deepEqual(existing.events, ['attach:toss', 'snapshot']);
  const absent = tossSandbox({ tabs: [{ targetId: 'unrelated', url: 'https://sharelink.toss.im.evil.test/' }] });
  await new BrowserAutomation(absent.runner).open('toss');
  assert.deepEqual(absent.events, ['open-tab', 'snapshot']);
  const failed = tossSandbox({ attachError: new Error('Page.enable timeout') });
  await assert.rejects(new BrowserAutomation(failed.runner).open('toss'), /Page.enable/);
  assert.deepEqual(failed.events, ['attach:toss']);
});

test('Aside rejects ambiguous tabs but selects exactly one observed matching product path', async () => {
  const tabs = [{ targetId: 'home', url: 'https://sharelink.toss.im/home' }, { targetId: 'detail', url: product.sourceUrl }];
  const ambiguous = tossSandbox({ tabs });
  await assert.rejects(new BrowserAutomation(ambiguous.runner).scanProducts(), /AF:.*탭이 여러 개/);
  assert.deepEqual(ambiguous.events, []);
  const exact = tossSandbox({ tabs });
  await new BrowserAutomation(exact.runner).verifyProduct(product);
  assert.equal(exact.events[0], 'attach:detail');
  const duplicate = tossSandbox({ tabs: [tabs[1]!, { targetId: 'duplicate', url: `${product.sourceUrl}?originSurface=home` }] });
  await assert.rejects(new BrowserAutomation(duplicate.runner).verifyProduct(product), /AF:.*탭이 여러 개/);
  assert.deepEqual(duplicate.events, []);
});

test('Aside uses the matching tab explicitly selected in the focused browser window', async () => {
  const sandbox = tossSandbox({ tabs: [
    { targetId: 'background', url: product.sourceUrl, active: true, focusedWindow: false, windowId: 1 },
    { targetId: 'selected', url: product.sourceUrl, active: true, focusedWindow: true, windowId: 2 },
  ] });
  await new BrowserAutomation(sandbox.runner).open('toss');
  assert.equal(sandbox.events[0], 'attach:selected');
});

test('discarded or unloaded tabs fail before CDP attachment and never wake user tabs', async () => {
  for (const options of [{ discarded: true }, { status: 'unloaded' }, { status: 'loading' }]) {
    const sandbox = tossSandbox(options);
    await assert.rejects(new BrowserAutomation(sandbox.runner).open('toss'), /언로드|로딩/);
    await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(() => assert.fail('Sleeping tabs cannot produce verified products')), /언로드|로딩/);
    assert.deepEqual(sandbox.events, []);
  }
});

test('explicit work-tab mode opens its own product page without waking the discarded user tab', async () => {
  const sandbox = tossSandbox({ discarded: true });
  await new BrowserAutomation(sandbox.runner, true).verifyProduct(product);
  assert.equal(sandbox.events[0], 'open-tab');
  assert.ok(!sandbox.events.some(e => e.startsWith('attach:')));
  assert.ok(sandbox.events.includes('read-product'));
  assert.ok(sandbox.events.includes('open-detail'));
  assert.ok(!sandbox.events.includes('goto'));
  assert.ok(!sandbox.events.includes('issue'));
});

test('selected browser tab remains usable when focus returns to the desktop app', async () => {
  const sandbox = tossSandbox({ tabs: [
    { targetId: 'inactive', url: product.sourceUrl, active: false, focusedWindow: false, windowId: 1 },
    { targetId: 'selected', url: `${product.sourceUrl}?originSurface=home`, active: true, focusedWindow: false, windowId: 1 },
  ] });
  await new BrowserAutomation(sandbox.runner).open('toss');
  assert.equal(sandbox.events[0], 'attach:selected');
});

test('product preflight reads the existing detail without clipboard issuance or mutating saved facts', async () => {
  const sandbox = tossSandbox();
  const before = structuredClone(product);
  await new BrowserAutomation(sandbox.runner).verifyProduct(product);
  assert.deepEqual(sandbox.events, ['attach:toss', 'snapshot', 'read-product']);
  assert.deepEqual(product, before);
  assert.ok(!buildProductScript(product, false).includes('navigator.clipboard'));
});

test('product preflight fails for price changes, ambiguous prices, sold-out state, name mismatch and redirects', async () => {
  for (const variant of [
    { priceText: '15,900원' }, { priceText: '14,900원 15,900원' }, { soldOut: true }, { name: '다른 상품' },
    { initialUrl: 'https://sharelink.toss.im/home', redirectUrl: 'https://sharelink.toss.im/links/products/999' },
  ]) {
    const sandbox = tossSandbox(variant);
    await assert.rejects(new BrowserAutomation(sandbox.runner).verifyProduct(product), /AF:.*(?:가격|품절|상품 ID 또는 상품명)/);
    assert.ok(!sandbox.events.some((event) => /issue|clipboard/.test(event)));
  }
});

test('scan supports a manually selected detail and discovers missing IDs through product-name UI only', async () => {
  const detail = tossSandbox();
  const { products: [observed], skipped } = await new BrowserAutomation(detail.runner).scanProducts();
  assert.deepEqual(skipped, []);
  assert.equal(observed!.id, product.id);
  assert.equal(observed!.name, product.name);
  assert.equal(observed!.price, product.price);
  assert.equal(observed!.facts, '');
  assert.equal(observed!.shareUrl, '');
  assert.ok(Number.isFinite(Date.parse(observed!.checkedAt)));
  assert.ok(!detail.events.includes('goto'));
  const list = tossSandbox({ initialUrl: 'https://sharelink.toss.im/home', noProductHref: true });
  assert.equal((await new BrowserAutomation(list.runner).scanProducts()).products[0]!.sourceUrl, product.sourceUrl);
  assert.equal(list.events.filter((event) => event === 'open-detail').length, 1);
  assert.equal(list.events.filter((event) => event === 'goto').length, 1);
  assert.ok(!list.events.includes('issue'));
});

test('list collection executes a bounded plan and each product in separate REPL calls', async () => {
  const first = { ...product, name: '첫 번째 상품', shareUrl: '' };
  const second = { ...product, id: '12345', sourceUrl: 'https://sharelink.toss.im/links/products/12345', name: '두 번째 상품', shareUrl: '' };
  const replies: unknown[] = [
    { products: [], candidates: [first, second].map(p => ({ name: p.name, sourceUrl: '', originalUrl: 'https://sharelink.toss.im/home', sectionName: '', price: p.price })) },
    first, second,
  ];
  const scripts: string[] = [];
  const runner: AsideRunner = async <T>(script: string) => { scripts.push(script); return replies.shift() as T; };
  assert.deepEqual(await new BrowserAutomation(runner).scanProducts(), { products: [first, second], skipped: [] });
  assert.equal(scripts.length, 3);
  assert.ok(scripts[1]!.includes('첫 번째 상품'));
  assert.ok(!scripts[1]!.includes('두 번째 상품'));
  assert.ok(scripts[2]!.includes('두 번째 상품'));
});

test('same-ID duplicate presentations merge sold-out stock conservatively in either section order', async () => {
  for (const stock of [[true, false], [false, true]]) {
    const observed = stock.map(soldOut => ({ ...product, shareUrl: '', soldOut }));
    const before = structuredClone(observed);
    const replies: unknown[] = [
      { products: [], candidates: observed.map((item, index) => ({
        name: item.name, sourceUrl: item.sourceUrl, price: item.price,
        originalUrl: 'https://sharelink.toss.im/links/best-ranking',
        sectionName: index === 0 ? '오늘만 이 가격에 살 수 있는 하루특가' : '지금 많이 팔리는 BEST',
      })) },
      ...observed,
    ];
    let calls = 0;
    const saved: Product[] = [];
    const runner: AsideRunner = async <T>() => { calls++; return replies.shift() as T; };
    const result = await new BrowserAutomation(runner).scanProducts(item => saved.push(item));
    assert.deepEqual(result, { products: [{ ...product, shareUrl: '', soldOut: true }], skipped: [] });
    assert.deepEqual(saved.map(item => item.soldOut), [stock[0], true]);
    assert.deepEqual(saved[saved.length - 1], result.products[0], 'The last saved callback must retain conservative stock');
    assert.deepEqual(observed, before, 'Merging must not mutate the original verified receipts');
    assert.equal(calls, 3);
  }
});

test('same-ID duplicate presentations still reject differing verified names or prices after the first callback', async () => {
  const first = { ...product, shareUrl: '' };
  for (const second of [{ ...first, name: '다른 검증 상품' }, { ...first, price: '15,900원' }]) {
    const replies: unknown[] = [
      { products: [], candidates: [first, second].map((item, index) => ({
        name: item.name, sourceUrl: item.sourceUrl, price: item.price,
        originalUrl: 'https://sharelink.toss.im/links/best-ranking',
        sectionName: index === 0 ? '오늘만 이 가격에 살 수 있는 하루특가' : '지금 많이 팔리는 BEST',
      })) },
      first, second,
    ];
    const saved: Product[] = [];
    const runner: AsideRunner = async <T>() => replies.shift() as T;
    await assert.rejects(new BrowserAutomation(runner).scanProducts(item => saved.push(item)), /수집 중 같은 상품의 정보가 바뀌었습니다/);
    assert.deepEqual(saved, [first]);
  }
});

test('structured missing candidates preserve verified products, report omissions and continue without retry', async () => {
  const first = { ...product, shareUrl: '' };
  const last = { ...first, id: '12345', sourceUrl: 'https://sharelink.toss.im/links/products/12345', name: '마지막 검증 상품' };
  const replies: unknown[] = [
    { products: [], candidates: [first.name, '사라진 검증 상품', last.name].map(name => ({ name, sourceUrl: '', originalUrl: 'https://sharelink.toss.im/links/best-ranking', sectionName: '', price: product.price })) },
    first, { skipped: 'missing' }, last,
  ];
  let calls = 0;
  const saved: Product[] = [];
  const runner: AsideRunner = async <T>() => { calls++; return replies.shift() as T; };
  const result = await new BrowserAutomation(runner).scanProducts(item => saved.push(item));
  assert.deepEqual(result, { products: [first, last], skipped: [{ name: '사라진 검증 상품', reason: 'missing' }] });
  assert.deepEqual(saved, [first, last]);
  assert.equal(calls, 4);
});

test('an all-missing scan returns zero products with explicit omissions, not a fabricated collection success', async () => {
  const replies: unknown[] = [
    { products: [], candidates: [{ name: product.name, sourceUrl: '', originalUrl: 'https://sharelink.toss.im/home', sectionName: '', price: product.price }] },
    { skipped: 'missing' },
  ];
  const runner: AsideRunner = async <T>() => replies.shift() as T;
  assert.deepEqual(await new BrowserAutomation(runner).scanProducts(() => assert.fail('No missing product may be saved')), {
    products: [], skipped: [{ name: product.name, reason: 'missing' }],
  });
});

test('fatal collection errors keep only previously validated callbacks and stop before later candidates', async () => {
  for (const message of ['로그인이 필요합니다', 'permission denied', 'Page.enable timeout', 'AF:상품이 사라졌습니다', 'AF:현재 표시 가격 하나를 확인할 수 없습니다']) {
    const first = { ...product, shareUrl: '' };
    const candidates = [first.name, '실패하는 검증 상품', '실행하면 안 되는 상품'].map(name => ({ name, sourceUrl: '', originalUrl: 'https://sharelink.toss.im/home', sectionName: '', price: product.price }));
    const saved: Product[] = [];
    let calls = 0;
    const runner: AsideRunner = async <T>() => {
      calls++;
      if (calls === 1) return { products: [], candidates } as T;
      if (calls === 2) return first as T;
      throw new Error(message);
    };
    await assert.rejects(new BrowserAutomation(runner).scanProducts(item => saved.push(item)), error => error instanceof Error && error.message === message);
    assert.deepEqual(saved, [first]);
    assert.equal(calls, 3);
  }
});

test('unvalidated receipts and candidate identity mismatches never reach the per-product callback', async () => {
  for (const invalid of [
    { ...product, shareUrl: '', id: '999' },
    { ...product, shareUrl: '', name: '다른 검증 상품' },
    { ...product, shareUrl: '', id: '999', sourceUrl: 'https://sharelink.toss.im/links/products/999' },
    { ...product, shareUrl: '', checkedAt: 'not-a-date' },
    { ...product, shareUrl: '', price: '15,900원' },
    { ...product, shareUrl: '', price: '14,900원 15,900원' },
    { skipped: 'changed' }, { skipped: 'missing', product },
    '상품이 사라졌습니다', null,
  ]) {
    let calls = 0;
    const runner: AsideRunner = async <T>() => {
      calls++;
      return (calls === 1
        ? { products: [], candidates: [{ name: product.name, sourceUrl: product.sourceUrl, originalUrl: 'https://sharelink.toss.im/home', sectionName: '', price: product.price }] }
        : invalid) as T;
    };
    await assert.rejects(new BrowserAutomation(runner).scanProducts(() => assert.fail('Invalid or mismatched output must not be saved')), /상품|수집/);
    assert.equal(calls, 2);
  }
});

test('direct-detail products are validated before callbacks and observer mutation cannot alter collected products', async () => {
  const verified = { ...product, shareUrl: '' };
  const validRunner: AsideRunner = async <T>() => ({ products: [verified], candidates: [] }) as T;
  const result = await new BrowserAutomation(validRunner).scanProducts(item => { item.name = '콜백이 변경한 이름'; });
  assert.deepEqual(result, { products: [verified], skipped: [] });
  for (const invalid of [{ ...verified, price: '14,900원 15,900원' }, { ...verified, id: '999' }]) {
    const runner: AsideRunner = async <T>() => ({ products: [invalid], candidates: [] }) as T;
    await assert.rejects(new BrowserAutomation(runner).scanProducts(() => assert.fail('Invalid detail output cannot be saved')), /유효한 상품 목록/);
  }
});

test('generated issuance scripts accept the actual Toss Shopping clipboard format', async () => {
  const url = 'https://toss.shopping/_m/Example_123';
  const sandbox = tossSandbox({ copied: `${product.name} ${url}` });
  assert.equal(await new BrowserAutomation(sandbox.runner).issueLink(product), url);
  assert.equal(sandbox.events.filter(event => event === 'issue').length, 1);
});

test('invalid or oversized discovery plans stop before any product navigation', async () => {
  for (const candidates of [
    Array.from({ length: 21 }, () => ({ name: '상품', sourceUrl: '', originalUrl: 'https://sharelink.toss.im/home', sectionName: '', price: product.price })),
    [{ name: '상품', sourceUrl: '', originalUrl: 'https://evil.test/', sectionName: '', price: product.price }],
    [{ name: product.name, sourceUrl: '', originalUrl: 'https://sharelink.toss.im/home', price: product.price }],
    [{ name: product.name, sourceUrl: '', originalUrl: 'https://sharelink.toss.im/home', sectionName: ' 영역 ', price: product.price }],
    [{ name: product.name, sourceUrl: '', originalUrl: 'https://sharelink.toss.im/home', sectionName: '가'.repeat(201), price: product.price }],
    [{ name: product.name, sourceUrl: '', originalUrl: 'https://sharelink.toss.im/home', sectionName: '', price: '14,900원 15,900원' }],
    [null],
  ]) {
    let calls = 0;
    const runner: AsideRunner = async <T>() => { calls++; return { products: [], candidates } as T; };
    await assert.rejects(new BrowserAutomation(runner).scanProducts(), /수집/);
    assert.equal(calls, 1);
  }
});

test('link issuance requires normal clipboard permission, fresh named output and one safe link without retry', async () => {
  const success = tossSandbox();
  assert.equal(await new BrowserAutomation(success.runner).issueLink(product), product.shareUrl);
  assert.equal(success.events.filter((event) => event === 'issue').length, 1);
  assert.ok(success.events.indexOf('clipboard-write') < success.events.indexOf('issue'));
  assert.equal(success.events[success.events.indexOf('issue') + 1], 'snapshot');
  for (const copied of ['auto-flow-fresh', `다른 상품 ${product.shareUrl}`, `${product.name} https://evil.test/a`, `${product.name} ${product.shareUrl} ${product.shareUrl}`]) {
    const invalid = tossSandbox({ copied });
    await assert.rejects(new BrowserAutomation(invalid.runner).issueLink(product), /AF:.*(?:복사 결과|토스 링크)/);
    assert.equal(invalid.events.filter((event) => event === 'issue').length, 1);
  }
  const denied = tossSandbox({ clipboardDenied: true });
  await assert.rejects(new BrowserAutomation(denied.runner).issueLink(product), /AF:.*클립보드 접근이 거부/);
  assert.ok(!denied.events.includes('issue'));
});

test('Aside rechecks URL/title/snapshot and stops on security or login warnings before product reads', async () => {
  for (const options of [
    { initialUrl: 'https://sharelink.toss.im/login' }, { initialUrl: 'http://sharelink.toss.im/home' },
    { snapshotTree: '오늘 조회 한도를 모두 사용했어요' }, { snapshotTree: '보안 확인' },
  ]) {
    const sandbox = tossSandbox(options);
    await assert.rejects(new BrowserAutomation(sandbox.runner).verifyProduct(product), /AF:/);
    assert.ok(!sandbox.events.includes('read-product'));
  }
});

test('Aside serializes hostile product names as JSON, not executable source', async () => {
  const name = '상품 "); injected(); // \\ 새 줄\n${injected()}';
  const sandbox = tossSandbox({ name });
  await new BrowserAutomation(sandbox.runner).verifyProduct({ ...product, name });
  assert.ok(sandbox.events.includes('read-product'));
  const payload = /^const input = (.+);$/m.exec(buildProductScript({ ...product, name }, false));
  assert.equal(JSON.parse(payload![1]!).product.name, name);
});

test('Aside lock rejects concurrent work, releases after errors and never retries the runner', async () => {
  let calls = 0;
  let finish!: (value: unknown) => void;
  const runner: AsideRunner = <T>() => {
    calls += 1;
    return new Promise<unknown>((resolve) => { finish = resolve; }) as Promise<T>;
  };
  const automation = new BrowserAutomation(runner);
  const first = automation.open('toss');
  await assert.rejects(automation.open('naver'), /진행 중/);
  assert.equal(calls, 1);
  finish(null);
  await first;
  const failing = new BrowserAutomation(async () => { calls += 1; throw new Error('연결 중단'); });
  await assert.rejects(failing.open('toss'), /연결 중단/);
  await assert.rejects(failing.open('toss'), /연결 중단/);
  assert.equal(calls, 3);
});





test('runner output URLs are revalidated and malformed input does not invoke Aside', async () => {
  const runner: AsideRunner = async <T>() => 'https://evil.test/secret' as T;
  await assert.rejects(new BrowserAutomation(runner).issueLink(product), /안전한 토스 링크/);
  const noRun = new BrowserAutomation(async () => { assert.fail('Invalid input must not run Aside'); });
  await assert.rejects(noRun.verifyProduct({ ...product, soldOut: true }), /품절/);
  await assert.rejects(noRun.verifyProduct({ ...product, id: '999' }), /상품 주소/);
});

test('operation-specific generated scripts fit the CLI budget and contain no private browser or profile APIs', () => {
  const scripts = [buildOpenScript('toss'), buildOpenScript('naver'), buildScanPlanScript(), buildScanScript({ name: product.name, sourceUrl: '', originalUrl: 'https://sharelink.toss.im/home', sectionName: '', price: product.price }), buildProductScript(product, false), buildProductScript(product, true)];
  for (const script of scripts) {
    assert.ok(Buffer.byteLength(wrapAsideScript(script, '__BUDGET__'), 'utf8') < 24000);
    assert.doesNotMatch(script, /grantPermissions|clearPermissions|launchPersistentContext|\.context\(|closeTab\(|document\.body|body\.innerText|\bimport\s|\brequire\(/);
    assert.ok(!script.includes('console.log'));
  }
});

test('collection script fits CLI byte limit with maximum Korean candidate name and section', () => {
  const sourceUrl = `https://sharelink.toss.im/links/products/${'1'.repeat(30)}`;
  const code = buildScanScript({
    name: '가'.repeat(500), sourceUrl, originalUrl: 'https://sharelink.toss.im/links/best-ranking',
    sectionName: '나'.repeat(200), price: '1000원',
  }, true);
  assert.ok(Buffer.byteLength(wrapAsideScript(code, `__AUTO_FLOW_${'0'.repeat(32)}__:`), 'utf8') <= 24000);
  assert.doesNotMatch(code, /async function checkedProduct/);
});

test('Naver results require the exact approved blog and a numeric post ID', () => {
  assert.equal(parseNaverPostUrl('https://blog.naver.com/approved_blog/123456789', 'approved_blog'), 'https://blog.naver.com/approved_blog/123456789');
  assert.equal(parseNaverPostUrl('https://m.blog.naver.com/PostView.naver?blogId=approved_blog&logNo=123456789&from=postList', 'approved_blog'), 'https://blog.naver.com/approved_blog/123456789');
  for (const url of [
    'https://blog.naver.com/another_blog/123', 'https://blog.naver.com/approved_blog',
    'https://blog.naver.com/approved_blog/write', 'https://blog.naver.com/approved_blog/0',
    'https://blog.naver.com/approved_blog/123?token=secret',
    'https://blog.naver.com/PostView.naver?blogId=another_blog&logNo=123',
    'https://blog.naver.com/PostView.naver?blogId=approved_blog&blogId=another_blog&logNo=123',
    'https://blog.naver.com/PostView.naver?blogId=approved_blog&logNo=123&logNo=456',
    'https://blog.naver.com.evil.test/approved_blog/123',
    'https://u:p@blog.naver.com/approved_blog/123',
    'https://blog.naver.com/approved_blog/123#fragment',
  ]) assert.equal(isNaverPostUrl(url, 'approved_blog'), false, url);
  assert.equal(isNaverPostUrl('https://blog.naver.com/approved_blog/123', '../approved_blog'), false);
});

test('Threads results are HTTPS public post permalinks on official domains only', () => {
  assert.equal(isThreadsPostUrl('https://www.threads.net/@example/post/ABC_12'), true);
  assert.equal(isThreadsPostUrl('https://www.threads.com/@example.name/post/ABC-12'), true);
  for (const url of [
    'https://www.threads.net/@example', 'https://www.threads.net/@example/post/ABC?token=secret',
    'http://www.threads.net/@example/post/ABC', 'https://www.threads.net.evil.test/@example/post/ABC',
    'https://user:secret@www.threads.net/@example/post/ABC', 'https://www.threads.net/@example/post/ABC#x',
    'https://graph.threads.net/123',
  ]) assert.equal(isThreadsPostUrl(url), false, url);
});
