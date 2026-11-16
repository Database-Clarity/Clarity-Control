---
name: clarity-control-design
description: Design approach for the Clarity Control web app (Destiny tooltip editor). Adapts Anthropic's frontend-design skill to a function-first, minimalist, utilitarian, customisable pro-tool UI. Use when designing or reshaping any Clarity Control surface so new work matches the existing dense, token-driven look instead of generic AI defaults.
license: Project-internal; follows .agents/t3/RULES.md and PRODUCT.md.
---

# Clarity Control — Design Approach

This is the design contract for the Clarity Control web app (`apps/web`). It adapts
Anthropic's `frontend-design` skill to this product. Read it before designing or
reshaping any surface. **Density wins; the brief's words win; the owner's product
decisions in `.agents/t3/PRODUCT.md` win.**

Shared elements live in the UI gallery (Management → UI gallery; `apps/web/src/features/gallery/README.md`): use what is there, and add new shared pieces there first.

## 1. What the product is

Clarity Control is a dense, keyboard-driven editor for Destiny 2 tooltip text.
Its users are translators, editors, maintainers, and trial editors who live in the
app for hours. It is a **tool**, not a marketing site. Every surface exists to
move text, markup, and metadata in and out quickly and accurately.

- Audience: expert, repeat users, often on phones in the field.
- Primary job: edit, review, and save tooltip text safely, with live preview.
- Subject matter: Destiny 2 lore/tooltips, markup, globals, compendium links.
- Vernacular: "tooltip", "hash", "variant", "enhanced", "sandbox", "global",
  "compendium", "draft", "base/next", "push live".

If a design choice does not serve that job, cut it.

## 2. Core principles (in priority order)

1. **Function first, form second.** A control earns its place by what it does.
   Decoration that does not encode information is removed.
2. **Minimalist.** Fewer elements, fewer colours, fewer words. Empty space is
   allowed; filler is not.
3. **Utilitarian.** Dense pro-tool feel (VS Code / Linear). Information density
   over breathing room. Every pixel carries data or affordance.
4. **Customisable.** Theme (system/light/dark), UI scale, editor font size and
   family, touch size, pane sizes, and remembered views are user-controlled.
   Nothing assumes a single density or a single theme.

## 3. Ground the design in the subject

Before designing, name: the screen's primary user, its primary job, and the one
thing that must be obvious on first glance. Build with real tooltip data, real
markup, and real long text — not lorem ipsum. A design that only works on short
English strings is not a design for this product.

## 4. Anti-defaults (tells to avoid)

AI-generated and template designs cluster around these. They are **defaults, not
choices** — if you reach for one, justify it in the plan and confirm it serves
this brief. The owner's firm prohibitions in `PRODUCT.md` are hard and separate;
do not treat them as optional.

- Warm cream background + high-contrast serif + terracotta accent.
- Near-black + single acid-green/vermilion accent (our green is **brand**, not
  decoration — see §5).
- Broadsheet hairline rules, zero radius, newspaper columns.
- The SaaS-card kit: identical rounded cards, one radius everywhere, the same
  soft grey shadow under each, gradient washes as decoration.
- Template chrome: tracked ALL-CAPS eyebrow above every heading; meta strings
  joined with middle dots; `WORD — fragment` labels; monospace for small data
  labels; `→` appended to links/buttons.
- Numbered markers (`01 / 02 / 03`) unless the content is genuinely a sequence.
- Accenting a single word in a headline.
- All-caps labels.
- Unnecessary typographic labels above content.
- Fade-and-slide-up entrances on every section; hover transitions on every card.
- Card-in-card, pills, hero headings, filler copy, decorative gradients.

Clarity's own "tells" to watch: green used as decoration rather than brand;
glowing focus rings; oversized rounded corners on dense controls; empty-state
illustrations; marketing-style hero copy on tool screens.

Recalibration note: in a dense editor, tinted near-black, hairlines, uppercase
labels, and monospace metadata are weak signals on their own — some occur
intentionally. Judge their **purpose and consistency**, not their mere presence.
Established conventions need not be re-justified each time; new uses do.

## 5. Token system (reuse, don't reinvent)

