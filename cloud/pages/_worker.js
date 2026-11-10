// since.varunsg.com. Its DNS is at Hostinger, and a Worker can only take a custom domain whose
// DNS is on Cloudflare, but a Pages site can. So this Pages site passes every request,
// UI and API alike, to the `since` Worker (cloud/worker.ts) over a service binding.
export default {
  fetch(request, env) {
    return env.SINCE.fetch(request);
  },
};
