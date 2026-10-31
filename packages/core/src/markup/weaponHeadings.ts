const legacyNames: Readonly<Record<string, string>> = {
  ar: 'Auto Rifle',
  bow: 'Combat Bow',
  fusion: 'Fusion Rifle',
  gl: 'Grenade Launcher',
  hc: 'Hand Cannon',
  'heavy gl': 'Heavy Grenade Launcher',
  lfr: 'Linear Fusion Rifle',
  lmg: 'Machine Gun',
  pulse: 'Pulse Rifle',
  rocket: 'Rocket Launcher',
  scout: 'Scout Rifle',
  smg: 'Submachine Gun',
  sniper: 'Sniper Rifle',
  trace: 'Trace Rifle',
};

/** Read-only compatibility for retired scoped syntax. No body is selected or discarded.
 * Run after normal import/variable/comment preparation, including inside title bodies.
 * Unknown names are kept verbatim; old abbreviations are expanded for readability.
 */
export function weaponSectionHeadings(text: string): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => {
      const header =
        line.match(/^\s*<weapons(?:\s+(.*?))?\s*>\s*$/i) ??
        line.match(/^\s*<\s*(?:weapon type\s*)?\((.*?)\)\s*>\s*$/);
      if (header) {
        const label = (header[1] || 'Weapons')
          .split(',')
          .map((name) => {
            const clean = name.trim();
            return clean.toLowerCase() === 'other'
              ? 'Other weapons'
              : Object.hasOwn(legacyNames, clean.toLowerCase())
                ? legacyNames[clean.toLowerCase()]
                : clean;
          })
          .join(', ');
        return `<bold ${label} />`;
      }
      if (/^\s*(<\/weapons\s*>|<\$\$>)\s*$/i.test(line)) return '';
      return line;
    })
    .join('\n');
}