The app already has a large semantic token system (`apps/web/src/ui/tokens.scss`,
~150 properties, dark base with light override). **Components use these
properties, never raw colours.** Your job is to *reuse* them, with justified
additions — not to design a new 4–6 colour palette per surface. Scoped token
definitions inside a module (e.g. `TooltipPreview.module.scss`) are legitimate
when they define theme-aware values; component declarations must still consume
tokens.

Anchor values (dark base) for orientation only:

- `--page` `#16181c` — canvas.
- `--chrome` `#1d2024` — app chrome / header.
- `--col` `#191c20` — columns / sidebars.
- `--raised` `#22262c` — raised surfaces.
- `--text` `#e6edf3` — primary text.
- `--accent` `#24ec54` — brand green (sparingly: brand marks, primary actions).
- `--cyan` `#1cdcfc` — secondary brand.

Light theme is "Europa ice" (not monochromatic): page `#d7e1ea`, chrome `#c3d3df`,
text `#0f151b`, same brand green/cyan with light-appropriate ink. Compendium sheet
colours stay dark on both themes.

### Safe colour roles (read this before picking a token)

- `--accent` is the **brand** colour. `--accent-ink` is the focus/ink variant
  used for focus rings and accent text; they differ sharply in light mode. Use
  `--accent-ink` for focus, not `--accent`.
- Links use `--link`, not `--cyan` (they differ in light mode).
- `--stasis` is a **background** token, always paired with `--stasis-text` and
  `--stasis-edge`. Never use `--stasis` alone as text or border.
- Status has dedicated families: `--warn`/`--warn-bg`/`--warn-edge`,
  `--danger`/`--alert-bg`/`--alert-edge`. Use them, not ad-hoc reds/greens.
- Diff: `--del-*` / `--ins-*`. Syntax: `--syn-*`. Game element colours:
  `--el-*` and `--sym-*`. These families are intentional and must not be
  replaced by brand colours.
- Control/field edges (`--ctl-edge`, `--fld-edge`, `--ctl-hover-edge`) must hold
  3:1 against their surface (WCAG 1.4.11). Text ≥ 4.5:1.

Type:

- One or two families, clearly distinct if two. System/variable fonts preferred
  for UI; monospace only for code/markup. Set a clear type scale with intentional
  weights and spacing; line length < 80 chars for body.
- Serif body text gets slightly more line-height than sans.
- The UI stack is Arial/Helvetica with ligatures disabled (`global.scss`); do not
  invite per-surface font selection.
- Type is an active design element when used as headline/visual — but on tool
  screens, type is mostly neutral delivery; let density speak.

Layout:

- Dense, left-aligned by default. **Scope centering to newly authored prose**
  (empty states, single-action confirmations). Do not re-center controls, tab
  labels, or preserved source content (e.g. Compendium alignment, phone tab
  labels) that are intentionally centered or aligned otherwise.
- Justified only for long-form reading (rare here).
- One border-radius scale tied to hierarchy, not one radius on everything.
- Borders/dividers encode structure (grouping, hierarchy), not decoration.
- No card-in-card. A raised surface inside a raised surface is a smell.

Customisation (all independent; changing one must not silently change another):

- Theme: system (default) / light / dark. Never assume dark.
- UI scale: **85–150% in 5% steps**, applied viewport-dependently. 100% and
  150% are QA points, not the only values. Automatic editor text size follows
  UI scale; an explicit editor font size is independent.
- Touch size: compact targets are ~36 px primary / ~28 px secondary at 100%,
  scaling with UI scale; Large mode restores a 44 px floor. Secondary controls
  may be smaller (status-bar items, version tabs, markup-help rows).
- Editor font size: per-device setting, default = today's effective size.
- Additional axes to honour where present: editor font family, pane
  resizing/collapse, Compendium cell zoom, sheet colours, remembered raw/rendered
  views. State account vs. device scope in the design.
- All of the above are independent. A change to one must not silently change
  another.

## 6. Typography rules

- Default to line lengths < 80 characters.
- Avoid: single-word accent in headlines; all-caps labels; unnecessary labels
  above content.
- Use active voice in UI copy: "Save changes", not "Submit". A button's verb
  matches its toast's past tense ("Publish" → "Published").
- Sentence case, no filler. One job per written element.

## 7. Motion

