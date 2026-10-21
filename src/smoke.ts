import type { BrowserWindow } from 'electron';
import { AsideWorkflow } from './adapters/aside-workflow.js';
import type { AsideTaskRunner } from './adapters/aside-tasks.js';
import type { ProductBrowser } from './controller.js';

// Used only with --smoke-test and an isolated temporary database, never normal app startup.
export function smokeServices() {
  let publicationCalls = 0;
  const receipts = new Map<string, unknown>();
  const runner: AsideTaskRunner = async <T>(request: Parameters<AsideTaskRunner>[0]) => {
    const data = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1));
    const sessionId = `smoke-${request.requestId}`;
    if (!data.channel) return { sessionId, value: { drafts: [
      { channel: 'naver', title: '구성을 확인하는 원고', body: `${data.name}\n표시 가격 ${data.price}. 구매 전 구성을 확인하세요.` },
      { channel: 'threads', title: '간결한 구성 안내', body: `${data.name}: 표시 가격 ${data.price}.` },
    ] } as T };
    publicationCalls++;
    await request.onSession?.(sessionId);
    const value = { requestId: request.requestId, channel: data.channel, target: data.target, published: true,
      url: data.channel === 'naver' ? `https://blog.naver.com/${data.target}/123456789` : `https://www.threads.com/@${data.target}/post/Smoke123`,
      verifiedOwner: true, verifiedText: true, verifiedDisclosure: true, verifiedAffiliateUrl: data.product.shareUrl, previewStatus: 'visible' };
    receipts.set(sessionId, value);
    if (data.channel === 'threads') throw new Error('Simulated client timeout after task admission');
    return { sessionId, value: value as T };
  };
  const workflow = new AsideWorkflow(runner, async <T>(sessionId: string) => ({ status: 'complete' as const, value: receipts.get(sessionId) as T }));
  const browser: ProductBrowser = {
    open: async () => {}, scanProducts: async () => [], verifyProduct: async () => {}, issueLink: async p => p.shareUrl,
  };
  return { workflow, browserFor: () => browser, publicationCalls: () => publicationCalls };
}

export async function reloadRenderer(window: BrowserWindow): Promise<void> {
  const loaded = new Promise<void>((resolve, reject) => {
    window.webContents.once('did-finish-load', () => resolve());
    window.webContents.once('did-fail-load', () => reject(new Error('Renderer reload failed')));
  });
  window.reload();
  await loaded;
}

export async function runSmoke(window: BrowserWindow): Promise<void> {
  const result = await window.webContents.executeJavaScript(`(async () => {
    const api = window.autoFlow;
    if (!api || typeof window.require !== 'undefined') throw new Error('IPC isolation failed');
    const initial = await api.execute({type:'state'});
    if (initial.products.length) throw new Error('Smoke data must be isolated');
    const now = new Date().toISOString();
    await api.execute({type:'saveSettings',naverBlogId:'autoflow_test',threadsHandle:'autoflow_test',tone:'확인된 사실만 다양한 도입으로 소개',useWorkTabs:true});
    await api.execute({type:'saveProduct',product:{id:'123456',name:'로컬 검증 상품',sourceUrl:'https://sharelink.toss.im/links/products/123456',price:'1000원',soldOut:false,checkedAt:now,facts:'',shareUrl:'https://toss.shopping/_m/SmokeOnly'}});
    let state = await api.execute({type:'generate',productId:'123456'});
    if(state.drafts.length!==2) throw new Error('App generation did not save both channels');
    let draft=state.drafts.find(d=>d.channel==='naver');
    state=await api.execute({type:'approve',draftId:draft.id,scheduledAt:null});
    state=await api.execute({type:'saveDraft',draft:{...draft,title:'수정한 로컬 원고'}});
    if(state.jobs.some(j=>j.status==='approved')) throw new Error('Edit did not invalidate approval');
    for(const channel of ['naver','threads']) {
      draft=state.drafts.find(d=>d.channel===channel);
      state=await api.execute({type:'approve',draftId:draft.id,scheduledAt:null});
      const job=state.jobs.find(j=>j.draftId===draft.id&&j.status==='approved');
      state=await api.execute({type:'runJob',jobId:job.id});
      const finished=state.jobs.find(j=>j.id===job.id);
      if(!finished.asideSessionId) throw new Error('Aside session was not persisted');
      if(channel==='threads') {
        if(finished.status!=='uncertain') throw new Error('Timeout was not quarantined');
        state=await api.execute({type:'checkJob',jobId:job.id});
      }
      if(state.jobs.find(j=>j.id===job.id).status!=='published') throw new Error('App publication/recovery did not complete');
    }
    await api.execute({type:'pause',paused:true});
    state=await api.execute({type:'state'});
    let rejected=false;try{await api.execute({type:'unknown-command'});}catch{rejected=true;}
    if(!rejected||!state.paused) throw new Error('Pause or invalid command protection failed');
    return {bridge:true,nodeExposed:false,productCount:state.products.length,draftCount:state.drafts.length,
      approvalInvalidated:true,paused:true,invalidCommandRejected:true,mockedChannelsPublished:2,recoveredWithoutRepublish:true};
  })()`);
  await reloadRenderer(window);
  const ui = await window.webContents.executeJavaScript(`(async () => {
    const wait=async condition=>{const deadline=Date.now()+5000;while(!condition()){if(Date.now()>deadline)throw new Error('Renderer state not visible');await new Promise(r=>setTimeout(r,20));}};
    await wait(()=>Array.from(document.querySelectorAll('input')).some(i=>i.value==='로컬 검증 상품'));
    const generationButton=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('채널별 원고 생성'));
    if(!generationButton||generationButton.disabled)throw new Error('Optional empty notes blocked generation');
    const panels=['상품','원고 검토','게시 작업','설정'];
    for(let i=0;i<panels.length;i++){document.querySelectorAll('.nav-item')[i].click();await wait(()=>document.querySelector('h1')?.textContent===panels[i]);}
    await wait(()=>Array.from(document.querySelectorAll('input')).some(i=>i.value==='autoflow_test'));
    if(document.querySelector('input[type=password]'))throw new Error('Obsolete secret inputs remain');
    if(!document.body.textContent.includes('미리보기'))throw new Error('Preview guidance missing');
    if(document.querySelector('[role=alert]'))throw new Error('Renderer error');
    return {title:document.title,panelsVerified:4,noApiKeyInputs:true};
  })()`);
  console.log('SMOKE_OK', JSON.stringify({ ...result, ...ui }));
}
