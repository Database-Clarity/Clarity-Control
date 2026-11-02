export function countActions(groups) {
  const entries = groups.flatMap((group) => group.entries);
  return {
    excludedParentLinks: entries.filter(
      (e) => e.confidence === 'out-of-scope' && e.action === 'link',
    ).length,
    excludedSunset: entries.filter((entry) => entry.ruleId === 'artifact-sunset').length,
    artifactAbsent: entries.filter((entry) => entry.ruleId === 'artifact-source-absent').length,
    linked: entries.filter((entry) => entry.action === 'link').length,
    highLinks: entries.filter((entry) => entry.confidence === 'high' && entry.action === 'link')
      .length,
    highNoEquivalent: entries.filter(
      (entry) => entry.confidence === 'high' && entry.action === 'no-equivalent',
    ).length,
  };
}
