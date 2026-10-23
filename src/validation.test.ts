import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, validateResultUrl } from './validation.js';

test('IPC rejects arbitrary commands, oversized values and extra fields', () => {
  assert.throws(() => parseCommand({ type: 'shell', command: 'anything' }));
  assert.throws(() => parseCommand({ type: 'state', token: 'hidden' }));
  assert.throws(() => parseCommand({ type: 'saveSettings', naverBlogId:'', threadsHandle:'', tone:'x'.repeat(2001), useWorkTabs:true }));
  assert.throws(() => parseCommand({ type: 'approve', draftId: '1', scheduledAt: 'tomorrow' }));
  assert.deepEqual(parseCommand({ type:'pause', paused:true }), { type:'pause', paused:true });
});
test('external links require real post paths and the exact approved channel account', () => {
  assert.equal(validateResultUrl('https://blog.naver.com/example/123', 'naver', 'example'), 'https://blog.naver.com/example/123');
  assert.equal(validateResultUrl('https://www.threads.com/@author/post/ABC_123', 'threads'), 'https://www.threads.com/@author/post/ABC_123');
  assert.equal(validateResultUrl('https://www.threads.com/@author.name_1/post/ABC_123', 'threads', 'author.name_1'), 'https://www.threads.com/@author.name_1/post/ABC_123');
  for (const url of ['https://blog.naver.com.evil.test/example/123','javascript:alert(1)','https://evil@blog.naver.com/example/123','http://blog.naver.com/example/123','https://blog.naver.com/other/123']) {
    assert.throws(() => validateResultUrl(url, 'naver', 'example'));
  }
  assert.throws(() => validateResultUrl('https://www.threads.com/', 'threads'));
  for (const url of [
    'https://www.threads.com/@other/post/ABC_123',
    'https://www.threads.com/@author.extra/post/ABC_123',
    'https://www.threads.com/@Author/post/ABC_123',
    'https://www.threads.com.evil.test/@author/post/ABC_123',
    'https://www.threads.com/@author/post/ABC_123?token=private',
    'https://www.threads.com/@author/post/ABC_123#fragment',
    'https://user:password@www.threads.com/@author/post/ABC_123',
    'https://www.threads.com:8443/@author/post/ABC_123',
    'https://www.threads.com/@author/post/ABC_123/extra',
    'https://www.threads.com/@author/post/ABC_123\n',
  ]) assert.throws(() => validateResultUrl(url, 'threads', 'author'));
  for (const handle of ['.author', 'author.', 'author..name', '한글', 'a'.repeat(31)]) {
    assert.throws(() => validateResultUrl(`https://www.threads.com/@${handle}/post/ABC_123`, 'threads'));
  }
});

test('settings IPC accepts only browser preferences, normalizes handles, and rejects all old secret fields', () => {
  const command = { type: 'saveSettings' as const, naverBlogId: 'my_blog', threadsHandle: '@author.name_1', tone: '확인된 사실만 다양하게 작성합니다.', useWorkTabs: true };
  assert.deepEqual(parseCommand(command), { ...command, threadsHandle: 'author.name_1' });
  for (const useWorkTabs of [true, false]) {
    assert.deepEqual(parseCommand({ ...command, threadsHandle: '', useWorkTabs }), { ...command, threadsHandle: '', useWorkTabs });
  }
  for (const threadsHandle of ['@@author', 'author-name', 'author/name', '.author', 'author.', 'author..name', 'a'.repeat(31), '@', 'author\n']) {
    assert.throws(() => parseCommand({ ...command, threadsHandle }));
  }
  for (const threadsHandle of ['author', '_author', '12345', '1.5', '0']) {
    assert.equal((parseCommand({ ...command, threadsHandle }) as typeof command).threadsHandle, threadsHandle);
  }
  for (const field of ['aiKey', 'threadsToken', 'aiModel', 'threadsUserId', 'hasAiKey', 'hasThreadsToken', 'apiKey', 'token']) {
    assert.throws(() => parseCommand({ ...command, [field]: 'not-accepted' }));
  }
  for (const useWorkTabs of [undefined, 'true', 1]) assert.throws(() => parseCommand({ ...command, useWorkTabs }));
});

test('job checks accept only a job ID and never a supplied session or secret', () => {
  assert.deepEqual(parseCommand({ type: 'checkJob', jobId: 'job-1' }), { type: 'checkJob', jobId: 'job-1' });
  for (const command of [
    { type: 'checkJob' }, { type: 'checkJob', jobId: '' }, { type: 'checkJob', jobId: 'x'.repeat(201) },
    { type: 'checkJob', jobId: 'job-1', asideSessionId: 'untrusted-session' },
    { type: 'checkJob', jobId: 'job-1', threadsToken: 'not-accepted' },
  ]) assert.throws(() => parseCommand(command));
});

test('product IPC accepts observed affiliate URLs but rejects lookalikes and hidden parameters', () => {
  const product = {
    id: '123', name: '검증 상품', sourceUrl: 'https://sharelink.toss.im/links/products/123',
    price: '4,500원', soldOut: false, checkedAt: new Date().toISOString(), facts: '',
    shareUrl: 'https://toss.shopping/_m/Example_123',
  };
  assert.deepEqual(parseCommand({ type: 'saveProduct', product }), { type: 'saveProduct', product });
  for (const shareUrl of ['https://toss.shopping.evil.test/_m/abc', 'https://toss.shopping/_m/abc?secret=x']) {
    assert.throws(() => parseCommand({ type: 'saveProduct', product: { ...product, shareUrl } }));
  }
});

test('Threads draft commands exclude schedules and require three literal acknowledgments', () => {
  assert.deepEqual(parseCommand({ type: 'approveThreadsDraft', draftId: 'draft-1' }), { type: 'approveThreadsDraft', draftId: 'draft-1' });
  assert.throws(() => parseCommand({ type: 'approveThreadsDraft', draftId: 'draft-1', scheduledAt: null }));
  const complete = { type: 'completeThreadsPublication', jobId: 'job-1', resultUrl: 'https://threads.com/@person/post/abc' };
  assert.deepEqual(parseCommand(complete), complete);
  const acknowledgment = { type: 'confirmDraftNotSaved', jobId: 'job-1', remoteStopped: true, noSavedDraft: true, noPublicPost: true };
  assert.deepEqual(parseCommand(acknowledgment), acknowledgment);
  for (const key of ['remoteStopped', 'noSavedDraft', 'noPublicPost']) {
    for (const value of [undefined, false, 1, 'true', null]) assert.throws(() => parseCommand({ ...acknowledgment, [key]: value }));
  }
  assert.throws(() => parseCommand({ ...acknowledgment, asideSessionId: 'untrusted' }));
});
