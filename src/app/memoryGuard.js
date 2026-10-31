/**
 * Deterministic Memory & ObjectURL Lifecycle Guard
 * Prevents Blob / ObjectURL / ArrayBuffer leaks across repeated large-archive operations.
 */

export class MemoryGuard {
  constructor(onChange = null) {
    /** @type {Map<string, { url: string, bytes: number, createdAt: number }>} */
    this.slots = new Map();
    this.totalCreated = 0;
    this.totalRevoked = 0;
    this.onChange = onChange;

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this._boundCleanup = () => this.revokeAll();
      window.addEventListener('pagehide', this._boundCleanup);
      window.addEventListener('beforeunload', this._boundCleanup);
    }
  }

  /**
   * Creates or replaces an ObjectURL in a named slot, revoking any previous URL in that slot immediately.
   * @param {string} slot
   * @param {Blob} blob
   * @returns {string}
   */
  registerBlobUrl(slot, blob) {
    this.revokeSlot(slot);
    const url = URL.createObjectURL(blob);
    this.slots.set(slot, {
      url,
      bytes: blob ? blob.size || 0 : 0,
      createdAt: Date.now(),
    });
    this.totalCreated++;
    this._notify();
    return url;
  }

  /**
   * Revokes a single named ObjectURL slot if active.
   * @param {string} slot
   */
  revokeSlot(slot) {
    const existing = this.slots.get(slot);
    if (!existing) return false;
    try {
      URL.revokeObjectURL(existing.url);
    } catch {
      // Ignore already-revoked URL
    }
    this.slots.delete(slot);
    this.totalRevoked++;
    this._notify();
    return true;
  }

  /**
   * Revokes ALL tracked ObjectURLs immediately.
   */
  revokeAll() {
    for (const [, entry] of this.slots) {
      try {
        URL.revokeObjectURL(entry.url);
      } catch {
        // Ignore
      }
      this.totalRevoked++;
    }
    this.slots.clear();
    this._notify();
  }

  /**
   * Returns current memory hygiene telemetry.
   */
  getStats() {
    let trackedBlobBytes = 0;
    for (const [, entry] of this.slots) {
      trackedBlobBytes += entry.bytes;
    }
    let jsHeapUsed = null;
    if (
      typeof performance !== 'undefined' &&
      performance &&
      performance.memory &&
      typeof performance.memory.usedJSHeapSize === 'number'
    ) {
      jsHeapUsed = performance.memory.usedJSHeapSize;
    }
    return {
      activeUrls: this.slots.size,
      totalCreated: this.totalCreated,
      totalRevoked: this.totalRevoked,
      trackedBlobBytes,
      jsHeapUsed,
    };
  }

  destroy() {
    this.revokeAll();
    if (typeof window !== 'undefined' && this._boundCleanup) {
      window.removeEventListener('pagehide', this._boundCleanup);
      window.removeEventListener('beforeunload', this._boundCleanup);
      this._boundCleanup = null;
    }
  }

  _notify() {
    if (typeof this.onChange === 'function') {
      this.onChange(this.getStats());
    }
  }
}
