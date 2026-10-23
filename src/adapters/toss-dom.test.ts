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
const tablets: FixtureProduct = {
  id: '900000003', name: '검증 정제, 180정', price: '32,160원',
  originalPrice: '44,900원', commission: '2,573원', unitPrice: '1 정 당 179원',
};
const homeUrl = 'https://sharelink.toss.im/home';
const rankingUrl = 'https://sharelink.toss.im/links/best-ranking';
const sourceUrl = (product: FixtureProduct) => `https://sharelink.toss.im/links/products/${product.id}`;
const normalize = (value: string | null) => (value ?? '').replace(/\s+/g, ' ').trim();
const accessibleName = (element: Element) => normalize(element.getAttribute('aria-label') || element.textContent);
const htmlText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

interface FixtureSection { name: string; products: FixtureProduct[]; knownIds?: boolean; rankControl?: boolean; imageOnlyControl?: boolean }

function homeHtml(products: FixtureProduct[], soldOut: boolean, sections?: FixtureSection[]): string {
  const cards = (products: FixtureProduct[], knownIds = false, rankControl = false, imageOnlyControl = false) => products.map(product => {
    const name = htmlText(`${product.name}${soldOut ? ', 품절' : ''}`);
    const image = '<img src="https://example.invalid/product.png">';
    const text = `<span>선착순특가</span><span>개당 ${product.commission} 수익</span><span>${htmlText(product.name)}</span><span>${product.price}</span>`;
    const issue = '<div><button>링크 발급</button></div>';
    // Observed rank/image control and full-content control are siblings of the same one-issue root.
    const content = rankControl ? `<button aria-label="${name}">1${image}</button><div><button aria-label="${name}">${text}</button>${issue}</div>`
      : imageOnlyControl ? `<button aria-label="${name}"></button><div>${image}<div>${text}${issue}</div></div>`
      : `<button aria-label="${name}">${image}${text}</button>${issue}`;
    return `<div data-fixture="product-card" data-product-id="${product.id}">${content}${knownIds ? `<a href="${sourceUrl(product)}">상세</a>` : ''}</div>`;
  }).join('');
  return `<!doctype html><html><head><title>토스쇼핑 쉐어링크</title></head><body>
    <main>${sections ? sections.map(section => `<section data-sentry-component="ModuleSection">
      <div><span data-sentry-component="ModuleTitle"><span>${htmlText(section.name)}</span></span>
      <button aria-label="${htmlText(section.name)} 설명 보기">설명</button></div>
      ${cards(section.products, section.knownIds, section.rankControl, section.imageOnlyControl)}</section>`).join('') : cards(products)}</main>
  </body></html>`;
}

