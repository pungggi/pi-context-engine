# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**, not in public issues:

1. Open a GitHub **Security Advisory**: Repository → Security → Advisories →
   "Report a vulnerability".
2. If you cannot use advisories, email the maintainer via the contact address
   on the GitHub profile (`pungggi`).

Include a description, reproduction steps, and impact. You will get an
acknowledgement within 7 days.

## Scope

- The npm package `pi-context-engine` and its GitHub repository
  (`pungggi/pi-context-engine`).
- Everything runs locally: the index, memory database, and embeddings never
  leave the machine. Reports about data handling (secret redaction, PII
  scrubbing, path validation) are especially welcome.

## Handling

- Fixes ship as patch/minor releases; advisories are published after the fix
  is available.
- We ask for 90 days of coordination before public disclosure, but we will
  not hold a fix hostage to that window.
