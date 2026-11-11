// The network a request comes from, for the hosted demo's per-network limits.
//
// An IPv4 address is one network. An IPv6 address is counted by its /64: a single connection is
// normally given a whole /64 and can pick any address in it, so a per-address limit would give
// one person 2^64 allowances.

/** "203.0.113.7" stays as it is; "2001:db8:1:2:aa:bb:cc:dd" becomes "2001:db8:1:2::/64". */
export function networkOf(address: string | null | undefined): string {
  const a = address?.trim().toLowerCase();
  if (!a) return 'unknown';
  if (!a.includes(':')) return a;

  // IPv4 written as IPv6 ("::ffff:203.0.113.7") is that IPv4 address.
  const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1]!;

  const [head = '', tail = '', extra] = a.split('::');
  if (extra !== undefined) return a; // two "::" is not an address; count it as given
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return a;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