function detailHtml(product: FixtureProduct, soldOut: boolean, extraPrice = ''): string {
  return `<!doctype html><html><head><title>토스쇼핑 쉐어링크</title></head><body>
    <main>
      ${soldOut ? '<div role="status" aria-label="품절. 상품이 재입고되면 구매할 수 있어요"></div>' : ''}
      <section>
        <div data-sentry-component="ProductImageColumn" data-sentry-source-file="product-detail-page.tsx">
          <img src="https://example.invalid/product.png"><img src="https://example.invalid/seller-logo.png">
          <div><span>다른 구성의 참고 금액은 19,700원입니다.</span></div>
        </div>
        <div data-fixture="price-panel">
          <span class="pc14-wed5fi0 xh8yej3" data-sentry-element="Txt" data-sentry-source-file="product-detail-page.tsx">${htmlText(product.name)}</span>
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
  products?: FixtureProduct[];
  detailProduct?: FixtureProduct;
  beforeProductLookup?: (document: Document) => void;
  home?: boolean;
  listUrl?: string;
  homeSoldOut?: boolean;
  detailSoldOut?: boolean;
  extraPrice?: string;
  sections?: FixtureSection[];
  workTab?: boolean;
}

interface FixtureLocator {
  count(): Promise<number>;
  click(): Promise<void>;
  first(): { waitFor(options: { state: string; timeout: number }): Promise<void> };
  nth(index: number): { click(): Promise<void> };
}

function domSandbox(options: SandboxOptions = {}) {
  const product = options.product ?? wipes;
  const { beforeProductLookup, detailProduct, detailSoldOut = false, extraPrice } = options;
  const knownProducts = options.sections?.flatMap(section => section.products) ?? options.products ?? [product];
  let home = homeHtml(knownProducts, options.homeSoldOut ?? false, options.sections);
  const detail = detailHtml(product, options.detailSoldOut ?? false, options.extraPrice);
  const listUrl = options.listUrl ?? homeUrl;
  let currentUrl = options.home ? listUrl : sourceUrl(product);
  const events: string[] = [];
  const clicks: Array<{ name: string; text: string; sectionName: string }> = [];
  const evaluations: Array<{ url: string; input: unknown }> = [];
  const sideEffects: string[] = [];
  let navigationSequence = 0;
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
  const roleLocator = (resolve: () => Element[], role: string, control: { name: string; exact: boolean }): FixtureLocator => {
    assert.equal(role, 'button');
    assert.equal(control.exact, true);
    assert.equal(control.name, '링크 발급', 'Only readiness uses page.getByRole; product controls use node-token CSS');
    return locator(() => resolve().filter(element => accessibleName(element) === control.name));
  };
  const locator = (resolve: () => Element[]): FixtureLocator => ({
    count: async () => new Set(resolve()).size,
    first: () => ({ waitFor: async wait => {
      assert.equal(wait.state, 'visible');
      assert.ok(wait.timeout > 0);
      const first = resolve()[0];
      assert.ok(first, 'The real DOM must contain the issue button before extraction');
      assert.notEqual((first as HTMLElement).style.display, 'none');
      assert.ok(first.getClientRects().length > 0);
      events.push('ready');
    } }),
    nth: () => ({ click: async () => forbid('positional click') }),
    click: async () => {
      const elements = [...new Set(resolve())];
      assert.equal(elements.length, 1, 'A scoped product click must resolve to one current control');
      const element = elements[0]!;
      assert.notEqual(accessibleName(element), '링크 발급', 'Read-only tests cannot issue links');
      assert.equal(currentUrl, listUrl, 'Only opening a product from the verified list UI is allowed');
      const selected = knownProducts.find(candidate => candidate.id === element.closest('[data-product-id]')?.getAttribute('data-product-id'));
      assert.ok(selected, 'The named control must belong to a known fixture product');
      clicks.push({ name: accessibleName(element), text: normalize(element.textContent),
        sectionName: normalize(element.closest('section')?.querySelector('[data-sentry-component="ModuleTitle"]')?.textContent ?? '') });
      events.push('open-detail');
      const opened = detailProduct ?? selected;
      currentUrl = sourceUrl(opened);
      window = load(detailHtml(opened, detailSoldOut, extraPrice));
    },
  });
  const page = {
    url: () => currentUrl,
    title: async () => window.document.title,
    getByRole: (role: string, control: { name: string; exact: boolean }) => roleLocator(
      () => [...window.document.querySelectorAll('button, [role="button"]')], role, control),
    evaluate: async (callback: (...args: never[]) => unknown, arg?: unknown) => {
      const input = structuredClone(arg);
      const before = structuredClone(input);
      evaluations.push({ url: currentUrl, input: before });
      // Run the actual generated callback with its serialized input, never canned product records.
      const result = await runInNewContext(`(${callback.toString()})(__input)`, {
        document: window.document,
        Node: window.Node,
        crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++navigationSequence).padStart(12, '0')}` },
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
    locator: (selector: string) => {
      assert.ok(selector === 'main' || selector.startsWith('main section:has(') || selector.startsWith('main [data-auto-flow-control='),
        'DOM product lookup must use a page-level CSS selector');
      if (selector.includes('[data-auto-flow-control=')) beforeProductLookup?.(window.document);
      return locator(() => [...window.document.querySelectorAll(selector)]);
    },
    goto: async (url: string) => {
      assert.equal(url, listUrl, 'Collection may restore only its original verified list URL');
      assert.ok(knownProducts.some(candidate => currentUrl === sourceUrl(candidate)), 'Return navigation must start from an opened product detail');
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
    openTab: async (url: string) => {
      if (!options.workTab) return forbid('opening a tab');
      assert.equal(url, rankingUrl);
      assert.equal(currentUrl, rankingUrl);
      events.push('open-work-tab');
      return page;
    },
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
  return { runner, events, clicks, evaluations, sideEffects, page, document: () => window.document,
    setListProducts: (products: FixtureProduct[]) => {
      assert.equal(currentUrl, listUrl);
      home = homeHtml(products, options.homeSoldOut ?? false);
      window = load(home);
    },
    setListSections: (sections: FixtureSection[]) => {
      assert.equal(currentUrl, listUrl);
      home = homeHtml(knownProducts, options.homeSoldOut ?? false, sections);
      window = load(home);
    } };
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
  const { products, skipped } = await new BrowserAutomation(sandbox.runner).scanProducts();
  assert.deepEqual(skipped, []);
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
    products: [], candidates: [{ name: wipes.name, sourceUrl: '', originalUrl: rankingUrl, sectionName: '', price: wipes.price }],
  });
  assert.deepEqual(sandbox.clicks, []);
  assertScannedProduct((await new BrowserAutomation(sandbox.runner).scanProducts()).products, wipes, true);
  assert.equal(sandbox.clicks.length, 1);
  assert.equal(sandbox.page.url(), rankingUrl);
  assert.equal(sandbox.events.filter((event) => event === 'return-home').length, 1);
  assertReadOnly(sandbox);
});

