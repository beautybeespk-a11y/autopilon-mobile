# Beta Testing — Operator Guide

For you (the platform owner), not beta users — see `BETA_USER_GUIDE.md` for
what to hand them.

## Adding a beta user (current, honest workflow)

There is **no invitation-email system** yet (no email delivery exists on
this deployment at all — see `PRODUCT_OVERVIEW.md`). Public signup is
intentionally closed (`PUBLIC_SIGNUP_ENABLED=false`). Until a real invite
system is built, the practical way to add someone is:

```bash
cd /opt/autopilon
sed -i 's/^PUBLIC_SIGNUP_ENABLED=.*/PUBLIC_SIGNUP_ENABLED=true/' .env
./deploy.sh
```

Have the person sign up at `https://autopilon.com` directly. Once they've
created their account (or you've created a small batch of accounts this
way), close signup again:

```bash
sed -i 's/^PUBLIC_SIGNUP_ENABLED=.*/PUBLIC_SIGNUP_ENABLED=false/' .env
./deploy.sh
```

**This is a real, documented limitation** — every account creation
currently requires this manual open/close cycle. A proper invite-token
system (generate a one-time signup link per invitee, no need to reopen
signup at all) is a reasonable next investment once the beta group grows
past a handful of people, but wasn't built in this phase per the explicit
instruction not to invent a fake email system.

## Managing beta users

**Admin Panel** (`/app/admin`, visible only to your platform-admin account)
currently shows: organizations (with plan/usage), billing activity,
feature flags, marketplace moderation, and — new this phase — a
**Beta feedback** section listing every submission with the sender's
name/email, which page they were on, and a status you can move through
New → Reviewed → Resolved.

What it does **not** yet show in one place: a flat list of every user
account with last-login/activity. Organizations show member lists; there's
no separate all-users admin view yet. For a beta of 5–10 people this is
manageable by checking each organization; it's worth building a dedicated
Users tab if the beta group grows meaningfully.

## Reading feedback

Admin Panel → scroll to **Beta feedback**. Each entry shows type
(bug/feature/general), the submitter, which page they were on, and their
message. Update the status dropdown as you triage.

## Recommended beta rollout

Matches what you described: start with 5–10 people you can personally
observe. Concretely:

1. Add each person via the manual signup-toggle above (batch them in one
   open/close cycle rather than reopening signup repeatedly).
2. Send them `BETA_USER_GUIDE.md` (or just point them at the app — the
   in-app onboarding covers the same ground).
3. Watch **Admin Panel → Beta feedback** and **Admin Panel → Billing
   activity/Organizations** for real usage patterns and any spend/quota
   surprises.
4. Fix what you learn, then expand the group.

## Known limitations affecting the beta specifically

- No email notifications — beta users only see things inside the app.
- No self-serve signup — every account is manually enabled, see above.
- No dedicated "all users" admin list yet — check per-organization.
- Product analytics (sign-ins, onboarding completion, first-agent-created,
  etc.) are not instrumented yet — `Admin Panel`'s existing data
  (organizations, billing activity, API usage) is the closest real signal
  available today. Treat direct observation of your 5–10 beta users as the
  primary signal for this first round, not a dashboard.
