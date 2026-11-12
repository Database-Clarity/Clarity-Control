if (import.meta.env.VITE_MOVED_MODE !== '1' && /^#\/report(?:[/?]|$)/.test(location.hash)) {
  await import('./reportEntry?report-public');
} else {
  await import('./main');
}
export {};
