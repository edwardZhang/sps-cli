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
import { AcpSdkAdapter } from './adapters/AcpSdkAdapter.js';
import { ClaudeACPAdapter } from './adapters/ClaudeACPAdapter.js';
import { CodexACPAdapter } from './adapters/CodexACPAdapter.js';

/** Legacy tool router — delegates to per-tool tmux adapters */
class LegacyToolRouter implements ACPClient {
  private readonly claude = new ClaudeACPAdapter();
  private readonly codex = new CodexACPAdapter();

  private pick(tool: string) {
    return tool === 'claude' ? this.claude : this.codex;
  }

  async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    return this.pick(input.tool).ensureSession(input);
  }
  async startRun(input: StartRunInput): Promise<StartRunResult> {
    return this.pick(input.tool).startRun(input);
  }
  async inspectSession(input: InspectSessionInput): Promise<InspectSessionResult> {
    return this.pick(input.tool).inspectSession(input);
  }
  async inspectRun(input: InspectRunInput): Promise<InspectRunResult> {
    return this.pick(input.tool).inspectRun(input);
  }
  async stopSession(input: StopSessionInput): Promise<void> {
    return this.pick(input.tool).stopSession(input);
  }
}

export class LocalACPClient implements ACPClient {
  private readonly adapter: ACPClient;

  constructor(mode: 'legacy' | 'sdk' = 'legacy') {
    this.adapter = mode === 'sdk' ? new AcpSdkAdapter() : new LegacyToolRouter();
  }

  async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    return this.adapter.ensureSession(input);
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    return this.adapter.startRun(input);
  }

  async inspectSession(input: InspectSessionInput): Promise<InspectSessionResult> {
    return this.adapter.inspectSession(input);
  }

  async inspectRun(input: InspectRunInput): Promise<InspectRunResult> {
    return this.adapter.inspectRun(input);
  }

  async stopSession(input: StopSessionInput): Promise<void> {
    return this.adapter.stopSession(input);
  }
}
