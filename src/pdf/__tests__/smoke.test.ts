import { describe, it, expect } from 'vitest';

// Deliberately failing probe: proves the runner actually executes tests.
// Flip the expectation to 2 once you have seen this fail.
describe('vitest runner', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});