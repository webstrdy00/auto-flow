import { isTossShareUrl, type Product } from '../shared.js';

export { isTossShareUrl } from '../shared.js';

// These parsers are deliberately closure-free: the same functions run in the app and in Aside.
export function parseTossProductUrl(value: string): { id: string; url: string } | null {
  if (!value || value !== value.trim() || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.origin !== 'https://sharelink.toss.im') return null;
    const match = /^\/links\/products\/([1-9]\d{0,29})\/?$/.exec(url.pathname);
    const tracking = ['originSurface', 'originSectionCode', 'originPosition', 'originPage', 'originRank'];
    if (!match || [...url.searchParams.keys()].some((key) => !tracking.includes(key))) return null;
    return { id: match[1]!, url: `https://sharelink.toss.im/links/products/${match[1]}` };
  } catch { return null; }
}

export function parseNaverPostUrl(value: string, blogId: string): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/.test(blogId) || !value || value !== value.trim() || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !['blog.naver.com', 'm.blog.naver.com'].includes(url.hostname)) return null;
    const path = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,49})\/([1-9]\d{0,29})\/?$/.exec(url.pathname);
    if (path && path[1] === blogId && !url.search) return `https://blog.naver.com/${blogId}/${path[2]}`;
    if (url.pathname !== '/PostView.naver' || url.searchParams.getAll('blogId').length !== 1 || url.searchParams.getAll('logNo').length !== 1) return null;
    const postId = url.searchParams.get('logNo') ?? '';
    const allowed = ['blogId', 'logNo', 'Redirect', 'redirect', 'from', 'trackingCode', 'proxyReferer'];
    if (url.searchParams.get('blogId') !== blogId || !/^[1-9]\d{0,29}$/.test(postId) || [...url.searchParams.keys()].some((key) => !allowed.includes(key))) return null;
    return `https://blog.naver.com/${blogId}/${postId}`;
  } catch { return null; }
}

export function isNaverHomeUrl(value: string): boolean {
  if (!value || value !== value.trim() || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    if (url.origin === 'https://blog.naver.com' && url.pathname === '/' && !url.search) return true;
    return url.hostname === 'section.blog.naver.com' && url.pathname === '/BlogHome.naver'
      && [...url.searchParams.keys()].every((key) => ['directoryNo', 'currentPage', 'groupId'].includes(key))
      && [...url.searchParams.values()].every((value) => /^\d{1,10}$/.test(value));
  } catch { return false; }
}

export function isThreadsPostUrl(value: string): boolean {
  if (!value || value !== value.trim() || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !url.search
      && ['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'].includes(url.hostname)
      && /^\/@[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  } catch { return false; }
}

export function parseDisplayedPrice(text: string): string | null {
  const money = '\\d[\\d,]*\\s*원';
  const labels = '(?:수익금?|적립금?|수수료|배송비)';
  const suffixLabels = '(?:수익금?|적립금?)';
  const remaining = text.normalize('NFC').replace(/\s+/g, ' ').trim()
    .replace(new RegExp(`(?:개당\\s*)?${money}\\s*${suffixLabels}(?=\\s|$|[,.])`, 'g'), ' ')
    .replace(new RegExp(`(?:예상\\s*|최대\\s*)?${labels}\\s*[:：]?\\s*${money}`, 'g'), ' ')
    .replace(new RegExp(`(?:\\d+(?:\\.\\d+)?\\s*)?(?:개|입|매|장|정|팩|펙|봉|병|통|박스|g|kg|ml|mL|L)\\s*당\\s*${money}`, 'g'), ' ');
  const values = [...remaining.matchAll(new RegExp(money, 'g'))].map((match) => match[0].replace(/\s+/g, ''));
  if (values.some((value) => !/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)원$/.test(value))) return null;
  const prices = new Set(values);
  return prices.size === 1 ? [...prices][0]! : null;
}

const parsers = [
  ['parseTossProductUrl', parseTossProductUrl], ['isTossShareUrl', isTossShareUrl],
  ['parseNaverPostUrl', parseNaverPostUrl], ['isNaverHomeUrl', isNaverHomeUrl],
  ['parseDisplayedPrice', parseDisplayedPrice],
] as const;

