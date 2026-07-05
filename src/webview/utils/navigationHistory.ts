/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

type TimerHandle = ReturnType<typeof setTimeout>;

export interface NavigationHistoryOptions {
  maxEntries?: number;
  minDistance?: number;
  idleMs?: number;
}

export interface RecordPositionOptions {
  immediate?: boolean;
}

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MIN_DISTANCE = 100;
const DEFAULT_IDLE_MS = 1000;

/**
 * Tracks meaningful insertion-point positions so users can jump back and
 * forward after large document navigations without recording every keystroke.
 */
export class NavigationHistory {
  private readonly maxEntries: number;
  private readonly minDistance: number;
  private readonly idleMs: number;
  private backStack: number[] = [];
  private forwardStack: number[] = [];
  private idleTimer: TimerHandle | null = null;
  private current: number | null = null;
  private suppressCount = 0;

  constructor(options: NavigationHistoryOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.minDistance = options.minDistance ?? DEFAULT_MIN_DISTANCE;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  }

  get currentPosition(): number | null {
    return this.current;
  }

  get canNavigateBack(): boolean {
    return this.backStack.length > 0;
  }

  get canNavigateForward(): boolean {
    return this.forwardStack.length > 0;
  }

  seed(pos: number): void {
    this.clearPendingRecord();
    this.current = pos;
    this.forwardStack = [];
  }

  recordPosition(pos: number, options: RecordPositionOptions = {}): void {
    if (this.suppressCount > 0) return;

    this.clearPendingRecord();

    if (options.immediate) {
      this.commitPosition(pos);
      return;
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.commitPosition(pos);
    }, this.idleMs);
  }

  navigateBack(): number | null {
    this.clearPendingRecord();
    if (this.backStack.length === 0) return null;

    const destination = this.backStack.pop() ?? null;
    if (destination === null) return null;

    if (this.current !== null) {
      this.pushWithLimit(this.forwardStack, this.current);
    }
    this.current = destination;
    return destination;
  }

  navigateForward(): number | null {
    this.clearPendingRecord();
    if (this.forwardStack.length === 0) return null;

    const destination = this.forwardStack.pop() ?? null;
    if (destination === null) return null;

    if (this.current !== null) {
      this.pushWithLimit(this.backStack, this.current);
    }
    this.current = destination;
    return destination;
  }

  suppressDuring<T>(operation: () => T): T {
    this.suppressCount++;
    try {
      return operation();
    } finally {
      this.suppressCount--;
    }
  }

  dispose(): void {
    this.clearPendingRecord();
  }

  private commitPosition(pos: number): void {
    if (this.current !== null && Math.abs(pos - this.current) < this.minDistance) {
      return;
    }

    if (this.current !== null) {
      this.pushWithLimit(this.backStack, this.current);
    }

    this.current = pos;
    this.forwardStack = [];
  }

  private pushWithLimit(stack: number[], pos: number): void {
    stack.push(pos);
    if (stack.length > this.maxEntries) {
      stack.shift();
    }
  }

  private clearPendingRecord(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
