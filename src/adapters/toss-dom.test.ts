import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import type { Product } from '../shared.js';
import type { AsideRunner } from './aside-client.js';
import { buildScanPlanScript, parseDisplayedPrice, type ScanPlan } from './aside-scripts.js';
import { BrowserAutomation } from './browser.js';

interface FixtureProduct {
  id: string;
  name: string;
  price: string;
  originalPrice: string;
  commission: string;
  unitPrice: string;
}

// Synthetic products only; these fixtures preserve the observed UI structure, not customer data.
const wipes: FixtureProduct = {
  id: '900000001', name: '검증 물티슈, 100매, 10팩', price: '4,990원',
  originalPrice: '7,990원', commission: '399원', unitPrice: '1 입 당 5원',
};
const soup: FixtureProduct = {
  id: '900000002', name: '검증 간편국, 4펙', price: '8,500원',
  originalPrice: '11,900원', commission: '680원', unitPrice: '1 펙 당 1,910원',
};
const homeUrl = 'https://sharelink.toss.im/home';
const rankingUrl = 'https://sharelink.toss.im/links/best-ranking';
const sourceUrl = (product: FixtureProduct) => `https://sharelink.toss.im/links/products/${product.id}`;
const normalize = (value: string | null) => (value ?? '').replace(/\s+/g, ' ').trim();
const accessibleName = (element: Element) => normalize(element.getAttribute('aria-label') || element.textContent);

function homeHtml(product: FixtureProduct, soldOut: boolean): string {
  return `<!doctype html><html><head><title>토스쇼핑 쉐어링크</title></head><body>
    <main><div data-fixture="product-card">
      <button aria-label="${product.name}${soldOut ? ', 품절' : ''}">
        <img src="https://example.invalid/product.png">
        <span>선착순특가</span><span>개당 ${product.commission} 수익</span>
        <span>${product.name}</span><span>${product.price}</span>
      </button>
      <div><button>링크 발급</button></div>
    </div></main>
  </body></html>`;
}

function detailHtml(product: FixtureProduct, soldOut: boolean, extraPrice = ''): string {
  return `<!doctype html><html><head><title>토스쇼핑 쉐어링크</title></head><body>
    <main>
      ${soldOut ? '<div role="status" aria-label="품절. 상품이 재입고되면 구매할 수 있어요"></div>' : ''}
      <section>
        <div><img src="https://example.invalid/product.png"></div>
        <div data-fixture="price-panel">
          <img src="https://example.invalid/seller-logo.png">
          <span class="pc14-wed5fi0 xh8yej3" data-sentry-element="Txt" data-sentry-source-file="product-detail-page.tsx">${product.name}</span>
          <span class="pc14-wed5fi0 xh8yej3">원산지: 상세페이지 참조</span>
          <span>개당 ${product.commission} 수익</span>
          <span class="pc14-wed5fi0"><span class="xmqliwb" style="text-decoration-line: line-through">${product.originalPrice}</span></span>
          <del>21,900원</del><s>22,900원</s>
          <span aria-hidden="true">23,900원</span>
          <span style="display: none">24,900원</span>
          <span style="visibility: hidden">25,900원</span>
          <span>${product.price}</span><span>${product.unitPrice}</span>
          ${extraPrice ? `<span>${extraPrice}</span>` : ''}
          <button>선착순특가</button>
          <div><button>링크 발급</button><button>토스 앱에서 보기</button></div>
        </div>
      </section>
    </main>
  </body></html>`;
}

interface SandboxOptions {
  product?: FixtureProduct;
  home?: boolean;
  listUrl?: string;
  homeSoldOut?: boolean;
  detailSoldOut?: boolean;
  extraPrice?: string;
}

