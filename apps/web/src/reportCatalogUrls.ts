// The Vite plugin replaces these development URLs with content-hashed build assets.
export default Array.from({ length: 65 }, (_, i) => `/report-catalog/${i}.json`);
