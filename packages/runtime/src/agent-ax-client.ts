import { randomUUID } from 'node:crypto';
import { ContractError } from '../../protocol/src/json.ts';
import type { JSONValue } from '../../protocol/src/json.ts';

export interface AgentElement {
  readonly id: string;
  readonly role: string;
  readonly label: string;
  readonly context: string;
  readonly editable: boolean;
  readonly pressable: boolean;
  readonly secure?: boolean;
  readonly value?: string;
  readonly selected?: boolean;
  readonly url?: string;
  /** A browser tab that can be closed by name. */
  readonly closable?: boolean;
}

/** One open window anywhere on the Mac. */
export interface AgentWindow {
  readonly id: string;
  readonly app: string;
  readonly title: string;
  readonly minimized?: boolean;
  readonly hidden?: boolean;
  /** The front window of the front app. */
  readonly front?: boolean;
  /** Name of the display the window is on. */
  readonly display?: string;
}

export interface AgentSnapshot {
  readonly app: string;
  readonly bundleId: string;
  readonly pid: number;
  readonly windowTitle: string;
  readonly url: string;
  readonly elements: readonly AgentElement[];
  readonly truncated: boolean;
  /** Layout only (controls, values, selection): the same screen even while a clock ticks. */
  readonly signature: string;
  /** Layout plus visible text: whether a step changed anything (e.g. a new song title). */
  readonly contentSignature?: string;
  /** Page scroll position in pixels, when the page itself was read. */
  readonly scrollY?: number | null;
  /** Other apps the user has open (regular apps only), for switching. */
  readonly runningApps?: readonly string[];
  /** Executor-measured read time and nodes visited, for traces. */
  readonly readMs?: number;
  readonly visited?: number;
  /** False when the app being read is open but behind another app. */
  readonly frontmost?: boolean;
  /** Reading the screen image is allowed (Screen Recording granted and the setting on). */
  readonly vision?: boolean;
  /** Apps installed on this Mac (open or not), so any of them can be opened. */
  readonly installedApps?: readonly string[];
  /** Whole-Mac state no window shows: appearance, Wi‑Fi power, output volume. */
  readonly mac?: { readonly darkMode?: boolean; readonly wifiOn?: boolean; readonly volume?: number; readonly muted?: boolean };
  /** Connected displays (index order is the executor's), and which has the pointer. */
  readonly displays?: readonly { readonly name: string; readonly index: number; readonly pointer?: boolean;
    readonly main?: boolean }[];
  /** System Settings panes on this Mac (from the system's own pane list). */
  readonly settingsPanes?: readonly { readonly id: string; readonly name: string }[];
  /** Every open window on the Mac (front app first). */
  readonly windows?: readonly AgentWindow[];
  /** "dom" when a browser tab was read from its page, "ax" otherwise. */
  readonly via?: string;
}

export type AgentOperation = 'snapshot' | 'press' | 'type' | 'key' | 'scroll' | 'open_url' | 'open_app' | 'copy' | 'paste' | 'close' | 'quit_app'
  | 'focus_window' | 'window_action' | 'media' | 'open_file' | 'system' | 'open_settings'
  | 'menu_items' | 'menu_press' | 'status_items' | 'status_press' | 'notifications' | 'vision_read';

/** Host-side end of the private pipe to the app's Accessibility executor. The
 * app accepts a request only for the active, host-admitted agent task. */
export class AgentAXClient {
  readonly #output: (value: Record<string, JSONValue>) => void;
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> }>();

  constructor(output: (value: Record<string, JSONValue>) => void) { this.#output = output; }

  call(taskId: string, op: AgentOperation, params: Record<string, JSONValue> = {}, timeoutMs = 10_000): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new ContractError(`agent ${op} timed out`)); },
        timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#output({ type: 'agent_ax_request', requestId, taskId, op, ...params });
    });
  }

  async snapshot(taskId: string): Promise<AgentSnapshot> {
    const value = await this.call(taskId, 'snapshot') as AgentSnapshot;
    if (!value || typeof value !== 'object' || !Array.isArray(value.elements)
      || typeof value.signature !== 'string') throw new ContractError('invalid agent snapshot');
    return value;
  }

  /** True when the message was an executor reply (consumed). */
  receive(message: Record<string, JSONValue>): boolean {
    if (message.type !== 'agent_ax_reply' || typeof message.requestId !== 'string') return false;
    const pending = this.#pending.get(message.requestId);
    if (!pending) return true;
    this.#pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.value ?? null);
    else pending.reject(new ContractError(`agent step failed: ${String(message.error ?? 'unknown')}`));
    return true;
  }

  cancelAll(): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer); pending.reject(new ContractError('agent request cancelled')); this.#pending.delete(id);
    }
  }
}
