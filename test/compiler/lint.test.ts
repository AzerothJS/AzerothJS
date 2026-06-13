// The compiler lint rules: each fires on its target mistake, stays silent
// on the legitimate look-alikes, and carries an accurate source span.

import { describe, it, expect } from 'vitest';
import { lintSource } from '@azerothjs/compiler';

describe('azeroth/handler-call', () =>
{
    it('flags a zero-argument call passed as an event handler', () =>
    {
        const src = 'const x = <button onClick={save()}>go</button>;';
        const warnings = lintSource(src);

        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe('azeroth/handler-call');
        expect(warnings[0].message).toContain('onClick={save}');
        // The span covers the offending attribute.
        expect(src.slice(warnings[0].start, warnings[0].end)).toBe('onClick={save()}');
    });

    it('flags a zero-argument method call', () =>
    {
        const warnings = lintSource('const x = <form onSubmit={actions.reset()}>x</form>;');
        expect(warnings.map(w => w.code)).toEqual(['azeroth/handler-call']);
    });

    it('stays silent for handler references, arrows, and factories', () =>
    {
        expect(lintSource('const x = <button onClick={save}>go</button>;')).toHaveLength(0);
        expect(lintSource('const x = <button onClick={() => save()}>go</button>;')).toHaveLength(0);
        // A call WITH arguments is the handler-factory idiom.
        expect(lintSource('const x = <button onClick={makeHandler(id)}>go</button>;')).toHaveLength(0);
    });
});

describe('azeroth/duplicate-attr', () =>
{
    it('flags the second occurrence of a repeated attribute', () =>
    {
        const src = 'const x = <div class="a" id="i" class="b">x</div>;';
        const warnings = lintSource(src);

        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe('azeroth/duplicate-attr');
        expect(src.slice(warnings[0].start, warnings[0].end)).toBe('class="b"');
    });

    it('does not confuse attributes across sibling elements', () =>
    {
        expect(lintSource('const x = <div><p class="a">x</p><p class="a">y</p></div>;')).toHaveLength(0);
    });
});

describe('azeroth/event-case', () =>
{
    it('flags lowercase DOM event attributes on host elements', () =>
    {
        const warnings = lintSource('const x = <button onclick={f}>go</button>;');

        expect(warnings).toHaveLength(1);
        expect(warnings[0].code).toBe('azeroth/event-case');
        expect(warnings[0].message).toContain('onClick');
    });

    it('ignores non-event attributes that merely start with "on"', () =>
    {
        expect(lintSource('const x = <a online="true">x</a>;')).toHaveLength(0);
    });

    it('ignores component props (their casing is the component\'s contract)', () =>
    {
        expect(lintSource('const x = <Widget onclick={f} />;')).toHaveLength(0);
    });
});

describe('lintSource', () =>
{
    it('walks nested elements and multiple regions', () =>
    {
        const src = [
            'const a = <div><button onClick={save()}>x</button></div>;',
            'const b = <input onchange={f} />;'
        ].join('\n');

        const codes = lintSource(src).map(w => w.code).sort();
        expect(codes).toEqual(['azeroth/event-case', 'azeroth/handler-call']);
    });

    it('reports nothing for clean markup and skips unparseable regions', () =>
    {
        expect(lintSource('const x = <button onClick={() => save()}>ok</button>;')).toHaveLength(0);
        expect(() => lintSource('const x = <di')).not.toThrow();
    });
});
