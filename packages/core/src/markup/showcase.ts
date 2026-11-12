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
<bold Formatting options />
<bold/>This whole line is bold.
<yellow Exotic names use yellow text. />
<pve This text is PvE-only. />
<pvp [This text is PvP-only.] />
<pve PvE: 10 /> <pvp [PvP: 5] />
10 <pvp [5] /> is a value with a PvP override.
Values per Stack: <pve 10|20|30 />. Pipes separate each Stack's value.
{{This is the base text.}{This is the enhanced text.}}
A variable supplies #amount; math doubles it to \${#amount * 2}.
An empty variable writes nothing here: #optional
<title Hover for a definition [Showcase] />
<link This text opens a web link [https://d2clarity.com] />

• A bullet starts a list.
• A blank line above adds a gap.
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
<kinetic Kinetic-tagged text tints the whole phrase. />
<arc Arc-tagged text tints the whole phrase. />
<solar Solar-tagged text tints the whole phrase. />
<void Void-tagged text tints the whole phrase. />
<stasis Stasis-tagged text tints the whole phrase. />
<strand Strand-tagged text tints the whole phrase. />
enhanced (
var d = 5
#e This arrow marks an enhanced effect.
An enhanced formula adds a bonus: #e\${10+#d}.
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
