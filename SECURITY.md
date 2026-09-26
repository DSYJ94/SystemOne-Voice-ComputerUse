# Security status

Pre-release development only. There is no application or effectful executor yet.
Do not give this repository production credentials, OS permissions, personal
browser profiles or user recordings for its current tests.

The design treats provider output and application/page text as untrusted data.
Structural validation and digest agreement are not execution authority. Future
host authentication, scope/argument policy, one-use permits, dispatch fencing and
durable recovery must be tested before enabling live effects.

Do not post secrets or personal traces in public issues. A private vulnerability
reporting channel and response owner must be configured before public release.
Until then, use the repository owner's established private contact.
