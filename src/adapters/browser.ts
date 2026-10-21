import type { Product } from '../shared.js';
import { runAside, type AsideRunner } from './aside-client.js';
import {
  buildOpenScript, buildProductScript, buildScanScript, buildScanPlanScript, type ScanPlan,
  isTossShareUrl, parseNaverPostUrl, parseTossProductUrl,
} from './aside-scripts.js';

export { isNaverHomeUrl, isThreadsPostUrl, isTossShareUrl, parseDisplayedPrice, parseNaverPostUrl, parseTossProductUrl } from './aside-scripts.js';

export function isNaverPostUrl(value: string, blogId: string): boolean {
  return parseNaverPostUrl(value, blogId) !== null;
}

function cleanText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function checkProduct(product: Product): void {
  const source = parseTossProductUrl(product.sourceUrl);
  if (!source || source.id !== product.id || !cleanText(product.name) || product.name.length > 500
    || !product.price.trim() || product.price.length > 100 || product.soldOut) {
    throw new Error('상품 주소·ID·상품명·가격 또는 품절 상태를 확인해 주세요.');
  }
}

// Aside owns the authenticated tabs. This adapter owns only its operation lock, never a browser profile.
export class BrowserAutomation {
  private busy = false;

  constructor(private readonly runner: AsideRunner = runAside, private readonly useWorkTabs = false) {}

  private async operation<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('다른 브라우저 작업이 진행 중입니다.');
    this.busy = true;
    try { return await action(); }
    finally { this.busy = false; }
  }

  async open(channel: 'toss' | 'naver'): Promise<void> {
    await this.operation(async () => {
      if (channel !== 'toss' && channel !== 'naver') throw new Error('지원하지 않는 브라우저 대상입니다.');
      await this.runner<null>(buildOpenScript(channel, this.useWorkTabs));
    });
  }

  async scanProducts(): Promise<Product[]> {
    return this.operation(async () => {
      const plan = await this.runner<ScanPlan>(buildScanPlanScript(this.useWorkTabs));
      if (!plan || !Array.isArray(plan.products) || !Array.isArray(plan.candidates)
        || plan.products.length > 1 || plan.candidates.length > 20 || (plan.products.length && plan.candidates.length)) {
        throw new Error('Aside 상품 수집 계획이 올바르지 않습니다.');
      }
      const products = [...plan.products];
      for (const candidate of plan.candidates) {
        if (!candidate || typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 500
          || typeof candidate.sourceUrl !== 'string'
          || !['https://sharelink.toss.im/home', 'https://sharelink.toss.im/links/best-ranking'].includes(candidate.originalUrl)
          || (candidate.sourceUrl !== '' && !parseTossProductUrl(candidate.sourceUrl))) {
          throw new Error('상품 수집 대상 주소와 이름을 확인할 수 없습니다.');
        }
        products.push(await this.runner<Product>(buildScanScript(candidate, this.useWorkTabs)));
      }
      if (!Array.isArray(products) || !products.length || products.length > 20 || products.some((product) => {
        if (!product || typeof product.sourceUrl !== 'string' || typeof product.name !== 'string'
          || typeof product.price !== 'string' || typeof product.facts !== 'string' || product.shareUrl !== ''
          || typeof product.checkedAt !== 'string' || !Number.isFinite(Date.parse(product.checkedAt))) return true;
        const source = parseTossProductUrl(product.sourceUrl);
        return !source || source.id !== product.id || source.url !== product.sourceUrl || !cleanText(product.name)
          || product.name.length > 500 || !product.price || product.price.length > 100 || typeof product.soldOut !== 'boolean';
      })) throw new Error('Aside에서 유효한 상품 목록을 확인하지 못했습니다.');
      const unique = new Map<string, Product>();
      for (const product of products) {
        const prior = unique.get(product.id);
        if (prior && (prior.name !== product.name || prior.price !== product.price || prior.soldOut !== product.soldOut)) {
          throw new Error('수집 중 같은 상품의 정보가 바뀌었습니다. 다시 확인하세요.');
        }
        unique.set(product.id, product);
      }
      return [...unique.values()];
    });
  }

  async verifyProduct(product: Product): Promise<void> {
    await this.operation(async () => {
      checkProduct(product);
      await this.runner<null>(buildProductScript(product, false, this.useWorkTabs));
    });
  }

  async issueLink(product: Product): Promise<string> {
    return this.operation(async () => {
      checkProduct(product);
      const link = await this.runner<string>(buildProductScript(product, true, this.useWorkTabs));
      if (typeof link !== 'string' || !isTossShareUrl(link)) throw new Error('발급 결과의 안전한 토스 링크를 확인하지 못했습니다. 재발급하지 말고 직접 확인해 주세요.');
      return link;
    });
  }

}
