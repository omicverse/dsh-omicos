# OmicOS OSS application completion audit

Status: incomplete; preserve the full application objective.

| Requirement | Current authoritative evidence | Assessment |
| --- | --- | --- |
| Transform the real Harness app, not a separate workbench | Native `dsh-app` renderer, root HTTP frontend of that same Host, own slots and native frame; inspected screenshots | Proven for the running preview |
| OmicOS navigation and visual language | Sage/charcoal tokens, helix brand, main rail, source welcome/menu derivative; desktop and narrow screenshots | Native light/dark screenshots inspected; computed workspace backgrounds are sage `rgb(238,244,241)` and charcoal `rgb(37,40,36)` with no gradient; eight actual native scientific/Store page screenshots inspected, with no panel horizontal overflow and no renderer errors |
| Native session list and central conversation | Original workspace/session owner and conversation renderer; full isolated Harness streaming/approval/MCP smoke; native Scientist selector | Preserved; no second Agent loop |
| Scientific sidebars | Native dock registry and real Session IDs, retained panes and visibility-paused streams; actual scoped memory tab tests | Integrated and exercised |
| Local Python/R and Notebook | Actual Electron confirmed-run writes and fresh Notebook/execution IDs, Python 42 and R mean 4 | Proven; saved receipts remain available |
| Data, figures, memory, pipelines and methods | Existing full component workflows and owner/CSRF tests; main-panel composition; successful native Session requests and concrete controls on all pages | Data→Notebook→memory workflow verified against the existing native Host: approved CSV import, exactly one real Python run returning 42, saved output survives navigation, execution-backed memory becomes effective only after confirmation; published method→hash-pinned gated Pipeline and actual Notebook plot→verified/downloaded PNG→approved Figure version also pass; ResearchPlan approval and execution-backed completion, four-source Dossier capture/review and matching exported digest pass; two-panel assembly fixes approved source revisions, preserves original hashes and exports an SVG with embedded PNG bytes; all nine sequential workflow checks pass; native page screenshots are visually inspected; remaining native foreground input is tracked separately |
| Optional cloud subscription Store | Real main Store surface and account status; existing scoped commerce implementation/tests; no account fixture in user preview | Integrated; real provider/payment acceptance not exercised |
| Preserve tools, approvals and plugins | Native owners retained; source GUI 10,902 passed, 115 focused shortcut cases, nine Web shortcut replays | Positive evidence; initial full Web replay was blocked by missing browser and is not claimed green |
| Guard editor navigation | Pointer/menu/float close flows; actual shared-Host browser keyboard cancel/accept and zero memory proposals | Proven on the browser frontend; native foreground input preflight still reports the window is not focused; user action requested to unlock if necessary and foreground the preview |
| Consistent project context | Main pages resolve the native `mainView` Session through the same authoritative CWD API as sidebars; shared-Host browser confirms the current workspace, manual override and another-page default | Real native workspace picker switches between two distinct Session IDs and different CWDs; main data page and fixed-scope memory sidebar agree, with no renderer errors |
| Runnable user preview | Native window remains alive; Codex browser opens the same native Host root, not the old `/omicos/oss` dashboard | Available; no second scientific process or fake model/account |

Release signing/installers and production billing are not represented as completed
by a development preview. The active goal is not complete until the remaining app
context/visual/workflow checks are resolved and the evidence is reviewed again.
