/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The responsive image element, deliberately two components in one. With no endpoint in
 * reach it is an honest `<img>` passthrough, so an app needs no image server to use it; with
 * one - `optimize`, or an {@link ImageConfig} provider - src and srcset target the transform
 * endpoint.
 *
 * Requested widths snap UP the {@link DEVICE_WIDTHS} ladder, which is what keeps the
 * endpoint's cache bounded: a thousand distinct layout widths still produce a handful of
 * files. The format never rides the URL either - the endpoint negotiates it from the Accept
 * header, so one URL serves avif, webp or the original depending on the browser.
 *
 * Width and height pass through as attributes so the browser reserves the box before the
 * bytes arrive, avoiding layout shift. Loading defaults to lazy and decoding to async.
 */

import type { Context } from '../reactivity/index.ts';
import { createContext, useContext } from '../reactivity/index.ts';
import { h } from '../renderer/h.ts';
import type { MountNode } from './types.ts';

/**
 * The width ladder src/srcset snap onto - the small sizes real layouts use plus the
 * device-width tiers. The kit's endpoint snaps the SAME way, so any URL the component
 * mints is a URL the endpoint caches under a bounded key space.
 */
export const DEVICE_WIDTHS: readonly number[] = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840];

/** App-wide enablement: provide `{ endpoint }` once instead of `optimize` per image. */
export const ImageConfig: Context<{ endpoint: string } | undefined> = createContext(undefined, 'ImageConfig');

/**
 * Reads a prop that may be a literal, a COMPILER-EMITTED GETTER, or an explicit function.
 *
 * Markup passes a component prop as a getter on the props object (`{ get alt() { ... } }`), so
 * reading one during setup resolves it ONCE and throws away the laziness the protocol exists to
 * provide. Every attribute below is therefore handed to `h()` as a FUNCTION, which binds it, and
 * this resolves the current value each time that binding runs - so a literal, a markup
 * expression and an explicit getter all behave the same way.
 */
function readProp<T>(value: T | (() => T)): T
{
    return typeof value === 'function' ? (value as () => T)() : value;
}

/** Props for {@link Image}. */
export interface ImageProps
{
    /** The source path (or a reactive getter of one). Local paths serve through the endpoint. */
    src: string | (() => string);

    /**
     * Required - an image without alternative text is an accessibility bug, typed as one.
     *
     * Reactive like {@link ImageProps.src}: on a page whose language can change, alt text that
     * cannot follow it is the accessibility defect the requirement exists to prevent - a sighted
     * reader sees the page switch language, a screen-reader user does not.
     */
    alt: string | (() => string);

    /** Rendered width in CSS pixels; also the box reservation and the srcset anchor. */
    width?: number;

    /** Rendered height in CSS pixels (the other half of the no-layout-shift box). */
    height?: number;

    /** The `sizes` attribute; with `width`, switches the srcset to a w-descriptor ladder. */
    sizes?: string;

    /** Transform quality 1..100 (default 75). */
    quality?: number;

    /** Default 'lazy' - below-the-fold images are the common case. */
    loading?: 'lazy' | 'eager';

    /** Default 'async'. */
    decoding?: 'sync' | 'async' | 'auto';

    fetchpriority?: 'high' | 'low' | 'auto';
    class?: string | (() => string);

    /**
     * Optimization target: `true` = `/_image`, a string = that endpoint, absent/false =
     * fall back to {@link ImageConfig}, and with neither the component is a plain <img>.
     */
    optimize?: boolean | string;
}

/** @internal The smallest ladder width >= `value` (the largest tier past the top). */
function snapUp(value: number): number
{
    for (const width of DEVICE_WIDTHS)
    {
        if (width >= value)
        {
            return width;
        }
    }
    return DEVICE_WIDTHS[DEVICE_WIDTHS.length - 1] as number;
}

/** @internal One transform URL. */
function transformUrl(endpoint: string, source: string, width: number | undefined, quality: number): string
{
    return `${ endpoint }?src=${ encodeURIComponent(source) }${ width !== undefined ? `&w=${ width }` : '' }&q=${ quality }`;
}

/**
 * One responsive `<img>`: endpoint-backed src and srcset when optimization is enabled, a
 * verbatim passthrough when it is not, with the same markup contract either way.
 *
 * What srcset it emits depends on what it is told. With `sizes` and `width` it is a
 * w-descriptor set over the ladder up to twice the width; with `width` alone, a 1x and 2x
 * density pair; with neither, just the transform URL, which still gets format negotiation.
 *
 * `alt` is required by the type. A function `src` stays reactive.
 *
 * @param props - See {@link ImageProps}.
 * @returns The image element, serializable through the ordinary SSR path.
 * @example
 * Image({ src: '/hero.png', alt: 'Hero', width: 1200, sizes: '100vw', optimize: true });
 */
export function Image(props: ImageProps): MountNode
{
    const endpoint = props.optimize === true
        ? '/_image'
        : typeof props.optimize === 'string'
            ? props.optimize
            : useContext(ImageConfig)?.endpoint;
    const quality = props.quality ?? 75;

    const attrs: Record<string, unknown> = {
        alt: (): string => readProp(props.alt),
        loading: props.loading ?? 'lazy',
        decoding: props.decoding ?? 'async'
    };
    if (props.width !== undefined)
    {
        attrs['width'] = props.width;
    }
    if (props.height !== undefined)
    {
        attrs['height'] = props.height;
    }
    if (props.sizes !== undefined)
    {
        attrs['sizes'] = props.sizes;
    }
    if (props.class !== undefined)
    {
        attrs['class'] = (): string | undefined => readProp(props.class);
    }
    if (props.fetchpriority !== undefined)
    {
        attrs['fetchpriority'] = props.fetchpriority;
    }

    if (endpoint === undefined)
    {
        attrs['src'] = (): string => readProp(props.src);
        return h('img', attrs);
    }

    const srcFor = (value: string): string =>
        transformUrl(endpoint, value, props.width !== undefined ? snapUp(props.width) : undefined, quality);
    const srcsetFor = (value: string): string | undefined =>
    {
        if (props.width === undefined)
        {
            return undefined;
        }
        if (props.sizes !== undefined)
        {
            // Capped at twice the rendered width UN-snapped: a 640px image never pulls the
            // 1920 tier for a 1280px need - the 1200 tier is the cheaper honest answer.
            const cap = props.width * 2;
            return DEVICE_WIDTHS
                .filter((width) => width <= cap)
                .map((width) => `${ transformUrl(endpoint, value, width, quality) } ${ width }w`)
                .join(', ');
        }
        return `${ transformUrl(endpoint, value, snapUp(props.width), quality) } 1x, `
            + `${ transformUrl(endpoint, value, snapUp(props.width * 2), quality) } 2x`;
    };

    // ONE path, not a fork on whether the caller happened to pass a function. Whether a srcset
    // applies is structural (it needs `width`), so it is decided with a probe value rather than
    // by reading the source here - which would freeze it again.
    attrs['src'] = (): string => srcFor(readProp(props.src));
    if (srcsetFor('probe') !== undefined)
    {
        attrs['srcset'] = (): string => srcsetFor(readProp(props.src)) as string;
    }
    return h('img', attrs);
}
