/**
 * Minimal Vitest-compatible shim for `tools/local-check/run.mjs`.
 *
 * Why this exists: the repository lives on a UNC path (`\\host\share\...`) on some
 * machines, and Vite/Vitest resolve a UNC project root as a POSIX path, which breaks
 * before a single test runs. The shim lets the SAME src test files execute through
 * execute through esbuild + node, so logic can still be verified there. It implements
 * only the surface this repository's tests use; it is NOT a general Vitest replacement.
 */

const state = { suites: [], stack: [], hooks: { before: [], after: [] } };

/**
 * The shim is imported as ONE module instance by every bundle (esbuild marks it external),
 * so its registry must be cleared between files - otherwise file N re-runs the suites of
 * files 1..N-1 and every later failure is attributed to the wrong file.
 */
export function __mdxReset() {
  state.suites.length = 0;
  state.stack.length = 0;
}

function register(name, fn) {
  const suite = { name, tests: [], children: [], before: [], after: [] };
  if (state.stack.length) state.stack[state.stack.length - 1].children.push(suite);
  else state.suites.push(suite);
  state.stack.push(suite);
  fn();
  state.stack.pop();
}

export function describe(name, fn) {
  register(name, fn);
}

export function it(name, fn) {
  state.stack[state.stack.length - 1].tests.push({ name, fn });
}

export const test = it;

// Skipping: `it.skipIf(cond)('name', fn)` returns the registration function.
it.skipIf = (condition) => (condition ? () => {} : it);
it.skip = () => {};
test.skipIf = it.skipIf;
test.skip = it.skip;
describe.skip = () => {};

export function beforeEach(fn) {
  state.stack[state.stack.length - 1].before.push(fn);
}

export function afterEach(fn) {
  state.stack[state.stack.length - 1].after.push(fn);
}

function fail(message) {
  throw new Error(message);
}

function equals(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => equals(a[k], b[k]));
}

function matchers(actual, negated) {
  const check = (ok, message) => {
    if (negated ? ok : !ok) fail((negated ? 'not: ' : '') + message);
  };
  const api = {
    toBe: (expected) => check(Object.is(actual, expected), `expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`),
    toEqual: (expected) => check(equals(actual, expected), `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`),
    toBeNull: () => check(actual === null, `expected ${JSON.stringify(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, `expected ${JSON.stringify(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, 'expected value to be defined'),
    toBeTruthy: () => check(Boolean(actual), `expected ${JSON.stringify(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, `expected ${JSON.stringify(actual)} to be falsy`),
    toContain: (needle) =>
      check(
        typeof actual === 'string' ? actual.includes(needle) : Array.isArray(actual) && actual.includes(needle),
        `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(needle)}`
      ),
    toHaveLength: (n) => check(actual != null && actual.length === n, `expected length ${actual?.length} to be ${n}`),
    toMatch: (pattern) =>
      check(
        typeof pattern === 'string' ? String(actual).includes(pattern) : pattern.test(String(actual)),
        `expected ${JSON.stringify(actual)} to match ${pattern}`
      ),
    toBeLessThan: (n) => check(actual < n, `expected ${actual} < ${n}`),
    toBeGreaterThan: (n) => check(actual > n, `expected ${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n) => check(actual >= n, `expected ${actual} >= ${n}`),
    toBeLessThanOrEqual: (n) => check(actual <= n, `expected ${actual} <= ${n}`),
    toBeCloseTo: (expected, digits = 2) =>
      check(
        Math.abs(Number(actual) - Number(expected)) < Math.pow(10, -digits) / 2,
        `expected ${actual} to be close to ${expected}`
      ),
    toThrow: () => {
      let threw = false;
      try {
        actual();
      } catch {
        threw = true;
      }
      check(threw, 'expected the function to throw');
    }
  };
  return api;
}

export function expect(actual) {
  const api = matchers(actual, false);
  api.not = matchers(actual, true);
  return api;
}

export async function __mdxRun() {
  const failures = [];
  let passed = 0;

  async function runSuite(suite, pathParts) {
    const label = [...pathParts, suite.name].filter(Boolean);
    for (const t of suite.tests) {
      const full = [...label, t.name].join(' › ');
      try {
        for (const hook of suite.before) await hook();
        await t.fn();
        passed++;
        console.log(`  ✓ ${full}`);
      } catch (err) {
        failures.push({ full, error: err });
        console.log(`  ✗ ${full}\n      ${err?.message || err}`);
      } finally {
        for (const hook of suite.after) await hook();
      }
    }
    for (const child of suite.children) await runSuite(child, label);
  }

  for (const suite of state.suites) await runSuite(suite, []);
  return { passed, failures };
}

// The bundle imports this module externally, so the runner and the test file share one
// instance - but the runner must reach it through the global to stay version-agnostic.
globalThis.__mdxRun = __mdxRun;
globalThis.__mdxReset = __mdxReset;