test('a missing planned ranking candidate is isolated while the remaining real DOM product is verified', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, products: [wipes, soup] });
  let calls = 0;
  const runner: AsideRunner = async <T>(script: string) => {
    const result = await sandbox.runner<T>(script);
    if (++calls === 1) sandbox.setListProducts([soup]);
    return result;
  };
  const saved: Product[] = [];
  const result = await new BrowserAutomation(runner).scanProducts(item => saved.push(item));
  assertScannedProduct(result.products, soup, false);
  assert.deepEqual(result.skipped, [{ name: wipes.name, reason: 'missing' }]);
  assert.deepEqual(saved, result.products);
  assert.deepEqual(sandbox.clicks.map(click => click.name), [soup.name]);
  assert.equal(calls, 3, 'A missing candidate is not retried and the next candidate still runs');
  assertReadOnly(sandbox);
});

test('all planned candidates absent from a still-valid ranking list produce only explicit missing outcomes', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, products: [wipes, soup] });
  let calls = 0;
  const runner: AsideRunner = async <T>(script: string) => {
    const result = await sandbox.runner<T>(script);
    if (++calls === 1) sandbox.setListProducts([tablets]);
    return result;
  };
  const result = await new BrowserAutomation(runner).scanProducts(() => assert.fail('Missing products must not be saved'));
  assert.deepEqual(result, { products: [], skipped: [
    { name: wipes.name, reason: 'missing' }, { name: soup.name, reason: 'missing' },
  ] });
  assert.equal(calls, 3);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('ranking reorder between extraction and click uses exact product names, never the earlier control index', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, products: [wipes, soup],
    beforeProductLookup: document => {
      const list = document.querySelector('main')!;
      list.prepend(list.lastElementChild!);
    },
  });
  const result = await new BrowserAutomation(sandbox.runner).scanProducts();
  assert.deepEqual(result.products.map(product => product.id), [wipes.id, soup.id]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(sandbox.clicks.map(click => click.name), [wipes.name, soup.name]);
  assertReadOnly(sandbox);
});

test('a named control disappearing after extraction is skipped only after a fresh list proves the product absent', async () => {
  let removed = false;
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, products: [wipes, soup],
    beforeProductLookup: document => {
      if (removed) return;
      document.querySelector(`[data-product-id="${wipes.id}"]`)!.remove();
      removed = true;
    },
  });
  const result = await new BrowserAutomation(sandbox.runner).scanProducts();
  assertScannedProduct(result.products, soup, false);
  assert.deepEqual(result.skipped, [{ name: wipes.name, reason: 'missing' }]);
  assert.deepEqual(sandbox.clicks.map(click => click.name), [soup.name]);
  assertReadOnly(sandbox);
});

test('a duplicate named control outside the verified card is not used as a product substitute', async () => {
  const sandbox = domSandbox({ home: true, products: [wipes, soup],
    beforeProductLookup: document => {
      const button = document.querySelector(`[data-product-id="${wipes.id}"] button`)!;
      const duplicate = button.cloneNode(true) as Element;
      duplicate.removeAttribute('data-auto-flow-control');
      document.querySelector('main')!.append(duplicate);
    },
  });
  const result = await new BrowserAutomation(sandbox.runner).scanProducts();
  assert.deepEqual(result.products.map(product => product.id), [wipes.id, soup.id]);
  assert.deepEqual(sandbox.clicks.map(click => click.name), [wipes.name, soup.name]);
  assertReadOnly(sandbox);
});

