/**
 * MODULE: api/explorer - the house API explorer
 *
 * A fully SELF-CONTAINED documentation page: one HTML string, inline CSS and JS, zero
 * external requests - it works offline, inside locked-down networks, and forever
 * (nothing to rot on a CDN). It fetches the sibling OpenAPI document at runtime and
 * renders it in the AzerothJS design language - the terminal canon translated to a
 * page: method verbs in their REST colors, status codes as verdicts, quiet grays,
 * the ice-blue brand on interactive facts, the mark in the corner.
 *
 * Discipline: spec strings (summaries, descriptions, names) are rendered exclusively
 * through textContent - never interpolated into markup - so a hostile string in a
 * contract cannot script the page. The try-it panel issues same-origin fetches with
 * an optional bearer token the user pastes; nothing is stored.
 */

/** @internal Escapes the few SERVER-side interpolations (title, spec URL). */
function escapeHtml(text: string): string
{
    return text.replace(/[&<>"']/g, (ch) =>
        (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'));
}

/**
 * Renders the Scalar shell page: ~10 lines of our HTML, the viewer itself loaded from
 * the CDN by the BROWSER (the framework still ships zero dependencies and the shell
 * never rots - Scalar updates independently). The trade, stated plainly: viewing
 * needs internet, and the viewer is third-party code your browser runs. For offline
 * or locked-down environments, the house explorer below is the zero-external option.
 */
export function renderScalarHtml(specUrl: string, title: string): string
{
    const safeTitle = escapeHtml(title);
    const safeSpecUrl = escapeHtml(specUrl);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ safeTitle }</title>
</head>
<body>
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script>
<script>
Scalar.createApiReference('#app', { url: '${ safeSpecUrl }', hideClientButton: true });
</script>
</body>
</html>
`;
}

/**
 * Renders the house explorer page for a spec served at `specUrl`. Pure string in,
 * string out - the plugin caches the result once.
 */
export function renderExplorerHtml(specUrl: string, title: string): string
{
    const safeTitle = escapeHtml(title);
    const safeSpecUrl = escapeHtml(specUrl);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ safeTitle }</title>
<style>
:root {
    --bg: #0b1220; --panel: #101a2c; --line: #1d2a41; --text: #e6edf3; --dim: #8a949e;
    --brand: #5fb3e8; --green: #3fb950; --yellow: #d29922; --red: #f85149; --cyan: #39c5cf;
    --mono: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, 'Segoe UI', sans-serif; }
a { color: var(--brand); text-decoration: none; }
.frame { display: grid; grid-template-columns: 300px 1fr; min-height: 100vh; }
.side { border-right: 1px solid var(--line); padding: 20px 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.head { display: flex; align-items: baseline; gap: 8px; padding: 0 20px 14px; }
.mark { color: var(--brand); font-size: 18px; }
.head b { font-size: 16px; }
.head .v { color: var(--dim); font-size: 12px; }
.search { margin: 0 20px 14px; }
.search input { width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
    color: var(--text); padding: 7px 10px; font: inherit; font-size: 13px; outline: none; }
.search input:focus { border-color: var(--brand); }
.tag { color: var(--dim); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; padding: 12px 20px 4px; }
.op-link { display: flex; gap: 8px; align-items: center; padding: 5px 20px; cursor: pointer; border-left: 2px solid transparent; }
.op-link:hover { background: var(--panel); }
.op-link.active { border-left-color: var(--brand); background: var(--panel); }
.op-link .path { font-family: var(--mono); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.method { font-family: var(--mono); font-size: 10.5px; font-weight: 700; width: 44px; text-align: right; flex: none; }
.m-get, .m-head { color: var(--cyan); } .m-post { color: var(--green); }
.m-put, .m-patch { color: var(--yellow); } .m-delete { color: var(--red); }
.main { padding: 28px 40px 80px; max-width: 980px; }
.crumb { color: var(--dim); font-size: 12px; margin-bottom: 4px; }
h1.op-title { font-size: 21px; margin-bottom: 2px; }
.deprecated { color: var(--yellow); font-size: 12px; border: 1px solid var(--yellow); border-radius: 4px; padding: 1px 7px; margin-left: 8px; vertical-align: 3px; }
.endpoint { display: flex; gap: 10px; align-items: center; font-family: var(--mono); font-size: 14px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin: 14px 0; }
.endpoint .param { color: var(--brand); }
.desc { color: var(--dim); margin: 10px 0 0; max-width: 72ch; }
.sec { margin-top: 26px; }
.sec > h2 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); margin-bottom: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
td, th { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--dim); font-weight: 500; font-size: 12px; }
.mono { font-family: var(--mono); font-size: 13px; }
.req { color: var(--red); font-size: 11px; margin-left: 4px; }
.schema { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px;
    font-family: var(--mono); font-size: 13px; overflow-x: auto; }
.schema .k { color: var(--text); } .schema .t { color: var(--brand); } .schema .c { color: var(--dim); }
.schema .row { padding-left: calc(var(--depth, 0) * 18px); }
.status { font-family: var(--mono); font-weight: 700; }
.s-2 { color: var(--green); } .s-3 { color: var(--cyan); } .s-4 { color: var(--yellow); } .s-5 { color: var(--red); }
.try { margin-top: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.try label { display: block; color: var(--dim); font-size: 12px; margin: 10px 0 3px; }
.try input, .try textarea { width: 100%; background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
    color: var(--text); padding: 7px 10px; font-family: var(--mono); font-size: 13px; outline: none; }
.try input:focus, .try textarea:focus { border-color: var(--brand); }
.try textarea { min-height: 110px; resize: vertical; }
.send { margin-top: 14px; background: var(--brand); color: #06101f; border: 0; border-radius: 6px;
    padding: 8px 22px; font: inherit; font-weight: 600; cursor: pointer; }
.send:hover { filter: brightness(1.1); }
.result { margin-top: 14px; display: none; }
.result pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px;
    font-family: var(--mono); font-size: 12.5px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.result .rline { font-family: var(--mono); font-size: 13px; margin-bottom: 8px; }
.empty { color: var(--dim); padding: 60px 40px; }
.badge-sec { color: var(--dim); font-size: 12px; border: 1px solid var(--line); border-radius: 4px; padding: 1px 7px; }
</style>
</head>
<body>
<div class="frame">
    <nav class="side">
        <div class="head"><span class="mark">▲</span><b>${ safeTitle }</b><span class="v" id="version"></span></div>
        <div class="search"><input id="search" type="search" placeholder="Filter operations..." autocomplete="off"></div>
        <div id="nav"></div>
    </nav>
    <main class="main"><div class="empty" id="content">Loading the API document…</div></main>
</div>
<script>
(async () => {
    'use strict';
    const SPEC_URL = '${ safeSpecUrl }';
    const spec = await (await fetch(SPEC_URL)).json();
    const nav = document.getElementById('nav');
    const content = document.getElementById('content');
    document.getElementById('version').textContent = 'v' + spec.info.version;
    document.title = spec.info.title;

    const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    const resolve = (schema) => {
        if (schema && schema.$ref) {
            const name = schema.$ref.split('/').pop();
            return { name, schema: spec.components.schemas[name] || {} };
        }
        return { name: null, schema: schema || {} };
    };

    const typeOf = (s) => {
        if (s.$ref) return resolve(s).name;
        if (s.const !== undefined) return JSON.stringify(s.const);
        if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
        if (s.anyOf) return s.anyOf.map(typeOf).join(' | ');
        if (s.type === 'array') return typeOf(s.items || {}) + '[]';
        return s.type || 'any';
    };

    const schemaRows = (schema, box, depth, seen) => {
        const { name, schema: s } = resolve(schema);
        if (name && seen.has(name)) { const r = el('div', 'row c', name + ' (see above)'); r.style.setProperty('--depth', depth); box.append(r); return; }
        if (name) seen.add(name);
        if (s.type === 'object' && s.properties) {
            const required = new Set(s.required || []);
            for (const [key, child] of Object.entries(s.properties)) {
                const row = el('div', 'row');
                row.style.setProperty('--depth', depth);
                row.append(el('span', 'k', key + (required.has(key) ? '' : '?')), el('span', 'c', ': '), el('span', 't', typeOf(child)));
                const facts = [];
                const rc = resolve(child).schema;
                for (const f of ['format', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'minItems', 'maxItems'])
                    if (rc[f] !== undefined) facts.push(f + '=' + rc[f]);
                if (rc.description) facts.push(rc.description);
                if (facts.length) row.append(el('span', 'c', '  · ' + facts.join(' · ')));
                box.append(row);
                const inner = resolve(child).schema;
                if (inner.type === 'object' || (inner.type === 'array' && resolve(inner.items || {}).schema.type === 'object'))
                    schemaRows(inner.type === 'array' ? inner.items : child, box, depth + 1, seen);
            }
        } else if (s.type === 'array') {
            schemaRows(s.items || {}, box, depth, seen);
        } else {
            const row = el('div', 'row t', typeOf(s));
            row.style.setProperty('--depth', depth);
            box.append(row);
        }
    };

    const operations = [];
    for (const [path, methods] of Object.entries(spec.paths || {}))
        for (const [method, op] of Object.entries(methods))
            operations.push({ path, method, op, tag: (op.tags && op.tags[0]) || 'general' });

    const render = (entry) => {
        content.className = '';
        content.textContent = '';
        const { path, method, op } = entry;

        content.append(el('div', 'crumb', entry.tag + ' · ' + op.operationId));
        const h1 = el('h1', 'op-title', op.summary || op.operationId);
        if (op.deprecated) h1.append(el('span', 'deprecated', 'deprecated'));
        content.append(h1);

        const endpoint = el('div', 'endpoint');
        endpoint.append(el('span', 'method m-' + method, method.toUpperCase()));
        const pathNode = el('span', 'mono');
        for (const piece of path.split(/({[^}]+})/g))
            pathNode.append(piece.startsWith('{') ? el('span', 'param', piece) : document.createTextNode(piece));
        endpoint.append(pathNode);
        if (op.security && op.security.length) endpoint.append(el('span', 'badge-sec', '\u{1f512} ' + Object.keys(op.security[0]).join(', ')));
        content.append(endpoint);
        if (op.description) content.append(el('p', 'desc', op.description));

        if (op.parameters && op.parameters.length) {
            const sec = el('div', 'sec'); sec.append(el('h2', null, 'Parameters'));
            const table = el('table'); const head = el('tr');
            for (const t of ['Name', 'In', 'Type', 'Notes']) head.append(el('th', null, t));
            table.append(head);
            for (const p of op.parameters) {
                const tr = el('tr');
                const name = el('td', 'mono', p.name); if (p.required) name.append(el('span', 'req', '*'));
                tr.append(name, el('td', null, p.in), el('td', 'mono', typeOf(p.schema || {})), el('td', null, (p.schema && p.schema.description) || p.description || ''));
                table.append(tr);
            }
            sec.append(table); content.append(sec);
        }

        if (op.requestBody) {
            const sec = el('div', 'sec'); sec.append(el('h2', null, 'Request body'));
            const box = el('div', 'schema');
            schemaRows(op.requestBody.content['application/json'].schema, box, 0, new Set());
            sec.append(box); content.append(sec);
        }

        const responses = el('div', 'sec'); responses.append(el('h2', null, 'Responses'));
        for (const [status, response] of Object.entries(op.responses || {})) {
            const line = el('div');
            line.style.margin = '10px 0 6px';
            line.append(el('span', 'status s-' + status[0], status), el('span', 'c', '  '), el('span', null, ' ' + (response.description || '')));
            responses.append(line);
            const media = response.content && response.content['application/json'];
            if (media) { const box = el('div', 'schema'); schemaRows(media.schema, box, 0, new Set()); responses.append(box); }
        }
        content.append(responses);

        // Try it - same-origin fetch with optional bearer token.
        const trySec = el('div', 'sec'); trySec.append(el('h2', null, 'Try it'));
        const panel = el('div', 'try');
        const inputs = {};
        for (const p of (op.parameters || []).filter((p) => p.in === 'path' || p.in === 'query')) {
            panel.append(el('label', null, p.name + ' (' + p.in + ')'));
            inputs[p.in + ':' + p.name] = panel.appendChild(el('input'));
        }
        if (op.security && op.security.length) {
            panel.append(el('label', null, 'Bearer token'));
            inputs.token = panel.appendChild(el('input'));
            inputs.token.placeholder = 'paste an access token';
        }
        let bodyInput = null;
        if (op.requestBody) {
            panel.append(el('label', null, 'Body (JSON)'));
            bodyInput = panel.appendChild(el('textarea'));
            bodyInput.value = '{\\n  \\n}';
        }
        const send = el('button', 'send', 'Send request');
        const result = el('div', 'result');
        const rline = el('div', 'rline');
        const rbody = el('pre');
        result.append(rline, rbody);
        send.addEventListener('click', async () => {
            let target = path;
            for (const [key, input] of Object.entries(inputs))
                if (key.startsWith('path:')) target = target.replace('{' + key.slice(5) + '}', encodeURIComponent(input.value));
            const query = new URLSearchParams();
            for (const [key, input] of Object.entries(inputs))
                if (key.startsWith('query:') && input.value !== '') query.set(key.slice(6), input.value);
            const headers = {};
            if (inputs.token && inputs.token.value) headers.authorization = 'Bearer ' + inputs.token.value;
            if (bodyInput) headers['content-type'] = 'application/json';
            const started = performance.now();
            try {
                const response = await fetch(target + (query.size ? '?' + query : ''), {
                    method: method.toUpperCase(), headers, body: bodyInput ? bodyInput.value : undefined
                });
                const text = await response.text();
                rline.textContent = '';
                rline.append(el('span', 'status s-' + String(response.status)[0], String(response.status)),
                    el('span', 'c', '  ·  ' + Math.round(performance.now() - started) + ' ms'));
                try { rbody.textContent = JSON.stringify(JSON.parse(text), null, 2); }
                catch { rbody.textContent = text; }
            } catch (error) {
                rline.textContent = ''; rline.append(el('span', 'status s-5', 'network error'));
                rbody.textContent = String(error);
            }
            result.style.display = 'block';
        });
        panel.append(send, result);
        trySec.append(panel); content.append(trySec);
    };

    // Navigation grouped by tag, filterable.
    const links = [];
    const buildNav = (filter) => {
        nav.textContent = '';
        links.length = 0;
        let currentTag = null;
        for (const entry of operations) {
            const label = (entry.op.summary || entry.op.operationId || '') + ' ' + entry.path;
            if (filter && !label.toLowerCase().includes(filter)) continue;
            if (entry.tag !== currentTag) { nav.append(el('div', 'tag', entry.tag)); currentTag = entry.tag; }
            const link = el('div', 'op-link');
            link.append(el('span', 'method m-' + entry.method, entry.method.toUpperCase()), el('span', 'path', entry.path));
            link.title = entry.op.summary || entry.op.operationId;
            link.addEventListener('click', () => {
                for (const other of links) other.classList.remove('active');
                link.classList.add('active');
                render(entry);
            });
            links.push(link);
            nav.append(link);
        }
    };
    buildNav('');
    document.getElementById('search').addEventListener('input', (event) => buildNav(event.target.value.trim().toLowerCase()));
    if (operations.length) { links[0].classList.add('active'); render(operations[0]); }
    else content.textContent = 'The document declares no operations.';
})();
</script>
</body>
</html>
`;
}
