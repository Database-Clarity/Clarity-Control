export function countActions(groups) {
  const entries = groups.flatMap((group) => group.entries);
  return {
    linked: entries.filter((entry) => entry.action === 'link').length,
    highLinks: entries.filter((entry) => entry.confidence === 'high' && entry.action === 'link')
      .length,
    highNoEquivalent: entries.filter(
      (entry) => entry.confidence === 'high' && entry.action === 'no-equivalent',
    ).length,
  };
}