test('a duplicated verified node token aborts instead of clicking the first matching control', async () => {
  const sandbox = domSandbox({ home: true, products: [wipes], beforeProductLookup: document => {
    const button = document.querySelector(`[data-product-id="${wipes.id}"] button`)!;
    document.querySelector('main')!.append(button.cloneNode(true));
  } });
  await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(), /AF:.*같은 상품명의 버튼/);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

const dailySection = '오늘만 이 가격에 살 수 있는 하루특가';
const bestSection = '지금 많이 팔리는 BEST';

test('repeated unknown-ID presentations retain observed section identity and verify each detail before ID deduplication', async () => {
  const sections = [{ name: dailySection, products: [wipes] }, { name: bestSection, products: [wipes] }];
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections });
  const plan = await sandbox.runner<ScanPlan>(buildScanPlanScript());
  assert.deepEqual(plan.candidates, sections.map(section => ({
    name: wipes.name, sourceUrl: '', originalUrl: rankingUrl, sectionName: section.name, price: wipes.price,
  })));
  const result = await new BrowserAutomation(sandbox.runner).scanProducts();
  assertScannedProduct(result.products, wipes, false);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(sandbox.clicks.map(click => click.sectionName), [dailySection, bestSection]);
  assertReadOnly(sandbox);
});

test('same names in separate sections keep different known IDs distinct and permit repeated equal known IDs', async () => {
  for (const second of [wipes, { ...wipes, id: tablets.id }]) {
    const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [
      { name: dailySection, products: [wipes], knownIds: true },
      { name: bestSection, products: [second], knownIds: true },
    ] });
    const result = await new BrowserAutomation(sandbox.runner).scanProducts();
    assert.deepEqual(result.products.map(product => product.id), [...new Set([wipes.id, second.id])]);
    assert.deepEqual(sandbox.clicks.map(click => click.sectionName), [dailySection, bestSection]);
    assertReadOnly(sandbox);
  }
});

test('unknown same-name products in separate sections are not collapsed before their distinct detail IDs are observed', async () => {
  const second = { ...wipes, id: tablets.id };
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [
    { name: dailySection, products: [wipes] }, { name: bestSection, products: [second] },
  ] });
  const result = await new BrowserAutomation(sandbox.runner).scanProducts();
  assert.deepEqual(result.products.map(product => product.id), [wipes.id, second.id]);
  assert.deepEqual(sandbox.clicks.map(click => click.sectionName), [dailySection, bestSection]);
  assertReadOnly(sandbox);
});

test('same-name cards with unknown or known IDs inside one section are rejected before any navigation', async () => {
  for (const knownIds of [false, true]) {
    const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [
      { name: bestSection, products: [wipes, { ...wipes, id: tablets.id }], knownIds },
    ] });
    await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(), /AF:.*같은 영역에 같은 상품명의 카드/);
    assert.deepEqual(sandbox.clicks, []);
    assertReadOnly(sandbox);
  }
});

test('rank-only and full-name controls in one card resolve to the unique full-name control', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [
    { name: bestSection, products: [wipes], rankControl: true },
  ] });
  assertScannedProduct((await new BrowserAutomation(sandbox.runner).scanProducts()).products, wipes, false);
  assert.equal(sandbox.clicks.length, 1);
  assert.ok(sandbox.clicks[0]!.text.includes(wipes.name));
  assert.notEqual(sandbox.clicks[0]!.text, '1');
  assertReadOnly(sandbox);
});

test('node-token CSS keeps single, double and mixed quotes in section and product names literal', async () => {
  for (const quote of ["'", '"', `'"`]) {
    const sectionName = `검증 ${quote} 영역`;
    const named = { ...wipes, name: `검증 ${quote} 물티슈, 100매, 10팩` };
    const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [
      { name: sectionName, products: [named], rankControl: true },
      { name: bestSection, products: [named], rankControl: true },
    ] });
    const result = await new BrowserAutomation(sandbox.runner).scanProducts();
    assertScannedProduct(result.products, named, false);
    assert.deepEqual(sandbox.clicks.map(click => click.sectionName), [sectionName, bestSection]);
    assert.ok(sandbox.clicks.every(click => click.text.includes(named.name)));
    assertReadOnly(sandbox);
  }
});

