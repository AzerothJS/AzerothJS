// The app, built pure: routes in, App out - no serving, no environment, no side
// effects. That split is what makes `app.handle(new Request(...))` the entire
// integration-testing story (see tests/app.spec.ts): no sockets, no test server.
import
{
    App, json, readJson,
    ValidationError,
    type ErrorSerializerContext, type RequestObserver
} from '@azerothjs/http';

export function buildApp(options: { dev: boolean; observe?: RequestObserver }): App
{
    // serializeError shapes EVERY error (route-miss 404s included) into one house
    // envelope instead of the default { error: { code, message } }. Delete it to keep
    // the default.
    const app = new App(
        {
            dev: options.dev,
            observe: options.observe,
            serializeError: ({ error, expose }: ErrorSerializerContext) => (
                {
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

    // `ctx.params` is typed from the pattern string - no annotation, no codegen.
    app.get('/hello/:name', (_request, ctx) => json({ hello: ctx.params.name }));

    // readJson enforces size limits and Content-Type (a bad body is a 400); a
    // ValidationError's field map lands in the envelope above as `error.fields`.
    app.post('/echo', async (request) =>
    {
        const body = await readJson<{ message?: unknown }>(request);
        if (typeof body.message !== 'string' || body.message.trim() === '')
        {
            throw new ValidationError({ message: 'A message is required.' });
        }
        return json({ echoed: body.message }, { status: 201 });
    });

    return app;
}
