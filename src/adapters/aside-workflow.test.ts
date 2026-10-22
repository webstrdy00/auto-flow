import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCLOSURE, validateThreadsBody, type Product, type Draft, type Settings } from '../shared.js';
import { AsideWorkflow, PublicationBlockedError, generationPrompt, publicationPrompt, parseGeneratedDrafts, validatePublicationReceipt, type PublishInput } from './aside-workflow.js';
import type { AsideTaskRunner, AsideTaskRequest } from './aside-tasks.js';
const product: Product = { id:'123',name:'검증 용기 2개',sourceUrl:'https://sharelink.toss.im/links/products/123',price:'4,500원',soldOut:false,checkedAt:new Date().toISOString(),facts:'검정, 2개 구성',shareUrl:'https://toss.shopping/_m/Example123' };
const settings: Settings = {naverBlogId:'example',threadsHandle:'example',tone:'다양하고 사실적인 문체',useWorkTabs:true};
const generated = {drafts:[{channel:'naver',title:'구성 비교',body:'용기 2개, 표시 가격 4,500원.\n필요한 수량을 확인하세요.'},{channel:'threads',title:'수량 안내',body:'용기 2개 구성, 표시 가격 4,500원입니다.'}]};
const draft: Draft = {id:'draft',productId:product.id,channel:'threads',title:'구성 안내',body:`${DISCLOSURE}\n${product.name}\n${product.shareUrl}`,version:1,updatedAt:product.checkedAt};
const input: PublishInput = {requestId:'request-123',draft,product,target:'example',useWorkTabs:true,onSession:()=>{}};
const receipt = {requestId:input.requestId,channel:'threads',target:'example',published:true,url:'https://www.threads.com/@example/post/ABC',verifiedOwner:true,verifiedText:true,verifiedDisclosure:true,verifiedAffiliateUrl:product.shareUrl,previewStatus:'visible'};

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
test('both channels preserve supplied previews and forbid overwriting existing drafts',()=>{
  for(const channel of ['naver','threads'] as const){
    const prompt=publicationPrompt({...input,draft:{...draft,channel}});
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
  }
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
  const blocked={requestId:input.requestId,channel:input.draft.channel,target:input.target,published:false,reason:'실제 플랫폼 안내에서 필수 항목을 확인했습니다.'};
  let starts=0,inspects=0,session='';
  const workflow=new AsideWorkflow(async<T>(request:AsideTaskRequest)=>{
    starts++;await request.onSession?.('session-blocked');return {sessionId:'session-blocked',value:blocked as T};
  },async<T>(id:string,key:string)=>{
    inspects++;assert.equal(id,'session-blocked');assert.equal(key,input.requestId);return {status:'complete',value:blocked as T};
  });
  for(const action of [()=>workflow.publish({...input,onSession:id=>{session=id;}}),()=>workflow.recover(session,input)]) {
    await assert.rejects(action,error=>{
      assert.ok(error instanceof PublicationBlockedError);assert.equal(error.reason,blocked.reason);return true;
    });
  }
  assert.equal(session,'session-blocked');assert.equal(starts,1);assert.equal(inspects,1);
});
test('timeout after session admission is not retried and recovery only inspects the same session',async()=>{
  let starts=0,inspects=0,session='';
  const runner: AsideTaskRunner=async r=>{starts++;await r.onSession?.('session-123');throw new Error('timeout');};
  const workflow=new AsideWorkflow(runner,async<T>(id: string,key: string)=>{inspects++;assert.equal(id,'session-123');assert.equal(key,input.requestId);return {status:'complete',value:receipt as T};});
  await assert.rejects(workflow.publish({...input,onSession:id=>{session=id;}}));
  assert.equal(session,'session-123');
  assert.equal((await workflow.recover(session,input)).url,receipt.url);
  assert.equal(starts,1);assert.equal(inspects,1);
});
test('running task cannot be interpreted as a completed publication',async()=>{
  const workflow=new AsideWorkflow(async()=>{throw new Error('must not start');},async()=>({status:'running'}));
  await assert.rejects(workflow.recover('session-123',input),/아직 실행 중/);
});
test('Threads 500-codepoint boundary and exact-link punctuation rules remain shared',()=>{
  const prefix=`${DISCLOSURE}\n`,suffix=`\n${product.shareUrl}`;
  const body=prefix+String.fromCodePoint(0x1f600).repeat(500-[...prefix+suffix].length)+suffix;
  assert.equal(validateThreadsBody(body,product.shareUrl),product.shareUrl);
  for(const bad of [body+'가',body+'.',product.shareUrl,`${DISCLOSURE}\n${product.shareUrl}\nhttps://toss.im/other`])assert.throws(()=>validateThreadsBody(bad,product.shareUrl));
});
