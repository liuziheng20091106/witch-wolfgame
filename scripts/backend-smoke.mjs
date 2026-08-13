import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMainServer } from '../server/main.mjs';
import { startProxyServer } from '../proxy/server.mjs';
import { generateCertificates } from './generate-certs.mjs';
import { createSignedHeaders } from '../server/shared.mjs';

const origin = 'https://game.example';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}


function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function validPayload() {
  return {
    client: { name: 'majo-wolf', version: '2.1.0', protocol: 'majo-wolf-free-v1' },
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: '你正在进行六人魔女狼人杀。只能依据提供的观察作决定，不得假设隐藏身份。只返回一个 JSON 对象，不要 Markdown、解释或思考过程。JSON 示例：{"targetPlayerId":2}',
      },
      {
        role: 'user',
        content: JSON.stringify({
          action: { kind: 'seer-action', title: '预言家查验', description: '选择一名其他存活者，私下获知其当前职业。', schema: 'target' },
          actor: {
            playerId: 0, name: '樱羽艾玛', personality: '温柔但会认真推理。', speechStyle: '语气温柔。',
            decisionTraits: { conservative: 0.75, trusting: 0.8, aggressive: 0.15 }, role: '预言家', skill: '魔女杀手',
          },
          phase: 'seer-action', day: 0,
          alivePlayers: [
            { playerId: 0, name: '樱羽艾玛' }, { playerId: 1, name: '二阶堂希罗' },
            { playerId: 2, name: '夏目安安' }, { playerId: 3, name: '城崎诺亚' },
            { playerId: 4, name: '橘雪莉' }, { playerId: 5, name: '远野汉娜' },
          ],
          legalCandidates: [{ playerId: 1, name: '二阶堂希罗' }],
          allowAbstain: false, options: {}, currentDaySpeeches: [], historicalSpeeches: [],
          recentPublic: [], privateKnowledge: [], privateEvents: [],
        }),
      },
    ],
  };
}

