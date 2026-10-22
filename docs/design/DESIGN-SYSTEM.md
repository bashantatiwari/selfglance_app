# SelfGlance design: "soft neo-brutalism"

The look of the SelfGlance dashboard (introduced in commit `13062e2`, 15 Oct 2026). Reference
screenshots: `docs/screenshots/today-light.png` and `today-dark.png`. All values are in
`docs/design/selfglance-theme.css` (self-contained); the original source is
`app/src/dashboard/neo.css`, `design.css` and `dashboard.css`.

## The rules (what makes it this design)

1. **Warm paper, not white.** Page `#f3ebd9` with a faint dot grid, cards `#fffaf0`, sidebar `#ebe1ca`.
   Text is warm charcoal `#221f1b`, never pure black.
2. **Everything that is a box has a 2px charcoal outline** (`--bd`) and a radius of 12px.
3. **Hard offset shadows, never blur**: `3px 3px 0` at rest, `5px 5px 0` when raised. Buttons
   physically press: hover moves them up-left, active moves them down-right.
4. **One yellow highlighter** (`#f4c63d`) marks the one thing that is selected: the active sidebar
   item, the active chip, marks. Nothing else is yellow-filled. This is the signature.
5. **Pastel tiles** (blue, orange, green, yellow, pink) for headline numbers in a 12-column
   "bento" grid. Big bold numbers (38px, weight 800, tabular figures), small uppercase labels
   (11.5px, weight 800, 0.1em letter spacing).
6. **Grouped sidebar** with small uppercase group labels (ANALYSE / PERSONAL / PREFERENCES), a logo
   with the same outline and shadow, a theme toggle and a "now" card at the bottom.
7. **Light and dark are both first-class**; dark follows the OS unless forced with
   `data-theme`. In dark the shadows become pure black and the outline becomes a soft cream.
8. **Color carries meaning**: category colors (working blue, entertainment orange, learning green,
   browsing amber, meetings pink) are the same everywhere. Do not reuse them as decoration.
9. **Type**: Segoe UI Variable (system font, nothing to bundle on Windows), weight 650-800 for
   anything that matters, tabular numbers for all figures. Headings tight (`-0.035em`).
10. **Accessible focus**: one ring (`--ring`) on every focusable thing.

## Using it in another app (e.g. Introcut)

- Copy `selfglance-theme.css`, import it once, and build with the classes in it (`.card`, `.tile`,
  `.tone-*`, `.btn`, `.chip`, `.kind-*`, `nav button.on`, `.bento`, `.page-head`).
- Segoe UI only exists on Windows. For a browser app that must look right on macOS, Linux and
  Android, either accept the system fallback (`system-ui`) or bundle an open font (for example
  Inter, SIL OFL) and record it in the app's `CREDITS.md`.
- Keep the semantic tokens (`--surface`, `--bd`, `--pop`...) instead of hard-coding colors, so
  dark mode keeps working.

## Prompt to give the other project's Claude

> Restyle this app's UI to match the SelfGlance design system ("soft neo-brutalism").
>
> Read, in this order: `D:\SelfGlance\docs\design\DESIGN-SYSTEM.md` (the rules),
> `D:\SelfGlance\docs\design\selfglance-theme.css` (all tokens and base components), and look at
> `D:\SelfGlance\docs\screenshots\today-light.png` and `today-dark.png` (the target).
>
> Do: copy the theme CSS into `src/` and import it once; map our existing screens onto its classes
> (cards, tiles, sidebar, buttons, chips); keep light and dark working through the tokens; use the
> yellow highlighter only for the selected item. Don't: add blur shadows, gradients, pure
> black/white, or a UI library; don't change any behaviour or data.
>
> Follow this repo's `CLAUDE.md`: work in small steps I can run with `npm run dev`, tell me about
> any font or asset license and add it to `CREDITS.md`, and update `STATUS.md` when done. Start
> with the app shell (sidebar + page header + one card) so I can approve the look before you
> restyle everything.
