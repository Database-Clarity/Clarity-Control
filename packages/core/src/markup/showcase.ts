import type { MarkupGlobals } from './types.js';

/** Outside Bungie's unsigned item-hash space; stable across showcase revisions. */
export const showcaseId = '-1';
export const showcaseName = 'Feature showcase';

/** One standalone document, shared by editor previews and opt-in consumer output. */
export const showcaseText = `var e = 🡅
var amount = 10
var optional = empty
title Showcase (
A title adds a definition on hover.
)
<bold Bold text /> can cover part of a line.
<bold/>This whole line is bold.
<yellow Exotic names use yellow text. />
<pve This text is PvE-only. />
<pvp [This text is PvP-only.] />
PvE and PvP values can share a line: <pve 10 /> <pvp [5] />
10 <pvp [5] /> is a value with a PvP override.
Values per Stack: <pve 10|20|30 />. Pipes separate each Stack's value.
{{Base perks use this text.}{Enhanced perks replace the base text with this line.}}
A variable supplies #amount; math doubles it to \${#amount * 2}.
Braces end a variable's name, so letters can follow it: #{amount}px.
An empty variable writes nothing here: #optional
<title Hover for a definition [Showcase] />
<link This text opens a web link [https://d2clarity.com] />

• A bullet starts each list line.
• The blank line above this list adds a gap.
<kinetic/>Kinetic damage icon.
<arc/>Arc damage icon.
<solar/>Solar damage icon.
<void/>Void damage icon.
<stasis/>Stasis damage icon.
<strand/>Strand damage icon.
<prismatic/>Prismatic subclass icon.
<primary/>Primary ammo icon.
<special/>Special ammo icon.
<heavy/>Heavy ammo icon.
<barrier/>Barrier champion icon.
<overload/>Overload champion icon.
<unstoppable/>Unstoppable champion icon.
<hunter/>Hunter class icon.
<titan/>Titan class icon.
<warlock/>Warlock class icon.
<kinetic Kinetic-tagged text is tinted in the editor. />
<arc Arc-tagged text is tinted in the editor. />
<solar Solar-tagged text is tinted in the editor. />
<void Void-tagged text is tinted in the editor. />
<stasis Stasis-tagged text is tinted in the editor. />
<strand Strand-tagged text is tinted in the editor. />
Exports apply the symbol settings without the text tint.
enhanced (
var d = 5
Only enhanced perks show this section.
<enhanced/>\${10+#{d}} is the enhanced value: base 10 plus 5.
)
export Showcase (
An export shares this text with other tooltips.
)
export hidden Hidden (
This hidden export is shared without being drawn here.
)
// Comments are notes that do not render.
/* Block comments do not render either. */`;

/** No published globals or imported data can change this example. */
export const showcaseGlobals: MarkupGlobals = {
  variables: '',
  titles: '',
  type: 'Weapon Trait Enhanced',
};
