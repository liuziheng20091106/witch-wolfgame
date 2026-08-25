import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOARD_DESCRIPTION,
  buildGameSystemPrompt,
  CHARACTER_CATALOG,
  FREE_CLIENT_PROTOCOL,
  formatPublicSkill,
  INVALID_GAME_REQUEST_MESSAGE,
} from '../shared/gamePromptContract.js';
import { startMainServer } from '../server/main.mjs';
import { buildUpstreamPayload, startProxyServer } from '../proxy/server.mjs';
import { generateCertificates } from './generate-certs.mjs';
import { createSignedHeaders } from '../server/shared.mjs';

const origin = 'https://game.example';
assert.equal(buildUpstreamPayload({ messages: [] }, { model: 'openai-model', protocol: 'openai', reasoningEffort: 'none' }, false).reasoning_effort, 'none');
assert.deepEqual(buildUpstreamPayload({ messages: [] }, { model: 'deepseek-model', protocol: 'deepseek', reasoningEffort: 'none' }, false).thinking, { type: 'disabled' });


function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}


function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sseChunk(content, finishReason = null) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model: 'smoke-model', choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`;
}


const SENSITIVE_MARKER = 'DO_NOT_ECHO_PRIVATE_PROMPT_VALUE';

function validPayload() {
  const players = CHARACTER_CATALOG.slice(0, 6).map((character, playerId) => ({
    playerId,
    name: character.name,
  }));
  return {
    client: { ...FREE_CLIENT_PROTOCOL, version: '2.4.0' },
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildGameSystemPrompt('target') },
      {
        role: 'user',
        content: JSON.stringify({
          action: { kind: 'seer-action', title: '预言家查验', description: '选择一名其他存活者，私下获知其当前职业。', schema: 'target' },
          actor: {
            playerId: 0,
            name: CHARACTER_CATALOG[0].name,
            personality: '温柔但会认真推理。',
            speechStyle: '语气温柔。',
            decisionTraits: { conservative: 0.75, trusting: 0.8, aggressive: 0.15 },
            role: '预言家',
            skill: '魔女杀手',
          },
          phase: 'seer-action',
          day: 0,
          board: BOARD_DESCRIPTION,
          alivePlayers: players,
          legalCandidates: [players[1]],
          allowAbstain: false,
          options: {},
          currentDaySpeeches: [],
          historicalSpeeches: [],
          recentPublic: [],
          privateKnowledge: [],
          publicSkills: CHARACTER_CATALOG.slice(0, 6).map((character, playerId) => ({
            playerId,
            name: character.name,
            skill: formatPublicSkill(character.defaultSkillId),
          })),
          privateEvents: [SENSITIVE_MARKER],
        }),
      },
    ],
  };
}

function promptOf(payload) {
  return JSON.parse(payload.messages[1].content);
}

function replacePrompt(payload, prompt) {
  payload.messages[1].content = JSON.stringify(prompt);
}
function mutatePrompt(payload, mutate) {
  const prompt = promptOf(payload);
  mutate(prompt);
  replacePrompt(payload, prompt);
}


function targetSkillPayload() {
  const payload = validPayload();
  const prompt = JSON.parse(payload.messages[1].content);
  prompt.action = {
    kind: 'skill',
    title: '视线诱导-目标',
    description: '选择诱导对象：被诱导者今天的发言必须提及她。',
    schema: 'target',
  };
  payload.messages[1].content = JSON.stringify(prompt);
  return payload;
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
let fallbackProxy;
let main;
const capturedLogs = [];
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
for (const method of Object.keys(originalConsole)) {
  console[method] = (...args) => {
    capturedLogs.push(args.join(' '));
    originalConsole[method](...args);
  };
}
try {
  await generateCertificates(certs);
  const [ca, clientCert, clientKey] = await Promise.all([
    readFile(join(certs, 'ca.crt')),
    readFile(join(certs, 'main-client.crt')),
    readFile(join(certs, 'main-client.key')),
  ]);
  let upstreamMode = 'sse-json';
  const upstreamRequests = [];
  upstream = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    upstreamRequests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
    if (upstreamMode === 'first-byte-timeout') {
      await delay(120);
      if (!response.destroyed) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`${sseChunk('{"targetPlayerId":1}', 'stop')}data: [DONE]\n\n`);
      }
      return;
    }
    if (upstreamMode === 'total-timeout') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sseChunk('{"target'));
      await delay(300);
      if (!response.destroyed) response.end(`${sseChunk('PlayerId":1}', 'stop')}data: [DONE]\n\n`);
      return;
    }
    if (upstreamMode === 'primary-http-500' && request.url?.startsWith('/primary/')) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'PRIMARY_FAILED' }));
      return;
    }
    if (upstreamMode === 'non-json') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('UPSTREAM_NON_JSON'); return; }
    if (upstreamMode === 'http-500') { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'UPSTREAM_500', message: 'upstream body retained' })); return; }
    const content = upstreamMode === 'plain-content' ? 'plain provider text' : '{"targetPlayerId":1}';
    if (upstreamMode === 'sse-json') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sseChunk(content.slice(0, 10)));
      await delay(10);
      response.end(`${sseChunk(content.slice(10), 'stop')}data: [DONE]\n\n`);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  const upstreamPort = await listen(upstream);
  const providersFile = join(work, 'providers.json');
  const proxyConfig = join(work, 'proxy.json');
  const mainConfig = join(work, 'main.json');
  await writeFile(providersFile, JSON.stringify({
    providers: [
      { name: 'disabled-provider', enabled: false },
      {
        name: 'smoke-provider', enabled: true, protocol: 'openai', endpoint: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        model: 'smoke-model', apiKeysEnv: 'SMOKE_API_KEYS', reasoningEffort: 'none', jsonOutputMode: 'auto',
        totalTimeoutMs: 250, firstByteTimeoutMs: 80, retryCount: 1,
      },
    ]
  }));
  await writeFile(proxyConfig, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    tls: { ca: join(certs, 'ca.crt'), cert: join(certs, 'proxy-server.crt'), key: join(certs, 'proxy-server.key') },
    connectionPasswordEnv: 'MAJO_PROXY_PASSWORD_PRIMARY', acceptedClientVersions: ['2.4.0'], providersFile,
  }));
  process.env.MAJO_PROXY_PASSWORD_PRIMARY = 'backend-smoke-long-random-password';
  process.env.SMOKE_API_KEYS = 'key-one,key-two';
  proxy = await startProxyServer(proxyConfig);
  const proxyPort = proxy.address().port;
  await writeFile(mainConfig, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 }, cors: { allowedOrigins: [origin] },
    proxies: [{ name: '水梦梦的服务器', url: `https://127.0.0.1:${proxyPort}/internal/v1/chat/completions`, ca: join(certs, 'ca.crt'), clientCert: join(certs, 'main-client.crt'), clientKey: join(certs, 'main-client.key'), serverName: 'proxy.internal', connectionPasswordEnv: 'MAJO_PROXY_PASSWORD_PRIMARY', timeoutMs: 5000 }],
    rateLimit: { windowMs: 60000, maxRequests: 2, maxConcurrent: 2 }, acceptedClientVersions: ['2.4.0'],
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
  assert.equal((await valid.json()).choices[0].message.content, '{"targetPlayerId":1}');
  assert.equal(valid.headers.get('X-Majo-Proxy'), encodeURIComponent('水梦梦的服务器'));
  assert.equal(upstreamRequests.length, 2);
  assert.equal(upstreamRequests.at(-1).authorization, 'Bearer key-two');
  assert.equal(upstreamRequests[0].body.model, 'smoke-model');
  assert.equal(upstreamRequests[0].body.reasoning_effort, 'none');
  assert.equal(upstreamRequests[0].body.stream, true);
  assert.equal(upstreamRequests[0].body.client, undefined);

  const targetSkill = await postMain(mainPort, targetSkillPayload(), '203.0.113.24');
  assert.equal(targetSkill.status, 200);
  assert.equal((await targetSkill.json()).choices[0].message.content, '{"targetPlayerId":1}');

  upstreamMode = 'json-content';
  const nonStreaming = await postMain(mainPort, validPayload(), '203.0.113.21');
  assert.equal(nonStreaming.status, 200);
  assert.equal((await nonStreaming.json()).choices[0].message.content, '{"targetPlayerId":1}');

  upstreamMode = 'plain-content';
  const beforePlain = upstreamRequests.length;
  const plain = await postMain(mainPort, validPayload(), '203.0.113.15');
  assert.equal(plain.status, 200);
  assert.deepEqual(await plain.json(), { choices: [{ message: { content: 'plain provider text' } }] });
  assert.equal(upstreamRequests.length - beforePlain, 2);
  assert.deepEqual(upstreamRequests.at(-2).body.response_format, { type: 'json_object' });
  assert.equal(upstreamRequests.at(-1).body.response_format, undefined);
  const afterPlain = upstreamRequests.length;
  upstreamMode = 'non-json';
  const nonJson = await postMain(mainPort, validPayload(), '203.0.113.16');
  assert.equal(nonJson.status, 502);
  assert.equal((await nonJson.json()).rawOutput, 'UPSTREAM_NON_JSON');
  assert.equal(upstreamRequests.length - afterPlain, 2);

  const afterNonJson = upstreamRequests.length;
  upstreamMode = 'http-500';
  const failed = await postMain(mainPort, validPayload(), '203.0.113.17');
  assert.equal(failed.status, 502);
  const failedBody = await failed.json();
  assert.equal(failedBody.error, 'proxy_unavailable');
  assert.match(failedBody.rawOutput, /UPSTREAM_500/);
  assert.equal(upstreamRequests.length - afterNonJson, 2);

  upstreamMode = 'first-byte-timeout';
  const beforeFirstByteTimeout = upstreamRequests.length;
  const firstByteTimeout = await postMain(mainPort, validPayload(), '203.0.113.22');
  assert.equal(firstByteTimeout.status, 502);
  assert.match((await firstByteTimeout.json()).message, /首字节超时/);
  assert.equal(upstreamRequests.length - beforeFirstByteTimeout, 2);

  upstreamMode = 'total-timeout';
  const beforeTotalTimeout = upstreamRequests.length;
  const totalTimeout = await postMain(mainPort, validPayload(), '203.0.113.23');
  assert.equal(totalTimeout.status, 502);
  assert.match((await totalTimeout.json()).message, /总请求超时/);
  assert.equal(upstreamRequests.length - beforeTotalTimeout, 2);

  const rejectionCases = [
    ['payload_shape', 'payload', () => null],
    ['payload_keys', 'payload', (payload) => { payload.model = SENSITIVE_MARKER; }],
    ['client_shape', 'client', (payload) => { payload.client = null; }],
    ['client_keys', 'client', (payload) => { payload.client.extra = SENSITIVE_MARKER; }],
    ['client_identity', 'client', (payload) => { payload.client.name = SENSITIVE_MARKER; }],
    ['client_version', 'client.version', (payload) => { payload.client.version = SENSITIVE_MARKER; }],
    ['response_format', 'response_format', (payload) => { payload.response_format = { type: SENSITIVE_MARKER }; }],
    ['messages_shape', 'messages', (payload) => { payload.messages = []; }],
    ['message_roles', 'messages', (payload) => { payload.messages[0].role = 'user'; }],
    ['message_keys', 'messages', (payload) => { payload.messages[0].extra = SENSITIVE_MARKER; }],
    ['user_content_shape', 'messages[1].content', (payload) => { payload.messages[1].content = 'x'.repeat(96_001); }],
    ['user_content_json', 'messages[1].content', (payload) => { payload.messages[1].content = '{'; }],
    ['prompt_shape', 'prompt', (payload) => { payload.messages[1].content = '[]'; }],
    ['prompt_keys', 'prompt', (payload) => mutatePrompt(payload, (prompt) => { prompt.untrustedInstruction = SENSITIVE_MARKER; })],
    ['action_shape', 'action', (payload) => mutatePrompt(payload, (prompt) => { prompt.action.extra = SENSITIVE_MARKER; })],
    ['action_schema', 'action.schema', (payload) => mutatePrompt(payload, (prompt) => { prompt.action.kind = SENSITIVE_MARKER; })],
    ['system_template', 'messages[0].content', (payload) => { payload.messages[0].content = SENSITIVE_MARKER; }],
    ['action_title', 'action.title', (payload) => mutatePrompt(payload, (prompt) => { prompt.action.title = ''; })],
    ['action_description', 'action.description', (payload) => mutatePrompt(payload, (prompt) => { prompt.action.description = 42; })],
    ['actor_keys', 'actor', (payload) => mutatePrompt(payload, (prompt) => { prompt.actor.extra = SENSITIVE_MARKER; })],
    ['actor_identity', 'actor', (payload) => mutatePrompt(payload, (prompt) => { prompt.actor.name = SENSITIVE_MARKER; })],
    ['actor_personality', 'actor.personality', (payload) => mutatePrompt(payload, (prompt) => { prompt.actor.personality = ''; })],
    ['actor_speech_style', 'actor.speechStyle', (payload) => mutatePrompt(payload, (prompt) => { prompt.actor.speechStyle = ''; })],
    ['decision_traits_shape', 'actor.decisionTraits', (payload) => mutatePrompt(payload, (prompt) => { delete prompt.actor.decisionTraits.aggressive; })],
    ['decision_traits_value', 'actor.decisionTraits', (payload) => mutatePrompt(payload, (prompt) => { prompt.actor.decisionTraits.aggressive = 2; })],
    ['actor_role', 'actor.role', (payload) => mutatePrompt(payload, (prompt) => { prompt.actor.role = 42; })],
    ['actor_skill', 'actor.skill', (payload) => mutatePrompt(payload, (prompt) => { prompt.actor.skill = 'x'.repeat(241); })],
    ['board', 'board', (payload) => mutatePrompt(payload, (prompt) => { prompt.board = SENSITIVE_MARKER; })],
    ['phase', 'phase', (payload) => mutatePrompt(payload, (prompt) => { prompt.phase = SENSITIVE_MARKER; })],
    ['day', 'day', (payload) => mutatePrompt(payload, (prompt) => { prompt.day = 101; })],
    ['alive_players_shape', 'alivePlayers', (payload) => mutatePrompt(payload, (prompt) => { prompt.alivePlayers = []; })],
    ['alive_players_unique', 'alivePlayers.playerId', (payload) => mutatePrompt(payload, (prompt) => { prompt.alivePlayers[1].playerId = 0; })],
    ['legal_candidates_shape', 'legalCandidates', (payload) => mutatePrompt(payload, (prompt) => { prompt.legalCandidates = null; })],
    ['legal_candidates_unique', 'legalCandidates.playerId', (payload) => mutatePrompt(payload, (prompt) => { prompt.legalCandidates = [prompt.alivePlayers[1], prompt.alivePlayers[1]]; })],
    ['allow_abstain', 'allowAbstain', (payload) => mutatePrompt(payload, (prompt) => { prompt.allowAbstain = SENSITIVE_MARKER; })],
    ['options_shape', 'options', (payload) => mutatePrompt(payload, (prompt) => { prompt.options = []; })],
    ['options_size', 'options', (payload) => mutatePrompt(payload, (prompt) => { prompt.options = { value: 'x'.repeat(8_001) }; })],
    ['current_day_speeches', 'currentDaySpeeches', (payload) => mutatePrompt(payload, (prompt) => { prompt.currentDaySpeeches = ['x'.repeat(2_001)]; })],
    ['historical_speeches', 'historicalSpeeches', (payload) => mutatePrompt(payload, (prompt) => { prompt.historicalSpeeches = ['x'.repeat(2_001)]; })],
    ['recent_public', 'recentPublic', (payload) => mutatePrompt(payload, (prompt) => { prompt.recentPublic = ['x'.repeat(2_001)]; })],
    ['private_events', 'privateEvents', (payload) => mutatePrompt(payload, (prompt) => { prompt.privateEvents = ['x'.repeat(2_001)]; })],
    ['private_knowledge_shape', 'privateKnowledge', (payload) => mutatePrompt(payload, (prompt) => { prompt.privateKnowledge = Array.from({ length: 65 }, () => ({ subjectPlayerId: 0, kind: 'role', value: 'wolf', observedDay: 0 })); })],
    ['private_knowledge_entry', 'privateKnowledge', (payload) => mutatePrompt(payload, (prompt) => { prompt.privateKnowledge = [{ subjectPlayerId: 0, kind: 'role', value: SENSITIVE_MARKER, observedDay: 0 }]; })],
    ['public_skills_shape', 'publicSkills', (payload) => mutatePrompt(payload, (prompt) => { prompt.publicSkills.pop(); })],
    ['public_skills_unique_player', 'publicSkills.playerId', (payload) => mutatePrompt(payload, (prompt) => { prompt.publicSkills[1].playerId = 0; })],
    ['public_skills_unique_name', 'publicSkills.name', (payload) => mutatePrompt(payload, (prompt) => { prompt.publicSkills[1].name = prompt.publicSkills[0].name; })],
    ['public_skills_unique_skill', 'publicSkills.skill', (payload) => mutatePrompt(payload, (prompt) => { prompt.publicSkills[1].skill = prompt.publicSkills[0].skill; })],
  ];
  const expectedRejection = (reason, path) => ({
    error: 'invalid_game_request',
    message: INVALID_GAME_REQUEST_MESSAGE,
    reason,
    path,
  });
  const mainRejections = new Map();
  for (const [index, [reason, path, mutate]] of rejectionCases.entries()) {
    let payload = validPayload();
    const replacement = mutate(payload);
    if (replacement !== undefined) payload = replacement;
    const beforeRejected = upstreamRequests.length;
    const response = await postMain(mainPort, payload, `203.0.113.${30 + index}`);
    assert.equal(response.status, 400, `${reason} 应返回 HTTP 400`);
    const body = await response.json();
    assert.deepEqual(body, expectedRejection(reason, path));
    assert.equal(upstreamRequests.length, beforeRejected, `${reason} 不应请求 provider`);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(SENSITIVE_MARKER), false, `${reason} 响应泄漏输入值`);
    mainRejections.set(reason, body);
  }

  const proxyInvalidPayload = validPayload();
  mutatePrompt(proxyInvalidPayload, (prompt) => { prompt.untrustedInstruction = SENSITIVE_MARKER; });
  const proxyInvalidBody = Buffer.from(JSON.stringify(proxyInvalidPayload));
  const beforeProxyRejected = upstreamRequests.length;
  const proxyInvalidHeaders = createSignedHeaders(
    'backend-smoke-long-random-password',
    'POST',
    '/internal/v1/chat/completions',
    proxyInvalidBody,
    'proxy-validation-request-01',
  );
  const proxyInvalid = await postProxy(proxyPort, ca, clientCert, clientKey, proxyInvalidBody, proxyInvalidHeaders);
  assert.equal(proxyInvalid.status, 400);
  assert.deepEqual(proxyInvalid.body, mainRejections.get('prompt_keys'));
  assert.equal(upstreamRequests.length, beforeProxyRejected, '代理拒绝后不应请求 provider');

  upstreamMode = 'sse-json';
  const rateStart = upstreamRequests.length;
  assert.equal((await postMain(mainPort, validPayload(), '203.0.113.11')).status, 200);
  assert.equal((await postMain(mainPort, validPayload(), '203.0.113.11')).status, 200);
  assert.equal((await postMain(mainPort, validPayload(), '203.0.113.11')).status, 429);
  assert.equal(upstreamRequests.length, rateStart + 2);

  const fallbackProvidersFile = join(work, 'fallback-providers.json');
  const fallbackProxyConfig = join(work, 'fallback-proxy.json');
  await writeFile(fallbackProvidersFile, JSON.stringify({
    providers: [
      {
        name: 'primary-provider', enabled: true, protocol: 'openai', endpoint: `http://127.0.0.1:${upstreamPort}/primary/chat/completions`,
        model: 'smoke-model', apiKeysEnv: 'SMOKE_API_KEYS', reasoningEffort: 'none', jsonOutputMode: 'auto',
        totalTimeoutMs: 250, firstByteTimeoutMs: 80, retryCount: 1,
      },
      {
        name: 'fallback-provider', enabled: true, protocol: 'openai', endpoint: `http://127.0.0.1:${upstreamPort}/fallback/chat/completions`,
        model: 'smoke-model', apiKeysEnv: 'SMOKE_API_KEYS', reasoningEffort: 'none', jsonOutputMode: 'auto',
        totalTimeoutMs: 250, firstByteTimeoutMs: 80, retryCount: 0,
      },
    ]
  }));
  await writeFile(fallbackProxyConfig, JSON.stringify({
    listen: { host: '127.0.0.1', port: 0 },
    tls: { ca: join(certs, 'ca.crt'), cert: join(certs, 'proxy-server.crt'), key: join(certs, 'proxy-server.key') },
    connectionPasswordEnv: 'MAJO_PROXY_PASSWORD_PRIMARY', acceptedClientVersions: ['2.4.0'], providersFile: fallbackProvidersFile,
  }));
  fallbackProxy = await startProxyServer(fallbackProxyConfig);
  const fallbackProxyPort = fallbackProxy.address().port;
  upstreamMode = 'primary-http-500';
  const beforeFallback = upstreamRequests.length;
  const fallbackSession = 'fallback-sequence-request-01';
  const fallbackHeaders = createSignedHeaders('backend-smoke-long-random-password', 'POST', '/internal/v1/chat/completions', internalBody, fallbackSession);
  assert.equal((await postProxy(fallbackProxyPort, ca, clientCert, clientKey, internalBody, fallbackHeaders)).status, 200);
  assert.deepEqual(upstreamRequests.slice(beforeFallback).map((entry) => entry.path), [
    '/primary/chat/completions',
    '/primary/chat/completions',
    '/fallback/chat/completions',
  ]);

  upstreamMode = 'sse-json';
  const secondFallbackSession = 'fallback-sequence-request-02';
  const secondFallbackHeaders = createSignedHeaders('backend-smoke-long-random-password', 'POST', '/internal/v1/chat/completions', internalBody, secondFallbackSession);
  assert.equal((await postProxy(fallbackProxyPort, ca, clientCert, clientKey, internalBody, secondFallbackHeaders)).status, 200);
  assert.equal(upstreamRequests.at(-1).path, '/primary/chat/completions');

  const structuredLogs = capturedLogs.flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  for (const event of ['ai_request', 'ai_success', 'proxy_request', 'proxy_success', 'provider_attempt', 'provider_success', 'provider_failure']) {
    const entry = structuredLogs.find((candidate) => candidate.event === event);
    assert.ok(entry, `缺少 ${event} 日志`);
    assert.ok(Number.isFinite(Date.parse(entry.time)), `${event} 日志缺少 ISO 时间`);
  }
  const mainValidationLogs = structuredLogs.filter((entry) => entry.event === 'ai_error' && entry.code === 'invalid_game_request');
  assert.equal(mainValidationLogs.length, rejectionCases.length, '每个主后端拒绝都应产生一条结构化日志');
  for (const entry of mainValidationLogs) {
    assert.deepEqual(Object.keys(entry).sort(), ['code', 'durationMs', 'event', 'ip', 'path', 'reason', 'sessionId', 'status', 'time']);
    assert.equal(entry.status, 400);
  }
  const proxyValidationLogs = structuredLogs.filter((entry) => entry.event === 'proxy_error' && entry.code === 'invalid_game_request');
  assert.equal(proxyValidationLogs.length, 1, '代理拒绝应产生一条结构化日志');
  assert.deepEqual(Object.keys(proxyValidationLogs[0]).sort(), ['code', 'durationMs', 'event', 'path', 'reason', 'sessionId', 'status', 'time']);
  assert.equal(proxyValidationLogs[0].reason, 'prompt_keys');
  assert.equal(proxyValidationLogs[0].path, 'prompt');
  const serializedLogs = capturedLogs.join('\n');
  for (const forbidden of [SENSITIVE_MARKER, 'untrustedInstruction', 'rawOutput', buildGameSystemPrompt('target')]) {
    assert.equal(serializedLogs.includes(forbidden), false, `结构化日志泄漏 ${forbidden}`);
  }

  console.log('后端烟测通过：固定 provider fallback 顺序、上游 SSE 聚合、非流式回退、首字节/总超时、重试、时间日志、mTLS、HMAC 与限流均已验证。');
} finally {
  if (fallbackProxy) await close(fallbackProxy);
  if (main) await close(main);
  if (proxy) await close(proxy);
  if (upstream) await close(upstream);
  for (const [method, implementation] of Object.entries(originalConsole)) console[method] = implementation;
  await rm(work, { recursive: true, force: true });
}
