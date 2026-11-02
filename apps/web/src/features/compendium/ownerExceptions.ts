import decisions from './owner-exceptions.json';
const exoticStats: Record<number, string> = decisions.exoticStats;
const absentArtifacts: Record<number, string> = decisions.absentArtifacts;
export function approvedExoticStat(entry: { hash: number; name: string }, category: string) {
  return category === 'catalog:weapon-perk-exotic' && exoticStats[entry.hash] === entry.name;
}
export function approvedAbsentArtifact(entry: { hash: number; name: string }) {
  return absentArtifacts[entry.hash] === entry.name;
}