// Explicit JavaScript source keeps the browser functions independent of imported/module closures.
const common = String.raw`
const fail = (message) => { throw new Error('AF:' + message); };
const clean = (value) => value.normalize('NFC').replace(/\s+/g, ' ').trim();
const site = (value, channel) => {
  try {
    const url = new URL(value);
    return channel === 'toss' ? url.hostname === 'sharelink.toss.im'
      : ['blog.naver.com', 'm.blog.naver.com', 'section.blog.naver.com'].includes(url.hostname);
  } catch { return false; }
};
async function selectTab(channel, create, productId) {
  const tabs = (await listBrowserTabs()).filter((tab) => site(tab.url, channel));
  if (input.useWorkTabs === true) {
    const destination = channel === 'toss' ? 'https://sharelink.toss.im/links/best-ranking' : 'https://blog.naver.com/';
    if (channel === 'toss' && input.product) {
      const source = parseTossProductUrl(input.product.sourceUrl);
      if (!source || source.id !== input.product.id) fail('작업 탭의 상품 주소와 ID가 다릅니다.');
    }
    return await openTab(destination);
  }
  const exact = productId ? tabs.filter((tab) => parseTossProductUrl(tab.url)?.id === productId) : [];
  const candidates = exact.length ? exact : tabs;
  const focused = candidates.filter((tab) => tab.active === true && tab.focusedWindow === true);
  const active = candidates.filter((tab) => tab.active === true);
  const preferred = focused.length === 1 ? focused : focused.length === 0 && active.length === 1 ? active : [];
  if (candidates.length > 1 && preferred.length !== 1) fail('같은 사이트의 대상 탭이 여러 개입니다. Aside 창에서 사용할 탭을 직접 선택한 뒤 다시 연결하세요.');
  const selected = candidates.length === 1 ? candidates[0] : preferred[0];
  if (selected) {
    let metadata;
    try {
      const patterns = channel === 'toss' ? ['https://sharelink.toss.im/*']
        : ['https://blog.naver.com/*', 'https://m.blog.naver.com/*', 'https://section.blog.naver.com/*'];
      metadata = await chrome.tabs.query({ url: patterns });
    } catch { fail('Aside 탭 상태를 읽지 못했습니다. Aside 앱과 CLI 연결을 확인하세요.'); }
    const matches = metadata.filter((tab) => tab.url === selected.url && tab.windowId === selected.windowId
      && (selected.active === undefined || tab.active === selected.active));
    if (matches.length !== 1) fail('선택한 탭의 상태가 바뀌었거나 모호합니다. Aside에서 대상 탭을 선택하고 다시 연결하세요.');
    if (matches[0].discarded === true || matches[0].status === 'unloaded') {
      fail('선택한 Aside 탭이 절전으로 언로드되어 있습니다. Aside에서 해당 탭을 직접 클릭해 페이지가 표시된 뒤 다시 연결하세요. 자동으로 깨우거나 재시도하지 않습니다.');
    }
    if (matches[0].status !== 'complete') fail('선택한 Aside 탭이 아직 로딩 중입니다. 페이지가 표시된 뒤 다시 연결하세요.');
    return await attachBrowserTab(selected.targetId);
  }
  if (!create) fail('Aside에서 토스에 로그인하고 원하는 상품 목록 또는 상품 상세 탭을 열어 주세요.');
  return await openTab(channel === 'toss' ? 'https://sharelink.toss.im/home' : 'https://blog.naver.com/');
}
async function observe(page, channel) {
  let url;
  try { url = new URL(page.url()); } catch { fail('대상 페이지 주소를 확인할 수 없습니다.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !site(url.href, channel)
    || /login|captcha|challenge/i.test(url.pathname)) fail('대상 사이트 또는 로그인 상태가 바뀌었습니다. Aside에서 직접 확인해 주세요.');
  const knownPath = channel === 'toss' ? /^\/(?:home\/?|links\/best-ranking|links\/products\/[1-9]\d{0,29}\/?|)$/.test(url.pathname)
    : isNaverHomeUrl(url.href) || (url.hostname === 'blog.naver.com' && (/^\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}(?:\/[1-9]\d{0,29})?\/?$/.test(url.pathname)
      || /^\/(?:PostList|PostView|PostWriteForm|GoBlogWrite|MyBlog)\.naver$/.test(url.pathname)));
  if (!knownPath || !clean(await page.title())) fail('지원되는 대상 화면과 제목을 확인할 수 없습니다. Aside에서 대상 화면을 열어 주세요.');
  // Read scoped controls only: the Toss homepage also contains private settlement data.
  const view = await snapshot(page, { interactive: true, selector: 'button, [role="button"], a[href], [role="dialog"], iframe' });
  if (/(?:자동입력 방지|보안 확인|본인 인증|오늘 조회 한도를 모두 사용|쉐어링크 발급이 제한|로그인이 필요|nid\.naver\.com|captcha|challenge)/i.test(view.tree)) {
    fail('보안 확인·로그인·이용 제한을 감지했습니다. 자동 우회하지 않으며 수동 확인이 필요합니다.');
  }
  return url.href;
}
async function navigate(page, channel, url) {
  await observe(page, channel);
  await page.goto(url);
  await observe(page, channel);
}
`;

