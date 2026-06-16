# Security Policy

Loom is pre-audit and not ready for production funds.

Security claims are governed by the product principles, design documentation,
threat model, and documented assumptions and residual risks. Passing CI or
formal checks does not by itself establish production readiness or complete
correctness.

## Reporting A Vulnerability

Do not open a public issue for a suspected vulnerability. Report it through a
private GitHub security advisory:

https://github.com/emirongrr/loom/security/advisories/new

Include the affected revision, impact, prerequisites, reproduction steps, and
any proposed mitigation. Reports are acknowledged as soon as practical, but
no response-time or reward commitment exists before a funded bug bounty is
announced.

## Scope

The current review boundary is documented in
`docs/security/audit-scope.md`. Third-party infrastructure, wallet clients,
and unaudited deployments are outside the repository's security guarantees.
