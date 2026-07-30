# Running this on Replit

This zip is packaged so the files sit at the repl root (no nested folder).

## Steps
1. Replit → Create Repl → **Import** → upload this zip
   (or: Create a blank **Node.js** repl, then ⋮ → Upload, unzip in Shell).
   If you uploaded the zip into a repl, run this once in the **Shell**:
       unzip *.zip -d . && rm *.zip && ls
   You should see: client/ server/ package.json .replit replit.nix

2. Left sidebar → **Tools → Secrets**. Add:
   - SESSION_SECRET      = any long random string
   - AI_PROVIDER         = anthropic        (or openai / gemini)
   - ANTHROPIC_API_KEY   = your key         (match the provider above)

3. Press **Run** (green button). First boot takes a few minutes — it installs
   both apps, compiles SQLite, builds the frontend, then starts the server.
   When the webview loads the landing page, you're live.

## First-boot check
Sign up → dashboard → Settings (should say your provider IS configured)
→ AI Chat → send a message → you should get a real reply.

## If Run is slow every time
After the first success, open `.replit` and change the run line to:
    run = "npm start"
Only re-run a build (`npm run build`) when you change frontend code.

## If the webview stays blank
Add a Secret `PORT` = `3000` and press Run again.
