import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCLOSURE, validateThreadsBody, type Product, type Draft, type Settings } from '../shared.js';
import { AsideWorkflow, PublicationBlockedError, generationPrompt, publicationPrompt, threadsDraftPrompt, parseGeneratedDrafts, validatePublicationReceipt, validateThreadsDraftReceipt, type PublishInput } from './aside-workflow.js';
import type { AsideTaskRunner, AsideTaskRequest } from './aside-tasks.js';
const product: Product = { id:'123',name:'검증 용기 2개',sourceUrl:'https://sharelink.toss.im/links/products/123',price:'4,500원',soldOut:false,checkedAt:new Date().toISOString(),facts:'검정, 2개 구성',shareUrl:'https://toss.shopping/_m/Example123' };
const settings: Settings = {naverBlogId:'example',threadsHandle:'example',tone:'다양하고 사실적인 문체',useWorkTabs:true};
const generated = {drafts:[{channel:'naver',title:'구성 비교',body:'용기 2개, 표시 가격 4,500원.\n필요한 수량을 확인하세요.'},{channel:'threads',title:'수량 안내',body:'용기 2개 구성, 표시 가격 4,500원입니다.'}]};
const draft: Draft = {id:'draft',productId:product.id,channel:'threads',title:'구성 안내',body:`${DISCLOSURE}\n${product.name}\n${product.shareUrl}`,version:1,updatedAt:product.checkedAt};
const input: PublishInput = {requestId:'request-123',draft,product,target:'example',useWorkTabs:true,onSession:()=>{}};
const receipt = {requestId:input.requestId,channel:'threads',target:'example',published:true,url:'https://www.threads.com/@example/post/ABC',verifiedOwner:true,verifiedText:true,verifiedDisclosure:true,verifiedAffiliateUrl:product.shareUrl,previewStatus:'visible'};
const naverInput: PublishInput = {...input,draft:{...draft,channel:'naver'}};
const naverReceipt = {...receipt,channel:'naver',url:'https://blog.naver.com/example/123'};
const draftReceipt = {requestId:input.requestId,channel:'threads',target:input.target,operation:'save_draft',saved:true,published:false,verifiedOwner:true,verifiedText:true,verifiedDisclosure:true,verifiedAffiliateUrl:product.shareUrl,verifiedDraftReopened:true,previewStatus:'visible'};

