// Compiles a component through the REAL generateModule and returns the live component
// function, with the emitted 'azerothjs/internal' import satisfied by the aliased runtime.
// No mocks: the conformance suite must exercise the exact code a build would ship.
import { generateModule } from '../../src/codegen.ts';
import * as internal from 'azerothjs/internal';

const INTERNAL_IMPORT = /import \{([^}]+)\} from 'azerothjs\/internal';/;

export type CompiledComponent = (props?: Record<string, unknown>) => unknown;

export function compileComponent(source: string, name: string): CompiledComponent
{
    const { code } = generateModule(source);
    const body = code.replace(INTERNAL_IMPORT, 'const {$1} = __internal;');
    if (body === code)
    {
        throw new Error('executor: emitted module has no azerothjs/internal import to rewrite');
    }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the compiler's own emitted module IS the test subject; the input is generateModule output, never external data
    const factory = new Function('__internal', `${ body }\nreturn ${ name };`) as (i: typeof internal) => CompiledComponent;
    return factory(internal);
}
