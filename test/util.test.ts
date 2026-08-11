import { describeError, nonEmpty } from '../src/util';

describe('describeError', () => {
  it('returns the message of an Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error value', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(42)).toBe('42');
  });
});

describe('nonEmpty', () => {
  it('returns the value for a non-blank string', () => {
    expect(nonEmpty('hello')).toBe('hello');
  });

  it('returns undefined for a blank or whitespace-only string', () => {
    expect(nonEmpty('')).toBeUndefined();
    expect(nonEmpty('   ')).toBeUndefined();
  });

  it('returns undefined for a non-string', () => {
    expect(nonEmpty(42)).toBeUndefined();
    expect(nonEmpty(undefined)).toBeUndefined();
  });
});
