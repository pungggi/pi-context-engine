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
- **Local by default**: the index and memory database live on disk on your
  machine, and embeddings are computed locally (ONNX model) or by a local
  Ollama at `localhost:11434`.
- **Remote endpoint caveat**: if you configure a remote Ollama
  (`PCE_OLLAMA_URL` or `compression.ollama_url`), chunk text and memory text
  are sent to that endpoint for embedding. That configuration is the user's
  responsibility, including how the endpoint handles the data.
- Reports about data handling (secret redaction, PII scrubbing, path
  validation) are especially welcome.

## Handling

- Fixes ship as patch/minor releases; advisories are published after the fix
  is available.
- We ask for 90 days of coordination before public disclosure, but we will
  not hold a fix hostage to that window.
