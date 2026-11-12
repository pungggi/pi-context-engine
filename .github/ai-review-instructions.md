# Review-Regeln für den AI-Reviewer (Repo: pi-context-engine)

Der Bot liest diese Datei vom PR-Head. Kurze, konkrete Regeln, eine pro Zeile.

## Projekt

- Einzelnes npm-Paket (kein Monorepo): `src/` = Index-Pipeline (`indexer/`), Speicher (`storage/`, SQLite + sqlite-vec), Retrieval (`retrieval/`), Memory (`memory/`), Dashboard, `extension.ts` (pi-Eintritt: Commands + Tool-Registrierung).
- Alles läuft lokal im pi-Prozess: keine Cloud, keine externen API-Aufrufe im Index-/Query-Pfad (Ausnahme: expliziter `/context-warmup`).
- Konsument ist das Tool-Schema (`context_search`, `related_context`, `index_status`) — das steht in README und `extension.ts`, nicht in einem separaten API-Vertrag.
- Tests: `vitest` (`npm test`, ~295 Tests) + `npm run typecheck` (`tsc --noEmit`) müssen grün bleiben; CI läuft auf Node 22, ubuntu UND windows.
- `package-lock.json`, `.pi/`, Generiertes wird nicht gerewtet (automatisch ausgeschlossen).

## Regeln

- Keine Secrets, API-Keys oder Tokens im Code, in Configs oder in Logs.
- Kein `any` in neuem Code ohne kurze Begründung (eslint-Disable ist die Begründung).
- Neue Logik braucht Tests (oder eine Begründung im PR, warum nicht).
- Tool- und Command-Schemas nicht still brechen: neue Parameter sind Additive, bestehende Namen/Typen bleiben.
- SQLite-Schema-Änderungen brauchen einen Migrationspfad (schema version bump) und dürfen alte Indizes nicht unlesbar machen.
- Fehler nicht verschlucken: keine leeren catch-Blöcke; Fehler mit Kontext weiterreichen oder als `result.errors` melden.
- Pfade immer mit `path.join`/`path.normalize` — Windows ist First-Class-Ziel (CI beweist das).
- Keine Netzwerkzugriffe im automatischen Index-/Watcher-Pfad (nur der explizite Warmup-Befehl).
- Config-Defaults rückwärts kompatibel halten: neue Felder brauchen einen Default, der bestehende Nutzer nicht bricht.
- README/`docs/` bei beobachtbarem Verhalten mitziehen (neue Commands, geänderte Grenzwerte).

## Bekannte Kontexte (nicht als Finding melden)

- `.github/workflows/ai-review.yml` ist ein bewusst dünner Stub; Logik + `pr_number`-Vertrag liegen zentral in `pungggi/ai-review`.
- `web-tree-sitter` wird per nativem `createRequire` geladen (jiti- und vitest-parität) inkl. `unwrapParser`-Fallback, Cache-Drop-Retry und Fingerprint-Diagnose — bewusster Hardening-Fix, kein Duplikat.
- `eslint-disable @typescript-eslint/no-explicit-any` bei tree-sitter-Interop ist gesetzt, weil die WASM-Grammatik-API ungetypt ist.
- Manifest-Checkpoints werden während Migration/Store-Reset unterdrückt (Review-Fix PR #21) — Absicht, kein vergessener Save.
- Der automatische Index-Lauf hat eine Dateibudget-Grenze (`indexer.max_auto_files`); manuelle `/context-index` umgeht sie bewusst.
- `realpathSync.native` im Watcher ist Windows-8.3-Hardening (sonst libuv-Absturz) — nicht refactorbar.
- Dashboard ist read-only und nur an 127.0.0.1 gebunden (Host-Header-Guard gegen DNS-Rebinding) — kein fehlendes Auth-Feature.
- `parserInitPromise`/`languageCache` setzen abgelehnte Promises zurück (Self-Heal) — Absicht, kein Race.
- Kein `pi`/`web-tree-sitter`-Version-Bump im PR-Window erwarten: Loader-Kontext-Fixes sind Teil des Stubs-Themas.
