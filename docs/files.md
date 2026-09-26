# Photos and documents

Users send photos and files on Telegram or WhatsApp: a receipt, a letter, a contract, an
expenses spreadsheet. The assistant reads them and uses them with its other tools ("add
this receipt to my expenses sheet", "put this meeting in my calendar", "summarise this").

| What | How the model sees it | Limit |
| --- | --- | --- |
| Photos (JPEG, PNG, WebP, GIF), sent as a photo or as a file | the image itself | 5 MB |
| iPhone photos in HEIC/HEIF, sent as a file | converted to JPEG, long edge ≤ 2048 px | 10 MB |
| PDF | the document itself: text, and scans/charts as pages | 10 MB |
| Word (.docx), Excel (.xlsx), PowerPoint (.pptx) | text we extract (`packages/files`) | 10 MB, 100k characters |
| Text, CSV, TSV, Markdown, JSON, XML, YAML | the text | 10 MB, 100k characters |

Anything else (old .doc/.xls, zip, video) gets a short reply listing what works.

**HEIC:** iPhones shoot HEIC, but WhatsApp and Telegram convert a picture sent as a *photo*
to JPEG. HEIC arrives only when it's sent as a *file* (from the Files app, or Telegram's
"send as file"). Neither model API accepts HEIC, so `packages/files/src/heic.ts` decodes
it with `heic-decode` (libheif compiled to WebAssembly, no native binaries), downscales
it, and encodes a JPEG with `jpeg-js`. A 12 MP photo takes about 0.1 s. libheif-js is
LGPL-3.0 and is used unmodified as a dependency; HEVC decoding may carry patent
obligations in some jurisdictions, so check this before a commercial launch.

Excel: every sheet by name, rows as tab-separated values, date cells as YYYY-MM-DD, up to
2,000 rows a sheet. Longer text is cut, and the model is told it only sees the first part.

```
photo / document message
  → worker, under the user's lock: store the message; type supported? size under the limit?
  → channel.downloadMedia (Telegram getFile; WhatsApp media id → short-lived URL → download)
  → toAttachment (packages/files): images and PDFs as they are, HEIC → JPEG, Office and text files → text
  → attachments row, expires in 3 hours
  → wait 2.5 s, outside the lock
  → did the user send anything newer (text, voice, photo, file)? then stop: that message
    is answered, with this file in view (photos sent together get one reply)
  → otherwise run the agent on the caption, with the file
```

- **Follow-ups:** files stay available for 3 hours, so "send photo, then type what to do" works.
  Each request shows the model the newest 4 files, up to 15 MB in total. Older ones are
  replaced by a note asking the user to send them again.
- **Retention:** the maintenance job deletes expired files every hour. The message row
  keeps only its caption (under the normal 30-day body retention). Audio is never stored;
  files are, for these 3 hours only, unencrypted in Postgres like message bodies (Render
  encrypts the disk). Before WhatsApp goes live, decide whether they need app-level
  encryption.
- **Logs:** format, size and character count only. Never the file name, the content or
  the extracted text.
- **Untrusted:** a file's content is data, not instructions. Text files are fenced in
  `<file_content>`, and photos and PDFs come after a line saying the user sent them and
  that the content is data. The system prompt's trust rules cover all of them. Outbound
  and money actions still need the user to press Approve. Evals: `injection-in-photo`,
  `injection-in-file`.
- **Providers:** Claude takes `image` and `document` (PDF) blocks. On OpenCode
  (gpt-6-luna), the adapter sends `input_image` and `input_file` parts. Both were checked
  live with a receipt photo and a PDF invoice.

## Save to Drive

After answering a photo or file, the bot adds a card: **📁 Save this photo to your Google
Drive?** with **Save to Drive** and **Not now** buttons. It covers every file answered in
that reply, so an album gets one card. The user can also just ask ("save this to my
Drive"), and the model calls `save_file_to_drive` with the file ids it sees next to each
file.

- **What is saved:** the file as sent, not what the model read. A .docx stays a .docx and a
  HEIC stays HEIC (`attachments.original`, kept only when it differs from the model's
  version). Files without a name are saved as e.g. "Photo 2026-09-26 19.30.jpg" in the
  user's timezone. Uploads are resumable, so files over Drive's 5 MB multipart limit work.
- **The button:** an ordinary action awaiting approval (`approvals.ts`), so it is
  single-use and the actions row exists before anything runs. It stays valid while the
  files are kept (3 hours), unlike the 15 minutes for sending. A second press gets "That
  was already done."
- **Not connected yet:** pressing Save sends the Google link and puts the action back to
  waiting (`error = needs_connection`, 15 minutes). When the user finishes connecting, it
  completes by itself (`resumeAfterConnection`), with no second press needed.
- **No card** when the request already saved the files, when Google isn't configured, or
  when the run failed. The model is told the button exists, so it doesn't offer it too.
- Saved files are private (`drive.file`: the app sees only files it created). "Undo" within
  10 minutes moves them to the trash.

## Try it on the dev bot

1. Send a photo of a receipt with the caption "what's the total?"
2. Send two or three photos at once with one caption: you should get a single reply.
3. Send a photo with no caption, then type "add this to my expenses sheet".
4. Send a PDF, a Word or an Excel file and ask for a summary.
5. From an iPhone, send a photo as a file (HEIC) and ask what's in it.
6. Send a .zip, or a photo over 5 MB as a file: you should get the "can't open" or
   "too large" reply.
7. Tap **Save to Drive** under a reply: you get the Drive link. Say "undo" to trash it.
8. Send a Word file, save it, and open it in Drive: it's the original .docx.
9. Send two photos together: one card, "Save these 2 files". Tap **Not now**.
10. Send a photo and say "save this to my Drive": it's saved, and no card appears.
