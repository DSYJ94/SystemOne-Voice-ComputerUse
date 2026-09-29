/** One controller task may own execution at a time, regardless of surface.
 * Release is identity-checked so a late completion cannot free a newer task. */
export class ExclusiveTaskSlot<T extends { readonly requestId: string }> {
  #active: T | undefined;
  #stopPending = false;
  #settled = false;

  get active(): T | undefined { return this.#active; }

  claim(task: T): void {
    if (this.#active) throw new Error('controller task slot occupied');
    this.#active = task;
    this.#stopPending = false;
    this.#settled = false;
  }

  beginStop(task: T): boolean {
    if (this.#active !== task || this.#stopPending) return false;
    this.#stopPending = true;
    return true;
  }

  /** A task that settles during Stop stays in the slot until the barrier ends. */
  release(task: T): boolean {
    if (this.#active !== task) return false;
    if (this.#stopPending) { this.#settled = true; return false; }
    this.#active = undefined;
    return true;
  }

  finishStop(task: T): boolean {
    if (this.#active !== task || !this.#stopPending) return false;
    this.#stopPending = false;
    if (!this.#settled) return false;
    this.#active = undefined;
    return true;
  }
}
