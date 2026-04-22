/**
 * @module        LocalACPClient
 * @description   本地 ACP 客户端，封装 ACP SDK 适配器提供会话与运行管理
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-27
 * @updated       2026-03-31
 *
 * @role          provider
 * @layer         provider
 * @boundedContext acp
 */
import type {
  AccumulatorListener,
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

export class LocalACPClient implements ACPClient {
  private readonly adapter = new AcpSdkAdapter();

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

  subscribe(sessionName: string, listener: AccumulatorListener): () => void {
    return this.adapter.subscribe(sessionName, listener);
  }
}
