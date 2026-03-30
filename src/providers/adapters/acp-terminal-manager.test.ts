import { describe, it, expect } from 'vitest';
import { TerminalManager } from './acp-terminal-manager.js';

describe('TerminalManager', () => {
  describe('createTerminal', () => {
    it('creates terminal and returns terminalId', async () => {
      const tm = new TerminalManager({ cwd: '/tmp', permissionMode: 'approve-all' });
      const result = await tm.createTerminal({ sessionId: 's1', command: 'echo', args: ['hello'] });
      expect(result.terminalId).toBeDefined();
      expect(typeof result.terminalId).toBe('string');
      await tm.releaseTerminal({ sessionId: 's1', terminalId: result.terminalId });
    });

    it('denies in deny-all mode', async () => {
      const tm = new TerminalManager({ cwd: '/tmp', permissionMode: 'deny-all' });
      await expect(
        tm.createTerminal({ sessionId: 's1', command: 'echo', args: ['hello'] }),
      ).rejects.toThrow('denied');
    });
  });

  describe('terminalOutput', () => {
    it('captures stdout', async () => {
      const tm = new TerminalManager({ cwd: '/tmp', permissionMode: 'approve-all' });
      const { terminalId } = await tm.createTerminal({ sessionId: 's1', command: 'echo', args: ['hello world'] });
      // Wait for process to finish
      await tm.waitForTerminalExit({ sessionId: 's1', terminalId });
      const output = await tm.terminalOutput({ sessionId: 's1', terminalId });
      expect(output.output).toContain('hello world');
      expect(output.truncated).toBe(false);
      expect(output.exitStatus?.exitCode).toBe(0);
      await tm.releaseTerminal({ sessionId: 's1', terminalId });
    });
  });

  describe('waitForTerminalExit', () => {
    it('returns exit code', async () => {
      const tm = new TerminalManager({ cwd: '/tmp', permissionMode: 'approve-all' });
      const { terminalId } = await tm.createTerminal({ sessionId: 's1', command: 'true' });
      const result = await tm.waitForTerminalExit({ sessionId: 's1', terminalId });
      expect(result.exitCode).toBe(0);
      await tm.releaseTerminal({ sessionId: 's1', terminalId });
    });

    it('captures non-zero exit code', async () => {
      const tm = new TerminalManager({ cwd: '/tmp', permissionMode: 'approve-all' });
      const { terminalId } = await tm.createTerminal({ sessionId: 's1', command: 'false' });
      const result = await tm.waitForTerminalExit({ sessionId: 's1', terminalId });
      expect(result.exitCode).toBe(1);
      await tm.releaseTerminal({ sessionId: 's1', terminalId });
    });
  });

  describe('killTerminal', () => {
    it('kills running process', async () => {
      const tm = new TerminalManager({ cwd: '/tmp', permissionMode: 'approve-all' });
      const { terminalId } = await tm.createTerminal({ sessionId: 's1', command: 'sleep', args: ['60'] });
      await tm.killTerminal({ sessionId: 's1', terminalId });
      const output = await tm.terminalOutput({ sessionId: 's1', terminalId });
      expect(output.exitStatus).toBeDefined();
      await tm.releaseTerminal({ sessionId: 's1', terminalId });
    });
  });

  describe('releaseTerminal', () => {
    it('releases and removes terminal', async () => {
      const tm = new TerminalManager({ cwd: '/tmp', permissionMode: 'approve-all' });
      const { terminalId } = await tm.createTerminal({ sessionId: 's1', command: 'echo', args: ['hi'] });
      await tm.waitForTerminalExit({ sessionId: 's1', terminalId });
      await tm.releaseTerminal({ sessionId: 's1', terminalId });
      // Second release is a no-op
      await tm.releaseTerminal({ sessionId: 's1', terminalId });
    });

    it('throws for unknown terminal on output', async () => {
      const tm = new TerminalManager({ cwd: '/tmp', permissionMode: 'approve-all' });
      await expect(
        tm.terminalOutput({ sessionId: 's1', terminalId: 'nonexistent' }),
      ).rejects.toThrow('Unknown terminal');
    });
  });
});
