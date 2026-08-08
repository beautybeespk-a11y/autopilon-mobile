# Real document uploads + "attach a file in chat" — setup

## 1. Install the new server dependencies

```bash
cd /workspaces/ai-factory/server
npm install multer pdf-parse mammoth
```

## 2. Install this zip's files

```bash
cd /workspaces/ai-factory
unzip -o document_upload_and_chat_attach.zip -d .
```

This overwrites:
- `server/routes/research.js` — adds upload + download endpoints
- `server/routes/chat.js` — accepts an optional attachment on a message
- `server/orchestrator/conversationService.js` — separates what's stored/
  shown (short) from what the model sees (short + full attachment text,
  for that one turn only)
- `server/orchestrator/index.js` — accepts `extraContext`, appended to the
  model's view of the conversation without touching the DB-stored history
- `client/src/lib/api.js` — adds multipart upload support
- `client/src/pages/Knowledge.jsx` — real upload/download UI
- `client/src/pages/Chat.jsx` — wires up the paperclip button to real
  upload + attach-to-message

And adds:
- `server/tools/research/documentExtract.js` (new — PDF/DOCX/text extraction)

## 3. Keep uploaded files out of git

```bash
echo "server/uploads/" >> .gitignore
```

## 4. Restart the server

Whatever you normally do to restart it (e.g. `npm run dev` in `server/`
with `--watch` will pick this up automatically; otherwise restart manually).

## 5. Rebuild the web client if it's served as a static build

```bash
cd /workspaces/ai-factory/client
npm run build
```

## What changed

### Knowledge > Uploaded documents
Uploading a file now actually uploads it — stored under
`server/uploads/knowledge/`, with a `knowledge_items` row
(`type = 'document'`) created for it. Text is extracted from PDF, DOCX,
TXT, MD, CSV, JSON, and LOG files and stored alongside the item, making it
automatically searchable by your agents via the existing `search_knowledge`
tool (no new agent tool needed). Other file types still upload and can be
downloaded, but aren't text-searchable yet. 15MB upload limit per file.

### Chat > Attach a file
The paperclip button in the chat composer is now live. Pick a file, and
its content becomes available to the agent for that message — you can
type a question about it, or send with no text and it'll just review the
file. Under the hood:
- The file is uploaded through the same endpoint as Knowledge uploads, so
  it's saved and searchable later too.
- What's stored/shown in the chat transcript stays short (just "📎
  filename.pdf" + whatever you typed) — the full extracted text (up to
  8,000 characters) is only added to what the model sees for that one
  turn, so reopening the conversation later doesn't replay a wall of
  pasted file content.
- Files whose content can't be extracted (images, legacy `.doc`, etc.)
  still attach and upload, with a small "not searchable" note.
