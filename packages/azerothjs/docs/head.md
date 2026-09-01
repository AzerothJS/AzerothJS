<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# azerothjs / head

[![npm](https://img.shields.io/npm/v/azerothjs?color=2ea44f)](https://www.npmjs.com/package/azerothjs)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

## Overview

`useHead()` declares what a component contributes to the document head: the title, meta tags,
links, and JSON-LD blocks. The same call works on the server and on the client. On the server
the declarations are serialized into the response document, so a crawler sees them without
running any JavaScript. On the client they are applied to the live `document.head` and rolled
back when the component that declared them goes away.

```azeroth
// ProfilePage.azeroth
import { useHead } from 'azerothjs';

export default component ProfilePage(props: { name: string; bio: string; handle: string })
{
    useHead({
        title: `${ props.name } - Acme`,
        meta: [{ name: 'description', content: props.bio }],
        links: [{ rel: 'canonical', href: `https://acme.example/u/${ props.handle }` }]
    });

    <article>
        <h1>{ props.name }</h1>
    </article>
}
```

## Install

```sh
npm install azerothjs
```

## What you can declare

| field | shape |
| --- | --- |
| `title` | a string, or a getter for a reactive one |
| `titleTemplate` | a string where `%s` marks the title slot |
| `meta` | `{ name \| property \| httpEquiv, content, media? }` - exactly one of the three keys |
| `links` | `{ rel, href, hreflang?, type?, sizes?, media?, as?, crossorigin?, ... }` |
| `jsonLd` | an object, an array of them, or a function returning either |

Every value may be a getter. On the client a getter stays live and re-applies when its
signals change. On the server it resolves once, at the `useHead()` call, inside the request.

## Precedence is nesting

A leaf's declaration wins over its layout's for the same key, and falls back to the layout's
when the leaf unmounts. Keys are what you would expect: the title, each `name`/`property`/
`http-equiv` for meta, and each `rel` for links. So a layout can set the site-wide defaults
and a page overrides only what it cares about.

`titleTemplate` applies to titles declared *after* it, which means a layout can frame every
page below it:

```ts
// layout
useHead({ titleTemplate: '%s - Acme' });
// page
useHead({ title: 'Pricing' });   // renders <title>Pricing - Acme</title>
```

A title declared alongside its own template in ONE call renders bare. Compose a template and
its own default title in two calls, template first.

## Server rendering, and the one rule that matters

The head is written into the response document by the host - `@azerothjs/kit` does this for
you. There is one rule, and it is the difference between SEO facts that reach a crawler and
facts that only ever reach a browser:

**A head fact must be resolvable during the synchronous main pass, because that is when the
head is built.**

A route loader always is. Loaders settle before the render begins, so anything derived from
`useLoader()` is present in time, including on a streamed route:

```ts
// Reaches the served <head> on every render mode, streaming included.
const user = useLoader();
useHead({ title: `Profile ${ user.data().name }` });
```

What does not is a fact that only exists after a Suspense boundary settles. On `render:
'stream'` the shell - the head included - has already been flushed by then, and bytes that
have left cannot be edited:

```azeroth
// Deferred.azeroth
import { useHead } from 'azerothjs';

export default component Deferred()
{
    resource article = () => fetch('/api/article').then(r => r.text());

    <Suspense fallback={ <p>Loading</p> } on={ [article] }>
        <Body text={ article.data() ?? '' } />
    </Suspense>
}

component Body(props: { text: string })
{
    // Inside the boundary: on a STREAMED route this never reaches the served head, because
    // the shell was flushed while this component was still pending.
    useHead({ title: 'Too late' });

    <article>{ props.text }</article>
}
```

The declaration is dropped with a development warning naming the remedy. The component's
CONTENT still streams normally; it is only the head that cannot be reached. Note that the
client applies the same declaration after hydration, so the page looks correct in a browser
while a crawler never sees it. If a fact is SEO-critical, move it to the route's loader or
render that route with `render: 'server'` instead of `'stream'`.

Buffered renders (`render: 'server'`, `'static'`) have no such limit: nothing is sent until
the whole document exists.

## On the client

Declarations are applied to the live `document.head`, and removed when the declaring
component is disposed, restoring whatever the nearest remaining declaration says. Getters
stay reactive, so a title that reads a signal updates in place.

All `render()` containers on a page share one document head and one registry. That is
deliberate: `document.head` is global, and the last registration wins across containers.

## Safety

Head values are frequently built from data, so the head path is gated like any other place
data reaches the document.

A `<meta http-equiv="refresh">` is an automatic navigation, so its target is judged by the
same rule a guard or loader redirect answers to: an off-origin one is refused as the
open-redirect shape. This covers every legal spelling of the directive, not just the
`url=` form.

```ts
useHead({ meta: [{ httpEquiv: 'refresh', content: '0;url=/checkout' }] });         // fine
useHead({ meta: [{ httpEquiv: 'refresh', content: `0;url=${ next }` }] });         // refused if `next` leaves the origin
useHead({ meta: [{ httpEquiv: 'refresh', content: unsafeUrl(partnerUrl) }] });     // deliberate, and says so
```

Only `refresh` is inspected. `og:url`, `og:image` and every other meta legitimately carry
absolute URLs in `content`, and are left alone.

A value the runtime cannot serialize - a JSON-LD block holding a `BigInt`, a title getter
that returns a function - is dropped with a development diagnostic and the response proceeds.
A head fact is never worth failing a page for.

## See also

- [`router`](./router.md) for loaders, which is where SEO-critical head facts belong.
- [`renderer`](./renderer.md) for the render modes the rules above refer to.