function domSandbox(options: SandboxOptions = {}) {
  const product = options.product ?? wipes;
  const home = homeHtml(product, options.homeSoldOut ?? false);
  const detail = detailHtml(product, options.detailSoldOut ?? false, options.extraPrice);
  const listUrl = options.listUrl ?? homeUrl;
  let currentUrl = options.home ? listUrl : sourceUrl(product);
  const events: string[] = [];
  const clicks: Array<{ name: string; text: string }> = [];
  const evaluations: Array<{ url: string; input: unknown }> = [];
  const sideEffects: string[] = [];
  const load = (html: string) => {
    const window = parseHTML(html);
    // linkedom has no layout engine. Include dynamically inserted elements in fixture geometry.
    Object.defineProperty(window.Element.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }],
    });
    return window;
  };
  let window = load(options.home ? home : detail);
  const forbid = (operation: string): never => {
    sideEffects.push(operation);
    assert.fail(`Read-only DOM tests must not perform ${operation}`);
  };
  const page = {
    url: () => currentUrl,
    title: async () => window.document.title,
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      assert.equal(role, 'button');
      assert.equal(options.name, '링크 발급');
      assert.equal(options.exact, true);
      return { first: () => ({ waitFor: async (wait: { state: string; timeout: number }) => {
        assert.equal(wait.state, 'visible');
        assert.ok(wait.timeout > 0);
        const first = [...window.document.querySelectorAll('button, [role="button"]')]
          .find((element) => accessibleName(element) === options.name);
        assert.ok(first, 'The real DOM must contain the issue button before extraction');
        assert.notEqual((first as HTMLElement).style.display, 'none');
        assert.ok(first.getClientRects().length > 0);
        events.push('ready');
      } }) };
    },
    evaluate: async (callback: (...args: never[]) => unknown, arg?: unknown) => {
      const input = structuredClone(arg);
      const before = structuredClone(input);
      evaluations.push({ url: currentUrl, input: before });
      // Run the actual generated callback with its serialized input, never canned product records.
      const result = await runInNewContext(`(${callback.toString()})(__input)`, {
        document: window.document,
        Node: window.Node,
        getComputedStyle: (element: HTMLElement) => ({
          display: element.style.display || 'block',
          visibility: element.style.visibility || 'visible',
          textDecorationLine: element.style.textDecorationLine || element.style.textDecoration || '',
        }),
        __input: input,
        navigator: { clipboard: {
          readText: () => forbid('clipboard read'), writeText: () => forbid('clipboard write'),
        } },
        fetch: () => forbid('network request'),
      }, { timeout: 1000 });
      assert.deepEqual(input, before, 'Extraction must not mutate its page.evaluate input');
      return structuredClone(result);
    },
    locator: (selector: string) => ({ nth: (index: number) => ({ click: async () => {
      const element = window.document.querySelectorAll(selector)[index];
      assert.ok(element, 'A click must resolve to an actual DOM element');
      const name = accessibleName(element);
      if (name === '링크 발급') forbid('link issuance');
      assert.equal(currentUrl, listUrl, 'Only opening a product from the verified list UI is allowed');
      assert.equal(name.replace(/,\s*품절$/, ''), product.name);
      clicks.push({ name, text: normalize(element.textContent) });
      events.push('open-detail');
      currentUrl = sourceUrl(product);
      window = load(detail);
    } }) }),
    goto: async (url: string) => {
      assert.equal(url, listUrl, 'Collection may restore only its original verified list URL');
      assert.equal(currentUrl, sourceUrl(product), 'Return navigation must start from the opened product detail');
      events.push('return-home');
      currentUrl = listUrl;
      window = load(home);
    },
  };
  const globals = {
    URL,
    listBrowserTabs: async () => [{ targetId: 'synthetic-toss', url: currentUrl, windowId: 1, active: true }],
    chrome: { tabs: { query: async (query: { url: string[] }) => {
      assert.deepEqual(structuredClone(query.url), ['https://sharelink.toss.im/*']);
      return [{ url: currentUrl, windowId: 1, active: true, discarded: false, status: 'complete' }];
    } } },
    attachBrowserTab: async (targetId: string) => {
      assert.equal(targetId, 'synthetic-toss');
      events.push('attach');
      return page;
    },
    openTab: () => forbid('opening a tab'),
    snapshot: async (target: unknown, options: { interactive: boolean; selector: string }) => {
      assert.equal(target, page);
      assert.equal(options.interactive, true);
      assert.ok(options.selector);
      events.push('snapshot');
      return { tree: [...window.document.querySelectorAll(options.selector)].map(accessibleName).join('\n'), diff: '' };
    },
    fetch: () => forbid('network request'),
  };
  const runner: AsideRunner = async <T>(script: string): Promise<T> => {
    events.push('run-script');
    const result = await runInNewContext(`(async () => {\n${script}\n})()`, globals, { timeout: 1000 });
    return structuredClone(result) as T;
  };
  return { runner, events, clicks, evaluations, sideEffects, page, document: () => window.document };
}

