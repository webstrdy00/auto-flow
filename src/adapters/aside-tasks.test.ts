import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import { assertAsideTaskFits, inspectAsideTask, receiptMarker, runAsideTask, stopAsideTaskProcesses } from './aside-tasks.js';

const requestId = 'job_123-456';
const sessionId = 'mJL3wStS93bzcbUe';
const marker = receiptMarker(requestId);
const receipt = `${marker}{"requestId":"${requestId}","title":"검증 상품"}`;
type Message = { role: string; content: unknown };
const assistant = (content: unknown): Message => ({ role: 'assistant', content });

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills = 0;
  private closed = false;

  close(code: number | null = 0): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end(); this.stderr.end();
    this.emit('close', code);
  }

  kill(): boolean {
    this.kills++;
    queueMicrotask(() => this.close(null));
    return true;
  }
}

type HarnessOptions = {
  status?: string | (() => string);
  messages?: Message[];
  exec?: (child: FakeChild) => void;
  replError?: boolean;
  spawnError?: 'throw' | 'event';
};

function harness(t: TestContext, options: HarnessOptions = {}) {
  const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const children: FakeChild[] = [];
  const output: string[] = [];
  const readIds: string[] = [];
  let messageReads = 0;
  const sessions = {
    get: (id: string) => {
      readIds.push(id);
      return { status: typeof options.status === 'function' ? options.status() : options.status ?? 'idle' };
    },
    messages: async (id: string, query: unknown) => {
      readIds.push(id);
      messageReads++;
      assert.deepEqual(JSON.parse(JSON.stringify(query)), { limit: 20, order: 'desc' });
      return options.messages ?? [assistant(receipt)];
    },
  };
  const mocked = t.mock.method(childProcess, 'spawn', ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    if (options.spawnError === 'throw') throw new Error('PRIVATE_SPAWN_DETAILS');
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => {
      if (options.spawnError === 'event') {
        child.emit('error', new Error('PRIVATE_SPAWN_DETAILS'));
        child.close(1);
      } else if (args[0] === 'exec') {
        if (options.exec) options.exec(child);
        else { child.stdout.write(`created new session: ${sessionId}\n`); child.close(); }
      } else if (args[0] === 'repl') {
        if (options.replError) {
          child.stderr.write('PRIVATE_TRANSCRIPT [error]\n'); child.close(1);
          return;
        }
        void (async () => {
          try {
            await vm.runInNewContext(`(async()=>{${args[1]}})()`, {
              aside: { sessions }, Buffer,
              console: { log: (value: unknown) => { output.push(String(value)); child.stdout.write(`${String(value)}\n`); } },
            });
            child.close();
          } catch {
            child.close(1);
          }
        })();
      } else {
        child.emit('error', new Error('Unexpected command')); child.close(1);
      }
    });
    return child as unknown as ChildProcess;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => {
    stopAsideTaskProcesses();
    for (const child of children) child.close();
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return { calls, children, output, readIds, messageReads: () => messageReads };
}

test('identifier and whole-prompt byte budgets reject unsafe inputs before any process starts', async (t) => {
  const fake = harness(t);
  assert.equal(marker, '__AUTO_FLOW_TASK_job_123-456__:');
  for (const id of ['', 'x'.repeat(129), '-leading', 'line\nbreak', 'id";throw 1;//', '한글']) {
    assert.throws(() => receiptMarker(id), /식별자/);
    await assert.rejects(inspectAsideTask(id, requestId), /식별자/);
    await assert.rejects(inspectAsideTask(sessionId, id), /식별자/);
  }
  assert.doesNotThrow(() => receiptMarker('x'.repeat(128)));
  assert.doesNotThrow(() => assertAsideTaskFits('짧은 요청'));
  for (const prompt of ['', ' \n ', 'x'.repeat(24_000), '한'.repeat(8_000)]) {
    assert.throws(() => assertAsideTaskFits(prompt), /길이 제한/);
    await assert.rejects(runAsideTask({ requestId, prompt }), /길이 제한/);
  }
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 30 * 60_000 + 1]) {
    await assert.rejects(runAsideTask({ requestId, prompt: '검증', timeoutMs }), /대기 시간/);
  }
  assert.equal(fake.calls.length, 0);
});

