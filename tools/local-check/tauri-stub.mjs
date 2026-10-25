/**
 * Stand-in for `@tauri-apps/api/core` used by `tools/local-check/run.mjs`.
 *
 * `convertFileSrc` is the only bridge the renderer touches, and it only exists on the
 * main thread of a real Tauri window. Returning the raw path mirrors the renderer's own
 * "deferred assets" mode, which is exactly the mode the Worker uses - so tests exercise
 * the same code path the Worker does.
 */
export function convertFileSrc(path) {
  return path;
}

export function invoke() {
  throw new Error('invoke() is not available in the local-check harness');
}

/** Minimal stand-ins for the rest of `@tauri-apps/api/core` that modules may re-export. */
export class Channel {
  constructor() {
    this.onmessage = () => {};
  }
  toJSON() {
    return `__CHANNEL__`;
  }
}

export class Resource {
  constructor(rid) {
    this.rid = rid;
  }
  async close() {}
}

export function transformCallback() {
  return 0;
}
