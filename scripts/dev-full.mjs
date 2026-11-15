import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('==============================================');
console.log(' Starting Map Navigator Full Development Stack');
console.log('==============================================');

const backendScript = path.join(rootDir, 'backend', 'server.js');
let backendProc = null;
let viteProc = null;

function cleanup(exitCode = 0) {
  console.log('\nShutting down development servers...');
  if (viteProc && !viteProc.killed) {
    viteProc.kill();
  }
  if (backendProc && !backendProc.killed) {
    backendProc.kill();
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
process.on('exit', () => {
  if (viteProc && !viteProc.killed) {
    viteProc.kill();
  }
  if (backendProc && !backendProc.killed) {
    backendProc.kill();
  }
});

function probeBackend(timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8080/api/status', { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => {
      resolve(false);
    });
  });
}

// Wait for backend to be ready
function waitForBackend(proc, retries = 20, delay = 250) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onEarlyExit = (code, signal) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Backend process exited early (code: ${code ?? 'null'}, signal: ${signal ?? 'none'})`));
      }
    };
    if (proc) {
      proc.once('exit', onEarlyExit);
    }

    function finish(err) {
      if (settled) return;
      settled = true;
      if (proc) {
        proc.removeListener('exit', onEarlyExit);
      }
      if (err) reject(err);
      else resolve();
    }

    function attempt(remaining) {
      if (settled) return;
      const req = http.get('http://127.0.0.1:8080/api/status', { timeout: 500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          finish(null);
        } else if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), delay);
        } else {
          finish(new Error('Backend status returned non-200 code'));
        }
      });
      req.on('timeout', () => {
        req.destroy();
      });
      req.on('error', () => {
        if (settled) return;
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), delay);
        } else {
          finish(new Error('Backend failed to respond on port 8080'));
        }
      });
    }
    attempt(retries);
  });
}

try {
  const alreadyRunning = await probeBackend(500);
  if (alreadyRunning) {
    console.log('[Dev] Existing Backend API detected on http://127.0.0.1:8080; skipping duplicate spawn.');
  } else {
    backendProc = spawn(process.execPath, [backendScript], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    await waitForBackend(backendProc);
    console.log('[Dev] Backend API is ready on http://127.0.0.1:8080');
  }

  // Start Vite frontend
  const viteBin = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
  viteProc = spawn(process.execPath, [viteBin], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  viteProc.on('exit', () => {
    cleanup(0);
  });
} catch (err) {
  console.error('[Dev] Failed to start backend:', err.message);
  cleanup(1);
}
