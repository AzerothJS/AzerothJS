/**
 * MODULE: cli - the azeroth command line, programmatically
 *
 * The bin (`azeroth`) is a thin dispatcher over these exports: shape detection
 * (detect.ts), command planning (plan.ts), plan execution (run.ts), diagnosis
 * (doctor.ts), and the info block (info.ts). Everything the CLI decides is available
 * as a plain function call - tests and tools consume the same seams the bin does.
 */

export { detectProject, classifyLeaf, readPackage, allDeps } from './detect.ts';
export type {
    Project, FrontendProject, BackendProject, LibraryProject, FullstackProject, NoProject, DetectOverrides
} from './detect.ts';

export { planDev, planCheck, planBuild, resolveTool, formatStep, isRunnable, PlanError } from './plan.ts';
export type { Plan, Step } from './plan.ts';

export { runToCompletion, runDev, printNotes } from './run.ts';

export { runDoctor } from './doctor.ts';
export type { DoctorResult, DoctorStatus } from './doctor.ts';

export { renderInfo } from './info.ts';
