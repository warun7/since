import { describe, expect, it } from 'vitest';
import { networkOf } from '../src/network.js';

describe('networkOf', () => {
  it('keeps an IPv4 address as its own network', () => {
    expect(networkOf('203.0.113.7')).toBe('203.0.113.7');
    expect(networkOf('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts every address in an IPv6 /64 as one network', () => {
    const a = networkOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(networkOf('2001:0DB8:0001:0002::1')).toBe(a);
    expect(networkOf('2001:db8:1:2:ffff:ffff:ffff:fffe')).toBe(a);
    expect(networkOf('2001:db8:1:3::1')).not.toBe(a);
  });

  it('expands "::" wherever it is', () => {
    expect(networkOf('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(networkOf('::1')).toBe('0:0:0:0::/64');
  });

  it('falls back to one shared bucket when there is no address, and leaves malformed input as given', () => {
    expect(networkOf(null)).toBe('unknown');
    expect(networkOf('')).toBe('unknown');
    expect(networkOf('1::2::3')).toBe('1::2::3');
  });
});
