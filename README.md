# AI Agent Platform — Phase 1 Foundation

A clean, scalable foundation for a universal AI agent platform. Web-first,
fully responsive, and structured so integrations and advanced AI features can be
added later without rebuilding.

Stack: **React + Vite + Tailwind** (client) · **Node + Express + SQLite** (server).
Chosen over Next.js deliberately so the frontend stays portable toward
React Native / Expo later.

---

## Quick start

```bash
# 1. Install everything (root, server, client)
npm run install:all

# 2. Configure environment
cp .env.example server/.env
#    then edit server/.env — set SESSION_SECRET and one AI provider key

# 3. Run both apps (client on :5173, server on :4000)
npm run dev
```

Open http://localhost:5173, create an account, and you're in.

### Single-service production build
```bash
npm run build      # builds client into client/dist
npm start          # server serves the API + the built client on one port
```
This is the shape to deploy to Railway / Render / Replit: one Node service.

---

## 1. What was built

- **Public**: Landing, Login, Sign up, Forgot password
- **App (protected)**: Dashboard, AI Chat, My Agents, Agent Builder, Skills,
  Automations, Integrations, Knowledge, Tasks, Activity, Settings
- **Real auth**: signup / login / logout / password-reset stub, session cookies,
  hashed passwords, server-protected routes
- **Real AI chat**: messages go through the backend to the configured provider;
  conversations + messages are persisted
- **Provider abstraction**: OpenAI / Anthropic / Gemini behind one interface
- **Agent Builder + Skill Registry**: create agents with personality,
  instructions, and selectable skills (skills are data, not hardcoded)
- **Dashboard**: greeting, quick prompt, quick actions, live overview counts,
  recent activity — all reading from the database
- **Light/dark mode**, responsive layout, mobile bottom nav + slide-out drawer
- **Signature component** `ToolActivity` — the agent trace rail
  (Planning → Researching → Using tool → Waiting → Completed), ready to render
  real tool runs inline later

Nothing is faked: integrations show real "not connected" status, and the chat
shows **"AI provider not configured"** when no key is set instead of pretending.

## 2. Project structure

```
ai-agent-platform/
├── package.json            # root scripts (dev / build / start)
├── .env.example
├── server/                 # Express API
│   ├── index.js            # app wiring, session, static serve
│   ├── db.js               # SQLite schema + skill seed
│   ├── middleware.js       # requireAuth, activity logging
│   ├── ai/
│   │   ├── provider.js     # abstraction + provider status
│   │   └── providers/      # anthropic.js · openai.js · gemini.js
│   └── routes/             # auth, chat, agents, skills, integrations,
│                           #   tasks, activity, dashboard
└── client/                 # React + Vite
    └── src/
        ├── lib/            # api, auth ctx, theme ctx, skill registry
        ├── components/     # Sidebar, MobileNav, Topbar, Layout,
        │                   #   ToolActivity, ProtectedRoute, ui/
        └── pages/          # one file per page
```

## 3. Database schema (SQLite)

Tables: `users`, `agents`, `skills`, `agent_skills`, `conversations`,
`messages`, `memories`, `integrations`, `tasks`, `activity_logs`.
Foreign keys and indexes are in place; schema is additive-friendly for
future migrations. See `server/db.js`.

## 4. Authentication status

**Working.** Database-backed users, bcrypt-hashed passwords, `express-session`
with a SQLite session store, httpOnly cookies. `requireAuth` guards every
`/api` resource; the client `ProtectedRoute` blocks the app shell for
signed-out users. Password reset is a safe stub (no email delivery yet).

## 5. AI provider setup status

**Architecture complete; activation is one env var + one key.**
Set `AI_PROVIDER` to `anthropic` | `openai` | `gemini` and provide that
provider's key. Until then, the app honestly reports "AI provider not
configured" in chat and in Settings. Keys live only on the server.

## 6. Next phase (suggested order)

1. Streaming responses + the `ToolActivity` rail driven by real tool calls
2. Tool/function-calling execution framework (approval gate already designed)
3. Knowledge processing: parse → chunk → embed → retrieve
4. Long-term memory read/write during chat
5. First real integration — **Meta Ads** (OAuth + connection status)
6. Automations (triggers + scheduled agent runs)
7. Package the web UI toward React Native / Expo

## 7. Environment variables

| Variable | Where | Required | Notes |
|---|---|---|---|
| `PORT` | server | no | defaults to 4000 |
| `SESSION_SECRET` | server | yes | long random string |
| `AI_PROVIDER` | server | yes | `anthropic` \| `openai` \| `gemini` |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | server | if using Anthropic | |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | server | if using OpenAI | |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | server | if using Gemini | |
| `CLIENT_ORIGIN` | server | no | only for cross-origin deploys |

Renaming the app: the name lives only in UI strings (search
`AI Agent Platform`) and the `<title>` in `client/index.html`.
