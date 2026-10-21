import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type AsideRunner = <T>(script: string) => Promise<T>;
const MAX_OUTPUT = 1024 * 1024;
const TIMEOUT_MS = 140_000;
const active = new Set<ChildProcess>();

export function stopAsideProcesses(): void {
  // Stop only this app's CLI children, never the user's Aside browser or its tabs.
  for (const child of active) child.kill();
}

export function assertAsideScriptFits(script: string): void {
  const sampleMarker = `__AUTO_FLOW_${'0'.repeat(32)}__:`;
  if (Buffer.byteLength(wrapAsideScript(script, sampleMarker), 'utf8') > 24_000) {
    throw new Error('Aside 작업 길이 제한을 초과했습니다. 원고를 줄인 뒤 다시 승인하세요.');
  }
}

export function wrapAsideScript(script: string, marker: string): string {
  return `await (async()=>{try{const value=await(async()=>{${script}\n})();console.log(${JSON.stringify(marker)}+JSON.stringify({ok:true,value}));}catch(error){const message=String(error?.message||'');let safe='Aside 화면 조작에 실패했습니다. 로그인, 열린 탭과 화면 구조를 확인하세요. 자동 재시도하지 않습니다.';if(message.includes('Page.enable'))safe='Aside 탭 목록에는 연결했지만 탭 제어 연결(Page.enable)이 시간 초과되었습니다. Aside에서 해당 탭을 직접 확인하고 다시 연결하세요.';else if(/timeout|timed out/i.test(message))safe='Aside 응답 시간이 초과되었습니다. 이미 실행된 동작이 있을 수 있으므로 결과를 확인한 후 다시 시도하세요.';else if(/permission|denied|not allowed/i.test(message))safe='Aside 또는 사이트의 조작 권한이 없습니다. 권한을 우회하지 않고 중단했습니다.';else if(message.startsWith('AF:'))safe=message.slice(3,353).replace(/https?:\\/\\/[^\\s]+/g,'[주소 생략]');console.log(${JSON.stringify(marker)}+JSON.stringify({ok:false,error:safe}));}})()`;
}

export function decodeAsideResult<T>(output: string, marker: string): T {
  // Do not treat the CLI's exit status as a REPL success: some REPL errors exit 0.
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const frames = lines.filter(line => line.startsWith(marker));
  if (frames.length !== 1 || lines.some(line => /^\[error(?:\s*\||\s*\])/.test(line))) {
    if (output.includes('Page.enable')) throw new Error('Aside 탭 목록에는 연결했지만 탭 제어 연결(Page.enable)이 시간 초과되었습니다. Aside에서 해당 탭을 직접 확인하고 다시 연결하세요.');
    if (/permission denied|not allowed/i.test(output)) throw new Error('Aside 또는 사이트의 조작 권한이 없습니다. 권한을 우회하지 않고 중단했습니다.');
    throw new Error('Aside에서 검증 가능한 결과를 받지 못했습니다. 연결 상태를 확인하세요. 자동 재시도하지 않습니다.');
  }
  let envelope: unknown;
  try { envelope = JSON.parse(frames[0]!.slice(marker.length)); }
  catch { throw new Error('Aside 결과 형식이 올바르지 않습니다. 작업 결과를 직접 확인하세요.'); }
  if (!envelope || typeof envelope !== 'object' || !('ok' in envelope)) throw new Error('Aside 결과 형식이 올바르지 않습니다.');
  const result = envelope as { ok: unknown; value?: T; error?: unknown };
  if (result.ok === false) {
    const message = typeof result.error === 'string' && result.error.length <= 350 ? result.error : 'Aside 작업이 중단되었습니다.';
    throw new Error(message);
  }
  if (result.ok !== true || !('value' in result)) throw new Error('Aside가 완료 결과를 반환하지 않았습니다.');
  return result.value as T;
}

export function asideExecutable(): string {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installed = join(process.env.LOCALAPPDATA, 'Aside', 'CLI', 'current', 'aside.exe');
    if (existsSync(installed)) return installed;
  }
  return process.platform === 'win32' ? 'aside.exe' : 'aside';
}

export function runAside<T>(script: string): Promise<T> {
  const marker = `__AUTO_FLOW_${randomUUID().replaceAll('-', '')}__:`;
  const code = wrapAsideScript(script, marker);
  try { assertAsideScriptFits(script); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const child = spawn(asideExecutable(), ['repl', code], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(child);
    let output = '';
    let diagnostics = '';
    let bytes = 0;
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill(); reject(new Error(message));
    };
    const timer = setTimeout(() => fail('Aside 실행 시간이 초과되었습니다. 작업 결과를 확인하세요. 실행을 자동 반복하지 않습니다.'), TIMEOUT_MS);
    const collect = (chunk: string, stderr = false) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_OUTPUT) { fail('Aside 출력이 안전한 크기를 초과하여 중단했습니다.'); return; }
      if (stderr) diagnostics += chunk;
      else output += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => collect(chunk));
    child.stderr.on('data', chunk => collect(chunk, true));
    child.on('error', () => fail('Aside CLI를 실행할 수 없습니다. Aside 설치와 실행 상태를 확인하세요.'));
    child.on('close', code => {
      active.delete(child);
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) { reject(new Error('Aside CLI 실행에 실패했습니다. 앱과 CLI 연결을 확인하세요.')); return; }
      try { resolve(decodeAsideResult<T>(`${output}\n${diagnostics}`, marker)); }
      catch (error) { reject(error); }
    });
  });
}
