import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { asideExecutable, runAside } from './aside-client.js';

export interface AsideTaskRequest {
  requestId: string;
  prompt: string;
  timeoutMs?: number;
  onSession?: (sessionId: string) => void | Promise<void>;
}

export interface AsideTaskResult<T> {
  sessionId: string;
  value: T;
}

export type AsideTaskRunner = <T>(request: AsideTaskRequest) => Promise<AsideTaskResult<T>>;
type Inspection<T> = { status: 'running' | 'complete' | 'unavailable'; value?: T };
type EndReason = 'exit' | 'spawn-error' | 'timeout' | 'output-limit' | 'stopped' | 'callback-error';
type Execution = { sessionId?: string; persistenceFailed: boolean; reason: EndReason };

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_PROMPT_BYTES = 24_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 512;
const MAX_IDENTIFIER_CHARS = 128;
const active = new Map<ChildProcess, () => void>();

function assertIdentifier(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error('Aside 작업 식별자가 올바르지 않습니다.');
  }
}

export function receiptMarker(requestId: string): string {
  assertIdentifier(requestId);
  return `__AUTO_FLOW_TASK_${requestId}__:`;
}

function taskPrompt(prompt: string, marker: string): string {
  return `${prompt}\n\nAUTO FLOW FINAL OUTPUT CONTRACT:\nReturn exactly one final assistant text message: the exact marker ${marker} immediately followed by one single-line JSON value. No Markdown fences, preamble, trailing explanation, or additional receipt. Only include verified results; never invent success. Do not print the receipt in thinking, tool calls, or tool results. Do not repeat the task after an error or uncertain outcome.`;
}

export function assertAsideTaskFits(prompt: string): void {
  // Reserve the longest permitted request ID so this check is safe before approval.
  const marker = receiptMarker('0'.repeat(MAX_IDENTIFIER_CHARS));
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(taskPrompt(prompt, marker), 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error('Aside 작업 길이 제한을 초과했거나 요청이 비어 있습니다. 원고를 확인한 뒤 다시 승인하세요.');
  }
}

export function stopAsideTaskProcesses(): void {
  // Disconnect only our CLI children. The remote task may still be running.
  for (const stop of active.values()) stop();
}

function executeTask(prompt: string, timeoutMs: number, onSession?: AsideTaskRequest['onSession']): Promise<Execution> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(asideExecutable(), ['exec', prompt], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ reason: 'spawn-error', persistenceFailed: false });
      return;
    }
    let sessionId: string | undefined;
    let persistenceFailed = false;
    let persistence = Promise.resolve();
    let ended = false;
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const streams = [child.stdout!, child.stderr!];

    const rememberSession = (line: string) => {
      if (sessionId) return;
      const match = /^created new session: ([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(line.replace(/\x1b\[[0-9;]*m/g, ''));
      if (!match) return;
      sessionId = match[1]!;
      for (const stream of streams) stream.pause();
      persistence = (async () => {
        try { await onSession?.(sessionId!); }
        catch { persistenceFailed = true; }
      })().then(() => {
        if (persistenceFailed) finish('callback-error');
        if (!ended) for (const stream of streams) stream.resume();
      });
    };

    const parsers = streams.map(() => {
      const decoder = new StringDecoder('utf8');
      let line = '';
      let discard = false;
      const consume = (text: string) => {
        let start = 0;
        while (start < text.length) {
          const end = text.indexOf('\n', start);
          const segmentEnd = end === -1 ? text.length : end;
          if (!discard && line.length + segmentEnd - start <= MAX_LINE_CHARS) line += text.slice(start, segmentEnd);
          else { line = ''; discard = true; }
          if (end === -1) break;
          if (!discard) rememberSession(line.endsWith('\r') ? line.slice(0, -1) : line);
          line = ''; discard = false; start = end + 1;
        }
      };
      return {
        write: (chunk: Buffer) => consume(decoder.write(chunk)),
        end: () => {
          consume(decoder.end());
          if (!discard && line) rememberSession(line.endsWith('\r') ? line.slice(0, -1) : line);
          line = ''; discard = false;
        },
      };
    });

    const finish = (reason: EndReason) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      for (const parser of parsers) parser.end();
      for (const stream of streams) stream.resume();
      if (reason !== 'exit') {
        try { child.kill(); } catch { /* A disconnected CLI does not cancel its remote session. */ }
      }
      void persistence.then(() => resolve({ sessionId, persistenceFailed, reason }));
    };

    active.set(child, () => finish('stopped'));
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    streams.forEach((stream, index) => stream.on('data', (chunk: Buffer) => {
      if (ended) return;
      const remaining = MAX_OUTPUT_BYTES - bytes;
      bytes += chunk.length;
      parsers[index]!.write(chunk.subarray(0, Math.max(0, remaining)));
      if (bytes > MAX_OUTPUT_BYTES) finish('output-limit');
    }));
    child.on('error', () => finish('spawn-error'));
    child.on('close', () => {
      active.delete(child);
      finish('exit');
    });
  });
}

