import worker from '../../../apps/worker/src/index.ts';
const isolate = crypto.randomUUID();
let invocations = 0;
export default {
  async fetch(request, env, context) {
    const response = await worker.fetch(request, env, context);
    console.log(
      JSON.stringify({
        cpuSample: request.headers.get('X-CPU-Sample'),
        isolate,
        invocation: ++invocations,
        status: response.status,
      }),
    );
    return response;
  },
};
