# Autopilon — Product Overview

What this product actually does today, in plain language — written for anyone
new to it, not just engineers. If a capability isn't listed here, assume it
doesn't exist yet rather than assuming it does.

## What it is

Autopilon lets you create **AI agents** — assistants with a specific job,
a personality, and real access to tools — and either talk to them directly
or let them run on their own when something happens.

It's not just a chatbot. A chatbot answers questions. An Autopilon agent can
also **do things**: search the web, read and manage files, send WhatsApp
messages, manage a WooCommerce/Shopify store, publish WordPress content,
read/draft Gmail, and more — depending on which skills and integrations
you give it.

## The core concepts

- **Agent** — an AI assistant with a name, instructions ("what should this
  agent do and how"), a personality, and a set of skills/integrations it's
  allowed to use. You can create one from scratch or install a ready-made
  template from the Agent Library.
- **Skill** — a specific capability an agent can use, e.g. web research,
  reading files, or managing a WooCommerce store. Skills are what an agent
  is *able* to do; you choose which ones each agent gets.
- **Integration** — a real connection to an outside tool (Gmail, WhatsApp
  Business, WooCommerce, Shopify, Google Workspace, Meta Ads, WordPress,
  and more). An agent can only use a skill that needs an integration once
  that integration is actually connected.
- **Automation** — a workflow that runs an agent (or a sequence of steps)
  automatically when a trigger happens, instead of you starting the
  conversation yourself.
- **Project / Task** — a lightweight way to keep related work — and the
  agent activity tied to it — organized in one place.
- **Knowledge** — documents you upload that agents can reference and cite
  when answering, instead of relying only on general knowledge.

## What's genuinely implemented right now

- Web app and Android mobile app, both talking to the same production
  backend — no separate mobile-only feature set.
- Real AI chat (OpenAI/Anthropic/Gemini, whichever provider is configured),
  with tool-calling — an agent can actually invoke a skill mid-conversation,
  not just describe what it would do.
- A starter Agent Library with 11 ready-to-install templates across 9
  categories (marketing, support, research, content, ecommerce, publishing,
  analytics, productivity, automation).
- Real integrations: Gmail, Google Calendar/Drive/Docs/Sheets, WhatsApp
  Business, WooCommerce, Shopify, WordPress, Meta Ads, Slack, Telegram.
- Automations that trigger agents from real events.
- File Manager (upload, organize, share, version).
- Content Studio (AI-assisted content/image/video generation).
- Organizations — invite teammates, share agents within an org, per-org
  usage tracking and quota limits.
- SEO audit skill — an agent can audit a page's on-page SEO (title, meta
  description, headings, alt text, canonical/robots tags) and check Core
  Web Vitals/page speed via Google PageSpeed Insights. This does NOT
  include keyword rank tracking or competitor backlink analysis — those
  need a paid third-party SEO data provider, not built yet.
- A public developer API + SDKs (JS/TS, Python) for anyone who wants to
  build against the platform programmatically.

## What's explicitly NOT implemented yet

Being direct about this matters more during a beta than a polished feature
list:

- **Email delivery** — no outbound email exists yet (invites, password
  resets, notifications are all in-app only, not emailed).
- **Payment/billing collection** — Stripe integration exists in the code
  but isn't configured on this deployment; no real charges happen.
- **iOS app** — Android only; iOS needs a Mac + Xcode, not attempted yet.
- **Public self-signup** — intentionally closed during the beta; access is
  by invitation only (see `BETA_USER_GUIDE.md`).

## Who it's for

Small businesses and individuals who want AI help that can actually take
action — not just chat — without needing to hire a developer or manage
a dozen disconnected tools. Marketers, store owners, and anyone managing
repetitive digital-communication work are the closest fit today, since
those are the integrations and skills that are most mature.