Shared primitives govern motion: `controls.scss` for dimensions/states/focus
containment, `Skeleton.module.scss` for reduced-motion-aware skeletons. Rules:

- Non-user-triggered motion needs functional justification. A single orchestrated
  moment (one page-load reveal) is the maximum; scattered fade-and-slide
  entrances are the generic default.
- Motion that answers an action (open, expand, confirm, save) is welcome when it
  shows what changed.
- Popovers stay trigger-adjacent. Editor text never shifts except from newly
  added text.
- Respect `prefers-reduced-motion`.

## 8. Writing (copy)

Words are design content, not decoration. Same intentionality as spacing/color.

- Name things by what users understand: "notifications", not "webhook config".
- Describe what something is/does in plain terms; never sell.
- Active voice default; consistent vocabulary across the whole flow.
- Errors explain what happened and how to fix it, in the interface's voice; never
  vague, never apologising.
- Empty screens are invitations to act.
- Tone: conversational, plain verbs, sentence case, no filler, matched to
  audience (expert users, no hand-holding, but never cryptic).

## 9. Accessibility and state floor (build to it, don't announce it)

Visible focus alone is insufficient. Require:

- Keyboard operation of every interactive element; accessible names; correct
  selected/expanded/disabled semantics; overlay dismissal and focus return.
- Non-colour status cues alongside colour; accessible error and loading feedback.
- Responsive down to mobile (390 px), including keyboard-open layouts and long
  localized strings.
- AA contrast: text ≥ 4.5:1, UI boundaries ≥ 3:1.
- Tap targets per §5 (compact ~36/~28 px scaling, 44 px Large floor).
- No horizontal overflow at 390/768/1280.

State coverage (sweep all that apply): loading, empty, error/retry, pending,
unsaved, conflict, read-only, permission-restricted, and signed-out.

## 10. Process: plan → review → build → critique

Work in two passes.

**Pass 1 — plan.** Write a compact token system before code:

- Color: reuse existing semantic tokens; list any additions with justification.
- Type: families and roles.
- Layout: one-sentence prose concept + ASCII wireframe; alignment guidance.
- Principles: what makes this surface unique.

**Review the plan against the brief.** If any part reads like the generic default
you'd produce for any similar page, revise it and say what changed and why. Only
when the plan is specific to this brief do you build.

**Pass 2 — build.** Mind CSS cascade: overlapping declarations resolve through
specificity and source order, not by "cancelling out" — check the cascade when
padding/margin between sections behaves unexpectedly.

**Critique.** Distinctiveness is optional and task-driven: add a memorable
element only when it serves the task; otherwise keep everything quiet and
disciplined. Cut any decoration that doesn't serve the brief. Chanel rule: before
shipping, remove one accessory. Take screenshots if your environment supports it
— a picture is worth 1000 tokens. Note what you tried so future passes don't
repeat.

## 11. Verification (required, not optional)

Render QA is mandatory: 390 / 768 / 1280, both themes, zero horizontal overflow,
no clipped text, no wrapping inside controls. Phone layout is judged at 100%,
checked at 120%, and checked for breakage at 150%. Also verify aligned control
heights/baselines and sensible space allocation; absence of overflow alone is
insufficient. Screenshots are required evidence where the environment supports
them.

## 12. Restraint checklist (before you ship)

- [ ] Decoration only where it encodes information.
- [ ] No card-in-card, no pills, no hero headings, no filler.
- [ ] Tokens only, no raw colours (except scoped token definitions).
- [ ] Correct colour roles (`--accent-ink` for focus, `--link` for links, etc.).
- [ ] Works in light AND dark.
- [ ] Works across UI scale 85–150%.
- [ ] Editor font size independent.
- [ ] Keyboard focus visible; full keyboard operability.
- [ ] Reduced motion respected.
- [ ] Render QA per §11.
- [ ] Real data, real long text, real markup.
- [ ] All relevant states covered (§9).

## 13. When NOT to use this skill

- Marketing/landing pages for the product (none today; if added, they may need a
  different, more expressive treatment — decide explicitly).
- Email/print exports.
- Anything where the owner has pinned a specific visual direction in
  `PRODUCT.md` — follow that exactly, even if it conflicts with this guide.