// The issue/name controls, detail title classes and numeric detail route were observed.
// Every bounded product region must still be unambiguous; an unrecognized layout stops the operation.
const toss = String.raw`
async function regions(page, detail, expectedName = '') {
  await page.getByRole('button', { name: '링크 발급', exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
  const found = await page.evaluate(({ detail, expectedName }) => {
    const normalize = (text) => (text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const issueSelector = 'button, [role="button"]';
    const nameSelector = 'button, [role="button"], a[href], h1, h2, h3, [data-testid="product-name"], [data-testid="product-title"], [class*="productName"], [class*="product-name"], [class*="product_title"], img[alt]'
      + (detail ? (expectedName ? ', span' : ', span.pc14-wed5fi0.xh8yej3') : '');
    const controls = [...document.querySelectorAll(issueSelector)];
    const nameControls = [...document.querySelectorAll(nameSelector)];
    const issues = controls.filter((element) => visible(element) && normalize(element.textContent) === '링크 발급');
    if (issues.length > 100 || (detail && issues.length !== 1)) return null;
    const unavailable = /품절|판매\s*(?:종료|중지)|구매\s*불가/;
    const detailUnavailable = detail && [...document.querySelectorAll('main [role="status"]')].some((element) =>
      visible(element) && unavailable.test((element.getAttribute('aria-label') ?? '') + ' ' + (element.textContent ?? '')));
    const readable = (element) => {
      const parts = [];
      const visit = (root) => {
        const style = getComputedStyle(root);
        if (root.matches('del, s, [aria-hidden="true"]') || !visible(root) || style.textDecorationLine.includes('line-through')) return;
        for (const node of root.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
          else if (node.nodeType === Node.ELEMENT_NODE) visit(node);
        }
      };
      visit(element);
      return normalize(parts.join(' '));
    };
    const result = [];
    for (const issue of issues.slice(0, 20)) {
      let card = null;
      let root = issue.parentElement;
      for (let depth = 0; root && depth < 10; depth += 1, root = root.parentElement) {
        if (['BODY', 'HTML'].includes(root.tagName) || root.matches('#root, #app, #__next') || (!detail && root.tagName === 'MAIN')) break;
        if (root.querySelector('nav, header, footer, aside, [role="navigation"]')) break;
        if ([...root.querySelectorAll(issueSelector)].filter((element) => visible(element) && normalize(element.textContent) === '링크 발급').length !== 1) break;
        if (!root.querySelector('img, [role="img"]')) continue;
        const names = new Map();
        for (const element of root.querySelectorAll(nameSelector)) {
          if (!visible(element)) continue;
          const accessibleName = element.getAttribute('aria-label');
          const name = normalize(accessibleName || (element.tagName === 'IMG' ? element.getAttribute('alt') : element.textContent))
            .replace(/,\s*품절$/, '');
          if (name.length < 4 || name.length > 500 || /링크 발급/.test(name)
            || /^(?:공유|더보기|자세히 보기|찜하기|토스 앱에서 보기|상품 이미지|대표 이미지|상세 이미지|선착순특가)$/.test(name)) continue;
          // The observed origin metadata shares the detail title's span classes.
          if (detail && element.matches('span.pc14-wed5fi0.xh8yej3') && name.startsWith('원산지:')) continue;
          if (expectedName && name !== normalize(expectedName)) continue;
          // Prefer the observed full-name button/link to a redundant image alt.
          if (!names.has(name) || element.matches('button, [role="button"], a[href]')) names.set(name, element);
        }
        if (names.size !== 1) continue;
        const [name, nameElement] = [...names][0];
        const text = readable(root);
        if (text.length > (detail ? 6000 : 5000)) continue;
        const links = [...root.querySelectorAll('a[href]')];
        if (links.length > 20) continue;
        card = {
          name, priceText: text.replace(name, ' [상품명] '), soldOut: detailUnavailable || unavailable.test(text)
            || unavailable.test(nameElement.getAttribute('aria-label') ?? ''),
          hrefs: links.map((link) => link.href).filter((href) => href.length <= 2048),
          nameIndex: nameControls.indexOf(nameElement), canNavigate: nameElement.matches('button, [role="button"]'),
          issueIndex: controls.indexOf(issue), enabled: !issue.disabled && issue.getAttribute('aria-disabled') !== 'true',
        };
        break;
      }
      if (!card) return { failedCard: issues.indexOf(issue) + 1 };
      result.push(card);
    }
    return result;
  }, { detail, expectedName });
  if (!Array.isArray(found) || !found.length || found.length > 20) fail((found?.failedCard ? found.failedCard + '번째 ' : '') + '상품명·가격·이미지·링크 발급 버튼을 갖춘 개별 상품 영역을 확인할 수 없습니다. 선택자 확인 또는 상세 화면의 수동 선택이 필요합니다.');
  return found.map((region, index) => {
    const price = parseDisplayedPrice(region.priceText);
    if (!price) fail((index + 1) + '번째 상품 영역에서 취소선과 수익금을 제외한 현재 표시 가격 하나를 확인할 수 없습니다.');
    const urls = [...new Set(region.hrefs.map((href) => parseTossProductUrl(href)?.url).filter(Boolean))];
    if (urls.length > 1) fail('개별 상품 영역의 상품 주소가 여러 개입니다. 수동 확인이 필요합니다.');
    return { ...region, price, source: urls.length ? parseTossProductUrl(urls[0]) : null };
  });
}
function productFrom(region, source) {
  return { id: source.id, name: region.name, price: region.price, soldOut: region.soldOut,
    sourceUrl: source.url, checkedAt: new Date().toISOString(), facts: '', shareUrl: '' };
}
async function checkedProduct(page, product) {
  const source = parseTossProductUrl(product.sourceUrl);
  await observe(page, 'toss');
  if (parseTossProductUrl(page.url())?.id !== source.id) {
    if (input.useWorkTabs === true) {
      const cards = await regions(page, false);
      const card = cards.find((candidate) => clean(candidate.name) === clean(product.name)
        && (!candidate.source || candidate.source.id === source.id));
      if (!card || !card.canNavigate) fail('작업 탭의 현재 목록에서 승인 상품을 선택할 수 없습니다. Aside에서 해당 상세 화면을 열고 기존 탭 모드로 확인하세요.');
      if (card.soldOut || clean(card.price) !== clean(product.price)) fail('상품 가격 또는 판매 상태가 바뀌었습니다. 다시 확인하세요.');
      await page.locator('button, [role="button"], a[href], h1, h2, h3, [data-testid="product-name"], [data-testid="product-title"], [class*="productName"], [class*="product-name"], [class*="product_title"], img[alt]').nth(card.nameIndex).click();
      await observe(page, 'toss');
    } else await navigate(page, 'toss', source.url);
  }
  const [current] = await regions(page, true, product.name);
  if (parseTossProductUrl(page.url())?.id !== source.id || clean(current.name) !== clean(product.name)) fail('상세 페이지의 상품 ID 또는 상품명이 다릅니다. 작업을 중단했습니다.');
  if (current.soldOut) fail('현재 품절 또는 판매 종료 상품입니다. 작업을 중단했습니다.');
  if (clean(current.price) !== clean(product.price)) fail('상품 가격이 바뀌었습니다. 다시 수집하고 원고를 검토해 주세요.');
  return current;
}
`;