test('an observed empty image-overlay name control is usable only inside its verified one-issue root', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [
    { name: '최저가 상품만 모았어요', products: [wipes], imageOnlyControl: true },
  ] });
  assertScannedProduct((await new BrowserAutomation(sandbox.runner).scanProducts()).products, wipes, false);
  assert.equal(sandbox.clicks.length, 1);
  assert.equal(sandbox.clicks[0]!.text, '');
  assertReadOnly(sandbox);
});

test('two full-content controls in one verified card remain ambiguous instead of using the first', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [{ name: bestSection, products: [wipes] }] });
  const card = sandbox.document().querySelector('[data-fixture="product-card"]')!;
  card.append(card.querySelector('button')!.cloneNode(true));
  await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(), /AF:.*상품명 버튼/);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('reordering sections and cards between extraction and click never changes the selected semantic section', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [
    { name: dailySection, products: [wipes, soup] }, { name: bestSection, products: [wipes] },
  ], beforeProductLookup: document => {
    const main = document.querySelector('main')!;
    main.prepend(main.lastElementChild!);
    for (const section of main.querySelectorAll('section')) section.append(section.querySelector('[data-fixture="product-card"]')!);
  } });
  const result = await new BrowserAutomation(sandbox.runner).scanProducts();
  assert.deepEqual(result.products.map(product => product.id), [wipes.id, soup.id]);
  assert.deepEqual(sandbox.clicks.map(click => click.sectionName), [dailySection, dailySection, bestSection]);
  assertReadOnly(sandbox);
});

test('a missing original section never falls back to a same-name card in another section', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [
    { name: dailySection, products: [wipes] }, { name: bestSection, products: [wipes] },
  ] });
  let calls = 0;
  const runner: AsideRunner = async <T>(script: string) => {
    const result = await sandbox.runner<T>(script);
    if (++calls === 1) sandbox.setListSections([{ name: bestSection, products: [wipes] }]);
    return result;
  };
  await assert.rejects(new BrowserAutomation(runner).scanProducts(), /AF:.*상품 영역이 사라졌습니다/);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('a missing card in a still-present empty section is skipped without selecting its presentation elsewhere', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [
    { name: dailySection, products: [wipes] }, { name: bestSection, products: [wipes] },
  ] });
  let calls = 0;
  const runner: AsideRunner = async <T>(script: string) => {
    const result = await sandbox.runner<T>(script);
    if (++calls === 1) sandbox.setListSections([
      { name: dailySection, products: [] }, { name: bestSection, products: [wipes] },
    ]);
    return result;
  };
  const result = await new BrowserAutomation(runner).scanProducts();
  assertScannedProduct(result.products, wipes, false);
  assert.deepEqual(result.skipped, [{ name: wipes.name, reason: 'missing' }]);
  assert.deepEqual(sandbox.clicks.map(click => click.sectionName), [bestSection]);
  assertReadOnly(sandbox);
});

test('observed section heading and guide must agree instead of inventing a section identity', async () => {
  for (const change of ['missing', 'conflicting']) {
    const sandbox = domSandbox({ home: true, listUrl: rankingUrl, sections: [{ name: bestSection, products: [wipes] }] });
    const title = sandbox.document().querySelector('[data-sentry-component="ModuleTitle"]')!;
    if (change === 'missing') title.remove();
    else title.textContent = dailySection;
    await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(), /AF:.*개별 상품 영역/);
    assert.deepEqual(sandbox.clicks, []);
    assertReadOnly(sandbox);
  }
});

test('card and detail price changes fail before collection callbacks or return navigation', async () => {
  const sandbox = domSandbox({ home: true, detailProduct: { ...wipes, price: '5,990원' } });
  await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(() => assert.fail('A changed price cannot be saved')), /AF:.*상품 가격이 다릅니다/);
  assert.equal(sandbox.clicks.length, 1);
  assert.ok(!sandbox.events.includes('return-home'));
  assertReadOnly(sandbox);
});

test('work-tab preflight uses a canonical verified section for equal unknown-ID presentations without issuance', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, workTab: true, sections: [
    { name: bestSection, products: [wipes], rankControl: true }, { name: dailySection, products: [wipes] },
  ] });
  const saved: Product = { ...wipes, sourceUrl: sourceUrl(wipes), checkedAt: '2026-01-02T03:04:05.000Z', soldOut: false, facts: '', shareUrl: '' };
  await new BrowserAutomation(sandbox.runner, true).verifyProduct(saved);
  assert.equal(sandbox.clicks.length, 1);
  assert.equal(sandbox.clicks[0]!.sectionName, [dailySection, bestSection].sort()[0]);
  assert.equal(sandbox.page.url(), sourceUrl(wipes));
  assertReadOnly(sandbox);
});

