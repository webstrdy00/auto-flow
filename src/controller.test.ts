import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.js';
import { AppController } from './controller.js';
import { smokeServices } from './smoke.js';
import { PublicationBlockedError } from './adapters/aside-workflow.js';

async function setup(t: {after(fn:()=>void):void}) {
  const store=new Store(':memory:');t.after(()=>store.close());
  const services=smokeServices();
  const app=new AppController(store,services.workflow,services.browserFor);
  await app.execute({type:'saveSettings',naverBlogId:'example',threadsHandle:'example',tone:'구성과 가격을 다양하게 소개',useWorkTabs:true});
  await app.execute({type:'saveProduct',product:{id:'123',name:'테스트 상품',sourceUrl:'https://sharelink.toss.im/links/products/123',price:'4,500원',soldOut:false,checkedAt:new Date().toISOString(),facts:'2개 구성',shareUrl:'https://toss.shopping/_m/Test123'}});
  return {store,services,app};
}
test('app publishes Naver but saves Threads draft and verifies user publication separately',async t=>{
  const {app,services}=await setup(t);
  let state=await app.execute({type:'generate',productId:'123'});
  assert.equal(state.drafts.length,2);
  assert.equal('hasAiKey' in state.settings,false);
  for(const draft of state.drafts){
    state=await app.execute(draft.channel==='threads'?{type:'approveThreadsDraft',draftId:draft.id}:{type:'approve',draftId:draft.id,scheduledAt:null});
    const job=state.jobs.find(j=>j.draftId===draft.id&&j.status==='approved')!;
    state=await app.execute({type:'runJob',jobId:job.id});
    let actual=state.jobs.find(j=>j.id===job.id)!;
    assert.ok(actual.asideSessionId);
    if(draft.channel==='threads'){
      assert.equal(actual.status,'uncertain');
      await assert.rejects(app.execute({type:'runJob',jobId:job.id}));
      state=await app.execute({type:'checkJob',jobId:job.id});
      actual=state.jobs.find(j=>j.id===job.id)!;
      assert.equal(actual.status,'awaiting_publication');
      assert.equal(actual.resultUrl,'');
      await assert.rejects(app.execute({type:'reconcile',jobId:job.id,resultUrl:'https://www.threads.com/@example/post/Smoke123'}));
      await assert.rejects(app.execute({type:'completeThreadsPublication',jobId:job.id,resultUrl:'https://www.threads.com/@other/post/Smoke123'}));
      state=await app.execute({type:'completeThreadsPublication',jobId:job.id,resultUrl:'https://www.threads.com/@example/post/Smoke123'});
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

test('Threads public approval is rejected and unverified manual URLs cannot complete a saved draft', async t => {
  const { app, store, services } = await setup(t);
  let state = await app.execute({ type: 'generate', productId: '123' });
  const draft = state.drafts.find(d => d.channel === 'threads')!;
  await assert.rejects(app.execute({ type: 'approve', draftId: draft.id, scheduledAt: null }));
  state = await app.execute({ type: 'approveThreadsDraft', draftId: draft.id });
  const job = state.jobs.find(j => j.status === 'approved')!;
  await app.execute({ type: 'runJob', jobId: job.id });
  state = await app.execute({ type: 'checkJob', jobId: job.id });
  assert.equal(state.jobs.find(j => j.id === job.id)!.status, 'awaiting_publication');
  await assert.rejects(app.execute({ type: 'approveThreadsDraft', draftId: draft.id }));
  await assert.rejects(app.execute({ type: 'saveDraft', draft: { ...draft, body: draft.body + '\nchanged' } }));
  const original = state.products[0]!;
  await app.execute({ type: 'saveProduct', product: { ...original, price: '5,000원', shareUrl: 'https://toss.shopping/_m/ChangedLink' } });
  const verifier = new AppController(store, {
    generate: services.workflow.generate.bind(services.workflow),
    assertPublishable: services.workflow.assertPublishable.bind(services.workflow),
    publish: services.workflow.publish.bind(services.workflow),
    recover: services.workflow.recover.bind(services.workflow),
    assertDraftSaveable: services.workflow.assertDraftSaveable.bind(services.workflow),
    saveThreadsDraft: services.workflow.saveThreadsDraft.bind(services.workflow),
    recoverThreadsDraft: services.workflow.recoverThreadsDraft.bind(services.workflow),
    verifyThreadsPublication: async input => {
      assert.equal(input.product.shareUrl, original.shareUrl);
      assert.equal(input.product.price, original.price);
      throw new Error('공개 글 본문이 승인 원고와 다릅니다.');
    },
  }, services.browserFor);
  await assert.rejects(verifier.execute({ type: 'completeThreadsPublication', jobId: job.id,
    resultUrl: 'https://www.threads.com/@example/post/Smoke123' }), /본문/);
  assert.equal((await app.execute({ type: 'state' })).jobs.find(j => j.id === job.id)!.status, 'awaiting_publication');
});

test('scan persists verified progress before a fatal error and preserves operator facts and link', async t => {
  const { store, services } = await setup(t);
  const original = store.state().products[0]!;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let progressed!: () => void;
  const ready = new Promise<void>(resolve => { progressed = resolve; });
  const app = new AppController(store, services.workflow, () => ({
    ...services.browserFor(),
    scanProducts: async onProduct => {
      onProduct?.({ ...original, price: '4,600원', facts: '', shareUrl: '' });
      progressed();
      await pending;
      throw new Error('로그인이 필요합니다.');
    },
  }));
  const operation = app.execute({ type: 'scanProducts' });
  const rejected = assert.rejects(operation, /로그인/);
  await ready;
  const progress = await app.execute({ type: 'state' });
  assert.equal(progress.scan?.status, 'running');
  assert.equal(progress.scan?.saved, 1);
  assert.equal(progress.products[0]!.price, '4,600원');
  assert.equal(progress.products[0]!.shareUrl, original.shareUrl);
  assert.equal(progress.products[0]!.facts, original.facts);
  release();
  await rejected;
  const failed = await app.execute({ type: 'state' });
  assert.equal(failed.scan?.status, 'failed');
  assert.equal(failed.scan?.saved, 1);
  assert.equal(failed.products[0]!.price, '4,600원');
  assert.match(failed.events[0]!.message, /상품 수집 오류 · 저장 1개/);
  assert.match(failed.events[0]!.message, /로그인·권한 또는 연결/);
});

test('scan reports missing candidates and does not claim they were collected', async t => {
  const { store, services } = await setup(t);
  const product = store.state().products[0]!;
  const app = new AppController(store, services.workflow, () => ({
    ...services.browserFor(),
    scanProducts: async onProduct => {
      onProduct?.(product);
      return { products: [product], skipped: [{ name: '사라진 상품', reason: 'missing' as const }] };
    },
  }));
  const state = await app.execute({ type: 'scanProducts' });
  assert.equal(state.scan?.status, 'complete');
  assert.equal(state.scan?.saved, 1);
  assert.deepEqual(state.scan?.skipped, [{ name: '사라진 상품', reason: 'missing' }]);
  assert.match(state.scan!.message, /건너뛰/);
  assert.match(state.events[0]!.message, /저장 1개 · 목록에서 사라져 건너뛴 상품 1개/);
});

test('scan error history records safe categories instead of raw private error text', async t => {
  const { store, services } = await setup(t);
  const app = new AppController(store, services.workflow, () => ({
    ...services.browserFor(),
    scanProducts: async () => { throw new Error('같은 상품명의 수집 대상이 여러 개입니다. SECRET https://private.invalid/?token=hidden'); },
  }));
  await assert.rejects(app.execute({ type: 'scanProducts' }));
  const state = await app.execute({ type: 'state' });
  assert.match(state.events[0]!.message, /상품 수집 오류 · 저장 0개/);
  assert.match(state.events[0]!.message, /상품명 또는 ID/);
  assert.doesNotMatch(JSON.stringify(state.events), /SECRET|private.invalid|token=hidden/);
});

test('verified blocked reports expose a reason but never enable automatic reposting', async t => {
  const { app, store, services } = await setup(t);
  const state = await app.execute({ type: 'generate', productId: '123' });
  const approved = await app.execute({ type: 'approve', draftId: state.drafts[0]!.id, scheduledAt: null });
  const job = approved.jobs.find(j => j.status === 'approved')!;
  let starts = 0;
  const blocked = new AppController(store, {
    generate: services.workflow.generate.bind(services.workflow),
    assertPublishable: services.workflow.assertPublishable.bind(services.workflow),
    assertDraftSaveable: services.workflow.assertDraftSaveable.bind(services.workflow),
    saveThreadsDraft: services.workflow.saveThreadsDraft.bind(services.workflow),
    recoverThreadsDraft: services.workflow.recoverThreadsDraft.bind(services.workflow),
    verifyThreadsPublication: services.workflow.verifyThreadsPublication.bind(services.workflow),
    publish: async input => {
      starts++;
      input.onSession('blocked-session');
      throw new PublicationBlockedError('플랫폼에서 대상 계정 확인을 요구했습니다.');
    },
    recover: async () => { throw new PublicationBlockedError('플랫폼에서 대상 계정 확인을 요구했습니다.'); },
  }, services.browserFor);
  const result = await blocked.execute({ type: 'runJob', jobId: job.id });
  const actual = result.jobs.find(j => j.id === job.id)!;
  assert.equal(actual.status, 'uncertain');
  assert.match(actual.message, /대상 계정 확인/);
  await assert.rejects(blocked.execute({ type: 'checkJob', jobId: job.id }), /대상 계정 확인/);
  await assert.rejects(blocked.execute({ type: 'runJob', jobId: job.id }));
  assert.equal(starts, 1);
});
