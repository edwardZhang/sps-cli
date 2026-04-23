/**
 * Phase 0 characterization — /api/logs 主线
 *
 * 锁定 v0.49.16 日志查询行为：单项目 tail、聚合、worker 过滤、since 过滤、limit。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestProject, destroyTestProject, type TestProjectFixture } from '../helpers/testProject';
import { buildTestApp, type TestAppHandle } from '../helpers/testServer';

describe('E2E /api/logs', () => {
  let fx: TestProjectFixture;
  let prevHome: string | undefined;
  let app: TestAppHandle;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    fx = createTestProject({ project: 'logs-test' });
    process.env.HOME = fx.home;
    app = await buildTestApp();
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    destroyTestProject(fx);
  });

  function seedLog(filename: string, content: string): void {
    writeFileSync(resolve(fx.logsDir, filename), content);
  }

  it('GET /logs?project=x 无日志返回空', async () => {
    const res = await app.req('/api/logs?project=logs-test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; files: unknown[] };
    expect(body.data).toEqual([]);
    expect(body.files).toEqual([]);
  });

  it('GET /logs?project=x 读 pipeline-*.log', async () => {
    seedLog(
      'pipeline-2026-04-23.log',
      '2026-04-23 10:00:00.000 [tick] \x1b[32mINFO\x1b[0m first line\n' +
        '2026-04-23 10:00:01.000 [tick] INFO second line\n',
    );
    const res = await app.req('/api/logs?project=logs-test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ msg: string }>; files: string[] };
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.files.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /logs?project=x&limit=1 只返 1 行', async () => {
    seedLog(
      'pipeline-2026-04-23.log',
      Array.from({ length: 10 }, (_, i) => `2026-04-23 10:00:0${i}.000 [tick] INFO line ${i}`).join(
        '\n',
      ) + '\n',
    );
    const res = await app.req('/api/logs?project=logs-test&limit=1');
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it('GET /logs?project=x&worker=1 过滤 worker log 文件', async () => {
    seedLog(
      'pipeline-2026-04-23.log',
      '2026-04-23 10:00:00.000 [tick] INFO pipeline line\n',
    );
    seedLog(
      'sps-acp-logs-test-worker-1-acp-123456.log',
      '2026-04-23 10:01:00.000 [worker-1] INFO worker 1 line\n',
    );
    const res = await app.req('/api/logs?project=logs-test&worker=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ msg: string }>; file?: string };
    expect(body.file ?? '').toContain('worker-1');
  });

  it('GET /logs 无 project 参数走聚合视图', async () => {
    seedLog('pipeline-2026-04-23.log', '2026-04-23 10:00:00.000 [tick] INFO aggregate\n');
    const res = await app.req('/api/logs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('data');
  });

  it('GET /logs?project=x&since=<ISO> 过滤时间', async () => {
    seedLog(
      'pipeline-2026-04-23.log',
      '2026-04-22 10:00:00.000 [tick] INFO old\n2026-04-23 10:00:00.000 [tick] INFO new\n',
    );
    const res = await app.req('/api/logs?project=logs-test&since=2026-04-23T00%3A00%3A00');
    const body = (await res.json()) as { data: Array<{ msg: string }> };
    const msgs = body.data.map((l) => l.msg).join(' ');
    expect(msgs).toContain('new');
  });
});
