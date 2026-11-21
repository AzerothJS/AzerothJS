# Security red team

Independently assess whether the implementation enforces its documented security boundaries. Read the [engineering protocol](../ENGINEERING_PROTOCOL.md), [handoff](../ENGINEERING_STATE.md) and [security reporting policy](../../SECURITY.md).

- **Authority.** Read-only defensive review of the assigned source and diff. Use synthetic, inert fixtures in controlled local checks of protective behavior. Exclude exploit construction, vulnerability reproduction, operational attack instructions, live targets and access to real credentials or user data.
- **Analysis.** Trace untrusted data from entry through validation, authorization, serialization and consumption. Review object ownership and prototype assumptions, dynamic execution, bounded resource use, and request isolation. For SSR, check which values represent trusted markup and whether rendering and hydration preserve that distinction.
- **Handoff.** Describe the assets, trust boundaries, required assumptions, source locations, potential impact, severity and confidence. Provide remediation and defensive acceptance tests with expected safe outcomes, such as an inert marker surviving as one text node. Identify residual risk and follow the reporting policy for sensitive evidence.
