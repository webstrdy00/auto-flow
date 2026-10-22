import { BrowserAutomation } from '../src/adapters/browser.js';
import { runAside, type AsideRunner } from '../src/adapters/aside-client.js';
let step = 0;
const runner: AsideRunner = async <T>(script: string): Promise<T> => {
  const started = Date.now();
  const result = await runAside<T>(script);
  console.log('READ_STEP_OK', JSON.stringify({ step: ++step, elapsedMs: Date.now() - started }));
  return result;
};
const browser = new BrowserAutomation(runner);
const started = Date.now();
void browser.scanProducts().then(async ({ products, skipped }) => {
  console.log('LIVE_SCAN_OK', JSON.stringify({ count: products.length, soldOut: products.filter(p => p.soldOut).length, elapsedMs: Date.now() - started,
    skippedCount: skipped.length,
    samples: products.slice(0, 3).map(p => ({ id: p.id, name: p.name, price: p.price, soldOut: p.soldOut })) }));
  if (process.argv.includes('--verify')) {
    const available = products.find(p => !p.soldOut);
    if (!available) throw new Error('재확인할 판매 중 상품이 없습니다.');
    await browser.verifyProduct(available);
    console.log('LIVE_PREFLIGHT_OK', JSON.stringify({ id: available.id }));
  }
}).catch(error => {
  console.error(error instanceof Error ? error.message : '실사이트 상품 확인 실패');
  process.exitCode = 1;
});