function assertScannedProduct(products: Product[], expected: FixtureProduct, soldOut: boolean): void {
  assert.equal(products.length, 1);
  const { checkedAt, ...product } = products[0]!;
  assert.deepEqual(product, {
    id: expected.id, name: expected.name, sourceUrl: sourceUrl(expected), price: expected.price,
    soldOut, facts: '', shareUrl: '',
  });
  assert.ok(Number.isFinite(Date.parse(checkedAt)), 'A real extraction must include a valid check timestamp');
}

function assertReadOnly(sandbox: ReturnType<typeof domSandbox>): void {
  assert.deepEqual(sandbox.sideEffects, []);
  assert.ok(sandbox.evaluations.length > 0, 'The generated DOM callback must actually execute');
  assert.equal(sandbox.events.filter((event) => event === 'ready').length, sandbox.evaluations.length);
}

test('home DOM uses the accessible product name, opens its detail once and preserves card stock without issuing links', async () => {
  const sandbox = domSandbox({ home: true, homeSoldOut: true, detailSoldOut: false });
  const products = await new BrowserAutomation(sandbox.runner).scanProducts();
  assertScannedProduct(products, wipes, true);
  assert.equal(sandbox.clicks.length, 1);
  assert.equal(sandbox.clicks[0]!.name, `${wipes.name}, 품절`);
  assert.notEqual(sandbox.clicks[0]!.text, wipes.name, 'The full button text is not the accessible product name');
  assert.ok(sandbox.clicks[0]!.text.includes(`개당 ${wipes.commission} 수익`));
  assert.equal(sandbox.events.filter((event) => event === 'run-script').length, 2, 'Planning and detail extraction use separate runner calls');
  assert.equal(sandbox.events.filter((event) => event === 'return-home').length, 1);
  assert.equal(sandbox.page.url(), homeUrl);
  assert.ok(sandbox.evaluations.some((evaluation) => evaluation.url === sourceUrl(wipes)));
  assertReadOnly(sandbox);
});

test('observed ranking list route is preserved through planning, detail lookup and return navigation', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, homeSoldOut: true });
  const plan = await sandbox.runner<ScanPlan>(buildScanPlanScript());
  assert.deepEqual(plan, {
    products: [], candidates: [{ name: wipes.name, sourceUrl: '', originalUrl: rankingUrl }],
  });
  assert.deepEqual(sandbox.clicks, []);
  assertScannedProduct(await new BrowserAutomation(sandbox.runner).scanProducts(), wipes, true);
  assert.equal(sandbox.clicks.length, 1);
  assert.equal(sandbox.page.url(), rankingUrl);
  assert.equal(sandbox.events.filter((event) => event === 'return-home').length, 1);
  assertReadOnly(sandbox);
});

test('ranking route still stops on a second current price before selecting any product', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl });
  const price = sandbox.document().createElement('span');
  price.textContent = '6,990원';
  sandbox.document().querySelector('[data-fixture="product-card"]')!.append(price);
  await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(), /AF:.*현재 표시 가격 하나/);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('detail DOM recognizes sold-out status outside the price panel and ignores seller images and non-sale amounts', async () => {
  const sandbox = domSandbox({ detailSoldOut: true });
  const panel = sandbox.document().querySelector('[data-fixture="price-panel"]')!;
  const status = sandbox.document().querySelector('main [role="status"]')!;
  assert.equal(panel.contains(status), false);
  assert.equal(normalize(status.textContent), '', 'The observed status is conveyed by aria-label, not visible text');
  const plan = await sandbox.runner<ScanPlan>(buildScanPlanScript());
  assertScannedProduct(plan.products, wipes, true);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(sandbox.clicks, []);
  assert.ok(!sandbox.events.includes('return-home'));
  assertReadOnly(sandbox);
});

