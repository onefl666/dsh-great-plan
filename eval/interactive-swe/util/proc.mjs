import { spawn } from 'node:child_process';

/**
 * Run a child process and resolve its result. A non-zero exit resolves
 * normally; only a spawn failure rejects.
 */
export function runCommand({ command, args = [], cwd, env, timeoutMs = 120000, input } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env === undefined ? process.env : env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, timeoutMs);
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? null, signal: signal ?? null, stdout, stderr, durationMs: Date.now() - started });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}
