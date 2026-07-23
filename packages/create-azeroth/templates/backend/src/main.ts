// A complete @azerothjs/http server. There is no build step: Node >= 24 runs this file
// directly, `azeroth dev` (node --watch) restarts it on save, and `azeroth build` will
// tell you there is nothing to build - deploy src/ as-is.
import
{
    App, serve, handleShutdownSignals,
    json, text, readJson,
    ValidationError,
    type ErrorSerializerContext
} from '@azerothjs/http';

// serializeError reshapes EVERY error (route-miss 404s included) into one house envelope
// instead of the default { error: { code, message } }. Delete it to keep the default.
const app = new App(
    {
        dev: process.env.NODE_ENV !== 'production',
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

app.get('/', () => text('ok'));

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

const served = await serve(app, { port: Number(process.env.PORT) || 3000 });
handleShutdownSignals(served); // SIGTERM/SIGINT: drain in-flight responses, then exit
