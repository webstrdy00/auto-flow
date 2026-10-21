import { runAside } from '../src/adapters/aside-client.js';
import { BrowserAutomation } from '../src/adapters/browser.js';
const inspect = process.argv.includes('--inspect');
const script = `
const tabs = await listBrowserTabs();
const tossStates = (await chrome.tabs.query({url:'https://sharelink.toss.im/*'}))
  .map(t=>({active:t.active,discarded:t.discarded,status:t.status}));
return {
  tossStates,
  tossTabs: tabs.filter(t => { try { return new URL(t.url).hostname === 'sharelink.toss.im'; } catch { return false; } }).length,
  naverTabs: tabs.filter(t => { try { return ['blog.naver.com','section.blog.naver.com'].includes(new URL(t.url).hostname); } catch { return false; } }).length
};
`;
void runAside<{ tossTabs: number; naverTabs: number }>(script)
  .then(async result => {
    console.log('ASIDE_LIST_OK', JSON.stringify(result));
    if (!inspect) return;
    if (result.tossTabs < 1) throw new Error('읽기 전용 진단에는 기존 토스 탭이 필요합니다. 탭을 자동 생성하지 않습니다.');
    await new BrowserAutomation().open('toss');
    console.log('ASIDE_ADAPTER_OPEN_OK');
  })
  .catch(error => { console.error(error instanceof Error ? error.message : 'Aside 확인 실패'); process.exitCode = 1; });
