import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmNodeUpdate, createUpdateHandler, recoverInterruptedUpdate } from '../proxy/update.mjs';
import { watchRestartSignal } from '../server/shared.mjs';

const sourceFiles = new Map([
  ['server/gameProtocol.mjs', '// 新协议内容 v2'],
  ['proxy/server.mjs', '// 新代理内容 v2'],
]);
const requestCounts = new Map();
let slowRequestStarted;
const slowStarted = new Promise((resolvePromise) => { slowRequestStarted = resolvePromise; });
const fileServer = createServer((request, response) => {
  const path = request.url ?? '/';
  requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
  if (path.startsWith('/redirect/')) {
    const file = path.slice('/redirect/'.length);
    response.writeHead(302, { Location: `/download/${file}` });
    response.end();
    return;
  }
  if (path === '/download/proxy/server.mjs' && requestCounts.get(path) === 1) {
    response.writeHead(503);
    response.end('retry');
    return;
  }
  if (path.startsWith('/slow/')) {
    const file = path.slice('/slow/'.length);
    slowRequestStarted();
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(sourceFiles.get(file));
    }, 100);
    return;
  }
  if (path.startsWith('/download/')) {
    const file = path.slice('/download/'.length);
    if (sourceFiles.has(file)) {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(sourceFiles.get(file));
      return;
    }
  }
  response.writeHead(404);
  response.end('not found');
});

function responseRecorder() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body) { this.body = body?.toString() ?? ''; },
  };
}