function inspectionScript(sessionId: string, requestId: string): string {
  const input = JSON.stringify({ sessionId, marker: receiptMarker(requestId) });
  return `
const input = ${input};
try {
  const session = await aside.sessions.get(input.sessionId);
  if (session?.status === 'running') return {status:'running'};
  if (session?.status !== 'idle') return {status:'unavailable'};
  const messages = await aside.sessions.messages(input.sessionId, {limit:20,order:'desc'});
  if (!Array.isArray(messages)) return {status:'unavailable'};
  const texts = [];
  for (const message of messages) {
    if (message?.role !== 'assistant') continue;
    let text;
    if (typeof message.content === 'string') text = message.content;
    else if (Array.isArray(message.content)) {
      if (message.content.some(block => !block || !['text','thinking'].includes(block.type))) continue;
      text = message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\\n');
    }
    if (typeof text === 'string' && text.length) texts.push(text);
  }
  const receipts = texts.filter(text => text.startsWith(input.marker));
  if (receipts.length !== 1 || texts[0] !== receipts[0]) return {status:'unavailable'};
  const payload = receipts[0].slice(input.marker.length);
  if (!payload || /[\\r\\n\\u2028\\u2029]/.test(payload) || Buffer.byteLength(payload, 'utf8') > 256000) return {status:'unavailable'};
  const value = JSON.parse(payload);
  const latest = await aside.sessions.get(input.sessionId);
  if (latest?.status === 'running') return {status:'running'};
  if (latest?.status !== 'idle') return {status:'unavailable'};
  return {status:'complete',value};
} catch {
  return {status:'unavailable'};
}`;
}

export async function inspectAsideTask<T>(sessionId: string, requestId: string): Promise<Inspection<T>> {
  assertIdentifier(sessionId);
  assertIdentifier(requestId);
  try {
    const result = await runAside<Inspection<T>>(inspectionScript(sessionId, requestId));
    if (result?.status === 'running') return { status: 'running' };
    if (result?.status === 'complete' && Object.hasOwn(result, 'value')) return { status: 'complete', value: result.value };
  } catch { /* Never expose REPL output, transcripts, or internal exception details. */ }
  return { status: 'unavailable' };
}

export async function runAsideTask<T>(request: AsideTaskRequest): Promise<AsideTaskResult<T>> {
  const marker = receiptMarker(request.requestId);
  assertAsideTaskFits(request.prompt);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('Aside 대기 시간은 1밀리초 이상 30분 이하여야 합니다.');
  }
  const execution = await executeTask(taskPrompt(request.prompt, marker), timeoutMs, request.onSession);
  if (!execution.sessionId) {
    if (execution.reason === 'spawn-error') throw new Error('Aside CLI를 실행할 수 없습니다. 설치와 연결 상태를 확인하세요. 자동 재시도하지 않습니다.');
    throw new Error('Aside 작업 ID를 확인하지 못했습니다. 작업이 실행 중일 수 있으므로 새 작업을 시작하지 말고 Aside에서 직접 확인하세요.');
  }
  const result = await inspectAsideTask<T>(execution.sessionId, request.requestId);
  if (execution.persistenceFailed) {
    throw new Error(`Aside 작업 ID ${execution.sessionId}를 저장하지 못했습니다. 작업이 계속 실행 중이거나 이미 완료되었을 수 있습니다. 새 작업을 시작하지 말고 결과를 직접 확인하세요.`);
  }
  if (result.status === 'complete') return { sessionId: execution.sessionId, value: result.value as T };
  if (result.status === 'running') {
    throw new Error(`Aside 작업 ${execution.sessionId}가 아직 실행 중입니다. 중복 실행하지 말고 같은 작업의 결과를 다시 확인하세요.`);
  }
  throw new Error(`Aside 작업 ${execution.sessionId}의 완료 여부를 검증하지 못했습니다. 이미 실행된 동작이 있을 수 있으므로 중복 실행하지 말고 같은 작업을 직접 확인하세요.`);
}
