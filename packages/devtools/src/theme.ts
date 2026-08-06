// The panel's design system: one class-based stylesheet injected into the shadow root, plus the
// kind/primitive color maps the views share. The shadow boundary already isolates the panel from
// host CSS; classes (instead of per-element inline styles) keep every surface consistent and make
// a restyle a one-file change. Palette: near-black blue surfaces with the brand ice-blue accent.

/** Node-kind accent colors (the reactive substrate). */
export const KIND_COLOR: Record<string, string> = {
    signal: '#5fb3e8',
    memo: '#b48ef0',
    effect: '#e2b95a',
    root: '#6b7f93'
};

/** Higher-level primitive accent colors (what the user declared). */
export const PRIMITIVE_COLOR: Record<string, string> = {
    store: '#4fd0a5',
    resource: '#e07a9b',
    stream: '#56c4d8',
    selector: '#a3c25f',
    deferred: '#90a8e8',
    form: '#e09a68'
};

/** Timeline event-type colors. */
export const EVENT_COLOR: Record<string, string> = {
    write: '#e2b95a',
    run: '#58c98b',
    created: '#5fb3e8',
    disposed: '#6b7f93'
};

/**
 * The brand mark (the 32px A-dragon tile) as a data URI - the package ships no
 * asset files and the panel makes no network requests, so the logo travels as a
 * string. Rendered at 16-18px, where the 32px raster stays crisp on 2x displays.
 */
export const MARK_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAARNSURBVFhHxVdraBxVFL67SfYxM/uYmc0maZqdnWylpNW26UabdomkPhr1h4igWKUVY4xJJEZsqX0oWhAV0YJGEIJFilD6Qyj+EEQKUhpa88DalFZro0hsbBObbF6bTZNNPrlnm0BnN+lu0m0ufFwYzj3nO+d+9945jCUZgkcrFWT/K4KiHxAU/7tLh35Akv21gse30RjrlmGTtc2Sov8kqjokNQDJE4jPS8VNP9yvqOgnJdkXMsZmoqxtFxU9JqnFEBV/xkD+VX1acPt2zAW3q/r9oqLPxBkmLrrjoArrsCtaeTx7xX8605kbQfFkrZ0JLm3DXcvcAF4FJrm1ehJIEoNMg8dl/JikS4AzzxYLwJgLzOSKzxYPfTfaLgQiYJe199IlYBHysXpdCHVNe1Fdvxt1Tfvw8BPPIsuen2C7EBZdAWZy48ix78BHdIYmdP/TD09hCXKkFQn282FRBMxWL9YGK9E3FEHf0Dj+HRglcB71b+wHYw6IauK6ZFgUAcac+PizFtwA0Ht9BEPRGCIx4K/efrR2nofg9sHmKkpYlwxpE+DCKwxsQPeVfgxPzGACQOf5S9j5ciP2vPMhpgE8vb2Gtsi4NhnSI6Dy7B3Ytf99KvefV/pR07AborMA/tVBtJ/7HSPRSXx/ohVmay7sspboYykELM6VcHqK0XXpbxId3+9VazbB4dEhuIrw0OPP4EJ3D8LRGCoeeQosW03wYURaBPjev1S3C4MjEdQ27gXLksEsuWBZCqzOlXDIGmob30IMwNdHj6e0DSkTsLl9yBEL8PPZi2jt6AJjDGWhx3CouQXPvdgAi7QCZksu1pdtxZGj3yI8FkVJaQXMNm+Cr0URYGYZVU8+T2rvH47ik+avcLmnj7ZiMDJFl5IpxwO3dxXOnL1I3z849GX8SCbxlxYBQdbAshUcO/4DEeBnfmwK+G9kgk7CtXAEgZJNlC23PdV+DuPTwOWeayjwr0OOOP/FlBIBk8WD4JYqDIxNULCrg2OU9fDENJ39HTVNVH473yZHIX482UbEJgE07TlIVZjvjUiJABdfc8s3dOZ59iM3pvHam2/jgVAVCovXU3W4Hb98eKC2X39DeDyG8PgUOrr+gEPVSaRGvykRyBLyEVhbjt7rwxgYm8To5AzO/HKBBMlVbrz3+cn49IvDlD2vFp9fqG6kF9PoOyUCPMjBjz7H1E2HvAqvvr6PqpLsvufvxH1lW3F1cJQ0wjVz4lQH7M4i2iKj/W0J8EX3BitJA6Xlj2Lj5m1w5gaSOpuF1VmENaUPIrhlG60pC1XBnXcPCdRoSwQW/B+Y/fGwemGyeWnmwecT1SzM9ry5NWZbXtLgHLetQKZBBCS31rCsBHi7tKx/xYwxkyhrbcvTF/g7452RopWTsO5aJXhnVIxbekRB8e+UVH0m05WgwGoxBEWrngs+OyS3XiEq/lZeDS6QO9ode+a649OiS6ucjfk/ceCe0xVL2SsAAAAASUVORK5CYII=';

