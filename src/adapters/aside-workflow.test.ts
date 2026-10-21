import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCLOSURE, validateThreadsBody, type Product, type Draft, type Settings } from '../shared.js';
import { AsideWorkflow, generationPrompt, publicationPrompt, parseGeneratedDrafts, validatePublicationReceipt, type PublishInput } from './aside-workflow.js';
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
test('both channels preserve supplied previews and forbid overwriting existing drafts',()=>{
  for(const channel of ['naver','threads'] as const){
    const prompt=publicationPrompt({...input,draft:{...draft,channel}});
    assert.match(prompt,/미리보기는 유지/);assert.match(prompt,/기존 작성 중\/임시저장 글을 덮어쓰거나 삭제하지 않는다/);
    assert.ok(prompt.includes(JSON.stringify(draft.body)));
  }
});
test('published receipt must bind request, account, body verification and original link',()=>{
  assert.equal(validatePublicationReceipt(receipt,input).url,receipt.url);
  for(const change of [{requestId:'other'},{target:'other'},{published:false},{verifiedText:false},{verifiedDisclosure:false},{verifiedAffiliateUrl:'https://toss.shopping/_m/Other'},{url:'https://www.threads.com/@other/post/ABC'},{url:'https://evil.test/post/ABC'},{previewStatus:'guessed'}]) assert.throws(()=>validatePublicationReceipt({...receipt,...change},input));
  assert.equal(validatePublicationReceipt({...receipt,previewStatus:'unavailable'},input).previewStatus,'unavailable');
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
