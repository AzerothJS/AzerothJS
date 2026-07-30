// @vitest-environment node
//
// `azeroth dev` declares NODE_ENV=development to its children.
//
// The framework's development-only gates check `NODE_ENV === 'development'` POSITIVELY, because
// an unset variable must not open them: a production deploy that forgot to set it would otherwise
// get the devtools bridge. A freshly scaffolded app ships no `.env`, so nothing sets it, and an
// app whose own config defaults an unset value to 'development' then disagrees with the runtime
// about what mode it is in. That disagreement killed the fullstack template at boot - its
// `if development` branch was true and the bridge it called refused - and only a real scaffold
// booted end to end could show it.
import { afterEach, describe, expect, it } from 'vitest';

import { devModeEnv } from '../src/run.ts';

const previous = process.env.NODE_ENV;

afterEach(() =>
{
    if (previous === undefined)
    {
        delete process.env.NODE_ENV;
    }
    else
    {
        process.env.NODE_ENV = previous;
    }
});

describe('azeroth dev declares the mode its children run in', () =>
{
    it('sets NODE_ENV=development when nothing set it', () =>
    {
        delete process.env.NODE_ENV;
        expect(devModeEnv('dev')).toEqual({ NODE_ENV: 'development' });
    });

    it('never overrides a mode the developer chose', () =>
    {
        process.env.NODE_ENV = 'test';
        expect(devModeEnv('dev')).toEqual({});
        process.env.NODE_ENV = 'production';
        expect(devModeEnv('dev')).toEqual({});
    });

    it('says nothing for the verbs that are not development', () =>
    {
        delete process.env.NODE_ENV;
        expect(devModeEnv('build')).toEqual({});
        expect(devModeEnv('check')).toEqual({});
        expect(devModeEnv('test')).toEqual({});
    });
});