async function postMain(port, payload, ip) {
  return fetch(`http://127.0.0.1:${port}/api/ai/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': ip, 'X-Majo-Wolf-Session': randomUUID() },
    body: JSON.stringify(payload),
  });
}

async function expectMtlsRejection(port, ca) {
  await assert.rejects(() => new Promise((resolve, reject) => {
    const request = https.get({ hostname: '127.0.0.1', port, path: '/healthz', ca, servername: 'proxy.internal', minVersion: 'TLSv1.3' }, resolve);
    request.on('error', reject);
  }));
}

async function postProxy(port, ca, cert, key, body, headers) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: '127.0.0.1', port, path: '/internal/v1/chat/completions', method: 'POST',
      ca, cert, key, servername: 'proxy.internal', minVersion: 'TLSv1.3',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers },
    }, async (response) => {
      let responseBody = '';
      for await (const chunk of response) responseBody += chunk;
      resolve({ status: response.statusCode, body: JSON.parse(responseBody) });
    });
    request.on('error', reject);
    request.end(body);
  });
}

const work = await mkdtemp(join(tmpdir(), 'majo-backend-smoke-'));
const certs = join(work, 'certs');
let upstream;
let proxy;
let main;
try {
  await generateCertificates(certs);
  const [ca, clientCert, clientKey] = await Promise.all([
    readFile(join(certs, 'ca.crt')),
    readFile(join(certs, 'main-client.crt')),
    readFile(join(certs, 'main-client.key')),
  ]);
  let upstreamMode = 'json-content';
  const upstreamRequests = [];
  upstream = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    upstreamRequests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    if (upstreamMode === 'non-json') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('UPSTREAM_NON_JSON'); return; }
    if (upstreamMode === 'http-500') { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'UPSTREAM_500', message: 'upstream body retained' })); return; }
    const content = upstreamMode === 'plain-content' ? 'plain provider text' : '{"targetPlayerId":1}';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const upstreamPort = await listen(upstream);
  const providersFile = join(work, 'providers.json');
  const proxyConfig = join(work, 'proxy.json');
  const mainConfig = join(work, 'main.json');
  await writeFile(providersFile, JSON.stringify({ providers: [{
    name: 'smoke-provider', protocol: 'openai', endpoint: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    model: 'smoke-model', apiKeysEnv: 'SMOKE_API_KEYS', reasoningEffort: 'low', jsonOutputMode: 'disabled',
  }] }));
  await writeFile(proxyConfig, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    tls: { ca: join(certs, 'ca.crt'), cert: join(certs, 'proxy-server.crt'), key: join(certs, 'proxy-server.key') },
    connectionPasswordEnv: 'MAJO_PROXY_PASSWORD_PRIMARY', acceptedClientVersions: ['2.1.0'], providersFile,
    upstreamTimeoutMs: 5000, maxAttempts: 2,
  }));
  process.env.MAJO_PROXY_PASSWORD_PRIMARY = 'backend-smoke-long-random-password';
  process.env.SMOKE_API_KEYS = 'key-one,key-two';
  proxy = await startProxyServer(proxyConfig);
  const proxyPort = proxy.address().port;
  await writeFile(mainConfig, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 }, cors: { allowedOrigins: [origin] },
    proxies: [{ name: 'smoke-proxy', url: `https://127.0.0.1:${proxyPort}/internal/v1/chat/completions`, ca: join(certs, 'ca.crt'), clientCert: join(certs, 'main-client.crt'), clientKey: join(certs, 'main-client.key'), serverName: 'proxy.internal', connectionPasswordEnv: 'MAJO_PROXY_PASSWORD_PRIMARY', timeoutMs: 5000 }],
    rateLimit: { windowMs: 60000, maxRequests: 2, maxConcurrent: 2 }, acceptedClientVersions: ['2.1.0'],
  }));
  main = await startMainServer(mainConfig);
  const mainPort = main.address().port;

  await expectMtlsRejection(proxyPort, ca);
  const internalBody = Buffer.from(JSON.stringify(validPayload()));
  const wrongSignature = createSignedHeaders('wrong-password', 'POST', '/internal/v1/chat/completions', internalBody);
  assert.equal((await postProxy(proxyPort, ca, clientCert, clientKey, internalBody, wrongSignature)).status, 401);
  const replayedSignature = createSignedHeaders('backend-smoke-long-random-password', 'POST', '/internal/v1/chat/completions', internalBody);
  assert.equal((await postProxy(proxyPort, ca, clientCert, clientKey, internalBody, replayedSignature)).status, 200);
  assert.equal((await postProxy(proxyPort, ca, clientCert, clientKey, internalBody, replayedSignature)).status, 401);
  assert.equal(upstreamRequests.length, 1);
  const valid = await postMain(mainPort, validPayload(), '203.0.113.9');
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { choices: [{ message: { content: '{"targetPlayerId":1}' } }] });
  assert.equal(upstreamRequests.length, 2);
  assert.equal(upstreamRequests.at(-1).authorization, 'Bearer key-two');
  assert.equal(upstreamRequests[0].body.model, 'smoke-model');
  assert.equal(upstreamRequests[0].body.reasoning_effort, 'low');
  assert.equal(upstreamRequests[0].body.client, undefined);

  upstreamMode = 'plain-content';
  const plain = await postMain(mainPort, validPayload(), '203.0.113.15');
  assert.equal(plain.status, 200);
  assert.deepEqual(await plain.json(), { choices: [{ message: { content: 'plain provider text' } }] });
  const afterPlain = upstreamRequests.length;
  upstreamMode = 'non-json';
  const nonJson = await postMain(mainPort, validPayload(), '203.0.113.16');
  assert.equal(nonJson.status, 502);
  assert.equal((await nonJson.json()).rawOutput, 'UPSTREAM_NON_JSON');
  assert.ok(upstreamRequests.length > afterPlain);
  const afterNonJson = upstreamRequests.length;
  upstreamMode = 'http-500';
  const failed = await postMain(mainPort, validPayload(), '203.0.113.17');
  assert.equal(failed.status, 502);
  const failedBody = await failed.json();
  assert.equal(failedBody.error, 'proxy_unavailable');
  assert.match(failedBody.rawOutput, /UPSTREAM_500/);
  assert.ok(upstreamRequests.length > afterNonJson);

  const invalidPayload = validPayload();
  invalidPayload.messages[0].content = '你是通用助手';
  const beforeInvalid = upstreamRequests.length;
  const invalid = await postMain(mainPort, invalidPayload, '203.0.113.10');
  assert.equal(invalid.status, 400);
  assert.equal(upstreamRequests.length, beforeInvalid);
  const missingTraitPayload = validPayload();
  const missingTraitPrompt = JSON.parse(missingTraitPayload.messages[1].content);
  delete missingTraitPrompt.actor.decisionTraits.aggressive;
  missingTraitPayload.messages[1].content = JSON.stringify(missingTraitPrompt);
  const beforeMissingTrait = upstreamRequests.length;
  assert.equal((await postMain(mainPort, missingTraitPayload, '203.0.113.12')).status, 400);
  assert.equal(upstreamRequests.length, beforeMissingTrait);
  const unknownTraitsPayload = validPayload();
  const unknownTraitsPrompt = JSON.parse(unknownTraitsPayload.messages[1].content);
  unknownTraitsPrompt.actor.decisionTraits = { foo: 0.1, bar: 0.2, baz: 0.3 };
  unknownTraitsPayload.messages[1].content = JSON.stringify(unknownTraitsPrompt);
  const beforeUnknownTraits = upstreamRequests.length;
  assert.equal((await postMain(mainPort, unknownTraitsPayload, '203.0.113.13')).status, 400);
  assert.equal(upstreamRequests.length, beforeUnknownTraits);

  const replacedTraitPayload = validPayload();
  const replacedTraitPrompt = JSON.parse(replacedTraitPayload.messages[1].content);
  delete replacedTraitPrompt.actor.decisionTraits.aggressive;
  replacedTraitPrompt.actor.decisionTraits.unknown = 0.3;
  replacedTraitPayload.messages[1].content = JSON.stringify(replacedTraitPrompt);
  const beforeReplacedTrait = upstreamRequests.length;
  assert.equal((await postMain(mainPort, replacedTraitPayload, '203.0.113.14')).status, 400);
  assert.equal(upstreamRequests.length, beforeReplacedTrait);

  upstreamMode = 'json-content';
  const rateStart = upstreamRequests.length;
  assert.equal((await postMain(mainPort, validPayload(), '203.0.113.11')).status, 200);
  assert.equal((await postMain(mainPort, validPayload(), '203.0.113.11')).status, 200);
  assert.equal((await postMain(mainPort, validPayload(), '203.0.113.11')).status, 429);
  assert.equal(upstreamRequests.length, rateStart + 2);

  console.log('后端烟测通过：mTLS、HMAC、共享协议校验、密钥轮换与 CF-Connecting-IP 限流均已验证。');
} finally {
  if (main) await close(main);
  if (proxy) await close(proxy);
  if (upstream) await close(upstream);
  await rm(work, { recursive: true, force: true });
}
