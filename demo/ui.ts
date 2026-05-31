// ============================================================================
// AZEROTHJS DEMO — Shared UI Components
// ============================================================================
//
// Small, reusable presentational components shared across every
// page. Everything here is a plain function component built with
// h() — the same primitives an app developer uses. Keeping these
// in one place is what makes the page components read cleanly.
//
// ============================================================================

import { h } from '@azerothjs/core';
import type { Child } from '@azerothjs/core';

/**
 * A row of small pill tags naming the framework APIs a demo
 * exercises. Purely informational — helps a reader connect the
 * live demo to the primitives behind it.
 */
export function FeatureTags(...tags: string[]): HTMLElement
{
    return h(
        'div',
        { class: 'feature-tags' },
        tags.map(tag => h('span', { class: 'feature-tag' }, tag))
    );
}

/** Options for {@link DemoCard}. */
export interface DemoCardOptions
{
    /** Card heading. */
    title: string;

    /** Optional one-line description shown under the title. */
    description?: string;

    /** Optional API tags rendered as pills. */
    tags?: string[];
}

/**
 * The standard "glass card" wrapper every demo lives in. Gives a
 * consistent title / description / tags header, then the demo's
 * own body below.
 */
export function DemoCard(options: DemoCardOptions, ...body: Child[]): HTMLElement
{
    return h(
        'section',
        { class: 'glass demo-card' },
        options.tags && options.tags.length > 0 ? FeatureTags(...options.tags) : null,
        h('h2', { class: 'demo-card-title' }, options.title),
        options.description
            ? h('p', { class: 'demo-card-desc' }, options.description)
            : null,
        h('div', { class: 'demo-card-body' }, ...body)
    );
}

/**
 * A page-level header: big title plus a muted subtitle. Sits at
 * the top of each route's content column.
 */
export function PageHeader(title: string, subtitle: string): HTMLElement
{
    return h(
        'header',
        { class: 'page-header' },
        h('h1', { class: 'page-title' }, title),
        h('p', { class: 'page-subtitle' }, subtitle)
    );
}

/**
 * A highlighted aside for tips and "what to notice" notes.
 *
 * @param tone - Visual tone: `info` (default) or `tip`.
 */
export function Callout(tone: 'info' | 'tip', ...body: Child[]): HTMLElement
{
    return h('div', { class: `callout callout-${ tone }` }, ...body);
}

/** A single labelled statistic, used in the home hero grid. */
export function Stat(value: string, label: string): HTMLElement
{
    return h(
        'div',
        { class: 'stat' },
        h('div', { class: 'stat-value' }, value),
        h('div', { class: 'stat-label' }, label)
    );
}
