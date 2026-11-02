// Explicit owner decision, 2026-11-02: parent-card links without a tooltip.
// Hash AND name bound this exception; other parent-only perks remain guarded.
const exoticStats: Record<number, string> = {
  1992361643: 'Anti-Taken Fletching',
  1958555234: 'Balanced Grip',
  3514694513: 'Balanced Tang',
  265542500: 'Chain Bowstring',
  1408087974: 'Combat Sights',
  2931483505: 'Default Ornament',
  3295115440: 'Defensive Grip',
  3794918801: 'Fencing Tang',
  1408087975: 'Marksman Sights',
  2005566727: 'Nucleosynthetic Magazine',
  697983358: 'Offensive Grip',
  3553394349: "Rampager's Handle",
  3492498209: 'Shortened Barrel',
  3377448506: 'Tenacious Handle',
  1127992351: 'Unyielding Handle',
  185041502: 'Volatile Battery',
  332773068: 'Volatile Launch',
};
export function approvedExoticStat(entry: { hash: number; name: string }, category: string) {
  return category === 'catalog:weapon-perk-exotic' && exoticStats[entry.hash] === entry.name;
}

// Only the twelve unresolved audit entries were dropped by this decision;
// preserve existing explicit owner samples/no-equivalent evidence.
const absentArtifacts: Record<number, string> = {
  4217417017: 'Anti-Barrier Hand Cannon',
  4217417018: 'Anti-Barrier Sniper Rifle',
  3619040079: 'Concentrated Forward Firepower',
  3619040074: 'Expert Handling',
  3619040077: 'Fastest Draw',
  3619040075: 'Gravitic-Voltaic Charge',
  4217417019: 'Overload Pulse Rifle',
  4217417020: 'Overload Submachine Gun',
  4217417023: 'Shield-Shattering Rounds',
  4217417022: 'Stunning Fusion',
  4217417021: 'Unstoppable Bow',
  3619040078: 'Vanguard Surplus Discounts',
};
export function approvedAbsentArtifact(entry: { hash: number; name: string }) {
  return absentArtifacts[entry.hash] === entry.name;
}
