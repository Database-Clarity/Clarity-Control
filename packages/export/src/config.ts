// `@clarity/export/config`: the strict config schema (zod) and its migrations, for the Worker,
// the site, and build-site. Kept out of the engine bundle (dist/engine.mjs) because of its size.
export * from './v1/config.js';