test('generation uses factual data without API keys and app inserts disclosure and original link', async()=>{
  let calls=0;
  const runner: AsideTaskRunner=async<T>(r: AsideTaskRequest)=>{calls++;assert.match(r.prompt,/게시, 발급, 계정 변경은 승인되지 않았다/);assert.ok(r.prompt.includes(settings.tone));return {sessionId:'test-session',value:generated as T};};
  const drafts=await new AsideWorkflow(runner).generate(product,settings,['이전 제목']);
  assert.equal(calls,1);assert.equal(drafts.length,2);
  for(const d of drafts){assert.ok(d.body.startsWith(DISCLOSURE));assert.equal(d.body.match(/https:\/\//g)?.length,1);assert.ok(d.body.endsWith(product.shareUrl));}
  validateThreadsBody(drafts[1]!.body,product.shareUrl);
});
test('generation rejects duplicate channels, injected URLs, control characters and oversized text',()=>{
  for(const value of [{}, {drafts:[generated.drafts[0],generated.drafts[0]]}, {drafts:[generated.drafts[0],{...generated.drafts[1],body:'https://evil.test'}]}, {drafts:[generated.drafts[0],{...generated.drafts[1],body:'가'.repeat(501)}]}, {drafts:[generated.drafts[0],{...generated.drafts[1],body:'hidden\u0001control'}]}]) assert.throws(()=>parseGeneratedDrafts(value,product));
  assert.throws(()=>generationPrompt({...product,soldOut:true},settings,[]));
  assert.throws(()=>generationPrompt({...product,facts:'<html>private</html>'},settings,[]),/HTML/);
});
test('copy angle changes with previous drafts and never authorizes invented reviews',()=>{
  const a=generationPrompt(product,settings,[]),b=generationPrompt(product,settings,['a']);
  assert.notEqual(a,b);assert.match(a,/확인되지 않은 경험/);assert.match(b,/개수당 가격/);
});
test('generation requests conversational channel-specific copy without padding or fictional testimonials', async () => {
  let prompt = '';
  const runner: AsideTaskRunner = async <T>(request: AsideTaskRequest) => {
    prompt = request.prompt;
    return { sessionId: 'copy-style-test', value: { drafts: [
      { channel: 'naver', title: '검증 용기 2개, 4,500원이에요', body: '용기 두 개가 한 묶음이에요.\n\n지금 확인한 가격은 4,500원이고, 한 개에 2,250원꼴이에요.\n\n구성은 아래 링크에서 확인할 수 있어요.' },
      { channel: 'threads', title: '용기 두 개 묶음', body: '검증 용기 2개에 4,500원이에요.\n\n두 개가 필요했던 분들은 구성을 살펴보세요.' },
    ] } as T };
  };
  const drafts = await new AsideWorkflow(runner).generate({ ...product, facts: '' }, settings, ['이전 도입']);
  assert.match(prompt, /자연스러운 해요체/);
  assert.match(prompt, /소제목은 필요할 때만 0~2개/);
  assert.match(prompt, /확인된 사실이 적으면 더 짧게/);
  assert.match(prompt, /블로그 본문을 축약 복사하지 않는다/);
  assert.match(prompt, /실제 사용·구매 경험을 지어내지 않는다/);
  assert.match(prompt, /실제 주의가 필요한 조건이 있으면 빠뜨리지 말고/);
  assert.doesNotMatch(prompt, /약 400~1000자|짧은 소제목 2~3개/);
  assert.equal(drafts.length, 2);
  assert.ok(drafts[0]!.body.includes('\n\n지금 확인한 가격은'));
  assert.ok(drafts.every(d => d.body.startsWith(DISCLOSURE) && d.body.endsWith(product.shareUrl)));
  validateThreadsBody(drafts[1]!.body, product.shareUrl);
});
test('Naver publication preserves previews, existing drafts and its public-post verification contract',()=>{
  const prompt=publicationPrompt(naverInput);
  assert.match(prompt,/미리보기는 유지/);assert.match(prompt,/기존 작성 중\/임시저장 글을 덮어쓰거나 삭제하지 않는다/);
  assert.ok(prompt.includes(JSON.stringify(draft.body)));
  assert.match(prompt,/사용자의 게시 승인과 플랫폼의 정책 요건은 별개/);
  assert.match(prompt,/UI가 보이지 않는다는 이유만으로 필수 요건을 만들어내지 않는다/);
  assert.match(prompt,/선택적 UI의 부재 자체는 실패가 아니지만, 제휴 콘텐츠가 요건에서 면제된다고 미리 단정하지도 않는다/);
  assert.match(prompt,/실제 플랫폼 경고·안내 또는 이 콘텐츠에 적용되는 최신 공식 요건/);
  assert.match(prompt,/실제 필수 요건은 우회하지 말고/);
  assert.match(prompt,/광고 고지를 삭제하거나 약화하지 않는다/);
  assert.match(prompt,/최종 공개 게시 버튼은 새 글당 1회만/);
  assert.match(prompt,/같은 세션에서 본인 글 목록과 실제 공개 주소/);
  assert.match(prompt,/검증 값이나 성공을 만들지 마라/);
});
test('Threads cannot dispatch through the public publication methods',async()=>{
  let starts=0;
  const workflow=new AsideWorkflow(async()=>{starts++;throw new Error('must not start');});
  assert.throws(()=>publicationPrompt(input),/Threads 공개 게시는 자동 실행하지 않습니다/);
  assert.throws(()=>workflow.assertPublishable(input),/Threads 공개 게시는 자동 실행하지 않습니다/);
  await assert.rejects(workflow.publish(input),/Threads 공개 게시는 자동 실행하지 않습니다/);
  assert.equal(starts,0);
});
test('published receipt must bind request, account, body verification and original link',()=>{
  assert.deepEqual(validatePublicationReceipt(receipt,input),{url:receipt.url,previewStatus:'visible'});
  for(const change of [{requestId:'other'},{target:'other'},{published:false},{verifiedText:false},{verifiedDisclosure:false},{verifiedAffiliateUrl:'https://toss.shopping/_m/Other'},{url:'https://www.threads.com/@other/post/ABC'},{url:'https://evil.test/post/ABC'},{previewStatus:'guessed'}]) assert.throws(()=>validatePublicationReceipt({...receipt,...change},input));
  assert.equal(validatePublicationReceipt({...receipt,previewStatus:'unavailable'},input).previewStatus,'unavailable');
  assert.deepEqual(validatePublicationReceipt({...receipt,reason:'추가 설명'},input),{url:receipt.url,previewStatus:'visible'});
});
test('matching blocked receipt exposes only a sanitized bounded reason and requires checking actual posts',()=>{
  const blocked={requestId:input.requestId,channel:input.draft.channel,target:input.target,published:false,
    reason:'플랫폼\u0000 안내\u001b https://private.example/path?token=secret\r\n www.private.example/path 정책 확인이 필요합니다. '+'가'.repeat(400)};
  assert.throws(()=>validatePublicationReceipt(blocked,input),error=>{
    assert.ok(error instanceof PublicationBlockedError);
    assert.equal(error.name,'PublicationBlockedError');
    assert.equal(error.reason.length,350);
    assert.ok(error.reason.startsWith('플랫폼 안내 [URL 생략] [URL 생략] 정책 확인이 필요합니다. '));
    assert.doesNotMatch(error.message,/private\.example|token=secret|[\p{Cc}\p{Cf}]/u);
    assert.match(error.message,/차단되었다고 보고/);
    assert.match(error.message,/게시되지 않았다는 증거는 아닙니다/);
    assert.match(error.message,/재시도 전에 원본 계정의 실제 게시물을 확인/);
    assert.match(error.message,/자동 재게시하지 않습니다/);
    return true;
  });
});
test('malformed or mismatched failure receipts cannot become a typed blocked result',()=>{
  const blocked={requestId:input.requestId,channel:input.draft.channel,target:input.target,published:false,reason:'플랫폼 안내를 확인해야 합니다.'};
  const malformed:unknown[]=[null,undefined,'not a receipt',[],{},
    {...blocked,requestId:'other'},{...blocked,channel:'naver'},{...blocked,target:'other'},
    {...blocked,requestId:undefined},{...blocked,published:'false'},{...blocked,published:undefined},
    ...[undefined,null,12,{},'', ' \r\n\t ', '\u0000\u001b', '\ud800'].map(reason=>({...blocked,reason})),
    {...blocked,published:true}];
  for(const value of malformed) assert.throws(()=>validatePublicationReceipt(value,input),error=>{
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof PublicationBlockedError));
    return true;
  });
});
test('publish and recovery preserve typed blocked reports without starting another task',async()=>{
  const blocked={requestId:naverInput.requestId,channel:'naver',target:naverInput.target,published:false,reason:'실제 플랫폼 안내에서 필수 항목을 확인했습니다.'};
  let starts=0,inspects=0,session='';
  const workflow=new AsideWorkflow(async<T>(request:AsideTaskRequest)=>{
    starts++;await request.onSession?.('session-blocked');return {sessionId:'session-blocked',value:blocked as T};
  },async<T>(id:string,key:string)=>{
    inspects++;assert.equal(id,'session-blocked');assert.equal(key,input.requestId);return {status:'complete',value:blocked as T};
  });
  for(const action of [()=>workflow.publish({...naverInput,onSession:id=>{session=id;}}),()=>workflow.recover(session,naverInput)]) {
    await assert.rejects(action,error=>{
      assert.ok(error instanceof PublicationBlockedError);assert.equal(error.reason,blocked.reason);return true;
    });
  }
  assert.equal(session,'session-blocked');assert.equal(starts,1);assert.equal(inspects,1);
});
test('timeout after session admission is not retried and recovery only inspects the same session',async()=>{
  let starts=0,inspects=0,session='';
  const runner: AsideTaskRunner=async r=>{starts++;await r.onSession?.('session-123');throw new Error('timeout');};
  const workflow=new AsideWorkflow(runner,async<T>(id: string,key: string)=>{inspects++;assert.equal(id,'session-123');assert.equal(key,naverInput.requestId);return {status:'complete',value:naverReceipt as T};});
  await assert.rejects(workflow.publish({...naverInput,onSession:id=>{session=id;}}));
  assert.equal(session,'session-123');
  assert.equal((await workflow.recover(session,naverInput)).url,naverReceipt.url);
  assert.equal(starts,1);assert.equal(inspects,1);
});
test('running task cannot be interpreted as a completed publication',async()=>{
  const workflow=new AsideWorkflow(async()=>{throw new Error('must not start');},async()=>({status:'running'}));
  await assert.rejects(workflow.recover('session-123',input),/아직 실행 중/);
});
test('historical Threads publication recovery still reads its original public receipt without saving',async()=>{
  let starts=0,inspects=0;
  const workflow=new AsideWorkflow(async()=>{starts++;throw new Error('must not start');},async<T>(id:string,key:string)=>{
    inspects++;assert.equal(id,'historical-session');assert.equal(key,input.requestId);
    return {status:'complete',value:receipt as T};
  });
  assert.deepEqual(await workflow.recover('historical-session',input),{url:receipt.url,previewStatus:'visible'});
  assert.equal(starts,0);assert.equal(inspects,1);
});
test('Threads draft prompt confines new saves and exact-match reuse to private non-destructive UI',()=>{
  const prompt=threadsDraftPrompt(input);
  for(const pattern of [/공개 게시 승인이 아니다/,/최종 공개 게시 버튼은 절대 누르지 않는다/,
    /기존 작성 중\/임시저장 글을 덮어쓰거나 삭제하지 않는다/,/기존 작성 중 글을 비우거나 닫아서 저장·폐기·변경하지 않는다/,
    /중복 저장하지 않는다/,/다른 기존 초안을 수정·재저장·삭제/,/NEW 초안 하나를 위한 새 빈 작성기/,
    /미리보기는 유지/,/미리보기를 삭제하지 않는다/,/상품 ID·상품명·가격·품절/,/판매 여부를 입증할 수 없으면 저장하지 않는다/,
    /재클릭·재저장·자동 재시도·새 작업을 하지 않는다/,/재열기 후 입력·수정·저장·삭제 없이 읽기만/,
    /변경·재저장·폐기 없이 임시저장 목록으로 돌아가야 한다/,/토스트·작성기 입력 성공/,
    /SAVE하는 것만으로 유료 파트너십 레이블 설정은 요구하지 않으며/,/직접 게시하기 전에.*레이블.*적용해야 한다/,
    /모바일 동기화는 미확인/,/JSON 값을 셸 명령이나 코드에 이어 붙이지 않는다/]) assert.match(prompt,pattern);
  const data=JSON.parse(prompt.split('\n').at(-1)!);
  assert.equal(data.operation,'save_draft');assert.equal(data.requestId,input.requestId);
  assert.equal(data.target,input.target);assert.equal(data.body,draft.body);
  assert.equal(data.product.shareUrl,product.shareUrl);assert.equal(data.product.id,product.id);
  assert.match(threadsDraftPrompt({...input,useWorkTabs:false}),/새 탭 생성으로 우회하지 않는다/);
});
test('Threads draft receipt requires every exact private-save and reopened verification field',()=>{
  assert.deepEqual(validateThreadsDraftReceipt(draftReceipt,input),{previewStatus:'visible'});
  assert.deepEqual(validateThreadsDraftReceipt({...draftReceipt,previewStatus:'unavailable'},input),{previewStatus:'unavailable'});
  for(const field of Object.keys(draftReceipt)){
    const partial:Record<string,unknown>={...draftReceipt};delete partial[field];
    assert.throws(()=>validateThreadsDraftReceipt(partial,input),/불확실/);
  }
  const malformed:unknown[]=[null,undefined,[],{},receipt,JSON.stringify(draftReceipt),
    `__AUTO_FLOW_TASK_${input.requestId}__:${JSON.stringify(draftReceipt)}`,
    {value:draftReceipt},Object.create(draftReceipt),
    ...[{requestId:'other'},{channel:'naver'},{target:'other'},{operation:'publish'},{saved:false},{saved:'true'},
      {published:true},{published:'false'},{verifiedOwner:false},{verifiedText:false},{verifiedDisclosure:false},
      {verifiedAffiliateUrl:'https://toss.shopping/_m/Other'},{verifiedDraftReopened:false},{verifiedDraftReopened:'true'},
      {previewStatus:'guessed'},{url:receipt.url},{reason:'저장 실패'}].map(change=>({...draftReceipt,...change}))];
  for(const value of malformed)assert.throws(()=>validateThreadsDraftReceipt(value,input),/불확실/);
});
test('draft-only methods reject wrong channels, injected identifiers, mismatched product and invalid bodies before dispatch',async()=>{
  let starts=0;
  const workflow=new AsideWorkflow(async()=>{starts++;throw new Error('must not start');});
  const invalid:PublishInput[]=[naverInput,{...input,target:'other; command'},{...input,target:'example\n'},
    {...input,requestId:'bad"; command'},{...input,requestId:'request\n'},
    {...input,draft:{...draft,productId:'other'}},{...input,product:{...product,soldOut:true}},
    {...input,draft:{...draft,body:`${draft.body}\n${product.shareUrl}`}},
    {...input,draft:{...draft,body:draft.body.replace(product.shareUrl,`${product.shareUrl}.`)}},
    {...input,draft:{...draft,body:`${DISCLOSURE}\n${'가'.repeat(501)}\n${product.shareUrl}`}},
    {...input,draft:{...draft,body:`${DISCLOSURE}\n\u0001\n${product.shareUrl}`}}];
  for(const value of invalid){
    assert.throws(()=>workflow.assertDraftSaveable(value));
    await assert.rejects(workflow.saveThreadsDraft(value));
  }
  assert.equal(starts,0);
});
test('draft save binds the original job session and returns no publication URL',async()=>{
  let starts=0,session='';
  const workflow=new AsideWorkflow(async<T>(request:AsideTaskRequest)=>{
    starts++;assert.equal(request.requestId,input.requestId);
    assert.equal(JSON.parse(request.prompt.split('\n').at(-1)!).operation,'save_draft');
    await request.onSession?.('draft-session');
    return {sessionId:'draft-session',value:draftReceipt as T};
  });
  workflow.assertDraftSaveable(input);
  assert.deepEqual(await workflow.saveThreadsDraft({...input,onSession:id=>{session=id;}}),{previewStatus:'visible'});
  assert.equal(session,'draft-session');assert.equal(starts,1);
});
test('uncertain draft saves are never retried and recovery only inspects the original session',async()=>{
  let starts=0,inspects=0,session='';
  const workflow=new AsideWorkflow(async request=>{
    starts++;await request.onSession?.('draft-timeout');throw new Error('timeout');
  },async<T>(id:string,key:string)=>{
    inspects++;assert.equal(id,'draft-timeout');assert.equal(key,input.requestId);
    return {status:'complete',value:draftReceipt as T};
  });
  await assert.rejects(workflow.saveThreadsDraft({...input,onSession:id=>{session=id;}}),/timeout/);
  assert.equal(session,'draft-timeout');
  assert.deepEqual(await workflow.recoverThreadsDraft(session,{...input,product:{...product,soldOut:true}}),{previewStatus:'visible'});
  assert.equal(starts,1);assert.equal(inspects,1);
});
test('draft recovery cannot accept a running, unavailable, public or partial receipt and never starts a task',async()=>{
  let starts=0;
  const runner:AsideTaskRunner=async()=>{starts++;throw new Error('must not start');};
  for(const status of ['running','unavailable'] as const){
    const workflow=new AsideWorkflow(runner,async()=>({status}));
    await assert.rejects(workflow.recoverThreadsDraft('draft-session',input));
  }
  for(const value of [receipt,{...draftReceipt,verifiedDraftReopened:false},{...draftReceipt,saved:false,reason:'확인 불가'}]){
    const workflow=new AsideWorkflow(runner,async<T>()=>({status:'complete',value:value as T}));
    await assert.rejects(workflow.recoverThreadsDraft('draft-session',input),/불확실/);
  }
  assert.equal(starts,0);
});
test('forged draft-save success is rejected after one task without retrying',async()=>{
  for(const value of [receipt,{...draftReceipt,verifiedDraftReopened:false},{...draftReceipt,target:'other'}]){
    let starts=0;
    const workflow=new AsideWorkflow(async<T>()=>{starts++;return {sessionId:'draft-session',value:value as T};});
    await assert.rejects(workflow.saveThreadsDraft(input),/불확실/);assert.equal(starts,1);
  }
});
test('manual publication verification uses unique read-only tasks without replacing the original job session',async()=>{
  const taskIds=new Set<string>();let callbacks=0;
  const workflow=new AsideWorkflow(async<T>(request:AsideTaskRequest)=>{
    assert.notEqual(request.requestId,input.requestId);
    assert.match(request.requestId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(!taskIds.has(request.requestId));taskIds.add(request.requestId);
    assert.equal(Object.hasOwn(request,'onSession'),false);
    const data=JSON.parse(request.prompt.split('\n').at(-1)!);
    assert.equal(data.operation,'verify_publication');assert.equal(data.url,receipt.url);
    assert.equal(data.requestId,input.requestId);assert.equal(data.target,input.target);
    assert.equal(data.body,draft.body);assert.equal(data.shareUrl,product.shareUrl);
    for(const pattern of [/읽기 전용/,/입력·편집·수정·저장·임시저장·삭제·게시·재게시·예약·답글·좋아요·팔로우·설정 변경을 절대 하지 않는다/,
      /불일치해도 고치지 말고 중단한다/,/원래 작업 requestId를 영수증 JSON에 그대로 사용/,
      /본문 전체와 줄바꿈/,/원본 제휴 링크/,/JSON 값을 셸 명령이나 실행 코드에 이어 붙이지 않는다/])assert.match(request.prompt,pattern);
    return {sessionId:`verification-${taskIds.size}`,value:receipt as T};
  },async()=>{throw new Error('must not recover a draft-save session');});
  for(let i=0;i<2;i++)assert.deepEqual(await workflow.verifyThreadsPublication({...input,product:{...product,soldOut:true},onSession:()=>{callbacks++;}},receipt.url),{url:receipt.url,previewStatus:'visible'});
  assert.equal(taskIds.size,2);assert.equal(callbacks,0);
});
test('verification rejects malformed URLs and target injection before starting a task',async()=>{
  let starts=0;
  const workflow=new AsideWorkflow(async()=>{starts++;throw new Error('must not start');});
  for(const url of ['https://www.threads.com/@other/post/ABC','https://evil.test/@example/post/ABC',
    `${receipt.url}?command=publish`,`${receipt.url}#edit`,`${receipt.url}\n`,
    'https://www.threads.com/@example/post/ABC;publish'])await assert.rejects(workflow.verifyThreadsPublication(input,url));
  for(const value of [naverInput,{...input,target:'example;publish'},{...input,requestId:'request"\npublish'}])await assert.rejects(workflow.verifyThreadsPublication(value,receipt.url));
  assert.equal(starts,0);
});
test('read-only verification rejects mismatched receipts and a different post on the same account without retrying',async()=>{
  for(const change of [{requestId:'transport-id'},{channel:'naver'},{target:'other'},
    {published:false,reason:'본문이 일치하지 않습니다.'},{verifiedOwner:false},{verifiedText:false},{verifiedDisclosure:false},
    {verifiedAffiliateUrl:'https://toss.shopping/_m/Other'},{url:'https://www.threads.com/@example/post/OTHER'},
    {url:'https://threads.com/@example/post/ABC'},{url:`${receipt.url}/`},{previewStatus:'guessed'}]){
    let starts=0;
    const workflow=new AsideWorkflow(async<T>(request:AsideTaskRequest)=>{
      starts++;assert.equal(Object.hasOwn(request,'onSession'),false);
      assert.match(request.prompt,/불일치해도 고치지 말고 중단한다/);
      return {sessionId:'verify-session',value:{...receipt,...change} as T};
    });
    await assert.rejects(workflow.verifyThreadsPublication(input,receipt.url));assert.equal(starts,1);
  }
});
test('Threads 500-codepoint boundary and exact-link punctuation rules remain shared',()=>{
  const prefix=`${DISCLOSURE}\n`,suffix=`\n${product.shareUrl}`;
  const body=prefix+String.fromCodePoint(0x1f600).repeat(500-[...prefix+suffix].length)+suffix;
  assert.equal(validateThreadsBody(body,product.shareUrl),product.shareUrl);
  for(const bad of [body+'가',body+'.',product.shareUrl,`${DISCLOSURE}\n${product.shareUrl}\nhttps://toss.im/other`])assert.throws(()=>validateThreadsBody(bad,product.shareUrl));
});
