# The AzerothJS terminal design language

One page, one hand. Every terminal surface in the framework - the scaffolder, the
CLI, the dev banner, the log faces - renders in this language. The engine is this
package's `color.ts` (`palette()`, `colorTier()`, `supportsUnicode()`); nothing else
in the framework may define ANSI codes.

## Color roles

| Role | Palette style | Used for |
|---|---|---|
| brand | `brand` (ice-blue #5fb3e8, tier-degraded) | the mark, active selection, command names |
| success | `green` | ok marks, ready lines |
| warning | `yellow` | warn marks |
| danger | `red` | failures, error prefixes |
| emphasis | `bold` | headings, the answer the user chose |
| quiet | `dim` | machinery: step headings, hints, flags, answered prompts |

Plain text is the default; color is seasoning. No gradients, no backgrounds except
the existing `inverseRed` fatal badge, no emoji.

## Glyphs (every one has an ASCII fallback via supportsUnicode)

| Glyph | ASCII | Meaning |
|---|---|---|
| `▲` | `A` | the mark (banner, intro) |
| `◆` | `*` | an active question |
| `◇` | `o` | an answered question / a quiet status |
| `●` | `>` | the selected option |
| `○` | ` ` | an unselected option |
| `│` | `\|` | flow column connecting a multi-step interaction |
| `└` | `+` | flow end / summary verdict |
| `✓` | `ok` | success (existing banner ready line) |
| `x` | `x` | failure (ASCII on purpose - reads in every log) |

## The interaction column

A multi-step flow (the scaffolder) is ONE visual column: intro mark, then each
question hangs off `│`, collapses to a dim `◇ question · answer` line when answered,
and the flow closes with `└`. The column is the connective tissue that makes a flow
read as designed rather than as sequential prints.

## Voice rules for errors

What happened - what was expected - what to do next, in that order, one sentence
each where possible. A USER mistake (usage, bad input) is calm and instructive,
prefixed `x` in red with the tool's name. An ENVIRONMENT failure (missing tool,
broken file) additionally names the exact path/lookup that failed. Never a stack
trace for either.

## The pipe contract (outranks everything above)

Non-TTY or NO_COLOR: no color, no glyph animation, byte-stable plain text. The
interactive primitives refuse to render on a non-TTY (callers guard and take the
args path). `--print`, `info`, and error lines are copy-pasteable always.

## Declined on purpose

- **Spinners in the dev conductor**: prefixed child streams own the terminal within
  moments of startup; a live status line fighting them produces flicker. The
  first-compile gate gets a calm static line instead.
- **azeroth-tsc colorization**: a gate tool whose output is parsed by editors and
  CI; its error lines are a wire format. Not worth a dependency for one summary line.
- **Box-drawing panels**: heavy borders age badly and wrap badly; the column is
  enough structure.