/** Builds the one stylesheet the shadow root carries. */
export function buildStyle(): HTMLStyleElement
{
    const style = document.createElement('style');
    style.textContent = CSS;
    return style;
}

const CSS = `
/*
 * \`direction\` is set explicitly because \`all\` does NOT cover it: the CSS spec excludes
 * direction and unicode-bidi from the \`all\` shorthand, so the panel would otherwise
 * inherit an RTL page and mirror itself - header, rows, filter, badges. This is a
 * developer tool whose labels are English and whose values are code, so it reads
 * left-to-right whatever the application it is inspecting does.
 */
:host { all: initial; direction: ltr; unicode-bidi: isolate }
* { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: #2a3a4d transparent }
::-webkit-scrollbar { width: 9px; height: 9px }
::-webkit-scrollbar-thumb { background: #2a3a4d; border-radius: 6px; border: 2px solid transparent; background-clip: padding-box }
::-webkit-scrollbar-thumb:hover { background: #3a4f68; background-clip: padding-box }
::-webkit-scrollbar-track { background: transparent }

.az-root {
    position: fixed; z-index: 2147483646;
    color: #d5e1ec; color-scheme: dark;
    font: 12px/1.45 "Segoe UI", system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
    --bg0: #090d12; --bg1: #0e141b; --bg2: #141c25; --bg3: #1a2431;
    --sel: #16283a; --line: #1e2a38; --line2: #2a3a4d;
    --text: #d5e1ec; --mut: #8aa0b5; --faint: #5a7089;
    --accent: #5fb3e8; --val: #e8c88f;
    --ok: #58c98b; --warn: #e2b95a; --err: #e06b6b;
}
.az-mono { font-family: ui-monospace, Consolas, monospace; font-size: 11px }

/* ---- launcher ---- */
.az-launcher {
    display: flex; align-items: center; gap: 6px;
    background: var(--bg1); color: var(--accent);
    border: 1px solid var(--line2); border-radius: 999px;
    padding: 5px 11px; cursor: grab; user-select: none; font: inherit; font-weight: 600;
    letter-spacing: 0.5px; box-shadow: 0 2px 10px rgba(0,0,0,0.5);
}
.az-launcher .az-launcher-mark { width: 18px; height: 18px; border-radius: 5px; display: block }
.az-launcher:hover { border-color: var(--accent) }
.az-badge {
    background: var(--sel); color: var(--text); border-radius: 999px;
    padding: 0 7px; min-width: 16px; text-align: center; font-weight: 600;
}

/* ---- panel chrome ---- */
.az-panel {
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg1); color: var(--text);
    border: 1px solid var(--line2); border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.55);
}
.az-header {
    display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    background: var(--bg2); border-bottom: 1px solid var(--line);
    user-select: none; flex: none;
}
.az-brand { color: var(--accent); font-weight: 700; letter-spacing: 0.4px; flex: none }
.az-brand .az-mark { width: 16px; height: 16px; border-radius: 4px; margin-right: 6px; vertical-align: -3px }
.az-summary {
    color: var(--mut); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 11px;
}
.az-iconbtn {
    background: transparent; color: var(--mut); border: 1px solid transparent; border-radius: 5px;
    width: 22px; height: 20px; cursor: pointer; font: inherit; line-height: 1; flex: none; padding: 0;
}
.az-iconbtn:hover { background: var(--bg3); color: var(--text) }

/* ---- toolbar (search) ---- */
.az-toolbar { display: flex; gap: 6px; padding: 7px 8px; border-bottom: 1px solid var(--line); flex: none; align-items: center }
.az-search {
    flex: 1; min-width: 0; background: var(--bg0); color: var(--text);
    border: 1px solid var(--line); border-radius: 6px; padding: 4px 9px; font: inherit; outline: none;
}
.az-search:focus { border-color: var(--accent) }
.az-search::placeholder { color: var(--faint) }
.az-kbd {
    color: var(--faint); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px;
    font-size: 10px; flex: none; user-select: none;
}

/* ---- layout: rail | main | side ---- */
.az-body { display: flex; flex: 1; min-height: 0 }
.az-rail {
    display: flex; flex-direction: column; gap: 2px; padding: 6px 4px;
    background: var(--bg2); border-right: 1px solid var(--line); flex: none; width: 40px; align-items: center;
}
.az-railbtn {
    display: flex; align-items: center; justify-content: center;
    width: 30px; height: 28px; border-radius: 6px; border: 0; background: transparent;
    color: var(--faint); cursor: pointer; padding: 0;
}
.az-railbtn:hover { background: var(--bg3); color: var(--mut) }
.az-railbtn.on { background: var(--sel); color: var(--accent) }
.az-railbtn svg { width: 15px; height: 15px; display: block }
.az-rail-gap { flex: 1 }
.az-main { flex: 1; min-width: 0; overflow: auto; position: relative; background: var(--bg1) }
.az-side {
    flex: none; overflow: auto; background: var(--bg0);
    border-left: 1px solid var(--line);
}
.az-side.bottom { border-left: 0; border-top: 2px solid var(--line2) }

/* ---- rows ---- */
.az-row {
    display: flex; gap: 7px; align-items: center; padding: 0 8px; height: 22px;
    cursor: pointer; white-space: nowrap;
}
.az-row:hover { background: var(--bg3) }
.az-row.sel { background: var(--sel); box-shadow: inset 2px 0 0 var(--accent) }
.az-kind {
    flex: none; width: 48px; text-align: center; border-radius: 4px; font-size: 10px; font-weight: 600;
    line-height: 15px; color: var(--bg0);
}
.az-kind.dim { background: transparent !important; border: 1px solid var(--line2); color: var(--mut); font-weight: 500 }
.az-name { color: var(--text); overflow: hidden; text-overflow: ellipsis; flex: none; max-width: 45% }
.az-val { color: var(--val); overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0 }
.az-count { flex: none; color: var(--faint); font-size: 10px }
.az-filehead {
    display: flex; align-items: center; gap: 7px; height: 22px; padding: 0 8px; margin-top: 2px;
    color: var(--accent); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-top: 1px solid var(--line); cursor: default; user-select: none;
}
.az-filehead .meta { color: var(--faint); font-weight: 400; font-size: 10px }
.az-grouphead {
    display: flex; align-items: center; gap: 7px; height: 22px; padding: 0 8px 0 16px;
    cursor: pointer; white-space: nowrap; user-select: none;
}
.az-grouphead:hover { background: var(--bg3) }
.az-grouphead.sel { background: var(--sel) }
.az-caret { flex: none; color: var(--faint); width: 8px; font-size: 9px }
.az-prim {
    flex: none; border-radius: 4px; font-size: 10px; font-weight: 700; padding: 0 6px; line-height: 15px;
    color: var(--bg0);
}
.az-groupname { color: var(--text); font-weight: 600 }
.az-groupmeta { color: var(--faint); font-size: 10px; overflow: hidden; text-overflow: ellipsis }
.az-status { flex: none; border-radius: 999px; font-size: 10px; padding: 0 7px; line-height: 15px; font-weight: 600 }
.az-status.ok { background: rgba(88,201,139,0.15); color: var(--ok) }
.az-status.warn { background: rgba(226,185,90,0.15); color: var(--warn) }
.az-status.err { background: rgba(224,107,107,0.15); color: var(--err) }
.az-member { padding-left: 26px }

/* ---- timeline ---- */
.az-ev { display: flex; gap: 7px; align-items: center; padding: 0 8px; height: 22px; cursor: pointer; white-space: nowrap }
.az-ev:hover { background: var(--bg3) }
.az-ev.sel { background: var(--sel) }
.az-ev.faded { opacity: 0.55 }
.az-evtag {
    flex: none; width: 52px; text-align: center; border-radius: 4px; font-size: 10px; font-weight: 700;
    line-height: 15px; color: var(--bg0);
}
.az-cause { color: var(--warn); flex: none; font-size: 11px; cursor: pointer }
.az-cause:hover { text-decoration: underline }
.az-time { color: var(--faint); flex: none; font-size: 10px; width: 44px; text-align: right }
.az-bursthead {
    display: flex; gap: 7px; align-items: center; height: 22px; padding: 0 8px; cursor: pointer;
    color: var(--mut); user-select: none; white-space: nowrap;
}
.az-bursthead:hover { background: var(--bg3) }

/* ---- perf ---- */
.az-bar { position: relative; flex: 1; min-width: 0; height: 6px; background: var(--bg0); border-radius: 3px; overflow: hidden }
.az-bar > i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); border-radius: 3px }

/* ---- inspector ---- */
.az-insp { padding: 10px }
.az-insp-title { display: flex; align-items: center; gap: 8px; margin-bottom: 8px }
.az-insp-name { color: var(--text); font-weight: 700; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.az-field { display: flex; gap: 8px; margin: 3px 0; align-items: baseline }
.az-fieldlbl { width: 58px; flex: none; color: var(--faint); font-size: 11px }
.az-fieldval { flex: 1; min-width: 0; color: var(--mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.az-fieldval.value { color: var(--val) }
.az-link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; cursor: pointer; font: inherit; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.az-chips { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; min-width: 0 }
.az-chip {
    background: var(--bg2); border: 1px solid var(--line2); border-radius: 4px; padding: 0 7px;
    cursor: pointer; font: inherit; font-size: 11px; line-height: 17px;
}
.az-chip:hover { border-color: var(--accent) }
.az-editrow { display: flex; gap: 6px; flex: 1; min-width: 0 }
.az-input {
    flex: 1; min-width: 0; background: var(--bg1); color: var(--val); border: 1px solid var(--line2);
    border-radius: 5px; padding: 2px 7px; font: inherit; outline: none;
}
.az-input:focus { border-color: var(--accent) }

/* ---- shared bits ---- */
.az-btn {
    background: var(--bg2); color: var(--text); border: 1px solid var(--line2); border-radius: 5px;
    padding: 3px 10px; cursor: pointer; font: inherit;
}
.az-btn:hover { border-color: var(--accent) }
.az-btn.on { background: var(--sel); border-color: var(--accent); color: var(--accent) }
.az-legend { color: var(--faint); font-size: 11px; padding: 6px 8px 4px }
.az-banner {
    display: flex; gap: 8px; align-items: center; margin: 6px 8px; padding: 5px 9px;
    background: var(--sel); color: var(--accent); border: 1px solid var(--line2); border-radius: 6px;
}
.az-warnbox {
    margin: 6px 8px; padding: 5px 9px; border-radius: 6px;
    background: rgba(224,107,107,0.1); color: var(--err); border: 1px solid rgba(224,107,107,0.35);
}
.az-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 34px 20px; text-align: center }
.az-empty-title { color: var(--mut); font-weight: 600 }
.az-empty-hint { color: var(--faint); font-size: 11px; max-width: 300px }
.az-section { color: var(--mut); font-weight: 600; padding: 8px 8px 3px; border-top: 1px solid var(--line); margin-top: 6px }
.az-hint { color: var(--faint); font-size: 11px; padding: 4px 8px }
.az-spacer { flex: 1 }
.az-resize { position: absolute; background: transparent; z-index: 1 }
`;