function updateRequest(method = 'POST', token = 'test-secret-123') {
  return { method, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

const roots = [];
const originalPass = process.env.MAJO_UPDATE_PASS;
try {
  await new Promise((resolvePromise) => fileServer.listen(0, '127.0.0.1', resolvePromise));
  const { port } = fileServer.address();
  process.env.MAJO_UPDATE_PASS = 'test-secret-123';

  const root = await mkdtemp(join(tmpdir(), 'update-test-'));
  roots.push(root);
  await mkdir(join(root, 'server'), { recursive: true });
  await mkdir(join(root, 'proxy'), { recursive: true });
  await writeFile(join(root, 'server/gameProtocol.mjs'), '// 旧协议 v1');
  await writeFile(join(root, 'proxy/server.mjs'), '// 旧代理 v1');

  const handler = createUpdateHandler({
    passEnv: 'MAJO_UPDATE_PASS',
    source: `http://127.0.0.1:${port}/redirect/{file}`,
    files: [...sourceFiles.keys()],
    restartOnSuccess: false,
    downloadAttempts: 3,
    retryDelayMs: 1,
    maxRedirects: 3,
  }, root, () => {});
  assert.ok(handler);

  const success = responseRecorder();
  await handler(updateRequest(), success);
  assert.equal(success.status, 200);
  assert.deepEqual(JSON.parse(success.body), { ok: true, updated: [...sourceFiles.keys()], next: 'running' });
  for (const [file, expected] of sourceFiles) {
    assert.equal(await readFile(join(root, file), 'utf8'), expected);
  }
  assert.equal(requestCounts.get('/download/proxy/server.mjs'), 2, '503 下载应自动重试');

  // 成功更新后，旧版本备份应归档到 .runtime/update-backups/<事务>/<文件>
  const backupsRoot = join(root, '.runtime', 'update-backups');
  const backupTransactions = await readdir(backupsRoot);
  assert.ok(backupTransactions.length >= 1, '成功更新后应保留版本备份');
  const latestTransaction = backupTransactions[backupTransactions.length - 1];
  const oldContents = new Map([
    ['server/gameProtocol.mjs', '// 旧协议 v1'],
    ['proxy/server.mjs', '// 旧代理 v1'],
  ]);
  for (const [file, oldContent] of oldContents) {
    const archived = await readFile(join(backupsRoot, latestTransaction, file), 'utf8');
    assert.equal(archived, oldContent, '归档备份应是更新前的旧版本内容');
  }
  // 归档采用复制+删除（跨设备卷兼容），源备份文件应已被清理
  const leftoverBackups = [];
  for (const dirName of ['server', 'proxy']) {
    const names = await readdir(join(root, dirName));
    for (const name of names) {
      if (name.includes('.backup-')) leftoverBackups.push(`${dirName}/${name}`);
    }
  }
  assert.deepEqual(leftoverBackups, [], '归档后源备份文件应被清理');

  const noHeader = responseRecorder();
  await handler(updateRequest('POST', null), noHeader);
  assert.equal(noHeader.status, 401, '更新密钥必须放在 Authorization 请求头');
  const wrongPass = responseRecorder();
  await handler(updateRequest('POST', 'wrong'), wrongPass);
  assert.equal(wrongPass.status, 401);
  const wrongMethod = responseRecorder();
  await handler(updateRequest('GET'), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const partialRoot = await mkdtemp(join(tmpdir(), 'update-partial-'));
  roots.push(partialRoot);
  await mkdir(join(partialRoot, 'server'), { recursive: true });
  await mkdir(join(partialRoot, 'proxy'), { recursive: true });
  await writeFile(join(partialRoot, 'server/gameProtocol.mjs'), '// 旧协议 v1');
  await writeFile(join(partialRoot, 'proxy/server.mjs'), '// 旧代理 v1');
  const partialHandler = createUpdateHandler({
    passEnv: 'MAJO_UPDATE_PASS',
    source: `http://127.0.0.1:${port}/download/{file}`,
    files: ['server/gameProtocol.mjs', 'proxy/missing.mjs'],
    restartOnSuccess: false,
    downloadAttempts: 1,
  }, partialRoot, () => {});
  const partial = responseRecorder();
  await partialHandler(updateRequest(), partial);
  assert.equal(partial.status, 502);
  assert.equal(await readFile(join(partialRoot, 'server/gameProtocol.mjs'), 'utf8'), '// 旧协议 v1');
  assert.equal(await readFile(join(partialRoot, 'proxy/server.mjs'), 'utf8'), '// 旧代理 v1');

  // 中断恢复：模拟进程在替换途中崩溃，遗留临时文件与备份文件
  const crashRoot = await mkdtemp(join(tmpdir(), 'update-crash-'));
  roots.push(crashRoot);
  await mkdir(join(crashRoot, 'server'), { recursive: true });
  await writeFile(join(crashRoot, 'server/gameProtocol.mjs.update-crash-1'), '// 半成品');
  await writeFile(join(crashRoot, 'server/gameProtocol.mjs.backup-crash-1'), '// 旧协议 v1');
  const crashRecovery = await recoverInterruptedUpdate({
    passEnv: 'MAJO_UPDATE_PASS',
    source: `http://127.0.0.1:${port}/download/{file}`,
    files: ['server/gameProtocol.mjs'],
    restartOnSuccess: false,
  }, crashRoot, () => {});
  assert.equal(crashRecovery.removedTemp, 1, '应清理中断残留的临时文件');
  assert.equal(crashRecovery.restored, 1, '目标缺失时应从备份恢复');
  assert.equal(await readFile(join(crashRoot, 'server/gameProtocol.mjs'), 'utf8'), '// 旧协议 v1');

  // 中断后目标仍存在：备份不应覆盖，应归档保留
  const archiveRoot = await mkdtemp(join(tmpdir(), 'update-archive-'));
  roots.push(archiveRoot);
  await mkdir(join(archiveRoot, 'server'), { recursive: true });
  await writeFile(join(archiveRoot, 'server/gameProtocol.mjs'), '// 新版 v2');
  await writeFile(join(archiveRoot, 'server/gameProtocol.mjs.backup-crash-2'), '// 旧协议 v1');
  const archiveRecovery = await recoverInterruptedUpdate({
    passEnv: 'MAJO_UPDATE_PASS',
    source: `http://127.0.0.1:${port}/download/{file}`,
    files: ['server/gameProtocol.mjs'],
    restartOnSuccess: false,
  }, archiveRoot, () => {});
  assert.equal(archiveRecovery.restored, 0, '目标存在时不应覆盖回旧版');
  assert.equal(await readFile(join(archiveRoot, 'server/gameProtocol.mjs'), 'utf8'), '// 新版 v2');
  const archiveBackups = await readdir(join(archiveRoot, '.runtime', 'update-backups'));
  assert.ok(archiveBackups.length >= 1, '目标存在时备份应归档保留');
  const archivedContent = await readFile(join(archiveRoot, '.runtime', 'update-backups', archiveBackups[0], 'server/gameProtocol.mjs'), 'utf8');
  assert.equal(archivedContent, '// 旧协议 v1', '归档备份应是旧版本内容');

  // 健康确认：节点更新后轮询 /healthz
  let healthy = true;
  const healthServer = createServer((request, response) => {
    if (request.url === '/healthz') {
      if (healthy) {
        response.writeHead(200);
        response.end('ok');
        return;
      }
      response.writeHead(503);
      response.end('down');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolvePromise) => healthServer.listen(0, '127.0.0.1', resolvePromise));
  const healthPort = healthServer.address().port;
  const healthNode = {
    name: 'health-node',
    url: new URL(`http://127.0.0.1:${healthPort}/update`),
  };
  const confirmed = await confirmNodeUpdate(healthNode, { timeoutMs: 3_000, intervalMs: 50 });
  assert.equal(confirmed.confirmed, true, '健康节点应确认更新成功');
  healthy = false;
  const unconfirmed = await confirmNodeUpdate(healthNode, { timeoutMs: 500, intervalMs: 50 });
  assert.equal(unconfirmed.confirmed, false, '不健康节点应确认失败');
  await new Promise((resolvePromise) => healthServer.close(resolvePromise));

  const concurrentRoot = await mkdtemp(join(tmpdir(), 'update-concurrent-'));
  roots.push(concurrentRoot);
  await mkdir(join(concurrentRoot, 'proxy'), { recursive: true });
  await writeFile(join(concurrentRoot, 'proxy/server.mjs'), '// 旧代理 v1');
  const concurrentHandler = createUpdateHandler({
    passEnv: 'MAJO_UPDATE_PASS',
    source: `http://127.0.0.1:${port}/slow/{file}`,
    files: ['proxy/server.mjs'],
    restartOnSuccess: false,
  }, concurrentRoot, () => {});
  const first = responseRecorder();
  const firstUpdate = concurrentHandler(updateRequest(), first);
  await slowStarted;
  const second = responseRecorder();
  await concurrentHandler(updateRequest(), second);
  assert.equal(second.status, 409);
  await firstUpdate;
  assert.equal(first.status, 200);

  const signalRoot = await mkdtemp(join(tmpdir(), 'update-signal-'));
  roots.push(signalRoot);
  const signalPath = join(signalRoot, 'restart-token');
  let signalReceived;
  const received = new Promise((resolvePromise) => { signalReceived = resolvePromise; });
  const stopWatching = await watchRestartSignal(signalPath, signalReceived, () => {});
  await writeFile(signalPath, 'transaction-1');
  await Promise.race([
    received,
    new Promise((_, reject) => setTimeout(() => reject(new Error('重启信号未触发')), 2_000)),
  ]);
  stopWatching();

  console.log('update smoke passed');
} finally {
  if (originalPass === undefined) delete process.env.MAJO_UPDATE_PASS;
  else process.env.MAJO_UPDATE_PASS = originalPass;
  await new Promise((resolvePromise) => fileServer.close(resolvePromise));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
