/**
 * SPS Console end-to-end smoke test (v0.49).
 *
 * 关键路径：
 *   1. 打开 /projects 页，确认新建按钮能用
 *   2. 新建向导填表 → 创建项目 → 跳详情页
 *   3. 回列表看到新项目
 *   4. 进详情页 → 配置 tab 编辑 conf → 保存
 *   5. 进详情页 → 危险操作 → 删除（不清 repo .claude/，因为是临时目录）
 *
 * 不测：pipeline start / worker 真跑，因为需要 claude-agent-acp 连真 API，
 * e2e 只验"UI → API → 文件系统"这条链。
 */
import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// 每次运行生成一次性项目名，避免残留导致 409
const PROJECT_NAME = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const TMP_REPO = mkdtempSync(resolve(tmpdir(), 'sps-e2e-repo-'));

test.afterAll(() => {
  // 清理临时 repo 目录（即使测试中途失败也尽量清掉）
  try { rmSync(TMP_REPO, { recursive: true, force: true }); } catch { /* noop */ }
});

test('smoke: projects CRUD end-to-end', async ({ page }) => {
  // 1. Landing page is /projects (since v0.48.1 default route)
  await page.goto('/');
  await expect(page).toHaveURL(/\/projects/);
  await expect(page.getByRole('heading', { name: /项目/ })).toBeVisible();

  // 2. 新建项目按钮
  await page.getByRole('button', { name: /新建项目/ }).click();
  await expect(page).toHaveURL(/\/projects\/new/);
  await expect(page.getByRole('heading', { name: /新建项目/ })).toBeVisible();

  // 填表
  await page.getByPlaceholder('例如: acme-web').fill(PROJECT_NAME);
  await page.getByPlaceholder('/home/coral/code/acme').fill(TMP_REPO);

  // 提交
  await page.getByRole('button', { name: '创建项目' }).click();

  // 3. 跳转到详情页
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_NAME}`), { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: PROJECT_NAME })).toBeVisible();

  // 概览 tab 默认显示，应该看得见仓库路径（getByText 按字符串精确匹配，不走 regex）
  await expect(page.getByText(TMP_REPO, { exact: false }).first()).toBeVisible();

  // 4. 配置 tab
  await page.getByRole('button', { name: /配置/ }).click();
  const confTextarea = page.getByLabel('conf 文件编辑器');
  await expect(confTextarea).toBeVisible({ timeout: 10_000 });
  const initialConf = await confTextarea.inputValue();
  expect(initialConf).toContain(`PROJECT_NAME="${PROJECT_NAME}"`);

  // 改一下，加个注释
  await confTextarea.fill(initialConf + '\n# e2e test marker\n');
  await page.getByRole('button', { name: '保存配置' }).click();
  // 保存后 dirty 标记消失
  await expect(page.locator('text=/未保存的修改/')).not.toBeVisible({ timeout: 10_000 });

  // 5. 危险操作 tab → 删除
  await page.getByRole('button', { name: /危险操作/ }).click();

  // 取消勾选 includeClaudeDir（临时目录没 .claude/）
  const checkbox = page.locator('input[type="checkbox"]').first();
  if (await checkbox.isChecked()) await checkbox.uncheck();

  // 输入项目名二次确认
  await page.getByPlaceholder(PROJECT_NAME).fill(PROJECT_NAME);
  await page.getByRole('button', { name: /永久删除/ }).click();

  // "已删除" dialog 会弹 — 用 heading role 避免和 body 文本冲突
  await expect(page.getByRole('heading', { name: '已删除' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: '知道了' }).click();

  // 6. 跳回列表，新项目消失
  await expect(page).toHaveURL(/\/projects$/, { timeout: 10_000 });
  await expect(page.getByText(PROJECT_NAME, { exact: false })).not.toBeVisible();

  // 7. 校验文件系统：~/.coral/projects/<PROJECT_NAME> 不该存在
  const projectDir = resolve(process.env.HOME ?? '/home/coral', '.coral', 'projects', PROJECT_NAME);
  expect(existsSync(projectDir)).toBe(false);
});

test('smoke: system page version + env view', async ({ page }) => {
  await page.goto('/system');
  await expect(page.getByRole('heading', { name: /系统/ })).toBeVisible();

  // 版本 section
  await expect(page.getByText(/sps-cli \(当前\)/)).toBeVisible();

  // 运行时 section — 用精确匹配避免和 "node v22.x" 重复
  await expect(page.getByText('Node', { exact: true })).toBeVisible();
  await expect(page.getByText('Platform', { exact: true })).toBeVisible();

  // 检查更新按钮存在但不触发（避免依赖外网 npm registry）
  // aria-label 是"检查最新版本"，visible text 是"检查更新"，用 aria-label 匹配
  await expect(page.getByRole('button', { name: '检查最新版本' })).toBeVisible();
});

test('smoke: status bar shows server + SSE + metrics', async ({ page }) => {
  await page.goto('/projects');
  // StatusBar 固定在底部
  const bar = page.locator('footer');
  await expect(bar.locator('text=server')).toBeVisible({ timeout: 10_000 });
  // SSE 可能先 connecting 再 open
  await expect(bar.locator('text=/SSE/')).toBeVisible({ timeout: 10_000 });
  await expect(bar.locator('text=pipeline')).toBeVisible();
  await expect(bar.locator('text=worker')).toBeVisible();
});
