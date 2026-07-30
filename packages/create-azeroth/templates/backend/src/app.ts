import { App, json, readJson, UnauthorizedError, ValidationError, type ErrorSerializerContext, type RequestObserver } from '@azerothjs/http';

export function buildApp(options: { dev: boolean; observe?: RequestObserver }): App
{
    const app = new App
    ({
        dev: options.dev,
        observe: options.observe,
        serializeError: ({ error, expose }: ErrorSerializerContext) => ({
            ok: false,
            error:
                {
                    code: error.code,
                    message: expose ? error.message : 'Something went wrong',
                    fields: (error.details as { fields?: Record<string, string> } | undefined)?.fields
                }
        })
    });

    // The orchestrator probe: cheap, dependency-free, always 200 when the process lives.
    app.get('/healthz', () => json({ ok: true }));

    // Scoped middleware. `with` returns a FORK, so only the routes registered on it run
    // this one. An object return adds TYPED fields to every later context; a throw rejects
    // the request before the handler and comes back in the envelope above.
    const authed = app.with((context) =>
    {
        const token = context.request.headers.get('authorization');
        if (token === null)
        {
            throw new UnauthorizedError('A bearer token is required.');
        }
        return { userId: token.replace('Bearer ', '') };
    });

    // One `context` per handler: the request, the params (typed from the pattern string -
    // no annotation, no codegen), and whatever the middleware added. readJson enforces the
    // body limit and Content-Type; a ValidationError's field map lands in `error.fields`.
    authed.post('/rooms/:room/messages', async (context) =>
    {
        const body = await readJson<{ message?: unknown }>(context.request);
        if (typeof body.message !== 'string' || body.message.trim() === '')
        {
            throw new ValidationError({ message: 'A message is required.' });
        }
        return json({ room: context.params.room, from: context.userId, message: body.message }, { status: 201 });
    });

    return app;
}
