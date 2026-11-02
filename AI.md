# AI policy

Bardesk accepts contributions made with the help of AI tools (LLM coding assistants).
This policy says how. It applies to code, tests, documentation, issues and reviews.

## Rules

1. **A human is responsible.** The person who submits a change is its author. They have
   read, understood and tested all of it and can explain it in review. "The AI wrote it" is
   not an answer.
2. **A human decides.** Requirements, architecture and design decisions are made by people.
   AI tools may draft and propose; they do not decide.
3. **Disclose AI help** in the commit message with a trailer:

   ```
   Assisted-by: <tool or model> <version>
   ```

   for example `Assisted-by: Claude Opus 5.5`. Use one line per tool. Do not use
   `Co-authored-by` for AI tools; it is for human co-authors. In a pull request, say
   briefly what the tool did.
4. **No autonomous agents.** An AI tool must not open pull requests, push, merge, comment or
   release on its own. A human reviews and submits every action.
5. **Same quality bar.** AI-assisted changes follow [`CONTRIBUTING.md`](CONTRIBUTING.md) and
   [`AGENTS.md`](AGENTS.md): no workaround code, fixes based on evidence, tests for every
   change, green CI.
6. **Licence.** Contributions are licensed under GPL-3.0-or-later. Do not submit output
   that reproduces third-party code or text you may not license this way. Make sure the
   tool's terms allow you to contribute its output.
7. **Privacy and secrets.** Never give AI services secrets, credentials or personal data
   (including real member data, emails or logs from an installation).
8. **Security reports** are written and checked by a human. If an AI tool found the issue,
   say so in the report (see [`SECURITY.md`](SECURITY.md)).

## How the maintainers use AI

The maintainers develop Bardesk with Claude Code (Anthropic models, for example Claude Opus
5.5, Claude Fable 5.1 and Claude Sonnet 5.5) under the same rules: they own the design,
review every change, run the test suite and test releases in real use before publishing.

## Background

This policy follows common open-source practice, for example the AI tool policies of
[LLVM](https://llvm.org/docs/AIToolPolicy.html),
[Fedora](https://docs.fedoraproject.org/en-US/council/policy/ai-contribution-policy/) and
[Mesa](https://docs.mesa3d.org/submittingpatches.html).
