# Contributing

Contributions are welcome — features, bug fixes, documentation improvements, and tests are all valuable.

## Before You Start

1. Read [Getting Started](/getting-started) to set up a working local environment.
2. Read [Development Workflow](/development) to understand the monorepo structure and common commands.
3. Check open issues and pull requests on GitHub to avoid duplicating work.
4. For large features or architectural changes, open an issue first to discuss the approach before writing code.

## Contribution Flow

```
1. Fork the repository (or create a branch if you have write access)
2. Create a feature branch from main
3. Make your changes
4. Run local checks (see below)
5. Open a pull request against main
```

### Branch Naming

Use a short, descriptive name:

```
feature/watch-party-hls
fix/turn-credential-expiry
docs/voice-architecture-update
```

## Local Checks

Run these before opening a pull request.

**Web client:**

```sh
cd client
npm run lint    # ESLint
npm run build   # Verify the production build succeeds
```

**Backend:**

```sh
cd server/Abyss.Api
dotnet build
```

**Docs:**

```sh
npm run docs:build
```

There is no automated test suite currently. Testing your change manually against a running local environment is expected.

## Pull Request Guidelines

- **Explain what changed and why** — the PR description is the right place for context that doesn't belong in commit messages.
- **One logical change per PR** — keep PRs focused. If you find unrelated improvements while working, open a separate PR.
- **Mention migration impact** — if your change adds or modifies EF Core migrations, call it out explicitly. Reviewers need to assess whether the migration is reversible and what downtime risk it carries.
- **Mention configuration changes** — if you add or rename an environment variable, update `docs/configuration.md` in the same PR.
- **Screenshots or GIFs for UI changes** — visual changes are much easier to review with before/after media.
- **Call out deferred work** — if you're intentionally leaving something for a follow-up, note it in the PR description.

## Commit Messages

Follow the conventional format:

```
<type>: <short description>

<optional body explaining why>
```

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `style`

Examples:

```
feat: add per-channel notification mute
fix: prevent voice oscillation when relay is already active
docs: expand TURN configuration section
```

## Code Style

- **TypeScript:** Follow the existing ESLint config. Run `npm run lint` before committing.
- **C#:** Follow the existing patterns in the codebase (PascalCase for public members, async/await throughout). The project targets .NET 10 and uses nullable reference types.
- **No unnecessary abstraction:** Prefer direct code over over-engineered helpers. If something is used once, write it inline.
- **No speculative features:** Implement what is needed now, not what might be needed later.

## Documentation Standards

When your change affects user-facing behavior or configuration:

- Update the relevant page in `docs/`.
- Use exact environment variable names and exact file paths — no paraphrasing.
- Include concrete commands, not descriptions of commands.
- Link to related pages using relative VitePress links, e.g. `[Configuration](/configuration)`.

If you're adding a new doc page, add it to the sidebar in `docs/.vitepress/config.mts`.

## What Makes a Good Contribution

- Bug fixes with a clear description of the root cause and the fix
- Features that align with the project's goal: a self-hosted, feature-complete chat platform
- Documentation improvements that fill gaps or correct inaccuracies
- Performance improvements with measurable impact

Thank you for contributing to Abyss.
