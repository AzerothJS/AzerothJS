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
| `✓` | `+` | success (banner ready line, compile-clean, verdict moments) |
| `✖` | `x` | stream failure (crashed child, compile errors) |
| `↻` | `~` | a restart in a watch stream |
| `▸` | `>` | a step heading (check/build) |
| `x` | `x` | failure prefix in error VOICE lines (ASCII on purpose - reads in every log) |

Unicode detection doctrine: on Windows, every console a supported Node can run in
(Win10+ conhost, Windows Terminal, VS Code, JetBrains, ConEmu) renders this set with
its default fonts - `supportsUnicode()` is true there without env markers. Elsewhere
only `TERM=linux` consoles fall back to ASCII.

## The pretty face's calm rules

- `info` is the ambient level: its icon and color carry it, the word stays home.
  Every other level keeps its word - warn/error lines SHOULD read louder than the
  stream around them, and the misalignment against info lines is that emphasis.
- The clock is seconds-only and dim (user-ratified reversal of the earlier keep-ms
  call): it answers "when", and sub-second precision lives in measured fields like
  durationMs. The full epoch stays in every record for NDJSON faces and files.
- The message is BOLD - the event name is what the line is about, which is exactly
  what bold is reserved for.
- A request-shaped record (string method/path + numeric status/durationMs) renders
  as a SENTENCE: `GET /healthz → 200 · 0.48ms` - the field order is the grammar, so
  the scaffolding keys and the redundant message word retire from display. Extra
  fields trail as ordinary pairs; an incomplete shape falls back to pairs entirely.
- `url=` before an http(s) value is a tautology - the value names itself, only that
  key drops; `docs=` keeps its key because it says WHICH url. Display only: files
  and NDJSON always carry every key.
- A field bound on every line (`service` in a single-service dev terminal) is noise
  to a human and signal to a collector: `prettySink({ hide: [...] })` drops it from
  the human face only; NDJSON faces and files always keep every field.
- Field pairs hang off a dim interpunct (` · `) - the house separator the doctor
  verdict line established. It marks the message/fields boundary and each pair's
  start without adding ink the eye must read. ASCII terminals keep the double space.

## Semantic values (pretty face only; bytes never altered)

| Fact | Style | Why |
|---|---|---|
| `url` key, or any `http(s)://` string value | brand | a destination - the same fact the ready frame paints brand |
| `status` key with an integer 100-599 | 2xx `green` · 3xx `cyan` · 4xx `yellow` · 5xx `red` | a status code is a verdict |
| warn message | `yellow` | the message IS the alarm |
| error / fatal message | `red` | same, louder |
| everything else | plain | restraint keeps the styled facts readable |

Declined on purpose: durationMs thresholds (an opinion the framework should not
hold), `method` bold (no information gained), type-based number/boolean tints
(rainbow soup), requestId truncation (alters bytes - that is what `hide` is for).

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
