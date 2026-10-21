import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.js';
import { AppController } from './controller.js';
import { smokeServices } from './smoke.js';

async function setup(t: {after(fn:()=>void):void}) {
  const store=new Store(':memory:');t.after(()=>store.close());
  const services=smokeServices();
  const app=new AppController(store,services.workflow,services.browserFor);
  await app.execute({type:'saveSettings',naverBlogId:'example',threadsHandle:'example',tone:'구성과 가격을 다양하게 소개',useWorkTabs:true});
  await app.execute({type:'saveProduct',product:{id:'123',name:'테스트 상품',sourceUrl:'https://sharelink.toss.im/links/products/123',price:'4,500원',soldOut:false,checkedAt:new Date().toISOString(),facts:'2개 구성',shareUrl:'https://toss.shopping/_m/Test123'}});
  return {store,services,app};
}
test('app commands generate, approve, publish both channels and recover timeout without reposting',async t=>{
  const {app,services}=await setup(t);
  let state=await app.execute({type:'generate',productId:'123'});
  assert.equal(state.drafts.length,2);
  assert.equal('hasAiKey' in state.settings,false);
  for(const draft of state.drafts){
    state=await app.execute({type:'approve',draftId:draft.id,scheduledAt:null});
    const job=state.jobs.find(j=>j.draftId===draft.id&&j.status==='approved')!;
    state=await app.execute({type:'runJob',jobId:job.id});
    let actual=state.jobs.find(j=>j.id===job.id)!;
    assert.ok(actual.asideSessionId);
    if(draft.channel==='threads'){
      assert.equal(actual.status,'uncertain');
      await assert.rejects(app.execute({type:'runJob',jobId:job.id}));
      state=await app.execute({type:'checkJob',jobId:job.id});
      actual=state.jobs.find(j=>j.id===job.id)!;
    }
    assert.equal(actual.status,'published');
    assert.ok(actual.resultUrl.includes('example'));
  }
  assert.equal(services.publicationCalls(),2);
});
test('app publication stops before task admission if fresh product preflight fails',async t=>{
  const {app,store,services}=await setup(t);
  const state=await app.execute({type:'generate',productId:'123'});
  const draft=state.drafts[0]!;
  const approved=await app.execute({type:'approve',draftId:draft.id,scheduledAt:null});
  const job=approved.jobs.find(j=>j.status==='approved')!;
  const blocked=new AppController(store,services.workflow,()=>({...services.browserFor(),verifyProduct:async()=>{throw new Error('품절');}}));
  const result=await blocked.execute({type:'runJob',jobId:job.id});
  assert.equal(result.jobs.find(j=>j.id===job.id)!.status,'needs_attention');
  assert.equal(services.publicationCalls(),0);
});
test('app rejects obsolete secret settings and a changed target cannot execute an old approval',async t=>{
  const {app,services}=await setup(t);
  await assert.rejects(app.execute({type:'saveSettings',naverBlogId:'example',threadsHandle:'example',tone:'test',useWorkTabs:true,aiKey:'not-used'}));
  let state=await app.execute({type:'generate',productId:'123'});
  state=await app.execute({type:'approve',draftId:state.drafts[0]!.id,scheduledAt:null});
  const id=state.jobs.find(j=>j.status==='approved')!.id;
  await app.execute({type:'saveSettings',naverBlogId:'changed',threadsHandle:'changed',tone:'test',useWorkTabs:true});
  await assert.rejects(app.execute({type:'runJob',jobId:id}));
  assert.equal(services.publicationCalls(),0);
});