function script(input: unknown, body: string, needed: readonly (typeof parsers[number][0])[], withToss = false): string {
  const parserSource = parsers.filter(([name]) => needed.includes(name)).map(([name, parser]) => `const ${name} = (${parser.toString()});`).join('\n');
  return `"use strict";\nconst input = ${JSON.stringify(input)};\n${parserSource}\n${common}\n${withToss ? toss : ''}\n${body}`;
}

export function buildOpenScript(channel: 'toss' | 'naver', useWorkTabs = false): string {
  return script({ channel, useWorkTabs }, String.raw`
const page = await selectTab(input.channel, true);
await observe(page, input.channel);
return null;
`, channel === 'naver' ? ['isNaverHomeUrl'] : []);
}

export interface ScanCandidate { name: string; sourceUrl: string; originalUrl: string }
export interface ScanPlan { products: Product[]; candidates: ScanCandidate[] }

export function buildScanPlanScript(useWorkTabs = false): string {
  return script({ useWorkTabs }, String.raw`
const page = await selectTab('toss', false);
const originalUrl = await observe(page, 'toss');
const detailSource = parseTossProductUrl(originalUrl);
if (detailSource) {
  const [region] = await regions(page, true);
  return { products: [productFrom(region, detailSource)], candidates: [] };
}
const initial = await regions(page, false);
const candidates = new Map();
for (const region of initial) {
  const sourceUrl = region.source?.url ?? '';
  candidates.set(region.name + '|' + sourceUrl, { name: region.name, sourceUrl, originalUrl });
}
return { products: [], candidates: [...candidates.values()] };
`, ['parseTossProductUrl', 'parseDisplayedPrice'], true);
}

