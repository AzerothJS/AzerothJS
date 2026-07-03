# Security Policy

## Supported versions

AzerothJS is pre-1.0 and versioned in lockstep across every package. Only the **latest
published release line** receives security fixes:

| Version | Supported |
| --- | --- |
| latest `0.x` release (currently `0.7.x`) | yes |
| older releases | no - upgrade to the latest release |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting instead: go to the repository's
[Security tab](https://github.com/AzerothJS/AzerothJS/security) and click
**"Report a vulnerability"**. This opens a private advisory that only the
maintainer can see.

If that is not an option for you, email
[IntelligentQuantum@Gmail.Com](mailto:IntelligentQuantum@Gmail.Com) with
"SECURITY" in the subject line.

Please include, where possible:

- the affected package(s) and version(s);
- a description of the issue and its impact;
- a minimal reproduction or proof of concept;
- any suggested fix.

## What to expect

- An acknowledgement within **7 days**.
- An assessment of the report and, for accepted issues, a fix in the next release
  (or a dedicated patch release for anything severe), credited to you in the
  release notes unless you prefer otherwise.
- Coordinated disclosure: please give the fix a chance to ship before publishing
  details.

## Scope notes

Areas of this project with a genuine security surface:

- **SSR output escaping** (`@azerothjs/server`): text and attribute values are
  escaped on render; anything that lets untrusted input reach unescaped HTML is a
  vulnerability.
- **The compiler and language tooling** (`@azerothjs/compiler`, the language
  server, the editor plugins) parse untrusted source text; crashes are bugs, but
  anything reachable that executes or exfiltrates beyond parsing is a
  vulnerability.
- Dependency advisories are monitored via Dependabot, and CodeQL runs weekly on
  the default branch.
