import { afterEach, describe, expect, it } from 'vitest';
import { describeError } from '../src/log.js';

describe('describeError', () => {
  afterEach(() => {
    delete process.env.LOG_DETAILS;
  });

  it('logs the error itself by default', () => {
    const err = new Error('details');
    expect(describeError(err)).toBe(err);
  });

  it("with LOG_DETAILS=0, keeps only the kind and status, never the text", () => {
    process.env.LOG_DETAILS = '0';
    let parseError: unknown;
    try {
      JSON.parse('{"the user asked": about Neon');
    } catch (err) {
      parseError = err;
    }
    expect(describeError(parseError)).toBe('SyntaxError');
    expect(describeError(Object.assign(new Error('Bad request: what does Neon cost'), { status: 400 }))).toBe('Error (status 400)');
    expect(describeError('a string')).toBe('string');
  });
});
