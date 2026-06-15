/**
 * A deterministic, scriptable FakeSessionDriver for testing the Phase-2 logic
 * (lifecycle, permission router, stream-json→bus mapping, resume/health) WITHOUT
 * the real Agent SDK or a spawned subprocess.
 *
 * It is the test-side counterpart of the production SdkSessionDriver: both
 * implement the SessionDriver seam, so the lifecycle manager can't tell them
 * apart. A test scripts a sequence of "programs" (one per start() — the initial
 * run and any resume runs after a simulated crash); each program is a list of
 * actions the driver performs: emit an event, fire a permission request, or end
 * the stream (cleanly with a result, or abruptly = a crash).
 */

import type {
  PermissionDecision,
  SessionDriver,
  SessionDriverHealth,
  SessionEvent,
  SessionStartOptions,
  ToolUse,
  UserTurn,
} from '../session-driver.js';
import { assertValidUserTurn, makeUserTurn } from '../adapters/sdk-session-driver.js';

/** One scripted step a program performs when started. */
export type ScriptStep =
  | { do: 'emit'; event: SessionEvent }
  | { do: 'permission'; toolName: string; input?: Record<string, unknown>; record?: (d: PermissionDecision) => void }
  | { do: 'awaitTurn' } // pause until the next send() — models an idle session waiting for a user turn
  | { do: 'endClean' } // stream ends normally (after a result was emitted)
  | { do: 'crash' }; // stream ends abruptly with NO result → lifecycle should restart+resume

/** A program = the steps for ONE start() invocation. */
export type Program = ScriptStep[];

export class FakeSessionDriver implements SessionDriver {
  /** Programs consumed in order — one per start() (initial, then each resume). */
  private readonly programs: Program[];
  private startCount = 0;
  private running = false;
  private sessionId: string | undefined;
  /** Resolver for the current `awaitTurn` step (set when paused, called by send()). */
  private turnWaiter: (() => void) | null = null;
  /** True if a send() arrived BEFORE the generator reached `awaitTurn` (release-on-arrival). */
  private pendingTurnRelease = false;
  /** Records the start opts of every start() (to assert resume was passed). */
  readonly startOpts: SessionStartOptions[] = [];
  /** Records user turns injected via send(). */
  readonly sentTurns: UserTurn[] = [];

  constructor(programs: Program[]) {
    this.programs = programs;
  }

  start(opts: SessionStartOptions): AsyncIterable<SessionEvent> {
    this.startOpts.push(opts);
    const program = this.programs[this.startCount] ?? [];
    this.startCount++;
    this.running = true;
    const self = this;

    async function* gen(): AsyncGenerator<SessionEvent> {
      for (const step of program) {
        if (step.do === 'emit') {
          if (step.event.kind === 'system_init') self.sessionId = step.event.sessionId;
          yield step.event;
        } else if (step.do === 'permission') {
          const decision = await opts.onPermission({
            toolName: step.toolName,
            input: step.input ?? {},
            sessionId: self.sessionId,
          });
          step.record?.(decision);
          // If allowed, simulate the tool running + a result event.
          if (decision.behavior === 'allow') {
            const tu: ToolUse = { id: `tu-${step.toolName}`, name: step.toolName, input: step.input ?? {} };
            yield { kind: 'assistant', text: '', toolUses: [tu] };
            yield { kind: 'tool_result', toolUseId: tu.id, content: 'ok' };
          }
        } else if (step.do === 'awaitTurn') {
          // Pause until send() is called (an idle session waiting for a user turn).
          // If a turn already arrived before we got here, proceed immediately
          // (release-on-arrival — avoids a start()/send() ordering race).
          if (self.pendingTurnRelease) {
            self.pendingTurnRelease = false;
          } else {
            await new Promise<void>((resolve) => {
              self.turnWaiter = resolve;
            });
          }
        } else if (step.do === 'endClean') {
          self.running = false;
          return; // generator completes → stream ended (clean if a result was emitted)
        } else if (step.do === 'crash') {
          self.running = false;
          return; // completes with NO result → lifecycle treats as crash → restart
        }
      }
      self.running = false;
    }
    return gen();
  }

  async send(turn: UserTurn): Promise<void> {
    // FIDELITY GUARD. The real SdkSessionDriver feeds each turn to the SDK's
    // streaming-input pump as an SDKUserMessageContent envelope. The original
    // `{type,content}` bug escaped because THIS fake never built/validated that
    // envelope — it just recorded the turn. We now shape it with the SAME
    // `makeUserTurn` the production driver uses and run it through the SAME
    // `assertValidUserTurn` contract, so a malformed turn FAILS here exactly as it
    // does live. (A future regression in the production envelope builder trips
    // this assertion in the test suite instead of only in a live session.)
    const envelope = makeUserTurn(turn.text);
    assertValidUserTurn(envelope);
    this.sentTurns.push(turn);
    // Release a paused `awaitTurn` step; if the generator hasn't reached it yet,
    // mark a pending release so it proceeds the instant it does (ordering-safe).
    if (this.turnWaiter) {
      const w = this.turnWaiter;
      this.turnWaiter = null;
      w();
    } else {
      this.pendingTurnRelease = true;
    }
  }

  async interrupt(): Promise<void> {
    /* no-op for the fake */
  }

  async stop(): Promise<void> {
    this.running = false;
    // Release a paused awaitTurn so the generator can exit on stop().
    if (this.turnWaiter) {
      const w = this.turnWaiter;
      this.turnWaiter = null;
      w();
    }
  }

  health(): SessionDriverHealth {
    return { running: this.running, sessionId: this.sessionId, detail: 'fake-session-driver' };
  }

  /** Test helper: how many times start() was called (initial + resumes). */
  get starts(): number {
    return this.startCount;
  }
}