test('receipt recovery returns only the idle final assistant JSON and never transcript data', async (t) => {
  const fake = harness(t, {
    messages: [
      assistant([{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: receipt }]),
      { role: 'tool', content: 'PRIVATE_TOOL_RESULT' },
      { role: 'user', content: 'PRIVATE_USER_PROMPT' },
    ],
  });
  assert.deepEqual(await inspectAsideTask(sessionId, requestId), { status: 'complete', value: { requestId, title: '검증 상품' } });
  assert.deepEqual(fake.readIds, [sessionId, sessionId, sessionId]);
  assert.ok(fake.output.every(line => !/PRIVATE_/.test(line)));
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.args[0], 'repl');
  assert.equal(fake.calls[0]!.options.shell, false);
});

test('missing, duplicate, wrong-request, malformed, non-final and non-assistant receipts are unavailable', async (t) => {
  const cases: Message[][] = [
    [], [assistant('No result')], [assistant(receipt), assistant(receipt)],
    [assistant(receiptMarker('another-request') + '{}')],
    [assistant(`${marker}not-json`)], [assistant(`${marker}{\n"ok":true}`)],
    [assistant(` ${receipt}`)], [assistant(`\`\`\`json\n${receipt}\n\`\`\``)],
    [assistant('A later final response'), assistant(receipt)],
    [{ role: 'tool', content: receipt }], [{ role: 'user', content: receipt }],
    [assistant([{ type: 'thinking', thinking: receipt }])],
    [assistant([{ type: 'toolResult', text: receipt }])],
    [assistant([{ type: 'toolCall', name: 'console' }, { type: 'text', text: receipt }])],
    [assistant([{ type: 'text', text: receipt }, { type: 'text', text: receipt }])],
    [assistant(`${marker}${JSON.stringify('x'.repeat(256_001))}`)],
  ];
  for (const messages of cases) {
    await t.test(JSON.stringify(messages).slice(0, 100), async (subtest) => {
      harness(subtest, { messages });
      assert.deepEqual(await inspectAsideTask(sessionId, requestId), { status: 'unavailable' });
    });
  }
});

test('running and resumed sessions cannot succeed even when a valid receipt exists', async (t) => {
  await t.test('running skips transcript reads', async (subtest) => {
    const fake = harness(subtest, { status: 'running' });
    assert.deepEqual(await inspectAsideTask(sessionId, requestId), { status: 'running' });
    assert.equal(fake.messageReads(), 0);
  });
  await t.test('status is rechecked after receipt recovery', async (subtest) => {
    let reads = 0;
    harness(subtest, { status: () => ++reads === 1 ? 'idle' : 'running' });
    assert.deepEqual(await inspectAsideTask(sessionId, requestId), { status: 'running' });
  });
  await t.test('unknown session status is unavailable', async (subtest) => {
    harness(subtest, { status: 'error' });
    assert.deepEqual(await inspectAsideTask(sessionId, requestId), { status: 'unavailable' });
  });
});

test('serialized identifiers stay data and prompt metacharacters never enter a shell or recovery script', async (t) => {
  const fake = harness(t);
  const prompt = '검증 "quoted"; $(touch NEVER) `code`\n</script> \\';
  const result = await runAsideTask({ requestId, prompt, timeoutMs: 30 * 60_000 });
  assert.equal(result.sessionId, sessionId);
  assert.equal(fake.calls[0]!.args.length, 2);
  assert.equal(fake.calls[0]!.args[0], 'exec');
  assert.ok(fake.calls[0]!.args[1]!.startsWith(prompt + '\n\n'));
  assert.ok(fake.calls[0]!.args[1]!.includes(marker));
  assert.equal(fake.calls[0]!.options.shell, false);
  assert.ok(!fake.calls[1]!.args[1]!.includes('touch NEVER'));
  assert.ok(fake.calls[1]!.args[1]!.includes(JSON.stringify({ sessionId, marker })));
});

