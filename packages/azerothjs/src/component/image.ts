/**
 * MODULE: component/image
 *
 * <Image> - the framework's responsive image element. It is deliberately TWO components in
 * one: with no endpoint in reach it is an honest <img> passthrough (an app needs no image
 * server to use it), and with one - `optimize`, or an {@link ImageConfig} provider - src and
 * srcset target the transform endpoint (`/_image?src&w&q`). Requested widths snap UP the
 * {@link DEVICE_WIDTHS} ladder so the endpoint's cache stays bounded: a thousand distinct
 * layout widths still produce a handful of files. The format never rides the URL - the
 * endpoint negotiates it from the Accept header, so one URL serves avif, webp, or the
 * original per browser. Width/height pass through as attributes so the browser reserves
 * the box before bytes arrive (no layout shift); loading defaults lazy, decoding async.
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

/** Props for {@link Image}. */
export interface ImageProps
{
    /** The source path (or a reactive getter of one). Local paths serve through the endpoint. */
    src: string | (() => string);

    /** Required - an image without alternative text is an accessibility bug, typed as one. */
    alt: string;

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
 * Image
 *
 * PURPOSE:
 * Renders one responsive <img>: endpoint-backed src/srcset when optimization is enabled,
 * a verbatim passthrough when it is not - the same markup contract either way.
 *
 * INPUT CONTRACT:
 * - See {@link ImageProps}. `alt` is required by type. A function `src` stays reactive.
 *
 * OUTPUT CONTRACT:
 * - One `<img>` element (SSR-serializable through the ordinary h() path). With `sizes` +
 *   `width`: a w-descriptor srcset over the ladder up to twice the width. With `width`
 *   alone: a 1x/2x density pair. Without `width`: the bare transform URL (format
 *   negotiation only).
 *
 * @param props - {@link ImageProps}.
 * @returns The image element.
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
        alt: props.alt,
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
        attrs['class'] = props.class;
    }
    if (props.fetchpriority !== undefined)
    {
        attrs['fetchpriority'] = props.fetchpriority;
    }

    if (endpoint === undefined)
    {
        attrs['src'] = props.src;
        return h('img', attrs);
    }

    const source = props.src;
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

    if (typeof source === 'function')
    {
        attrs['src'] = (): string => srcFor(source());
        const set = srcsetFor('probe');
        if (set !== undefined)
        {
            attrs['srcset'] = (): string => srcsetFor(source()) as string;
        }
        return h('img', attrs);
    }
    attrs['src'] = srcFor(source);
    const srcset = srcsetFor(source);
    if (srcset !== undefined)
    {
        attrs['srcset'] = srcset;
    }
    return h('img', attrs);
}
