# Research: In-app notification providers for Cadence (Knock vs Novu vs MagicBell)

- **Date:** 2026-11-13
- **Ticket:** [#4 — Compare in-app notification providers for Cadence](https://github.com/manuelpires/cohort-005-project-fork/issues/4) (child of wayfinder map #3)
- **Status:** Resolved — shortlist at the end
- **Location note:** this repo had no existing research-notes convention (`docs/` holds ADRs and agent docs only); this file establishes `docs/research/` as the home for research findings, date-prefixed.

All claims below are sourced from each provider's **official documentation**, fetched 2026-11-13. Primary sources:

- Knock: <https://knock.app/docs> index plus the specific pages cited inline (canonical host `docs.knock.app`), and <https://knock.app/pricing>
- Novu: <https://docs.novu.co> (Mintlify; raw `.md` pages fetched), and <https://www.novu.co/pricing>
- MagicBell: <https://www.magicbell.com/docs> pages cited inline, and <https://www.magicbell.com/pricing>

## Cadence's constraints (what "fits" means)

From the map (#3) and the codebase:

- React Router v7 (SSR), Drizzle/SQLite, **no job/queue/scheduler infra** — triggers must fire synchronously from route actions/loaders.
- Email-only auth, **numeric user ids** (`app/lib/session.ts`), DevUI user switching.
- v1 is **strictly in-app** (Postmark stays), reactive only, per-type mute preferences in scope.
- Testing precedent: the mailer's `outboxTransport` fake (`app/lib/mailer.server.ts`) — we want a provider we can fake or sandbox in CI the same way.
- README already earmarks Knock with a free Developer account.

## Provider profiles

### Knock

**Pricing / free tier.** Free **Developer** plan: $0/mo, up to **10,000 messages** included ("messages" = one notification delivered to one user on one channel — an in-app-only workflow consumes 1 per recipient). Beyond 10k you must upgrade; **Starter is $250/mo** with 50,000 messages included and $0.005 per additional message. Per-tenant preferences/branding, i18n, SSO/SCIM are Enterprise-only — none of those are Cadence v1 needs. Sources: [Knock plans and usage](https://docs.knock.app/manage-your-account/knock-plans), [pricing page](https://knock.app/pricing).

**In-app inbox.** Dedicated in-app feed channel: prebuilt feed/inbox/toast components **and** headless primitives; per-message `unseen`/`seen`/`read` statuses powering badge counts, filtering, mark-as-read; archiving; per-feed filtering. Realtime via a **managed websocket service** the SDKs manage automatically. Sources: [in-app feeds](https://docs.knock.app/integrations/in-app/feeds), [real-time socket behavior](https://docs.knock.app/in-app-ui/feeds/socket-behavior), [React SDK overview](https://docs.knock.app/in-app-ui/react/sdk/overview).

**React / React Router v7 fit.** `@knocklabs/react` (on `@knocklabs/client`): `KnockProvider` + feed components or headless hooks (`useNotifications`, `useNotificationStore`). Client-side components; SSR story is "render provider in a client boundary, pass a user token from the server". In production you enable **enhanced security**: sign an RS256 JWT per user server-side with `signUserToken(userId)` (`@knocklabs/node/lib/tokenSigner`) — trivially done in a React Router `loader` and handed to `KnockProvider` via `userToken`. Source: [security + authentication](https://docs.knock.app/in-app-ui/security-and-authentication).

**Server-side trigger.** `POST /v1/workflows/{workflow_key}/trigger` with the environment secret key (Node SDK `@knocklabs/node`) — a plain fetch from a route action. **Inline identification** upserts recipient data (id, email, custom properties) *in the same trigger call*, so no separate user-sync job is needed — important given no queue infra. Sources: [workflows concept](https://docs.knock.app/concepts/workflows), [identifying recipients](https://docs.knock.app/managing-recipients/identifying-recipients).

**Identity mapping.** `id` = "your internal user identifier" (only required property; numeric id as string is fine), `email`/`name`/`avatar` etc. as properties; direct, inline, or bulk identification. Auto-creation of unknown recipients via inline identification. Source: [identifying recipients](https://docs.knock.app/managing-recipients/identifying-recipients).

**Per-type preferences / mute.** `PreferenceSet` with booleans for `categories`, `workflows`, `channels`, `channel_types`; workflows get **categories**, so per-type mute is a first-class concept. Evaluation happens automatically at trigger time. **Preference conditions** cover per-resource muting ("mute notifications about this task"). Critical workflows can override preferences. Hosted preference center, custom preference center, or a prebuilt React `<Preferences/>` component + headless `usePreferences`. Source: [preferences overview](https://docs.knock.app/preferences/overview).

**Testability / CI.** Account ships with isolated **development and production environments** (own API keys, own data). **Sandbox mode** renders messages for dashboard preview without delivering or **counting toward usage** — explicitly recommended for non-production. Workflow test runner + debugger in the dashboard. Server-side, the Node client is a thin HTTP wrapper — easy to fake behind an `outboxTransport`-style seam in CI. Sources: [environments](https://docs.knock.app/version-control/environments), [knock plans (sandbox mode)](https://docs.knock.app/manage-your-account/knock-plans).

### Novu

**Pricing / free tier.** Novu Cloud is **free up to 10,000 workflow runs/month** (a run = one trigger to one subscriber after fan-out); overage "rolls into on-demand pricing" (pricing page shows $1.20 per 1K); **Business $250/mo**; Enterprise custom; unlimited subscribers on paid plans; notifications are never throttled when you exceed the limit. **Open-source and self-hostable** — a real escape hatch the others don't have. Caveat for us: billing counts runs "across **all environments**", so dev/test triggers consume the same allowance (no Knock-style usage-free sandbox). Sources: [novu.co/pricing](https://www.novu.co/pricing) (plan table + FAQ JSON-LD), [environments](https://docs.novu.co/platform/developer/environments).

**In-app inbox.** `<Inbox />` component (bell + feed + built-in Preferences view), tabs/filters, snooze, unread counts, read/archive actions, all "synchronized with the Novu backend in real-time". Realtime transport is explicit: headless hooks listen to **websocket events** (`notifications.notification_received`). Full headless mode via `@novu/react` hooks (`useNotifications`, `useCounts`). Sources: [Inbox overview](https://docs.novu.co/platform/inbox), [headless mode](https://docs.novu.co/platform/inbox/headless-mode).

**React / React Router v7 fit.** `@novu/react` requires **React 18+** (React 19 supported). Novu maintains a **React Router quickstart** — `<Inbox routerPush={(path) => navigate(path)} />` wired to `useNavigate()` — the only provider of the three that documents our router explicitly. Production requires **HMAC** (`subscriberHash`) enabled on the Inbox, computed server-side (loader). Sources: [React quickstart](https://docs.novu.co/platform/quickstart/react), [Inbox FAQ (React versions, HMAC)](https://docs.novu.co/platform/inbox), [prepare for production](https://docs.novu.co/platform/inbox/prepare-for-production).

**Server-side trigger.** `POST https://api.novu.co/v1/events/trigger` with the environment secret key, or `novu.trigger({ name, to: [{ subscriberId }], payload })` in the Node SDK — a direct call from a route action. **Just-in-time subscriber creation**: if the subscriber doesn't exist, the trigger creates/updates them from the `to` payload (including `email`). A workflow must be **published** to production before a production trigger runs it. Sources: [trigger workflow](https://docs.novu.co/platform/workflow/trigger-workflow), [subscribers](https://docs.novu.co/platform/concepts/subscribers).

**Identity mapping.** `subscriberId` = "your application's internal user ID… the same id your application uses for that user" (stringified numeric id works); `email` is profile data; auto-create on trigger or ahead of time. Source: [subscribers](https://docs.novu.co/platform/concepts/subscribers).

**Per-type preferences / mute.** Three layers: workflow channel preferences (dashboard/code), subscriber **global** channel preferences, and subscriber **per-workflow** channel preferences — most specific wins; `critical` workflows bypass subscriber preferences entirely. Preferences are exposed to users through the Inbox's built-in Preferences view, a dedicated `<Subscription/>` component, headless hooks, and REST endpoints. Per-type mute maps to per-workflow preferences (one workflow per notification type). Source: [preferences](https://docs.novu.co/platform/concepts/preferences).

**Testability / CI.** Free plan includes **development + production environments** (custom envs are paid): isolated API keys, subscribers, activity; workflows are edited in dev and published to prod. Dashboard "Test workflow" runner for ad-hoc triggers. No usage-free sandbox equivalent found in docs — dev-env runs count toward the monthly total (10k free runs is ample for Cadence + CI, but it's a shared pot). Server client (`@novu/api`) is fakeable like the others. Sources: [environments](https://docs.novu.co/platform/developer/environments), [pricing FAQ](https://www.novu.co/pricing).

### MagicBell

**Pricing / free tier.** **Builder** free: $0/mo, **1,000 deliveries/mo**, **1 project**, unlimited users/team members. **Startup $249/mo**: 50,000 deliveries + $0.0025 per additional, 5 projects ($99 per extra project). A delivery = one user × one channel. This is the tightest free tier of the three (10× smaller than Knock/Novu) and the single-project limit collides with their own "create projects for staging/production" go-live guidance — a second (staging) project is effectively a paid feature. Source: [magicbell.com/pricing](https://www.magicbell.com/pricing), [quick start (go live)](https://www.magicbell.com/docs/quick-start).

**In-app inbox.** Core product: notification feed with read/unread/seen/archived states, infinite scroll, real-time delivery over a **persistent connection** (websocket), unread counts, themable/embeddable inbox; preferences UI for per-channel and per-category control. Sources: [in-app channel](https://www.magicbell.com/docs/channels/in_app), [notification primitive](https://www.magicbell.com/docs/primitive/notification).

**React fit.** `@magicbell/react`: `ContextProvider` (takes a **User JWT** generated on your own server), `FloatingInbox`, `Inbox`, `UserPreferences`, toasts; headless via `@magicbell/js`. Also Preact/Svelte/Web Components. Client-side components like the others; JWT generation fits a loader. Source: [React components](https://www.magicbell.com/docs/libraries/magicbell-react).

**Server-side trigger.** Everything routes through **broadcasts**: `POST /broadcasts` with Project JWT auth and explicit `recipients` (users or topics); broadcasts carry `title`, `content`, `action_url`, `category`, `custom_attributes`, channel overrides; notifications are materialized per recipient. Callable from a route action. Sources: [broadcast primitive](https://www.magicbell.com/docs/primitive/broadcast), [quick start](https://www.magicbell.com/docs/quick-start).

**Identity mapping.** Accepts **email or `external_id`**; `external_id` maps to "your app's DB records (typically the `user_id`)", is immutable once set, and is their recommended production identifier — numeric ids must be **cast to string**. Upserts everywhere; users auto-created on the fly. External IDs take precedence over email. Excellent direct fit for Cadence's numeric ids + email. Source: [user primitive](https://www.magicbell.com/docs/primitive/user).

**Per-type preferences / mute.** Per-channel preferences + **category-based subscription management** (broadcast `category` groups notifications for preference purposes); `UserPreferences` React component and REST endpoints. Covers per-type mute, though the model (string categories on broadcasts) is lighter-weight than Knock's structured preference sets. Sources: [in-app channel](https://www.magicbell.com/docs/channels/in_app), [broadcast primitive](https://www.magicbell.com/docs/primitive/broadcast).

**Testability / CI.** Multi-project separation for staging/production exists but is paywalled beyond one project (see pricing). No documented sandbox/usage-free mode or CI guidance found in the docs we reviewed. Docs are noticeably thinner than Knock/Novu (fewer concepts, smaller pages, community support via GitHub Discussions).

## Comparison at a glance

| Criterion | Knock | Novu | MagicBell |
| --- | --- | --- | --- |
| Free tier | 10,000 msgs/mo | 10,000 workflow runs/mo | 1,000 deliveries/mo |
| First paid plan | Starter $250/mo (50k msgs, $0.005 ea.) | Business $250/mo (on-demand $1.20/1K runs) | Startup $249/mo (50k deliveries, $0.0025 ea.) |
| Pricing cliff risk | Low for v1 scale | Low; no throttle; self-host escape hatch | High: 1k/mo + 1 project on free |
| Does test usage burn quota? | **No** (sandbox mode is usage-free) | Yes (all environments count) | Unclear; no sandbox documented |
| Feed + unread state | unseen/seen/read, badges, archive, filters | unread/unseen counts, tabs, snooze, archive | read/unread/seen/archived, infinite scroll |
| Realtime | Websocket (managed, SDK-handled) | Websocket events | Persistent connection (websocket) |
| Prebuilt + headless React | Yes (`@knocklabs/react`) | Yes (`@novu/react`, React 18+) | Yes (`@magicbell/react` + `@magicbell/js`) |
| React Router v7 documented? | Generic React (token via loader; works fine) | **Official React Router quickstart** | Generic React (JWT via loader; works fine) |
| SSR-friendly auth | RS256 user token signed in loader | HMAC `subscriberHash` from server | User JWT minted by server |
| Trigger from route action | `POST /v1/workflows/{key}/trigger`; inline identify+trigger in one call | `POST /v1/events/trigger`; JIT subscriber create | `POST /broadcasts` with recipients |
| Numeric id + email mapping | `id` = internal id, email property, inline upsert | `subscriberId` = internal id, email profile, JIT | `external_id` = user_id (stringified), email, upsert |
| Per-type mute | Workflow **categories** + per-resource **preference conditions** | Per-workflow + global prefs; critical bypass | Broadcast **categories** + channel prefs |
| Preferences UI | Prebuilt React component, hosted, or headless | Built into Inbox + Subscription component + headless | `UserPreferences` component |
| CI story | Dev/prod envs, **usage-free sandbox**, test runner, CLI | Dev/prod envs (free), publish flow, test workflow; runs count | Projects paywalled beyond 1; no sandbox docs |
| Self-host option | No | **Yes** (open source) | No |

## Shortlist recommendation

**1. Knock (primary).** Maps cleanest onto Cadence's constraints:

- **No job infra needed** — inline identification means the trigger call *is* the user sync; one `fetch` per domain event from a route action.
- **CI without quota anxiety** — sandbox mode renders but doesn't deliver or bill; dev environment has its own keys, matching the `outboxTransport` fake-it-in-CI precedent.
- **Per-type mute is native** — workflow categories give the PRD's per-type preferences for free, and preference conditions leave room for the map's later "mute a specific resource" questions.
- **Numeric-id friendly** — internal user id is the documented primary identifier; email is just a property.
- Free 10k messages/mo comfortably covers a course platform's reactive in-app volume; already earmarked in the README, so no new vendor onboarding.
- SSR/auth fits React Router: `signUserToken` in a loader → `KnockProvider` in a client boundary.

**2. Novu (strong fallback).** The only provider with an officially documented **React Router** integration path, a comparable 10k free tier, no-throttle overage, and a unique **self-host escape hatch** (open source). Choose it over Knock if we value the escape hatch and its all-in-one Inbox (preferences UI built in) more than Knock's usage-free sandbox and richer preference model. Watch: HMAC is mandatory before production, dev/test triggers share the billing allowance, and workflows must be published before production triggers run.

**MagicBell: not shortlisted.** Its identity model (`external_id`) is arguably the best literal fit for Cadence's numeric ids, but the 1,000-delivery free tier, the one-project limit (staging as a paid extra), and the thinnest docs/testing story of the three make it a clear third for a strictly-in-app v1.

**No fourth candidate beats these three** for an in-app-only alert layer with prebuilt React UI at Cadence's scale (Courier et al. are heavier cross-channel platforms; building a feed by hand is out of scope by the map's premise — third-party delivery is the decision being made).

**What this doesn't decide:** final provider choice (map owner's call between the shortlist), per-notification copy, batching semantics, and deleted-source behaviour — those stay with the map's open questions.
