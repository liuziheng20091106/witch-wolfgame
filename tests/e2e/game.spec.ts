import { expect, test, type Page, type Route } from '@playwright/test';

const endpoint = 'https://fake.example/v1/chat/completions';

async function configureAi(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'AI 设置' }).click();
  await page.getByLabel('服务商名称').fill('E2E Fake');
  await page.getByLabel('协议').selectOption('openai-compatible');
  await page.getByLabel('完整端点').fill(endpoint);
  await page.getByLabel('模型').fill('fake-model');
  await page.getByLabel('API Key', { exact: true }).fill('fake-key');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('button', { name: '开始新局' })).toBeEnabled();
}

interface PromptPayload {
  action: { schema: string; title: string };
  legalCandidates: Array<{ playerId: number }>;
  options: Record<string, unknown>;
}

async function fulfillDecision(route: Route): Promise<void> {
  const body = route.request().postDataJSON() as {
    response_format: { type: string };
    reasoning_effort: string;
    messages: Array<{ content: string }>;
  };
  expect(body.response_format).toEqual({ type: 'json_object' });
  expect(body.reasoning_effort).toBe('low');
  const prompt = JSON.parse(body.messages.at(-1)?.content ?? '{}') as PromptPayload;
  const first = prompt.legalCandidates[0]?.playerId ?? null;
  let decision: Record<string, unknown>;
  if (prompt.action.schema === 'speech') {
    decision = { speech: '莲见蕾雅值得继续关注，我会依据公开记录判断。' };
  } else if (prompt.action.schema === 'witch') {
    decision = { save: false, poisonTargetPlayerId: null };
  } else if (prompt.action.schema === 'ignition') {
    decision = { use: false };
  } else if (prompt.action.schema === 'liquid-control') {
    decision = { use: false, mode: null, targetPlayerId: null, factId: null };
  } else if (prompt.action.schema === 'levitation') {
    decision = { use: false, mode: null, targetPlayerId: null };
  } else if (prompt.action.schema === 'voice-mimic') {
    decision = { use: false, targetPlayerId: null, forgedSpeech: null };
  } else if (prompt.action.schema === 'optional-target') {
    decision = { use: false, targetPlayerId: null };
  } else {
    const targetPlayerId = prompt.action.title === '治愈' && prompt.legalCandidates.some((candidate) => candidate.playerId === 1) ? 1 : first;
    decision = { targetPlayerId };
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }),
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('观战模式在 AI 错误后整局切换本地策略并恢复存档', async ({ page }) => {
  let requestCount = 0;
  await page.route(endpoint, async (route) => {
    requestCount += 1;
    await route.abort('failed');
  });
  await configureAi(page);
  await page.getByRole('button', { name: '开始新局' }).click();
  await expect(page.getByRole('button', { name: '本局改用本地策略' })).toBeVisible();
  await page.getByRole('button', { name: '2x' }).click();
  await page.getByRole('button', { name: '本局改用本地策略' }).click();
  await expect(page.getByRole('button', { name: '再来一局' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/阵营获胜/).first()).toBeVisible();
  expect(requestCount).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('majo-wolf.game.v1') ?? '{}').state.automationMode)).toBe('local');

  await page.reload();
  await page.getByRole('button', { name: '继续上局' }).click();
  await expect(page.getByText(/本地策略/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '再来一局' })).toBeVisible();
  expect(requestCount).toBe(1);
});

test('参与模式恢复人类待决策并完成发言、投票与结算', async ({ page }) => {
  await page.route(endpoint, fulfillDecision);
  await configureAi(page);
  await page.getByRole('button', { name: '加入一个席位' }).click();
  await page.getByRole('button', { name: /樱羽艾玛/ }).click();
  await page.getByRole('button', { name: '开始新局' }).click();
  await expect(page.getByRole('radio', { name: /莲见蕾雅/ })).toBeVisible();
  await expect(page.getByText('身份未公开').first()).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: '继续上局' }).click();
  await expect(page.getByRole('radio', { name: /莲见蕾雅/ })).toBeVisible();
  await page.getByRole('radio', { name: /莲见蕾雅/ }).check();
  await page.getByRole('button', { name: '提交决策' }).click();
  await page.getByRole('button', { name: '2x' }).click();

  let submittedSpeech = false;
  let submittedVote = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await page.getByRole('button', { name: '再来一局' }).isVisible().catch(() => false)) break;
    const submit = page.getByRole('button', { name: '提交决策' });
    if (await submit.isVisible().catch(() => false)) {
      const textarea = page.locator('textarea').first();
      const bodyText = await page.locator('body').innerText();
      if (await textarea.isVisible().catch(() => false)) {
        await textarea.fill('莲见蕾雅值得继续关注，我提交自己的公开判断。');
        submittedSpeech = true;
      } else {
        const radios = page.getByRole('radio');
        if (await radios.count() > 0) await radios.first().check();
        if (bodyText.includes('公开投票')) submittedVote = true;
      }
      await submit.click();
    }
    await page.waitForTimeout(220);
  }

  await expect(page.getByRole('button', { name: '再来一局' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/魔女杀手/).first()).toBeVisible();
  expect(submittedSpeech).toBe(true);
  expect(submittedVote).toBe(true);
});

test('准备区与游戏在目标视口无横向溢出', async ({ page }) => {
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 390, height: 844 },
    { name: 'landscape', width: 844, height: 390 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/visual/${viewport.name}.png`, fullPage: true });
  }
});
