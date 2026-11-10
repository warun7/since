// since.varunsg.com. Its DNS is at Hostinger, and a Worker can only take a custom domain whose
// DNS is on Cloudflare, but a Pages site can. So this Pages site passes every request,
// UI and API alike, to the `since` Worker (cloud/worker.ts) over a service binding.
// Its own pages.dev addresses redirect to the domain: one address, one cookie, one memory.
const CANONICAL_ORIGIN = 'https://since.varunsg.com';

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.endsWith('.pages.dev')) return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 301);
    return env.SINCE.fetch(request);
  },
};
