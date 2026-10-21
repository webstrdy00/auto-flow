import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assertAsideScriptFits, decodeAsideResult, wrapAsideScript } from './aside-client.js';
const marker = '__TEST_ONLY_FRAME__:';
async function execute(script: string): Promise<string> {
  const lines: string[] = [];
  await vm.runInNewContext(`(async()=>{${wrapAsideScript(script, marker)}})()`, { console: { log: (value: string) => lines.push(value) } });
  return lines.join('\n');
}
test('Aside wrapper returns Unicode structured data without relying on final expressions', async () => {
  assert.match(wrapAsideScript('return null;', marker), /^await /);
  const output = await execute('return {name:"검증 상품",count:2};');
  assert.deepEqual(decodeAsideResult(output, marker), { name: '검증 상품', count: 2 });
});
test('CLI exit-zero REPL errors, duplicate or missing frames cannot be successes', () => {
  const frame = `${marker}{"ok":true,"value":[]}`;
  for (const output of ['[ok | 1ms]', `${frame}\n[error | 4ms]`, `${frame}\n${frame}`, `${marker}not-json`, `${marker}{"ok":true}`]) {
    assert.throws(() => decodeAsideResult(output, marker));
  }
  assert.deepEqual(decodeAsideResult(`${frame}\n[ok | 12ms]`, marker), []);
  assert.equal(decodeAsideResult(`${marker}{"ok":true,"value":"[error] is ordinary product text"}`, marker), '[error] is ordinary product text');
  assert.deepEqual(decodeAsideResult(`\x1b[2m${frame}\x1b[0m\n[ok | 12ms]`, marker), []);
  assert.throws(() => decodeAsideResult('Error: CDP command timeout: Page.enable\n[error | 33000ms]', marker), /탭 제어 연결/);
});
test('Unknown Aside failures are redacted and timeout failures give actionable guidance', async () => {
  let output = await execute('throw new Error("SECRET_TOKEN https://private.test/?code=secret");');
  assert.ok(!output.includes('SECRET_TOKEN'));
  assert.ok(!output.includes('private.test'));
  assert.throws(() => decodeAsideResult(output, marker), /화면 조작/);
  output = await execute('throw new Error("CDP command timeout: Page.enable");');
  assert.throws(() => decodeAsideResult(output, marker), /탭 제어 연결/);
  output = await execute('throw new Error("AF:상품 가격이 바뀌었습니다.");');
  assert.throws(() => decodeAsideResult(output, marker), /가격이 바뀌/);
});
test('Aside permission denials do not attempt fallback or retries', async () => {
  const output = await execute('throw new Error("Permission denied");');
  assert.throws(() => decodeAsideResult(output, marker), /권한을 우회하지/);
});

test('Windows command length is checked before approval or process creation', () => {
  assert.doesNotThrow(() => assertAsideScriptFits('return null;'));
  assert.throws(() => assertAsideScriptFits(`return ${JSON.stringify('한'.repeat(9000))};`), /길이 제한/);
});
