<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://getkite.sh/logo-on-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://getkite.sh/logo-on-light.svg">
    <img alt="Kite" src="https://getkite.sh/logo-on-dark.svg" width="260">
  </picture>

  <h3>Kite SDK — emit events to Kite from your own code</h3>

  <p>
    <a href="https://getkite.sh"><img alt="Website" src="https://img.shields.io/badge/getkite.sh-00ff9d?style=flat-square&labelColor=0a0a0f"></a>
    <a href="https://getkite.sh/docs"><img alt="Docs" src="https://img.shields.io/badge/docs-00d4ff?style=flat-square&labelColor=0a0a0f"></a>
  </p>
</div>

---

Send events from your application straight into [Kite](https://getkite.sh) — they flow through the same pipeline as GitHub or Stripe webhooks and arrive in `kite stream`, `kite proxy`, and agent sessions as CloudEvents.

```
your app ──(SDK)──▶ api.getkite.sh ──▶ kite CLI / agents
```

## Packages

| Directory | Package | Status |
|---|---|---|
| [`typescript/`](./typescript) | `@getkite/sdk` (npm) | Unpublished |
| [`rust/`](./rust) | `kite-sdk` (crates.io) | Unpublished |

Both packages are verified from their packed artifacts in CI. Maintainers should
follow the [release runbook](./docs/RELEASING.md); source availability does not
mean either registry package has been published.

See the [changelog](./CHANGELOG.md) for release notes and the
[security policy](./SECURITY.md) for private vulnerability reporting.

## Quick look (TypeScript)

```ts
import { Kite } from "@getkite/sdk";

const kite = new Kite({
  teamId: "your-team",
  source: "my-app",
  token: process.env.KITE_HOOK_TOKEN!,
});

await kite.emit("com.myapp.user.signup", { userId: "u_123" }, {
  summary: "User u_123 signed up",
});
```

Create the endpoint and token with the [Kite CLI](https://github.com/Alpha-Centauri-Cyberspace/kite-cli):

```bash
kite endpoints create --source my-app
```

## Docs

- [Quickstart](https://getkite.sh/docs/quickstart)
- [Emitting events from your app](https://getkite.sh/docs/guides/emitting-events)
- [SDK reference](https://getkite.sh/docs/reference/sdk)

## License

[MIT](./LICENSE) © Alpha Centauri Cyberspace