test('work-tab preflight rejects mixed known IDs, conflicting unknown prices and clicked detail ID substitutions', async () => {
  const saved: Product = { ...wipes, sourceUrl: sourceUrl(wipes), checkedAt: '2026-01-02T03:04:05.000Z', soldOut: false, facts: '', shareUrl: '' };
  for (const variant of ['mixed', 'price', 'detail-id']) {
    const sandbox = domSandbox({ home: true, listUrl: rankingUrl, workTab: true,
      detailProduct: variant === 'detail-id' ? { ...wipes, id: tablets.id } : undefined,
      sections: [
        { name: dailySection, products: [wipes], knownIds: variant === 'mixed' },
        { name: bestSection, products: [{ ...wipes, price: variant === 'price' ? '5,990원' : wipes.price }] },
      ],
    });
    await assert.rejects(new BrowserAutomation(sandbox.runner, true).verifyProduct(saved), /AF:.*(?:ID|가격)/);
    assert.equal(sandbox.clicks.length, variant === 'detail-id' ? 1 : 0);
    assertReadOnly(sandbox);
  }
});

test('a stale control with the product still present is not falsely reported as missing', async () => {
  const sandbox = domSandbox({ home: true, products: [wipes, soup],
    beforeProductLookup: document => {
      const button = document.querySelector(`[data-product-id="${wipes.id}"] button`)!;
      const heading = document.createElement('h2');
      heading.innerHTML = button.innerHTML;
      heading.setAttribute('aria-label', wipes.name);
      button.replaceWith(heading);
    },
  });
  await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(() => assert.fail('An unproven stale product cannot be saved')), /AF:.*상품명 버튼이 바뀌었습니다/);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('known card IDs and detail names must match; identity conflicts are fatal rather than missing', async () => {
  for (const opened of [soup, { ...wipes, id: soup.id }]) {
    const sandbox = domSandbox({ home: true, detailProduct: opened });
    const link = sandbox.document().createElement('a');
    link.href = sourceUrl(wipes);
    link.textContent = '상세';
    sandbox.document().querySelector('[data-fixture="product-card"]')!.append(link);
    await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(() => assert.fail('A substituted product cannot be saved')), /AF:.*상품 ID/);
    assert.equal(sandbox.clicks.length, 1);
    assert.equal(sandbox.page.url(), sourceUrl(opened));
    assertReadOnly(sandbox);
  }
  const sandbox = domSandbox({ home: true, detailProduct: { ...soup, id: wipes.id } });
  await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(() => assert.fail('A renamed product cannot be saved')), /AF:.*개별 상품 영역|AF:.*상품명/);
  assert.equal(sandbox.clicks.length, 1);
  assertReadOnly(sandbox);
});

test('a known ID changing on the current card is not misreported as a missing candidate', async () => {
  const sandbox = domSandbox({ home: true });
  const link = sandbox.document().createElement('a');
  link.href = sourceUrl(wipes);
  link.textContent = '상세';
  sandbox.document().querySelector('[data-fixture="product-card"]')!.append(link);
  let calls = 0;
  const runner: AsideRunner = async <T>(script: string) => {
    const result = await sandbox.runner<T>(script);
    if (++calls === 1) link.href = sourceUrl(soup);
    return result;
  };
  await assert.rejects(new BrowserAutomation(runner).scanProducts(() => assert.fail('An identity conflict cannot be saved')), /AF:.*상품 ID 또는 상품명/);
  assert.deepEqual(sandbox.clicks, []);
  assertReadOnly(sandbox);
});

test('login and permission screens during a missing candidate abort rather than produce a partial success receipt', async () => {
  for (const warning of ['로그인이 필요합니다', '접근 권한이 없습니다', 'permission denied']) {
    const sandbox = domSandbox({ home: true, products: [wipes, soup] });
    let calls = 0;
    const runner: AsideRunner = async <T>(script: string) => {
      const result = await sandbox.runner<T>(script);
      if (++calls === 1) {
        sandbox.setListProducts([soup]);
        const dialog = sandbox.document().createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.textContent = warning;
        sandbox.document().querySelector('main')!.append(dialog);
      }
      return result;
    };
    await assert.rejects(new BrowserAutomation(runner).scanProducts(() => assert.fail('Security warnings must stop collection')), /AF:.*보안 확인·로그인·이용 제한/);
    assert.deepEqual(sandbox.clicks, []);
    assert.equal(sandbox.events.filter(event => event === 'run-script').length, 2);
    assertReadOnly(sandbox);
  }
});

