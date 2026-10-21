import type { BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { reloadRenderer } from './smoke.js';
import { isTossShareUrl } from './shared.js';

// --live-check uses real services but main.ts forbids issuance, approval and publication IPC.
export async function runAppLiveCheck(window: BrowserWindow, inputFile: string): Promise<void> {
  const input = JSON.parse(readFileSync(inputFile, 'utf8'));
  const selected = input.products?.find((p: { soldOut: boolean; shareUrl: string }) => !p.soldOut && isTossShareUrl(p.shareUrl));
  if (!selected || !/^[A-Za-z0-9_.-]+$/.test(input.account)) throw new Error('검증용 실제 상품과 계정 정보가 없습니다.');
  const product = { id: selected.id, name: selected.name, sourceUrl: selected.sourceUrl,
    price: `${Number(selected.priceWon).toLocaleString('ko-KR')}원`, soldOut: false,
    checkedAt: new Date().toISOString(), facts: `확인한 구성: ${selected.name}. 표시 가격 ${selected.priceWon}원. 직접 사용한 후기는 아님.`, shareUrl: selected.shareUrl };
  await window.webContents.executeJavaScript(`(async()=>{
    const state=await window.autoFlow.execute({type:'state'});
    if(state.products.length||state.jobs.length)throw new Error('Live check must use isolated app data');
    await window.autoFlow.execute(${JSON.stringify({ type: 'saveSettings', naverBlogId: input.account, threadsHandle: input.account,
      tone: '짧고 다양한 도입으로 구성·가격과 사용 상황을 설명한다. 확인사항은 필요한 것만 간결하게 쓰고, 허위 경험·효능·최저가·긴급성을 만들지 않는다.', useWorkTabs: true })});
    await window.autoFlow.execute(${JSON.stringify({ type: 'saveProduct', product })});
  })()`);
  await reloadRenderer(window);
  const started = Date.now();
  const result = await window.webContents.executeJavaScript(`(async()=>{
    const until=async(fn,ms)=>{const end=Date.now()+ms;while(true){const value=await fn();if(value)return value;if(Date.now()>end)throw new Error('App live check deadline exceeded');await new Promise(r=>setTimeout(r,250));}};
    const button=await until(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('채널별 원고 생성')&&!b.disabled),10000);
    button.click();
    const state=await until(async()=>{
      const alert=document.querySelector('[role=alert]');if(alert)throw new Error(alert.textContent);
      const s=await window.autoFlow.execute({type:'state'});
      if(s.jobs.length)throw new Error('Live check must not approve or publish');
      return s.drafts.length===2?s:null;
    },420000);
    await until(()=>document.querySelector('h1')?.textContent==='원고 검토',5000);
    return {pipeline:'Electron renderer button → IPC → AppController → real product preflight → Aside generation → Store → renderer',
      realAsideGeneration:true,newPublications:0,issuedLinks:0,apiKeyInputsRequired:false,
      drafts:state.drafts.map(d=>({channel:d.channel,title:d.title,body:d.body})),settings:state.settings};
  })()`);
  const output = { ...result, elapsedMs: Date.now() - started };
  writeFileSync(join(dirname(inputFile), 'app-live-check-result.json'), JSON.stringify(output, null, 2));
  const image = await window.webContents.capturePage();
  writeFileSync(join(dirname(inputFile), 'app-live-check.png'), image.toPNG());
  console.log('APP_LIVE_CHECK_OK', JSON.stringify({ realAsideGeneration: true, draftCount: result.drafts.length, elapsedMs: output.elapsedMs, newPublications: 0 }));
}
