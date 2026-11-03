import worker from '../../../apps/worker/src/index.ts';
let isolate;
let invocations = 0;
export default {
  async fetch(request, env, context) {
    isolate ??= crypto.randomUUID();
    const upstream = await worker.fetch(request, env, context);
    const invocation = ++invocations;
    console.log(
      JSON.stringify({
        cpuSample: request.headers.get('X-CPU-Sample'),
        isolate,
        invocation,
        build: env.CPU_BUILD,
        status: upstream.status,
      }),
    );
    // The build stamp lets the gate discard responses from a previous deployment that is still
    // being served while a new one propagates (run 6: a stale isolate rejected the new token).
    // Headers are set in place (no body re-wrap) so the measured path stays the product's own.
    let response = upstream;
    try {
      response.headers.set('X-CPU-Build', String(env.CPU_BUILD));
    } catch {
      response = new Response(upstream.body, upstream);
      response.headers.set('X-CPU-Build', String(env.CPU_BUILD));
    }
    response.headers.set('X-CPU-Invocation', String(invocation));
    return response;
  },
};