test('a later ambiguous price aborts collection without losing the earlier verified DOM product', async () => {
  const sandbox = domSandbox({ home: true, products: [wipes, soup] });
  let calls = 0;
  const runner: AsideRunner = async <T>(script: string) => {
    const result = await sandbox.runner<T>(script);
    if (++calls === 2) {
      const price = sandbox.document().createElement('span');
      price.textContent = '9,900원';
      sandbox.document().querySelector(`[data-product-id="${soup.id}"]`)!.append(price);
    }
    return result;
  };
  const saved: Product[] = [];
  await assert.rejects(new BrowserAutomation(runner).scanProducts(item => saved.push(item)), /AF:.*현재 표시 가격 하나/);
  assertScannedProduct(saved, wipes, false);
  assert.deepEqual(sandbox.clicks.map(click => click.name), [wipes.name]);
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

test('ranking collection excludes observed image-column description prices but verifies the separated title and stock status', async () => {
  const sandbox = domSandbox({ home: true, listUrl: rankingUrl, detailSoldOut: true });
  const runner: AsideRunner = async <T>(script: string) => {
    const result = await sandbox.runner<T>(script);
    const detail = sandbox.evaluations.find(evaluation => evaluation.url === sourceUrl(wipes));
    if (detail) assert.deepEqual(detail.input, { detail: true, expectedName: wipes.name });
    return result;
  };
  const result = await new BrowserAutomation(runner).scanProducts();
  assertScannedProduct(result.products, wipes, true);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(sandbox.clicks.map(click => click.name), [wipes.name]);
  assertReadOnly(sandbox);
});

test('description prices never replace a missing sale price or resolve conflicting visible sale prices', async () => {
  for (const missingPrice of [true, false]) {
    const sandbox = domSandbox({ extraPrice: missingPrice ? '' : '6,990원' });
    const document = sandbox.document();
    const description = document.querySelector('[data-sentry-component="ProductImageColumn"]')!;
    const panel = document.querySelector('[data-fixture="price-panel"]')!;
    assert.ok(normalize(description.textContent).includes('19,700원'));
    assert.equal(description.contains(panel), false);
    assert.equal(panel.querySelector('img'), null, 'The actual detail image is outside the name/price/issue panel');
    if (missingPrice) [...panel.querySelectorAll('span')].find(element => element.textContent === wipes.price)!.remove();
    await assert.rejects(new BrowserAutomation(sandbox.runner).scanProducts(() => assert.fail('An ambiguous or absent sale price cannot be saved')),
      /AF:.*현재 표시 가격 하나/);
    assert.deepEqual(sandbox.clicks, []);
    assertReadOnly(sandbox);
  }
});

test('observed detail title classes also match origin metadata without making it a second product name', async () => {
  const sandbox = domSandbox();
  assert.deepEqual(
    [...sandbox.document().querySelectorAll('span.pc14-wed5fi0.xh8yej3')].map((element) => normalize(element.textContent)),
    [wipes.name, '원산지: 상세페이지 참조'],
  );
  const originalPrice = sandbox.document().querySelector('span.xmqliwb') as HTMLElement;
  assert.equal(originalPrice.style.textDecorationLine, 'line-through');
  assertScannedProduct((await new BrowserAutomation(sandbox.runner).scanProducts()).products, wipes, false);
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
  assertScannedProduct((await new BrowserAutomation(sandbox.runner).scanProducts()).products, soup, false);
  assert.deepEqual(sandbox.clicks, []);
  assert.equal(sandbox.page.url(), sourceUrl(soup));
  assertReadOnly(sandbox);
});

test('the observed 정 unit-price label remains excluded without discarding the current sale price', async () => {
  const sandbox = domSandbox({ product: tablets });
  assertScannedProduct((await new BrowserAutomation(sandbox.runner).scanProducts()).products, tablets, false);
  assert.deepEqual(sandbox.clicks, []);
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
