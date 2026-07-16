# Phase 8E deterministic baseline

These fixtures pin the Phase 8E simulation at commit
`592cc6f775cfd1dde6a8db7ee2f3ed9a77219ec7` with seed
`0x0A17C010`. They intentionally record simulation outcomes rather than visual
detail, so presentation-only Phase 9 work can be checked without approving
unrelated biological changes.

The browser exports a fixture through the existing deterministic report hook
when `fixtureExport=1` is present. It automatically compares that export with
the saved scenario unless `fixtureCompare=0` is also present.

| Scenario | Query |
| --- | --- |
| normal year | `?fixture=normal&fixtureExport=1&horizon=368` |
| abundance | `?fixture=abundance&fixtureExport=1&demography=abundance&horizon=736` |
| scarcity | `?fixture=scarcity&fixtureExport=1&demography=scarcity&horizon=736` |
| succession | `?fixture=succession&fixtureExport=1&demography=abundance&flight=force&horizon=736&succession=amber` |
| descendant maturity | `?fixture=maturity&fixtureExport=1&demography=abundance&flight=force&horizon=1104&succession=maturity` |
| founding stress | `?fixture=founding-stress&fixtureExport=1&flight=force&founding=stress&horizon=92` |
| young-colony collapse | `?fixture=young-collapse&fixtureExport=1&flight=force&horizon=230&young=collapse` |
| focused mature nest | `?fixture=mature-nest&fixtureExport=1&horizon=368&nest=rival` |
| focused descendant nest | `?fixture=descendant-nest&fixtureExport=1&demography=abundance&flight=force&horizon=184&nest=young` |

The final report contains both `fixture` and `comparison`. A passing
comparison has `ok: true`. A failure lists changed top-level subsystems and
the exact metric paths. Deliberate regeneration is done by adding
`fixtureCompare=0`, copying the exported fixture from the state report, and
reviewing the resulting baseline diff before replacing a saved file.

Every fixture also records founding outcomes, bounded lineage-event counts,
and the selected nest focus. That makes the stress, collapse, maturity, and
focused-nest scenarios sensitive to their intended lifecycle result rather
than passing on population totals alone.
