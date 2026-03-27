import type {
  ACPClient,
  EnsureSessionInput,
  EnsureSessionResult,
  InspectRunInput,
  InspectRunResult,
  InspectSessionInput,
  InspectSessionResult,
  StartRunInput,
  StartRunResult,
  StopSessionInput,
} from '../interfaces/ACPClient.js';
import { ClaudeACPAdapter } from './adapters/ClaudeACPAdapter.js';
import { CodexACPAdapter } from './adapters/CodexACPAdapter.js';

export class LocalACPClient implements ACPClient {
  private readonly claude = new ClaudeACPAdapter();
  private readonly codex = new CodexACPAdapter();

  async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    return input.tool === 'claude'
      ? this.claude.ensureSession(input)
      : this.codex.ensureSession(input);
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    return input.tool === 'claude'
      ? this.claude.startRun(input)
      : this.codex.startRun(input);
  }

  async inspectSession(input: InspectSessionInput): Promise<InspectSessionResult> {
    return input.tool === 'claude'
      ? this.claude.inspectSession(input)
      : this.codex.inspectSession(input);
  }

  async inspectRun(input: InspectRunInput): Promise<InspectRunResult> {
    return input.tool === 'claude'
      ? this.claude.inspectRun(input)
      : this.codex.inspectRun(input);
  }

  async stopSession(input: StopSessionInput): Promise<void> {
    if (input.tool === 'claude') {
      await this.claude.stopSession(input);
    } else {
      await this.codex.stopSession(input);
    }
  }
}