// Each candidate has its own REPL deadline; a long list never runs in one 120-second session.
export function buildScanScript(candidate: ScanCandidate, useWorkTabs = false): string {
  return script({ ...candidate, useWorkTabs }, String.raw`
  const page = await selectTab('toss', false);
  const originalUrl = input.originalUrl;
  await observe(page, 'toss');
  if (page.url() !== originalUrl) fail('수집 중 상품 목록이 바뀌었습니다. 자동 수집을 중단했습니다.');
  const current = await regions(page, false);
  let region = current.find((candidate) => clean(candidate.name) === clean(input.name)
    && (!input.sourceUrl || candidate.source?.url === input.sourceUrl));
  if (!region) fail('수집 대상 상품이 현재 목록에서 사라졌습니다. 다시 확인해 주세요.');
  let source = region.source;
  if (!source) {
    if (!region.canNavigate || region.nameIndex < 0) fail('상품 UI에서 상세 화면을 여는 상품명 버튼을 확인할 수 없습니다. 상세 화면을 직접 열어 주세요.');
    await page.locator('button, [role="button"], a[href], h1, h2, h3, [data-testid="product-name"], [data-testid="product-title"], [class*="productName"], [class*="product-name"], [class*="product_title"], img[alt]').nth(region.nameIndex).click();
    await observe(page, 'toss');
    source = parseTossProductUrl(page.url());
    if (!source) fail('상품 UI에서 숫자 상품 ID를 확인하지 못했습니다. 주소를 추측하지 않으며 수동 확인이 필요합니다.');
    const [detail] = await regions(page, true, region.name);
    if (clean(detail.name) !== clean(region.name)) fail('상품 카드와 상세 화면의 상품명이 다릅니다.');
    region = { ...detail, soldOut: detail.soldOut || region.soldOut };
    await navigate(page, 'toss', originalUrl);
    if (page.url() !== originalUrl) fail('상품 조회 후 원래 목록으로 돌아오지 못했습니다.');
  }
  return productFrom(region, source);
`, ['parseTossProductUrl', 'parseDisplayedPrice'], true);
}

export function buildProductScript(product: Product, issue: boolean, useWorkTabs = false): string {
  const input = { useWorkTabs, product: { id: product.id, name: product.name, price: product.price, sourceUrl: product.sourceUrl } };
  const preflight = String.raw`
const page = await selectTab('toss', false, input.product.id);
await checkedProduct(page, input.product);
`;
  const issuance = String.raw`
let sentinel;
try {
  sentinel = await page.evaluate(async () => {
    const value = 'auto-flow-' + crypto.randomUUID();
    await navigator.clipboard.writeText(value);
    return await navigator.clipboard.readText() === value ? value : null;
  });
} catch { fail('클립보드 접근이 거부되었습니다. Aside의 정상 클립보드 권한을 직접 확인해 주세요. 링크는 발급하지 않았습니다.'); }
if (!sentinel) fail('클립보드 초기화를 확인하지 못했습니다. 링크는 발급하지 않았습니다.');
await observe(page, 'toss');
const current = await checkedProduct(page, input.product);
if (!current.enabled) fail('링크 발급 버튼이 비활성화되어 있습니다.');
await page.locator('button, [role="button"]').nth(current.issueIndex).click();
await observe(page, 'toss');
if (parseTossProductUrl(page.url())?.id !== input.product.id) fail('발급 후 상품 화면이 바뀌었습니다. 자동 재발급하지 말고 링크 관리에서 결과를 확인해 주세요.');
let copied;
try { copied = await page.evaluate(() => navigator.clipboard.readText()); }
catch { fail('발급 후 클립보드 접근이 거부되었습니다. 재발급하지 말고 링크 관리에서 결과를 직접 확인해 주세요.'); }
if (typeof copied !== 'string' || copied === sentinel || copied.length > 10000 || !clean(copied).includes(clean(input.product.name))) {
  fail('새 복사 결과에서 해당 상품명을 확인하지 못했습니다. 재발급하지 말고 링크 관리에서 결과를 확인해 주세요.');
}
const links = copied.match(/https:\/\/[^\s<>"']+/g) ?? [];
if (links.length !== 1 || !isTossShareUrl(links[0])) fail('새 복사 결과에서 안전한 토스 링크 하나를 확인하지 못했습니다. 자동 재발급하지 않습니다.');
return links[0];
`;
  return script(input, preflight + (issue ? issuance : 'return null;'), issue
    ? ['parseTossProductUrl', 'parseDisplayedPrice', 'isTossShareUrl'] : ['parseTossProductUrl', 'parseDisplayedPrice'], true);
}