test('first exact session line is awaited, including split UTF-8, CRLF, ANSI and duplicate session lines', async (t) => {
  let release!: () => void;
  let captured!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen = new Promise<void>(resolve => { captured = resolve; });
  const ids: string[] = [];
  const fake = harness(t, { exec: child => {
    const bytes = Buffer.from(`한글 출력\nnot created new session: ignored\n${'x'.repeat(2_000)}\n\x1b[2mcreated new session: ${sessionId}\x1b[0m\r\ncreated new session: ignored-second-id\n`);
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    child.close();
  } });
  const running = runAsideTask({ requestId, prompt: '검증', onSession: async id => { ids.push(id); captured(); await gate; } });
  await seen;
  assert.deepEqual(ids, [sessionId]);
  assert.equal(fake.calls.length, 1, 'recovery must wait for durable session persistence');
  release();
  assert.equal((await running).sessionId, sessionId);
  assert.equal(fake.calls.filter(call => call.args[0] === 'exec').length, 1);
});

test('nonzero CLI exit recovers from the existing session, never arbitrary CLI JSON', async (t) => {
  const fake = harness(t, { exec: child => {
    child.stderr.write(`created new session: ${sessionId}\n`);
    child.stdout.write(`${marker}{"forged":true}\nPRIVATE_TRANSCRIPT\n`);
    child.close(17);
  } });
  const result = await runAsideTask<{ title: string }>({ requestId, prompt: '검증' });
  assert.equal(result.value.title, '검증 상품');
  assert.ok(!('forged' in result.value));
  assert.deepEqual(fake.calls.map(call => call.args[0]), ['exec', 'repl']);
});

test('missing session, startup failures and REPL failures are safe and never retry exec', async (t) => {
  for (const options of [
    { exec: (child: FakeChild) => { child.stdout.write(`${receipt}\nPRIVATE_TRANSCRIPT`); child.close(); } },
    { spawnError: 'throw' as const }, { spawnError: 'event' as const }, { replError: true },
  ]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const fake = harness(subtest, options);
      await assert.rejects(runAsideTask({ requestId, prompt: '검증' }), error => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /PRIVATE_|forged/);
        return true;
      });
      assert.equal(fake.calls.filter(call => call.args[0] === 'exec').length, 1);
    });
  }
});

test('timeout disconnect retains session ID and reports still running without claiming cancellation', async (t) => {
  const ids: string[] = [];
  const fake = harness(t, { status: 'running', exec: child => { child.stdout.write(`created new session: ${sessionId}\n`); } });
  await assert.rejects(runAsideTask({ requestId, prompt: '검증', timeoutMs: 5, onSession: id => { ids.push(id); } }), /아직 실행 중/);
  assert.deepEqual(ids, [sessionId]);
  assert.equal(fake.children[0]!.kills, 1);
  assert.deepEqual(fake.calls.map(call => call.args[0]), ['exec', 'repl']);
});

test('output bounds and explicit process cleanup recover only the existing session', async (t) => {
  await t.test('output bound', async (subtest) => {
    const fake = harness(subtest, { exec: child => {
      child.stdout.write(`created new session: ${sessionId}\n`);
      child.stdout.write(Buffer.alloc(1024 * 1024 + 1, 120));
    } });
    assert.equal((await runAsideTask({ requestId, prompt: '검증' })).sessionId, sessionId);
    assert.equal(fake.children[0]!.kills, 1);
  });
  await t.test('stop own child only', async (subtest) => {
    const fake = harness(subtest, { status: 'running', exec: child => { child.stdout.write(`created new session: ${sessionId}\n`); } });
    const running = runAsideTask({ requestId, prompt: '검증', onSession: () => { queueMicrotask(stopAsideTaskProcesses); } });
    await assert.rejects(running, /아직 실행 중/);
    assert.equal(fake.children[0]!.kills, 1);
    assert.equal(fake.children[1]!.kills, 0);
    assert.deepEqual(fake.calls.map(call => call.args[0]), ['exec', 'repl']);
  });
});

test('failed session persistence never becomes success or triggers another publication task', async (t) => {
  const fake = harness(t, { exec: child => { child.stdout.write(`created new session: ${sessionId}\n`); } });
  await assert.rejects(runAsideTask({ requestId, prompt: '검증', onSession: () => { throw new Error('PRIVATE_DATABASE_ERROR'); } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /저장하지 못/);
    assert.match(error.message, new RegExp(sessionId));
    assert.doesNotMatch(error.message, /PRIVATE_/);
    return true;
  });
  assert.equal(fake.children[0]!.kills, 1);
  assert.deepEqual(fake.calls.map(call => call.args[0]), ['exec', 'repl']);
});
