import type { MarkupGlobals } from './types.js';

/** Outside Bungie's unsigned item-hash space; stable across showcase revisions. */
export const showcaseId = '-1';
export const showcaseName = 'Feature showcase';

/** One standalone document, shared by editor previews and opt-in consumer output. */
export const showcaseText = `var e = 🡅
var stacks = 3
var optional = empty
title Showcase (
This text is the note: apps show it on hover or tap.
)
<bold Bold /> marks key words and <yellow yellow /> marks Exotic names.
<bold/>A bold line is bold from start to end.
<pve 30% /> <pvp [15%] /> pairs a PvE value with its PvP value.
Lasts 11 <pvp [7.5] /> seconds: the bracketed value applies in PvP.
<pve 10|20|30 /> lists one value per stack.
30%<arrow/>33% marks a value that changes.
{{Base perks get this line.}{Enhanced perks get this line instead.}}
Variables and math arrive worked out: #stacks stacks, \${#stacks * 10}%, #{stacks}x.#optional
<title Notes [Showcase] /> carry extra text for a word.
<link Links [https://d2clarity.com] /> open a web page.

export Showcase (
• Bullets start list lines.
• The gap above this list is a spacer line.
)
<kinetic/>Kinetic <arc/>Arc <solar/>Solar <void/>Void <stasis/>Stasis <strand/>Strand <prismatic/>Prismatic
<primary/>Primary <special/>Special <heavy/>Heavy
<barrier/>Barrier <overload/>Overload <unstoppable/>Unstoppable
<hunter/>Hunter <titan/>Titan <warlock/>Warlock
Element text: <kinetic Kinetic />, <arc Jolt />, <solar Scorch />, <void Volatile />, <stasis Slow />, <strand Sever />, <prismatic Transcendence />.
enhanced (
var d = 5
<enhanced/>\${10+#{d}}% is an enhanced value: only Enhanced perks have this line.
)
export hidden Hidden (
A hidden export is shared with other tooltips and never drawn here.
)
// Comments, variables, and exports are for editors: no export contains them.
/* A block comment. */`;

/** No published globals or imported data can change this example. */
export const showcaseGlobals: MarkupGlobals = {
  variables: '',
  titles: '',
  type: 'Weapon Trait Enhanced',
};