test('observed detail title classes also match origin metadata without making it a second product name', async () => {
  const sandbox = domSandbox();
  assert.deepEqual(
    [...sandbox.document().querySelectorAll('span.pc14-wed5fi0.xh8yej3')].map((element) => normalize(element.textContent)),
    [wipes.name, '원산지: 상세페이지 참조'],
  );
  const originalPrice = sandbox.document().querySelector('span.xmqliwb') as HTMLElement;
  assert.equal(originalPrice.style.textDecorationLine, 'line-through');
  assertScannedProduct(await new BrowserAutomation(sandbox.runner).scanProducts(), wipes, false);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('detail still rejects unrelated title candidates instead of silently ignoring ambiguous names', async () => {
  for (const text of ['추가 상품 제목', '제조사: 검증 판매자', '원산지 표시 상품, 1개']) {
    const sandbox = domSandbox();
    const title = sandbox.document().createElement('span');
    title.className = 'pc14-wed5fi0 xh8yej3';
    title.textContent = text;
    sandbox.document().querySelector('[data-fixture="price-panel"]')!.append(title);
    await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(), /AF:.*개별 상품 영역/);
    assert.deepEqual(sandbox.clicks, []);
    assertReadOnly(sandbox);
  }
});

test('origin metadata exclusion does not discard a heading that could identify another product', async () => {
  const sandbox = domSandbox();
  const title = sandbox.document().createElement('h2');
  title.textContent = '원산지: 상세페이지 참조';
  sandbox.document().querySelector('[data-fixture="price-panel"]')!.append(title);
  await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(), /AF:.*개별 상품 영역/);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('available detail DOM keeps the sale price after suffix commission and the observed 펙 unit-price label are removed', async () => {
  const sandbox = domSandbox({ product: soup });
  assertScannedProduct(await new BrowserAutomation(sandbox.runner).scanProducts(), soup, false);
  assert.deepEqual(sandbox.clicks, []);
  assert.equal(sandbox.page.url(), sourceUrl(soup));
  assertReadOnly(sandbox);
});

test('real DOM preflight verifies the available detail without mutating saved input or issuing a link', async () => {
  const sandbox = domSandbox({ product: soup });
  const saved: Product = Object.freeze({
    id: soup.id, name: soup.name, sourceUrl: sourceUrl(soup), price: soup.price, soldOut: false,
    checkedAt: '2026-01-02T03:04:05.000Z', facts: '합성 상품의 사용자 메모', shareUrl: 'https://toss.im/_m/synthetic-dom',
  });
  const before = structuredClone(saved);
  await new BrowserAutomation(sandbox.runner).verifyProduct(saved);
  assert.deepEqual(saved, before);
  assert.deepEqual(sandbox.evaluations.map((evaluation) => evaluation.input), [{ detail: true, expectedName: soup.name }]);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('real DOM preflight stops on out-of-panel sold-out status before any link or clipboard operation', async () => {
  const sandbox = domSandbox({ detailSoldOut: true });
  const saved: Product = {
    id: wipes.id, name: wipes.name, sourceUrl: sourceUrl(wipes), price: wipes.price, soldOut: false,
    checkedAt: '2026-01-02T03:04:05.000Z', facts: '', shareUrl: '',
  };
  const before = structuredClone(saved);
  await assert.rejects(new BrowserAutomation(sandbox.runner).verifyProduct(saved), /AF:.*품절/);
  assert.deepEqual(saved, before);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('detail DOM rejects an unrelated second visible price instead of guessing the sale price', async () => {
  const sandbox = domSandbox({ extraPrice: '6,990원' });
  await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(), /AF:.*현재 표시 가격 하나/);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('displayed-price parsing strips suffix commission before sale price and accepts observed 입 and 펙 unit labels', () => {
  assert.equal(parseDisplayedPrice('680원 수익 8,500원'), '8,500원');
  assert.equal(parseDisplayedPrice('개당 680원 수익 [상품명] 8,500원 1 펙 당 1,910원'), '8,500원');
  assert.equal(parseDisplayedPrice('개당 399원 수익 [상품명] 4,990원 1 입 당 5원'), '4,990원');
  assert.equal(parseDisplayedPrice('개당 680원 수익 8,500원 1 펙 당 1,910원 9,900원'), null);
  assert.equal(parseDisplayedPrice('개당 399원 수익 4,990원 1 입 당 5원 6,990원'), null);
});

test('exact observed ranking card readable text already has one unambiguous current price', () => {
  const name = '스파클 생수, 무라벨, 2L, 30개';
  const text = '선착순특가 지금   30일 내 최저가 예요 스파클 생수, 무라벨, 2L, 30개 11,810원 4.8  ( 10,922 ) 내일출발 베스트판매자 링크 발급';
  assert.equal(parseDisplayedPrice(text), '11,810원');
  assert.equal(parseDisplayedPrice(text.replace(name, ' [상품명] ')), '11,810원');
  assert.equal(parseDisplayedPrice(text + ' 12,900원'), null);
});
