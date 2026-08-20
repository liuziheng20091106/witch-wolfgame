// 端到端测试：proxy/update.mjs 的下载-替换-校验流程
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateHandler } from '../proxy/update.mjs';

// 1. 文件服务器作为下载源
const sourceFiles = new Map([
  ['server/gameProtocol.mjs', '// 新协议内容 v2'],
  ['proxy/server.mjs', '// 新代理内容 v2'],
]);
const fileServer = createServer((req, res) => {
  const key = req.url.slice(1);
  if (sourceFiles.has(key)) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(sourceFiles.get(key));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => fileServer.listen(0, r));
const port = fileServer.address().port;

// 2. 临时项目根
const root = await mkdtemp(join(tmpdir(), 'update-test-'));
await mkdir(join(root, 'server'), { recursive: true });
await mkdir(join(root, 'proxy'), { recursive: true });
await writeFile(join(root, 'server/gameProtocol.mjs'), '// 旧协议 v1');
await writeFile(join(root, 'proxy/server.mjs'), '// 旧代理 v1');

// 3. 配置
process.env.MAJO_UPDATE_PASS = 'test-secret-123';
const update = {
  passEnv: 'MAJO_UPDATE_PASS',
  source: `http://127.0.0.1:${port}/{file}`,
  files: ['server/gameProtocol.mjs', 'proxy/server.mjs'],
  restartOnSuccess: false, // 测试不真退出
};
const handler = createUpdateHandler(update, root);
const baseRes = () => {
  const r = { _status: 0, _body: '', writeHead(s) { this._status = s; }, end(b) { this._body = b.toString(); } };
  return r;
};

// 4. 正确密钥
const res = baseRes();
await handler({ method: 'POST', url: '/update?pass=test-secret-123' }, res, new URL('http://x/update?pass=test-secret-123'));
console.log('正确密钥 状态:', res._status);
console.log('响应体:', res._body);
console.log('新 gameProtocol:', await readFile(join(root, 'server/gameProtocol.mjs'), 'utf8'));
console.log('新 server:', await readFile(join(root, 'proxy/server.mjs'), 'utf8'));

// 5. 错误密钥
const res2 = baseRes();
await handler({ method: 'POST', url: '/update?pass=wrong' }, res2, new URL('http://x/update?pass=wrong'));
console.log('错误密钥 状态:', res2._status, res2._body);

// 6. 非 POST
const res3 = baseRes();
await handler({ method: 'GET', url: '/update?pass=test-secret-123' }, res3, new URL('http://x/update?pass=test-secret-123'));
console.log('GET 状态:', res3._status);

// 7. 全有或全无：源缺第二个文件 → 整体失败，第一个文件不能被替换
{
  const root2 = await mkdtemp(join(tmpdir(), 'update-test2-'));
  await mkdir(join(root2, 'server'), { recursive: true });
  await mkdir(join(root2, 'proxy'), { recursive: true });
  await writeFile(join(root2, 'server/gameProtocol.mjs'), '// 旧协议 v1');
  await writeFile(join(root2, 'proxy/server.mjs'), '// 旧代理 v1');
  // 第二个文件源 404
  const update2 = {
    passEnv: 'MAJO_UPDATE_PASS',
    source: `http://127.0.0.1:${port}/{file}`,
    files: ['server/gameProtocol.mjs', 'proxy/missing.mjs'],
    restartOnSuccess: false,
  };
  const handler2 = createUpdateHandler(update2, root2);
  const res4 = baseRes();
  await handler2({ method: 'POST', url: '/update?pass=test-secret-123' }, res4, new URL('http://x/update?pass=test-secret-123'));
  const g1 = await readFile(join(root2, 'server/gameProtocol.mjs'), 'utf8');
  const partialOk = res4._status === 502 && g1 === '// 旧协议 v1';
  let partialLabel = '✗ 被改了';
  if (g1 === '// 旧协议 v1') {
    partialLabel = '✓ 保持旧版';
  }
  console.log('部分失败 状态:', res4._status, '| gameProtocol 未被替换:', partialLabel);
  await new Promise((resolve) => fileServer.close(resolve));
  const allOk = res._status === 200 && res2._status === 401 && res3._status === 405 && partialOk;
  if (allOk) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}
