# Getting Help with AzerothJS

Thanks for using AzerothJS! Here is where to go for what:

## Support window

AzerothJS ships as a **lockstep train**: every package carries the same version,
released together. The support statement is deliberately simple and honest:

- **The latest published release line is supported** - bug fixes and security
  fixes land there. Moving to it is one command inside your project:
  `npx @azerothjs/cli upgrade` (rewrites every pin, installs, runs the doctor).
  Use the scoped name, not `npx azeroth` - the bare `azeroth` name on npm is an
  unrelated squatted package.
- **Older releases are not patched.** Pre-release versions (betas) are superseded
  the moment the next release publishes.
- **There is no LTS designation yet.** Long-term support lines are a promise that
  must be backed by capacity; one will be considered at the 2.0 horizon rather
  than promised now. How the project is run - and what binds its decisions - is
  documented in [GOVERNANCE.md](GOVERNANCE.md).

## Documentation first

- The [README](README.md) covers installation, the `.azeroth` language, rendering
  modes, and the package map.
- Every package has its own README with focused docs and examples - see the
  [Packages table](README.md#packages).
- The editor extensions document their features and setup:
  [VS Code](editors/vscode/README.md) and [JetBrains](editors/jetbrains/README.md).

## Questions and ideas

Use [GitHub Discussions](https://github.com/AzerothJS/AzerothJS/discussions) for
how-to questions, design discussions, and sharing what you build. Please do not
open an issue for a question - issues are for actionable bugs and feature
requests.

## Bugs and feature requests

Open an issue using the structured templates:

- [Report a bug](https://github.com/AzerothJS/AzerothJS/issues/new?template=bug_report.yml) -
  include the version and a minimal reproduction; that is the single biggest
  factor in how fast it gets fixed.
- [Request a feature](https://github.com/AzerothJS/AzerothJS/issues/new?template=feature_request.yml)

## Security issues

Never report security problems in public issues - see the
[Security Policy](SECURITY.md) for private reporting.

## Contributing

Want to fix it yourself? Start with the
[Contributing Guide](CONTRIBUTING.md) - setup, conventions, and the PR
workflow.
