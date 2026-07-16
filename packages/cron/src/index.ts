/**
 * MODULE: cron - the AzerothJS job scheduler
 *
 * Zero-dependency scheduled work for Node >= 24: 5-field cron expressions (names, ranges,
 * steps, @aliases) evaluated in any IANA timezone with honest DST semantics, drift-free
 * single-timeout arming, overlap control, a printable job table, error isolation, and a
 * graceful drain built to sit next to an HTTP server's shutdown. The expression engine
 * (parseExpression / nextOccurrence) is exported on its own - "when would this run next?"
 * is a useful question outside the scheduler too.
 */

export { createScheduler } from './scheduler.ts';
export type { Scheduler, SchedulerOptions, JobOptions, JobInfo } from './scheduler.ts';

export { parseExpression, nextOccurrence, localKeyOf, assertTimeZone } from './expression.ts';
export type { CronFields } from './expression.ts';
