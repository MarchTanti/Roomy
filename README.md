# RoomyAI — AI Furniture Placement Chatbot

ผู้ช่วยคุยแนะนำเฟอร์นิเจอร์ แล้วลองวางของจริงลงในรูปห้องของคุณ — และแต่งห้องให้เป็นห้องทั้งห้อง

> Upload a photo of your room → chat about style and budget → see the chosen
> piece of furniture composited into your actual photo. Every picture is
> labelled as a simulation in the interface, under the picture.

> Or say "ฉันอยากได้ห้องสไตล์มินิมอล" — the assistant asks what is still unclear,
> has the plan confirmed, and then draws the room with real furniture from the
> catalogue, ready to be adjusted.

This repository holds all eight steps of the project. See the build plan at
the end of this README for what is wired in each of the eight steps, and
[`REPORT.md`](REPORT.md) for what the system actually did when it was tested.

## Stack

- **Next.js 16 (App Router) + React 19 + TypeScript**
- **Tailwind CSS 4**
- **Google Gemini API** with function calling (chat, room analysis, fit check,
  product comparison, room design) and native image editing — one key and one
  SDK for both. The chat and image sides sit behind their own small interfaces
  (`LlmProvider`, `ImageProvider`) so a future provider swap stays a
  one-file change.
- **Supabase** (Postgres + Storage) — adapter optional, see `DB_ADAPTER`
- **Pluggable `ImageProvider`** — Gemini adapter, one file to swap
- **Zod** for run-time validation
- **Vitest** for unit tests

## The interface

The UI was rebuilt around three decisions: the look of Gemini's chat — a blue
shopfront, a pale canvas, one vivid accent — a layout that works on a phone as
well as a desktop, and **no new dependency**: the markdown renderer, the
lightbox, the product illustrations and the design system are all hand-rolled.

**One set of tokens, two modes.** `app/globals.css` defines semantic colours
(`surface`, `raised`, `sunken`, `tint`, `band`, `line`, `ink`, `brand`, `ok`,
`warn`, `bad`) as CSS custom properties and maps them into Tailwind v4's
`@theme inline`. Each token holds both of its versions side by side, so a
component never has to know which mode it is in — there is not a single `dark:`
variant in the app. The palette is blue — a **deep blue band** (`--band:
#285098`) at the top of every page, a **pale blue canvas** (`--surface:
#ebf3fa`), white cards lifted off it by a hairline, and the **vivid blue**
(`--brand: #0058c8`) for the one action that matters. The dark theme is the
same picture read the other way round: a navy canvas, a deeper blue band, and
a brighter accent so it keeps carrying the eye.

The band is the only place the colour is allowed to be loud, and it changes
what a button can be: on the band the page's own blue is already the
background, so the quiet button is the band showing through (`.btn-band`) and
the one that matters is the band in reverse — white, with the band's blue for
the words (`.btn-band-primary`). The brand blue is two tokens, because one
value cannot be both a background and a line of text: `--brand` is bright
enough to read as text on a dark canvas, `--brand-fill` is deep enough to
carry white text.

**The theme switch** (`app/theme-toggle.tsx`) is a small button with a sun and
a moon in it — in the header of every page, and at the foot of the chat's left
rail, where a sidebar keeps the settings. CSS decides which one is showing,
from the same `data-theme` attribute the palette reads, so the button holds no
state of its own and the icon the server rendered can never disagree with the
one on screen. The choice is kept in `localStorage` under `roomy.theme`; with
nothing stored, the operating system's own preference wins.

The palette is applied before the first paint by a small script in the
document (`app/layout.tsx`, via `app/inline-script.tsx`) — the server cannot
know what the person chose, so without it a dark-theme user would get a white
flash on every load. That script is a copy of `resolveTheme` in
`lib/theme.ts`, because a script in the document cannot import anything; the
test in `tests/theme.test.ts` takes the shipped script out of the layout and
runs it against a fake browser, checking that it agrees with `resolveTheme` on
every input — including a browser that will not let it read the storage, where
the page is simply left in the server's light theme.

**Type.** `next/font/google` self-hosts Noto Sans Thai and Noto Serif Thai —
the server has no fonts installed, so the labels drawn into the pictures use a
bitmap font, but the interface needs a real Thai typeface. Both are variable
fonts, so one file covers every weight, and the display face is used for the
headings.

**The layout.** Two columns, the way a chat assistant is usually drawn: the
**left rail** and the **chat column** with the composer at the bottom. The rail
is one piece with four parts — the **mark** and the button that opens and
closes the rail at the top, the **conversation list** below it (every chat this
account has, and a button that starts a new one), the **tools** under that
(the room photo, the measurement, the style cards, the preference chips and the
live session state), and the **account and the theme switch** at the very
bottom. The chat
page has no band of its own: the rail is the only frame around the
conversation, so the conversation gets the whole column. The list is read from
`/api/history`, and clicking a conversation
reopens it — the transcript, the preferences, the measurement and the image
budget all come back with it. On a wide screen the rail stands beside the
chat; on a narrow one it slides in from the left as a drawer, and the backdrop
closes it. While the rail is closed a slim strip at the top of the chat column
holds the button that opens it again, in the place the mark sits when the rail
is open. The composer is a rounded well on a tinted band, with the send
button as a blue circle on the right.

**The style cards.** The styles in the rail are not chips with names on them —
they are **cards with a picture of a room in that style**, two to a row, the
way Gemini's own gallery shows a style. The seven pictures are drawn once by
`npm run style-examples` and kept in `public/style-examples/`, so nothing is
generated when the rail is opened and the examples never change under the
user's feet. Pressing a card sends the same sentence the chip used to send.

**The logo.** The mark is a blue rounded square with a white drawing of
a room and a sofa in it, and it is the same file everywhere: the blue band of
every page but the chat, the top of the chat's rail, the hero of the landing
page, the footer, the empty state of the chat, and the favicon. The ground of
the mark is one flat house blue — `#0058c8`, the blue of the buttons — so the
logo and the page it sits on are the same colour in both themes.
The name beside it is live text in the page's own type — the wordmark in the
picture is navy, and navy disappears on the dark canvas — so the brand reads
in both themes and the name can be selected and copied.
The way home is the logo itself: `app/home-button.tsx` puts the mark on a small
white tile with the name beside it, and every page opens with it — the landing
page, the sign-in, the history and the status page. On the blue band the tile
is what carries the mark (the blue of the mark and the blue of the band are too
close to tell apart), and the button stays quiet so it does not compete with
the one action that matters.
The chat page is the exception: it has no band of its own, and the mark sits
at the top of the left rail instead — the way home belongs at the top of the
rail on a page that is mostly a conversation, and the rail needs no tile,
because the mark is on the rail's own pale ground. The button that opens and
closes the rail sits beside it.
`scripts/make-logo.mjs` builds the assets from `assets/logo-source.png`, the
picture the logo came in. The shape of the mark is found rather than assumed:
the azure of the picture is one piece, and the square is closed around the
white drawing inside it, so the drawing is part of the mark and not a hole in
it. The mark keeps its own proportions and sits on a square of its own, so
the corners of it stay round.

The blue of that picture is a light azure, and the app's own blue is the deep
one of the buttons (`#0058c8`), so `scripts/logo-colour.mjs` repaints the mark
in the house colour. The drawing has to come off the ground first: the ground
is one colour, so the median of the azure pixels is the ground, and what is
left on top of it — read against it — is the white of the drawing. It is
painted back over a ground that is flat, so the mark is the house blue from
edge to edge and the drawing stays white and sharp.

**The landing page.** `app/page.tsx` is a greeting and a rounded box that looks
like the composer, then a tinted band explaining the three steps, then what the
app does that a bare model cannot. It is the page a person lands on; the
wiring check moved to `/health`.

**What the user sees while the model works.** The stream carries the name of
the tool that is running (`onTool` in `lib/llm/loop.ts` → a `tool` frame in the
SSE), so the interface says *"กำลังค้นหาสินค้าที่เข้ากับห้อง…"* instead of
showing a bare spinner.

**The markdown renderer.** The model writes markdown; the browser has to show
it. `app/chat/markdown.ts` is a pure parser (text → blocks → inline nodes) and
`app/chat/markdown-view.tsx` turns that tree into React elements. There is no
`dangerouslySetInnerHTML` anywhere — every character the model wrote ends up
as a text node, so a product description that contains markup is shown, not
executed. Links are checked against an allow-list (`http`, `https`, `mailto`,
same-site paths); anything else is rendered as plain text. The parser is
covered by `tests/ui/markdown.test.ts`.

**Other things that changed.** A starter-card empty state instead of a wall of
welcome text; a `<textarea>` composer where Enter sends and Shift+Enter makes
a new line; a retry button on a failed turn; product cards with the price, the
size, the colour and the material, and a link to the retailer; a lightbox and
a download button on every generated picture; a bigger version strip; and the
tool calls tucked behind a disclosure for anyone who wants to see the steps.

### The picture of the furniture

A recommendation the user cannot picture is a recommendation they cannot want,
so the picture of every piece the answer names is put **next to the words that
name it** — a small figure in the sentence, and a full card below it.

The pictures themselves are the **shop's own photographs**, fetched with the
catalogue (`npm run fetch:catalog`) and kept under
`public/product-images/<id>.jpg`. A row without a photograph gets a drawn
illustration instead — one SVG per row, in the palette of the piece (colour,
material, category), with the Thai name and the dimensions on a card;
`npm run images` redraws them, `npm run seed` writes them as well, and
neither ever overwrites a fetched photograph.

The point is that the sofa is recognisably *that* sofa — a photograph of it,
where there is one.

Finding the piece an answer names is a rule, so it lives apart from the
renderer in `app/chat/product-mentions.ts`:

- the **whole name** in the text — "โซฟาลินเนส 3 ที่นั่ง", "KATJA 3-seat sofa" —
  is that product and no other, so it is certain;
- a **word only that product has** — "คัทจ้า" — identifies it too, but only
  when no other product in the set claims the same word. "HEMNES" is a sofa, a
  shelf, a desk and a chest, so saying "HEMNES" alone attaches no picture at
  all.

Size words ("3-seat") and category words ("โซฟา") never identify anything, and
the rule drops them before it looks. `tests/ui/product-mentions.test.ts` pins
all of it down.


## Quick start

```bash
cp .env.example .env.local        # then fill in the keys you have
npm install
npm run seed                      # writes the catalog into .data/
npm run dev                       # http://localhost:3000
```

Visit `http://localhost:3000` — it is the landing page. The wiring check (the
adapter, the seeded catalog, which optional credentials are present) lives at
`http://localhost:3000/health`.

## Environment variables

Copy `.env.example` to `.env.local`. Every variable is documented in the
example file; missing variables are read lazily, so an empty `.env.local` does
not block the catalog step.

| Variable                   | Required for                                  | Default     |
| -------------------------- | --------------------------------------------- | ----------- |
| `DB_ADAPTER`               | always pickable: `local` or `supabase`        | `local`     |
| `AUTH_MODE`                | `local` or `supabase`, where accounts live    | follows `DB_ADAPTER` |
| `GEMINI_API_KEY`         | every chat turn (build step 2 onward)         | —           |
| `LLM_MODEL`              | which Gemini model handles chat + vision      | `gemini-3.8-flash` |
| `IMAGE_MODEL`            | which Gemini model edits images               | `gemini-3.1-flash-image` |
| `SUPABASE_URL`             | only when `DB_ADAPTER=supabase`               | —           |
| `SUPABASE_ANON_KEY`       | only for Supabase Auth                        | —           |
| `SUPABASE_SERVICE_ROLE_KEY`| only when `DB_ADAPTER=supabase`               | —           |
| `PHOTO_STORE`              | `local` or `supabase`, for room photos         | auto        |
| `VISION_MODEL`             | room photo analysis                           | `LLM_MODEL` |
| `IMAGE_QUOTA_PER_SESSION`  | generated images per session                   | `10`        |
| `ROOM_PHOTOS_PER_SESSION`  | room photo uploads per session                | `4`         |
| `GENERATION_TIMEOUT_MS`    | how long one image generation may take         | `90000`     |
| `CLEANUP_SECRET`           | the token that authorises `POST /api/cleanup`   | — (off)     |
| `RETENTION_DAYS`           | how long a session and its photos are kept      | `7`         |
| `ROOMY_PUBLIC_DIR`         | where the catalogue's pictures are read from   | `./public`  |

The `local` adapter needs **no credentials**. The whole app boots, the catalog
is seeded into `.data/*.json`, uploaded room photos land in `.data/uploads/`,
and the status page reports `Database adapter: local`. Switching to Supabase is
a single env var change — see below.

## Commands

```bash
npm run dev        # next dev — http://localhost:3000
npm run build      # next build
npm run start      # next start (after build)
npm run seed       # load the catalog from data/catalog.seed.json
npm run fetch:catalog  # rebuild the catalog from IKEA + HomePro (see below)
npm run images     # redraw the furniture illustrations only
npm run style-examples  # draw the example room of each style (once)
npm run cleanup    # delete sessions and photos older than RETENTION_DAYS
npm run results    # step 8: sweep the catalogue + run the chat scenarios → results.json
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run test:watch # vitest --watch
```

`npm run style-examples` draws **one example room per style** with the image
provider and writes them to `public/style-examples/<style>.jpg`. They are the
pictures in the left rail: the user sees what a style looks like before asking
for it, the way Gemini's own gallery shows a style. The script draws them
**once** — the files are part of the project, so the rail costs nothing to
open and the pictures never change under the user's feet. A style that already
has a picture is kept; `--force` redraws them all. The scene of each style is
in `data/style-scenes.json`, and the script refuses to run if a style in
`app/chat/filters.ts` has no scene there.

Each picture is one call to the image provider. The script sends a sentence
and no photo — nothing of the user's goes to it.

`npm run seed` writes the catalogue, and it **replaces** it: the rows in the
seed file are written, and any product the file no longer lists is deleted.
The seed file is the catalogue, not a set of patches — a piece that has
dropped out of it has to go, or the bot keeps offering furniture whose
photograph the app no longer has. A placed image or a generation job that
points at a deleted product keeps its own row and loses only the reference.

The references are cleared by the adapter before the delete, not by the
database. The schema says `ON DELETE SET NULL`, but a database created from an
earlier version of `0001_init.sql` carries the plain `references products(id)`
rule, which Postgres reads as NO ACTION — and then the delete is refused with
`violates foreign key constraint "images_product_id_fkey"`. Clearing the links
in the application works under either rule, so the seed does not depend on the
database having been migrated. `supabase/migrations/0004_product_fk_set_null.sql`
puts the database back in step with the schema it is supposed to have.

## Where the catalogue comes from

The 42 rows in `data/catalog.seed.json` are **fetched from the shops' own
catalogues**, not written by hand. `npm run fetch:catalog` does it:

```bash
npm run fetch:catalog                              # → data/catalog.fetched.json
npm run fetch:catalog -- --refresh                 # ask the shops again
npm run fetch:catalog -- --out data/catalog.seed.json   # replace the seed
```

What it does, in order:

1. **Finds the pieces.** IKEA's Thailand product sitemaps (`/sitemaps/…`) give
   every product URL and its picture; HomePro's category sitemap
   (`sitemap-categories.xml.gz`) gives the category pages, whose listings
   carry each product's id, name, price and stock.
2. **Reads the real numbers.** Each product page is opened and its JSON-LD
   block and specification table are read: price in baht, width, depth and
   height in centimetres, colour, material, and whether it is in stock. A
   product missing a price or a dimension is dropped rather than guessed.
   IKEA publishes only some of the dimensions in its JSON-LD block, so the
   rest come from the Thai measurement list on the same page — the English
   one on the page measures the box the piece arrives in, not the piece.
3. **Downloads the picture.** Each photograph is fetched once, resized to
   900 px and re-encoded as JPEG into `public/product-images/<id>.jpg`.
   The app serves it itself, so nothing hot-links a retailer's CDN.
4. **Writes the catalogue and its provenance.** The rows go to
   `data/catalog.fetched.json`; beside it, `data/catalog.fetched.sources.json`
   records, for every row, the source, the exact product URL, the URL the
   photograph came from, and the time it was fetched.

Pieces that are not furniture for a room are left out as they are found:
outdoor sets, pet beds, children's furniture, massage and therapy devices,
bar stools, table sets and candle holders. Each rule is in
`scripts/catalog/ikea.ts` and `scripts/catalog/homepro.ts`, beside the
category vocabulary of the shop it reads.

The seed file **is** the last fetch: `data/catalog.seed.json` and
`data/catalog.fetched.json` hold the same rows, and
`data/catalog.fetched.sources.json` says where each of them came from. The
earlier, hand-written catalogue is kept at `data/catalog.seed.sample.json`, so
the difference can be seen side by side.

**What the last fetch found**

42 rows — **29 from IKEA, 13 from HomePro** — spread over the twelve
categories the app places:

| category | rows | category | rows |
|---|---|---|---|
| sofa | 5 | desk | 3 |
| armchair | 4 | cabinet | 3 |
| table | 6 | rug | 2 |
| chair | 3 | tv_stand | 2 |
| shelf | 4 | dresser | 2 |
| lamp | 4 | bed | 4 |

Every row is a different model: the shop's list is walked in order, but a
piece whose model is already in the catalogue is passed over while a model
that is not is still waiting further down, and no model is taken more than
three times (IKEA sells most pieces in six colours).

**Rules this pipeline keeps to**

- Only `GET` requests, to `ikea.com` and `homepro.co.th` only. One request at
  a time, with a pause between them, a browser's user agent, and a cache under
  `.data/catalog-cache/` so a second run does not ask the same question twice.
- Both shops' `robots.txt` are respected: no `/search` URLs, no filtered or
  sorted listings — category pages, product pages and sitemaps only.
- Prices and dimensions always come from the shop's own page. Nothing is
  estimated, and a product whose numbers cannot be read is left out.
- **The fetch never writes to the database.** `npm run seed` does that, and it
  is the user's to run.
- The style tags are **ours**, not the shops': neither retailer publishes a
  style, so each category carries our own tags from the vocabulary the app
  already uses (`app/chat/filters.ts`). The shop's own colour and material
  are kept as they are.
- The photographs belong to the shops. They are kept here for a demo
  catalogue; a public deployment needs the shops' permission, or pictures
  replaced by the drawn illustrations (`npm run images`).


## Repository layout

```
.
├── app/                       # Next.js App Router
│   ├── api/
│   │   ├── auth/
│   │   │   ├── login/route.ts     # Sign in, set the cookie
│   │   │   ├── logout/route.ts    # Revoke the token, clear the cookie
│   │   │   ├── me/route.ts        # Who is signed in
│   │   │   └── register/route.ts  # Create an account, set the cookie
│   │   ├── chat/route.ts         # One chat turn, streamed as SSE
│   │   ├── cleanup/route.ts      # The retention sweep, behind a secret
│   │   ├── generate/route.ts     # Room photo + product → a placed picture
│   │   ├── history/route.ts      # The signed-in person's conversations
│   │   ├── image/[id]/route.ts   # Serves one photo to its owning session
│   │   ├── session/route.ts      # Create / read / patch / delete a session
│   │   └── upload/route.ts       # Room photo → strip EXIF → store → analyse
│   ├── chat/
│   │   ├── chat-client.tsx      # The layout, the bubbles, the SSE reader
│   │   ├── design-card.tsx      # The card of a designed room, and its refinement box
│   │   ├── filters.ts           # The style / budget / category chips
│   │   ├── side-rail.tsx         # The left rail: the mark, the history, the tools, the account
│   │   ├── session-list.ts      # How the list says when — pure, no React
│   │   ├── room-photo.tsx       # Uploads a room photo, shows the analysis
│   │   ├── area-picker.tsx      # Drag a footprint and a reference line
│   │   ├── product-cards.tsx    # Product cards, version strip, comparison table
│   │   ├── product-mentions.ts  # Which product an answer names — the rule
│   │   ├── panel-icon.tsx       # The rail's open/close icon
│   │   ├── privacy-panel.tsx    # The privacy promises, the budgets, the delete
│   │   ├── state-panel.tsx      # The live view of the session state
│   │   ├── markdown.ts          # The markdown parser — pure, no React
│   │   ├── markdown-view.tsx    # The parser's tree → React elements
│   │   ├── lightbox.tsx         # A picture, opened full size
│   │   ├── session-view.ts      # The shapes the client renders
│   │   └── geometry.ts          # Pointer maths for those two drags
│   ├── history/page.tsx       # The account's conversations
│   ├── login/
│   │   ├── login-form.tsx      # Sign in / register, one form, two tabs
│   │   └── page.tsx            # The sign-in page
│   ├── health/page.tsx        # The wiring check (adapter, catalog, keys, accounts)
│   ├── brand.tsx              # The mark and the name, for the blue band
│   ├── home-button.tsx        # The way home, with the mark in it
│   ├── layout.tsx             # html[lang="th"], font stack, metadata, the theme script
│   ├── inline-script.tsx      # A script the browser runs before the first paint
│   ├── theme-toggle.tsx       # The sun/moon button
│   ├── globals.css            # Tailwind v4 import + the blue token set
│   └── page.tsx               # The landing page
├── assets/
│   └── logo-source.png         # The picture the logo came in — the mark on its own
├── data/
│   ├── catalog.seed.json      # 42 furniture products (Thai + English), fetched
│   ├── catalog.seed.sample.json  # the earlier, hand-written catalogue
│   ├── catalog.fetched.json   # what `npm run fetch:catalog` last fetched
│   ├── catalog.fetched.sources.json  # where every fetched row came from
│   └── style-scenes.json      # the room of each style, for the style pictures
├── lib/
│   ├── env.ts                 # Lazy env reads + MissingEnvError
│   ├── fit.ts                 # The fit rule — pure arithmetic, no I/O
│   ├── rate-limit.ts          # In-process sliding window (20 turns/hour)
│   ├── theme.ts               # Which theme is in effect, and where the choice lives
│   ├── auth/
│   │   ├── types.ts           # AuthUser, AuthResult, the email and password rules
│   │   ├── password.ts        # scrypt hash + verify — no dependency
│   │   ├── tokens.ts          # The session token and its hash
│   │   ├── local.ts           # Our own email + password accounts
│   │   ├── supabase.ts        # Supabase Auth, and the mirror into `users`
│   │   ├── cookie.ts          # The httpOnly `roomy_session` cookie
│   │   ├── http.ts            # What the auth routes share
│   │   └── index.ts           # signUp / signIn / resolveUserByToken / endSession
│   ├── db/
│   │   ├── types.ts           # Single source of truth: Product, Session, User, …
│   │   ├── local.ts           # Zero-credential JSON-file adapter
│   │   ├── supabase.ts        # Service-role adapter (Postgres + Storage + RPC)
│   │   ├── errors.ts          # "That table is not there yet" errors
│   │   └── index.ts           # getDb() — picks adapter once, memoised
│   ├── design/
│   │   ├── brief.ts           # The user's words → the size, the pieces, the brief
│   │   ├── prompt.ts          # The prompt template for a room, built from the rows
│   │   ├── render.ts          # Drawing a room: quota, job, provider, store
│   │   ├── tool.ts            # The designRoom tool — the refusals and the result
│   │   └── view.ts            # The shape the client renders
│   ├── image/
│   │   ├── index.ts           # getImageProvider() — picks the adapter
│   │   ├── gemini.ts          # ImageProvider adapter (native editing)
│   │   ├── prompt.ts          # The prompt template, built from the DB row
│   │   ├── reference.ts       # The piece's own picture, as the model's reference
│   │   ├── mark-area.ts       # Draws the target area on the photo copy
│   │   ├── label.ts           # The "Simulated image" label — kept, not used
│   │   ├── bitmap.ts          # 5x7 bitmap font — no fonts on the server
│   │   └── types.ts           # The provider interface
│   ├── llm/
│   │   ├── gemini.ts          # LlmProvider adapter, streaming included
│   │   ├── vision.ts          # RoomAnalyzer adapter
│   │   ├── loop.ts            # Provider-neutral tool loop
│   │   ├── history.ts         # Stored-turn guard + legal trimming
│   │   ├── prompt.ts          # System prompt + session-state serialisation
│   │   └── tools.ts           # Tool declarations and executors (search, room,
│   │                          #   fit, compare, design) + the comparison extractor
│   ├── results/
│   │   ├── types.ts           # The shape of results.json
│   │   ├── catalogue-fit.ts   # Every product judged against one space
│   │   ├── chat-cases.ts      # The eight scenarios + the checks they are judged by
│   │   └── chat-run.ts        # Reads the chat route's SSE + the transcript
│   ├── session/
│   │   ├── purge.ts           # Delete a session: photos first, then the rows
│   │   └── transcript.ts      # A stored conversation, read back as a chat
│   └── storage/
│       ├── store.ts           # getPhotoStore() — local or Supabase
│       ├── process-image.ts   # sharp: strip EXIF, resize, re-encode
│       ├── delete.ts          # Removes one photo, or a whole session folder
│       └── signed-url.ts      # 1-hour signed URLs
├── public/
│   ├── product-images/        # the furniture pictures (the shop photographs)
│   ├── style-examples/        # one example room per style, drawn once
│   └── roomyai-icon.png       # The mark, on a transparent ground — flat #0058c8
├── scripts/
│   ├── seed.ts                # Zod-validate → write the pictures → upsert → prune → test query
│   ├── fetch-catalog.ts       # rebuild the catalogue from IKEA + HomePro
│   ├── catalog/
│   │   ├── types.ts           # the shared shapes: candidate, fetched product
│   │   ├── http.ts            # polite fetching: browser UA, pause, cache, retries
│   │   ├── thai.ts            # the Thai colour and material words → English
│   │   ├── ikea.ts            # IKEA's sitemaps + JSON-LD + measurements
│   │   ├── homepro.ts         # HomePro's category pages + JSON-LD + spec table
│   │   ├── images.ts          # download one picture, resize, save as JPEG
│   │   └── rows.ts            # a fetched product → a catalogue row
│   ├── draw-images.ts         # Redraw the pictures alone (`npm run images`)
│   ├── style-examples.ts      # Draw the example room of each style (`npm run style-examples`)
│   ├── product-art.ts         # Draws one piece of furniture as an SVG
│   ├── probe-image.ts         # One real image call, with the piece as reference
│   ├── _probe-empty.ts        # Two real chat turns — shows a turn with no answer
│   ├── make-logo.mjs          # The logo assets, from assets/logo-source.png
│   ├── logo-colour.mjs        # Repaints the mark on a flat house-blue ground
│   ├── cleanup.ts             # The retention sweep from the command line
│   └── results.ts             # Step 8: the catalogue sweep + the chat scenarios
├── supabase/
│   └── migrations/
│       ├── 0001_init.sql     # Schema, RLS, quota RPC, storage policies
│       ├── 0002_retention.sql  # Locks the SECURITY DEFINER helpers down
│       ├── 0003_auth.sql     # users, auth_sessions, sessions.user_id
│       ├── 0004_product_fk_set_null.sql  # The product references' delete rule
│       └── 0005_session_state_design_brief.sql  # The state default, with the brief
├── tests/                     # Vitest — 610 tests, no network
├── results.json               # The last step-8 run (rewritten by `npm run results`)
├── REPORT.md                  # The curated report of that run
├── next.config.ts
├── package.json
├── postcss.config.mjs
├── tsconfig.json
└── vitest.config.ts
```

## Swapping to Supabase

1. Create a Supabase project.
2. Run `supabase/migrations/0001_init.sql` in the SQL editor
   (or via `supabase db push` once the CLI is wired up), then
   `supabase/migrations/0002_retention.sql` — the second one locks the
   `SECURITY DEFINER` helpers down so only the service role can run them —
   and then `supabase/migrations/0003_auth.sql`, which adds the account
   tables and `sessions.user_id`. The chat works without the third one; the
   sign-in page says so until it is applied. Finally run
   `supabase/migrations/0004_product_fk_set_null.sql` — it gives the two
   product references their `ON DELETE SET NULL` rule, which a database
   created from an earlier `0001_init.sql` does not have — and then
   `supabase/migrations/0005_session_state_design_brief.sql`, which realigns the
   `sessions.state` default with the shape the code writes now that a session
   can hold the brief of a designed room. The seed works either way; these make
   the schema agree with itself.
3. Create a private bucket named `room-photos`.
4. Set in `.env.local`:
   ```
   DB_ADAPTER=supabase
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   ```
   `SUPABASE_ANON_KEY` is only needed for Supabase Auth. The service-role key
   is used by the server for everything else and is never sent to the browser.
5. `npm run seed` again — the local JSON adapter is bypassed, the upsert
   goes through to Postgres, and the products the catalogue no longer lists
   are removed from the `products` table.

The service-role key is read **only server-side**, never sent to the browser.
Nothing sensitive should ever be placed in a `NEXT_PUBLIC_*` variable.

## Deploying to Vercel

The app deploys as an ordinary Next.js project. Two things do not survive the
move on their own — the **database** and the **photos** — and both have to
point at Supabase before the first deploy.

### 1. Put the project in a git repository

This folder is not a git repository yet. Vercel deploys from a repository
(GitHub, GitLab, Bitbucket) or straight from the command line, so either make
one or use the CLI:

```bash
cd "RoomyAI Project"
git init
git add .
git commit -m "RoomyAI: the project as it stands"
```

`.gitignore` already keeps `.data/`, `.env.local` and `node_modules/` out of
the commit. The catalogue's pictures (`public/product-images/`) and the example
rooms (`public/style-examples/`) **are** committed on purpose: every catalogue
row points at a file in the first folder, and a deployment without them shows
an empty frame where the furniture should be.

Push the repository to a private repository of your own, then import it in the
Vercel dashboard (Add New → Project). The settings it asks for are the
defaults:

| Setting         | Value                                    |
| --------------- | ---------------------------------------- |
| Framework preset| Next.js                                  |
| Build command   | `npm run build`                          |
| Install command | `npm ci`                                 |
| Node.js version | 22 or 24 — `engines` asks for ≥ 20.9.0   |
| Output directory| `.next` — leave it alone                 |

### 2. Set the environment variables in the dashboard

Project → Settings → Environment Variables. Add them for **Production** (and
Preview, if you want the preview deployments to work too):

```
GEMINI_API_KEY=<the key from aistudio.google.com/apikey>
DB_ADAPTER=supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
PHOTO_STORE=supabase
```

The **build** needs none of them: the three pages Vercel prerenders (`/`,
`/chat`, the icon) read neither the database nor the environment, so the
build succeeds even with an empty environment. The secrets are needed at
runtime, when a request comes in.

`AUTH_MODE` can stay empty — it follows `DB_ADAPTER`, so with Supabase in
place the accounts are Supabase Auth's. `CLEANUP_SECRET` is needed only if the
retention sweep is called over HTTP (see step 5).

The rest of the variables in `.env.example` all have defaults, and the ones
that matter most on a server are the same ones they are locally:

```
IMAGE_QUOTA_PER_SESSION=10
GENERATION_TIMEOUT_MS=90000
RETENTION_DAYS=7
```

One of them has to change on Vercel: **`MAX_UPLOAD_MB=4`**. Vercel refuses a
request body over 4.5 MB before the app ever sees it, so with the default of
8 MB a photo of 5 MB would come back as Vercel's bare `413` instead of the
app's own "ไฟล์ใหญ่เกินไป" message. At 4 MB the app's own guard fires first.

Two things behave differently on a serverless deployment, and neither is
hidden:

- The rate limiter (`lib/rate-limit.ts`) keeps its window **in the process's
  memory**. On Vercel several instances run at once, so the effective limit is
  20 turns/hour *per instance*, not per person. The same is true of the local
  database adapter, which is why `DB_ADAPTER=supabase` is not optional there.
- The retention sweep has no scheduler of its own — see step 5.

### 3. The database and the photos must be Supabase

The `local` adapter writes to `.data/` **inside the server's own filesystem**.
On Vercel every deployment gets a fresh filesystem, so the catalogue would be
empty on every cold start and the sessions would vanish with it. So
`DB_ADAPTER=supabase` and `PHOTO_STORE=supabase` are not optional there — the
photos have to live in the private `room-photos` bucket as well, because the
bucket is the only thing that survives a new deployment.

### 4. The migrations and the seed are yours to run

Before the first deploy, in this order:

1. Apply `supabase/migrations/0001_init.sql`, `0002_retention.sql`,
   `0003_auth.sql`, `0004_product_fk_set_null.sql` and
   `0005_session_state_design_brief.sql` in the Supabase SQL editor.
2. Create a **private** bucket named `room-photos`.
3. Run `npm run seed` **from your own machine**, with the same
   `SUPABASE_*` values in `.env.local`. The seed writes to the live project
   and replaces the catalogue — it is not something a build on Vercel should
   do, and it must not run on every deploy.

Then deploy. The status page at `/health` says which adapter is live, how
many products are in the catalogue and which credentials arrived — if it says
`local`, the environment variables did not make it.

### 5. The retention sweep

`POST /api/cleanup` with `Authorization: Bearer <CLEANUP_SECRET>` deletes
everything older than `RETENTION_DAYS`. Vercel's own cron sends **GET**
requests and the route answers POST only, so a Vercel cron cannot call it as
it stands. Two ways round that:

- run `npm run cleanup` from your own machine on a schedule (a cron on the
  machine, or a GitHub Action with the Supabase credentials as secrets) — this
  needs no `CLEANUP_SECRET` at all, because the script runs where the
  credentials are; or
- add a GET handler to `app/api/cleanup/route.ts` that accepts Vercel's
  `CRON_SECRET` bearer and then point a `vercel.json` cron at it.

### 6. How long a request may take

`/api/generate` and `/api/chat` export `maxDuration = 120`. Vercel's limit
with fluid compute is 300 s on Hobby and 800 s on Pro, so 120 s fits on the
free plan. The number that decides whether a slow picture is a timeout is
`GENERATION_TIMEOUT_MS` (90 s by default), and it sits inside the 120 s — a
generation that runs out of time fails with "ใช้เวลานานเกินไปในการสร้างรูป"
rather than being cut off by the platform.

### 7. What to check after the deploy

- `https://<your-app>.vercel.app/health` — the adapter, the number of
  products, which credentials arrived.
- Upload a room photo, ask for a sofa, press **วางในห้องให้ดู**. The picture
  comes back signed, from the private bucket, and expires in an hour.
- The style cards in the left rail are the project's own files
  (`public/style-examples/`), so they are on screen as soon as the deploy is
  live — no generation, no cost.

### 8. What it costs

Vercel Hobby is free. The Gemini API is not: a chat turn and a generated
picture are billed separately, and the picture is the expensive one — ten
generated pictures per session, and a new session starts the count again.

## Spec rules this repo honours

- API keys stay server-side. Nothing secret in client code or in
  `NEXT_PUBLIC_*`.
- Text from uploaded photos and product descriptions is treated as data,
  never as instructions to the LLM.
- EXIF metadata (including location) is stripped on upload, before the bytes
  reach storage **and before they reach the vision model** — the analysis call
  is handed the processed JPEG, not the original upload.
- Photos live in a private bucket and are served with signed URLs that expire
  in 1 hour. Room photos are sent to Gemini as `inlineData`, never as a URL, so
  a signed capability token is never handed to a third party.
- Prices and dimensions always come from the database, never from LLM text.
  `checkFit` takes a product id and nothing else about the product; it reads
  the row itself. When a space has been measured on the photo, that
  measurement wins over any centimetres the model was handed. The image
  prompt is a template filled from the same row, so a picture cannot describe
  a different sofa than the one the catalogue lists. The model is told to
  quote the tool's numbers and not to work any out itself — the step-8 run
  caught it halving a 30 cm clearance into "15 ซม. ข้างละ", a number nobody
  had checked and that assumed the sofa sat in the middle of the room.
- `compareOptions` follows the same rule: it takes 2–4 product **ids** and
  nothing else. It reads the rows itself, and it judges every product against
  the same measured space and the same fit rule as `checkFit` — the space
  measured on the photo, or, when there is none, the size a previous
  `checkFit` was given — so the two can never contradict each other.
- The fit check answers the question that was asked. The catalogue is ordered by
  price, so the first hit for "furniture for the living room" is the cheapest
  one, not the sofa the user is talking about. When the user names a category,
  the model is told to filter the search by that category *before* it checks a
  fit — the step-8 run caught it checking an armchair for a question about a
  sofa.
- The change request of an iteration is the user's own sentence, quoted into
  the prompt as **data**. It cannot rewrite the rules of the prompt, and it
  cannot make the model draw text or logos.
- The room design follows the same rule about numbers. The model passes the
  user's own words — "24 ตารางเมตร", "3.5 ฟุต" — and the code turns them into
  square metres and centimetres; the model is told not to convert units
  itself. The pieces of the room are catalogue rows, and the prices and the
  dimensions in the card are the rows' own.
- A room is drawn only after the user has confirmed the plan. The check is in
  the tool, not in the prompt: without `confirmed: true` the tool refuses, so
  a model that forgets to ask still cannot draw a room.
- The version chain is derived from the stored image rows — session, product,
  order — so iteration needs no new table, no new column and no migration. The
  same database serves step 5 and step 6.
- Every generated image is labelled as a simulation in the interface, under the
  picture (`ภาพจำลอง`). The words are **not** burned into the pixels — the
  owner asked for the pictures without them (November 2026). The module that
  drew the label is kept in `lib/image/label.ts`, unused, with a note on how to
  put it back.
- Rate limits and the image quota are enforced server-side.
  `image_quota_left` (10 per session) is the budget for **generated** images
  only — uploading your own room photo does not spend it.
- A session's photos are removed from storage **before** its rows are removed
  from the database, and the rows are kept if the storage removal fails. A
  deletion that only removed the rows would leave the room photo in the
  bucket.
- The retention sweep is off unless `CLEANUP_SECRET` is set, and the token is
  compared in constant time. The two `SECURITY DEFINER` helpers in
  `0001_init.sql` are `SECURITY DEFINER`, so `0002_retention.sql` revokes
  their default `EXECUTE` grant to `PUBLIC` and gives it to `service_role`
  only.
- Replacing a room photo clears the measurement taken on the old one.
- The room photo reaches exactly two places: the chat model (as `inlineData`,
  for the analysis) and the image provider (as `inlineData`, for the edit).
  Never as a URL, never to anyone else.
- The catalogue's own picture of the recommended piece goes to the image
  provider as a second `inlineData`, so the model copies the real item instead
  of inventing one that fits the description. It is a picture of a product,
  not of the person, and it never touches the user's room photo.

## Accounts and the history

Signing in is **optional**. The chat works exactly as it did before: no
account, no sign-in, no history — a guest session, kept under a random id in
the browser, deleted with the retention sweep like anything else. An account is
for **keeping the log**, which is what the user asked for: every conversation
that belongs to the person, listed, reopenable.

**Which system holds the accounts** is decided by one env var:

| `AUTH_MODE` | Accounts live in | Passwords |
| --- | --- | --- |
| unset (default) | follows `DB_ADAPTER`: Supabase Auth on Supabase, our own table locally | — |
| `supabase` | Supabase Auth (`SUPABASE_URL` + `SUPABASE_ANON_KEY`) | hashed by Supabase |
| `local` | our own `users` table | hashed by us, with scrypt |

If Supabase Auth is not switched on, the app falls back to our own accounts
rather than refusing to start — a Supabase project can have a database and no
login, and that is a normal state for it to be in.

**The browser holds an opaque token, not a provider session.** One `httpOnly`
cookie, `roomy_session`, carries a random 32-byte token; the database stores
its SHA-256 and nothing else. A dump of the `auth_sessions` table is therefore
useless to whoever finds it — there is nothing in it that can be signed in
with. Signing out revokes the row, so a cookie that was copied keeps working
for nothing.

**Our own accounts** (`lib/auth/local.ts`, `lib/auth/password.ts`) hash with
scrypt from Node's own crypto — no extra dependency — with a per-user salt and
the parameters written into the hash, so an old row keeps verifying. The email
is stored in lower case and is unique, so one address is one account across
both worlds. A wrong password and an unknown address give the same message,
so the page cannot be used to find out which addresses are registered.

**What the database needs** is `supabase/migrations/0003_auth.sql`: the `users`
and `auth_sessions` tables, and `sessions.user_id` — the column that says
whose conversation a chat session is. Both new tables have RLS on and **no
policies**, so the anon key reads nothing from them; only the service role,
which the server adapter uses, can. Until that migration is applied the app
says so plainly on the sign-in page and on `/health`, and the chat keeps
working as a guest.

**The history** is a rail beside the conversation, the way a chat assistant
usually draws it: `/history` still lists every session of the account, newest
first, titled with the first thing the person said, and the chat page carries
the same list at the top of its left rail (`app/chat/side-rail.tsx`). Clicking a
conversation there reopens it in place — the transcript, the tool round trips
hidden, the pictures of the recommended pieces recovered from the stored tool
results, so an old conversation looks the way it looked. `/chat?session=<id>`
does the same thing for a link, so a conversation can still be sent to
someone.

**A new conversation keeps the old one.** "แชทใหม่" in the rail starts
another session; it deletes nothing. The button that erases things is the
**ลบข้อมูลทั้งหมด** one in the session state, and it says so.

**Ownership is enforced on the server.** A session that belongs to an account
can only be read, chatted in, uploaded to, generated in, or deleted by that
account, and its photos are not served to anybody else — a picture is addressed
by the session it belongs to, so an owned session's pictures are addressed by
the account too. A session with no owner is a guest's, and its id is the only
key to it — the way it has always been.

## How a picture is made

`POST /api/generate { session_id, product_id, placement }`, in this order:

1. The request must carry the **request the user wrote** — the sentence they
   typed in the chat that asked for this piece. A picture is made for a request
   somebody wrote; without one there is nothing to place, and the route
   answers `400 no_placement_prompt` before it touches the quota. The sentence
   is quoted into the prompt as data, in a section that says in as many words
   that it can change the placement and nothing else.
2. The session and the product row are read from the database. The request
   carries no dimensions — there is no path by which a client could talk the
   app into a different size.
3. The room photo is required. Without one there is nothing to edit.
4. The space is measured off the photo, using the same scale rule as the fit
   check, so the prompt and the fit verdict cannot disagree.
5. The catalogue's own picture of the piece is read, when there is one
   (`lib/image/reference.ts`). It is sent to the model as a second image, and
   the prompt says which of the two pictures is the room and which is the
   piece. This is what makes the thing in the room the thing in the card: the
   model copies the item instead of drawing a sofa that merely fits the
   description. No picture is no problem — the piece is described in words and
   the generation goes on.
6. One unit of `image_quota_left` is taken atomically, before the call.
7. The area the user drew is outlined on a **copy** of the photo, and the
   prompt asks for the piece to go inside it.
8. The image provider is called and waited on. The prompt is the template in
   `lib/image/prompt.ts`, filled from the catalogue row.
9. The picture is stored as the provider returned it, and the session points
   at it.

The request waits for the picture: the answer is a picture or an error, never
a job to poll. A job row is still written, so a failed attempt is visible in
`generation_jobs`.

**The button needs a prompt.** The card under the assistant's answer carries
the button **วางในห้องให้ดู**, and the button only works once the user has
written something in the chat: the sentence nearest above the card is the
request the picture is made for. With no sentence there is nothing to place,
so the button stays shut and says why ("ยังไม่มีคำขอ"), and the route
refuses the request as well — the check is on the server, so it cannot be
walked around from the browser.

### Another version of the same piece

`POST /api/generate { session_id, product_id, placement, instruction, previous_instructions }`

The same route makes the next version. The request the picture was made for
travels with it (`placement`), so the new version is made for the same
sentence. The user types what to change — "ย้ายไปทางขวา",
"ทำให้เล็กลง" — and that sentence becomes the next version of the same piece in
the same room. Steps 1–7 above are unchanged: the piece still comes from the
catalogue row, the space is still the measured one, and one unit of quota is
still taken before the call.

What is new:

- The change request is quoted into the prompt **as data**, in a section that
  says so in as many words. It cannot change the rules of the prompt, and it
  cannot make the model draw text.
- The earlier change requests travel with the request (`previous_instructions`),
  oldest first, so "เล็กลงอีก" has something to be smaller than. The server
  stores the pictures, not the requests that produced them, so the client sends
  the chain's own history back.
- The version number is derived from the image rows of that session and that
  product, so the chain needs **no schema change**: the same database serves
  step 5 and step 6.
- The new version is drawn from the **room photo again**, not by editing the
  previous picture. Every version therefore shows the same room at the same
  size, and the versions can be compared with each other side by side.

Under each picture is the version strip (in `app/chat/product-cards.tsx`): a
thumbnail of every version so far, oldest first, with the one on screen
outlined. Click a thumbnail to go back to an earlier version; type into the box
and press "วางใหม่" (or Enter) to ask for the next one.

### Comparing two or three products

`compareOptions` is a tool the model calls by itself when the user asks which
one is better. It takes **ids only** — 2 to 4 of them, taken from the ids
`searchFurniture` returned — and reads the price, the dimensions and the stock
from the rows itself. The fit verdict of each product comes from the same
measured space and the same fit rule as `checkFit`, so a comparison and a fit
check can never tell the user two different things. The result also names the
cheapest one and the one that fits best.

The chat route reads that result back out of the turn and sends it to the
browser in the `done` frame; the chat draws it as a table next to the cards:
price, size, "วางได้ไหม", and the notes ("ราคาถูกสุด", "วางได้ดีที่สุด",
"หมดสต็อก"). If the model passes an id that does not exist, the tool compares
the ones it found and reports the one it did not, rather than guessing.

The model is told two things about this, because getting them wrong was the
easy mistake to make: search first when the user has already said what they
want ("หาโซฟา" is not a question), and compare with the ids that search
returned, never with invented ones. An empty session state is not a reason to
ask the user again what they just told the assistant.

### Designing a whole room

`designRoom` is a tool the model calls when the user asks for a **room** rather
than for a piece: "ฉันอยากได้ห้องสไตล์มินิมอล", "ช่วยแต่งห้องนอนให้หน่อย".
The result is a drawn room — real furniture from the catalogue, standing in a
room of the size the user gave — and a card that says what the room is made of
and what it costs.

**The assistant asks before it draws.** This is the user's requirement, so it
is a rule in the code and not a request to the model: the tool refuses with
`not_confirmed` until the model has agreed the plan with the user and passed
`confirmed: true`. Nothing is drawn, and no unit of the image quota is spent,
on a plan nobody approved.

The refusals are four, and each of them tells the model what to do next:

| The refusal | What it means |
| --- | --- |
| `not_confirmed` | The plan has not been agreed with the user yet. |
| `incomplete_brief` | The style, the size of the room or the pieces are missing — `missing` says which. |
| `no_catalogue_match` | The catalogue has nothing for one of the requested pieces — the room waits rather than quietly dropping it. |
| `render_failed` | The picture could not be drawn. |

**The model never does the arithmetic.** A user says "ห้องใหญ่ 24 ตารางเมตร"
and "เตียง 3.5 ฟุต", and the model passes those **words** on. The code reads
them (`lib/design/brief.ts`): 24 square metres becomes a floor of 600 × 400 cm
at a ratio of 3:2, and 3.5 feet becomes 106.68 cm, which is then compared with
the widths in the catalogue rows. The prompt says so in as many words, because a
model that converts units itself produces numbers the database never said.

**The pieces are real rows.** Every piece of the room is a catalogue row, chosen
by the code: by category, then by how close its width is to what the user asked
for, then by style and colour, and finally by price. The chosen rows go back
into the brief, so the next version of the room keeps the same furniture — the
user asked for a different colour, not for a different bed. The prices and the
dimensions in the card are the rows' own.

**The picture.** The room photo the user uploaded is the base image when there
is one, so the room is *their* room, refurnished; without one, the room is
drawn from the brief. The catalogue's own photograph of each piece travels with
it as a reference, in the order the pieces are listed, and the prompt says
which picture is which. The picture is stored as the provider returned it, just
like a placed picture.

**Another version of the same room.** "เปลี่ยนเป็นสีฟ้า" asks the tool again
with an `instruction` and no brief: the stored brief fills in the rest, the
pieces stay the ones that were chosen, and the change is quoted into the prompt
**as data** — it cannot change the rules of the prompt and it cannot make the
model draw text.

**Where the brief lives.** The brief is a tenth field of the stored session
state, so the next turn refines the room instead of starting over. The state
the *model* sees keeps exactly the nine fields the spec names — that shape is a
promise the tests keep — and the brief travels in a section of its own below
it. `supabase/migrations/0005_session_state_design_brief.sql` realigns the
column default with the shape the code writes; the application does not depend
on it, since both adapters normalise the state on read.

### The image quota in the interface

`image_quota_left` (10 per session) is enforced on the server as before, and
now it is visible before it runs out: the session state in the rail counts it
down with every picture, the buttons turn off when the session is out, and the
reason is written next to them. An iteration spends one unit, like any other
picture.

### The privacy promises

The rail's session state carries the four promises the spec makes, in short
form, all the time (`app/chat/privacy-panel.tsx`):

- **ส่งแค่ 2 ที่** — the room photo goes to the chat model and to the image
  provider, and nowhere else.
- **EXIF/ตำแหน่งถูกลบ** — the metadata, location included, is stripped before
  the bytes reach storage or any model.
- **ที่เก็บรูป + ลิงก์ 1 ชม.** — private bucket, signed URLs that expire after
  an hour, readable only by the owning session.
- **โควตา/เรตลิมิต** — what is left of the two budgets, counted down next to
  the promise: images left in the session, chat turns left in the hour.
- **รูปสินค้าจากแคตตาล็อก** — the catalogue's own picture of the recommended
  piece goes to the image model as well, so the placement shows the actual
  item. It is a picture of a product, not of the person, and the room photo
  still reaches exactly two places.

"รายละเอียด" expands the four sentences in full, including how long anything
is kept. The rules are not a privacy policy nobody reads: they are on screen.

The block lives under the session state because it is the same subject: what
the server knows about this session — what is left of it, what was promised
about it, and the button that erases it.

### Deleting everything

The **ลบข้อมูลทั้งหมด** button in the session state asks once, inline, and
then does the real thing: `DELETE /api/session` removes the photos from
storage **and** the rows from the database, and the client starts a fresh
session on the spot — no page reload, and the old conversation is gone from the
screen.

The order is the point, and it is the same order in the code as in the promise
(`lib/session/purge.ts`):

1. The photos go first. A deleted session whose room photo is still in the
   bucket is not a deletion.
2. Only then do the rows go — the jobs, then the images, then the messages,
   then the session. The schema cascades them, but the adapter removes them
   itself, in that order, so the deletion does not depend on a foreign-key
   rule the database may not carry. A job is removed before the images
   because a job may point at an image.
3. If the photos cannot be removed, the **rows stay**. The request answers
   500 and the session state shows the error, because a session that looks
   deleted but is not is worse than one that visibly failed. The user can try
   again, and the retention sweep will try later.

A store that cannot delete a whole folder (a test double, or a future one)
falls back to removing the files one by one, using the image rows the database
still holds.

### The 7-day cleanup

`npm run cleanup` deletes every session older than `RETENTION_DAYS` (default
7) — the photos first, then the rows, exactly like the button. It runs on the
machine that holds the credentials, so it needs no token.

`POST /api/cleanup` is the same sweep over HTTP, for a scheduler to call:

```
curl -X POST http://localhost:3000/api/cleanup \
  -H "Authorization: Bearer $CLEANUP_SECRET"
```

The endpoint is **off** while `CLEANUP_SECRET` is unset (503): with no secret
there is nothing to compare the token against, and an open "delete everything
older than N days" endpoint should not be reachable from the internet. The
token is compared in constant time, and the secret is never echoed back.

One session that fails does not stop the sweep — the others are still worth
deleting, and the failures are listed in the response so they can be looked
at.

### Step 8 — the test script and the report

`npm run results` writes `results.json`: what the system actually did, on this
machine, against the real catalogue and the real model. It has two halves.

**The catalogue sweep** (`lib/results/catalogue-fit.ts`) puts every product in
the catalogue against one measured space and asks the fit rule to judge it. No
model, no tokens, no network — so a rule that is wrong shows up as a wrong row
rather than as one bad sentence in a conversation. The room is 240 × 120 × 260 cm
by default; `--space=300x200x260` judges the same catalogue against another
one, and `--skip-chat` runs the sweep alone.

**The chat scenarios** (`lib/results/chat-cases.ts`) are eight conversations sent
through the real `/api/chat` route: search by style and budget, a fit check
against a size the user typed, a comparison, a style question with no photo, a
budget change, the price of a piece the catalogue holds, the price of a piece it
does not, and a room designed from a description. The first five share one
session, because the later turns are only meaningful if the earlier ones
happened.

**The two price scenarios name a piece of furniture, and the piece is chosen
when the run starts** — a real row for the first one, a name the catalogue does
not hold for the second. The catalogue is re-seeded from live shops, so a
scenario with a name typed into it goes stale the moment the catalogue changes;
asking about a row that is really there keeps the check meaningful (the quoted
number must be that row's own price). Both run in sessions of their own: a price
recalled from an earlier answer in the same conversation is not evidence that
the bot went to the database.

The **room scenario** is the one that takes two turns. The assistant asks
before it draws — that is the user's rule — so the drawing happens in the
answer to "yes", and the harness sends both messages. It runs in a session of
its own: a style remembered from an earlier scenario would be a style nobody
asked for in that room, and the room it leaves behind would change what the
scenarios after it see. Its checks are the room's own:

- nothing was drawn in the turn before the confirmation, and the assistant
  asked in it;
- the room has a picture, the style the user asked for, and the size the
  user's own words mean (24 square metres → 600 × 400 cm);
- every piece is a row the catalogue holds, at the catalogue's price and size;
- the total is the sum of the pieces, and it is inside the budget;
- the width the user asked for is the one the code read out of their words
  ("3.5 ฟุต" → 106.68 cm), and the piece chosen is the catalogue's closest.

Each turn is judged by checks that are about *facts*, not phrasing:

- the tool the task needed was called;
- every amount of money in the answer is a catalogue price, a number the user
  typed, or arithmetic on those;
- every clearance in the answer is a number the fit tool produced;
- the answer does not contradict the verdict the rule gave;
- what the database remembered is what the user actually said;
- **the model actually answered.** A turn whose answer was cut off fails the
  run even though the reply is not empty — the loop answers a turn it could
  not finish with a short apology, so the text alone would not tell the
  difference.

The script creates real sessions and deletes them at the end (`--keep-session`
keeps them), so the database is left as it was. Exit code 0 means every check
passed, 1 means one did not, 2 means the run could not finish.

[`REPORT.md`](REPORT.md) is the curated report of the last run: the sweep
table, the scenarios with their timings and token counts, what the run found,
and the limits that are still open. It is the report of the run made on
31 October 2026 — seven scenarios, with one check failing because the script
asked about a product that was no longer in the catalogue. The script now has
eight; running `npm run results` again rewrites `results.json` and the report's
numbers with it.

## Known limits of this scaffold

- The model's **thinking counts against the same token budget as its answer**.
  Gemini 3 spends ~1,000–1,200 tokens reasoning before it writes, and the
  budget covers both: at 1,024 the model thought for ~980 tokens, had nothing
  left to write with, and the turn came back empty — `finishReason
  MAX_TOKENS`, no content at all. Every answer after the first one in a
  session was blank, and the app looked fine. The budget is now 4,096
  (`lib/llm/gemini.ts`), which leaves room for the thinking and the answer;
  measured, the model thinks about the same ~1,200 tokens either way, so a
  bigger budget does not make it think more. If the budget is ever lowered
  again, `scripts/_probe-empty.ts` shows the symptom: a large `think` next to
  a zero `out`.
- A turn the model could not finish — the budget ran out, or the answer was
  blocked — is not a blank bubble: the loop says something ("ตอบไม่ทัน ลองถาม
  อีกครั้งนะครับ") and flags the turn as `truncated`. The step-8 run fails
  such a turn, so a run cannot report a reply that never happened.
- The interface is tested by types and by unit tests, not by a browser. The
  suite runs in Node with no jsdom and no Playwright, so the layout, the
  drawer's open/close and the drag gestures are checked by reading the code,
  not by clicking through them. The markdown parser is the exception — it is
  pure, so it is pinned by `tests/ui/markdown.test.ts`.
- The local adapter is single-process only. It does not synchronise across
  multiple Next.js workers. Swap to Supabase before going to production.
- Room photo uploads are capped separately at `ROOM_PHOTOS_PER_SESSION`
  (default 4) so one session cannot fill the bucket. That number is not from the
  spec; raise or lower it in `.env.local`.
- The fit check assumes one flat scale across the photo. A single reference
  line sets it, so a room photographed at a strong angle — a long room shot
  from the doorway — will measure less accurately toward the far wall. It is
  there to stop a wrong recommendation, not to replace a tape measure; the
  answer says so whenever the ceiling height is unknown, too.
- The fit rule is one rule for every category, so it asks for 5 cm of walking
  room around a rug as well as around a sofa. A rug that exactly covers the
  floor is therefore reported as "ชิด" (tight) rather than "วางได้". The step-8
  sweep shows this in a 300 × 200 room: both 200 × 300 rugs come back `tight`
  with 0 cm to spare. **Decided: the rule stays as it is.** It does not know
  the category on purpose, and "ชิด" is the strict answer — it never claims a
  rug fits when it does not. Giving rugs their own rule means changing
  `lib/fit.ts` (the heart of step 4) and rewriting that rule's tests.
- The space a comparison is judged by is the one a previous `checkFit` used,
  read back from the transcript. The transcript is trimmed to the last 16
  messages, so in a long chat that space can fall out of the window and the
  comparison comes back without verdicts. **Decided: it stays in the
  transcript.** Keeping it for good needs a field in the session state, which
  the spec's state shape does not have.
- A generation that fails still costs one unit of the image quota. Giving the
  unit back needs a second atomic database operation and a migration on the
  Supabase side; a session that could be pushed over its cap by failing calls
  would be worse. A request that never reaches the provider — no room photo,
  no quota — costs nothing.
- The server has no fonts installed, so an SVG `<text>` label comes out as
  empty boxes. The "Simulated image" label was therefore drawn from a 5x7
  bitmap font in `lib/image/bitmap.ts`: no dependency, and the same pixels on
  every machine. The label is **not used any more** — the owner asked for the
  pictures without words in them (November 2026) — so the module sits there
  unused, with the two lines that put it back written at the top of it.
- The request a picture is made for is the **nearest user message above the
  card**, taken as it stands. If the last thing the user wrote was a question
  rather than a wish ("แล้วถ้างบ 10,000 ล่ะ?"), that sentence is the request the
  picture follows. That is the rule the owner chose — the prompt typed in the
  chat — and it is the same sentence the picture caption shows, so the user
  can always see which words the picture was made from.
- The placement marker (the orange rectangle) is drawn on the copy of the
  photo that is sent to the image provider. The model is asked to remove it
  again; occasionally it leaves a trace of it.
- Product images are the **shop's own photographs**, fetched by
  `npm run fetch:catalog` and kept under `public/product-images/<id>.jpg`.
  `npm run images` still draws an illustration for any row that has no
  photograph — it never overwrites one, so a fetched picture always survives.
  The photographs belong to IKEA and HomePro; this is a demo catalogue, and a
  public deployment needs the shops' permission. Either kind of picture is
  what the image model is given as the piece's own picture
  (`lib/image/reference.ts`).
- The style tags on a row are **ours**: neither shop publishes a style, so
  each category carries tags from the app's own vocabulary
  (`app/chat/filters.ts`). The colour and material are the shop's own words.
- Source URLs are the real product pages — `source_url` on each row points at
  the exact product the row was read from, and
  `data/catalog.fetched.sources.json` records the same, plus the URL each
  photograph came from.
- The catalogue is **re-seeded from live shops** (`npm run fetch:catalog` then
  `npm run seed`), so the rows it holds change. A scenario with a product name
  typed into it goes stale with it: the run of 31 October asked about a sofa
  that the new catalogue does not hold, the bot correctly said so, and the
  script's own check failed. The scenarios that name a piece now resolve it
  from the catalogue when the run starts (`buildChatCases` in
  `lib/results/chat-cases.ts`) — a real row for the price check, a name the
  catalogue does not hold for the "not in the catalogue" check. If the
  catalogue cannot support one of them, the run stops and says why instead of
  asking the bot a question nothing can answer.
- An iteration draws the next version from the **room photo again**, not by
  editing the previous picture. The piece can therefore shift a little between
  versions — the model redraws it rather than moving it. The upside is that
  every version shows the same room at the same size, so they can be compared
  side by side.
- The server stores the pictures, not the change requests that produced them.
  The client therefore sends the chain's earlier requests back with the next
  one, and they live only as long as the chat view does: **reloading the page
  loses the chat and the typed requests**, while the pictures stay in the
  database and keep counting against the session's quota.
- The comparison table is drawn from the tool's result, so every number in it
  is the database's. The sentence the model writes around the table is still
  its own wording — the tool result carries the notes it is told to follow,
  but the model chooses how to phrase them.
- The rate limiter counts in the memory of one process. With more than one
  worker — or a serverless deployment with several instances — each keeps its
  own counters, so the effective limit becomes N × 20 turns per hour. A
  restart also empties the counters. Moving them to Postgres or Redis is a
  drop-in replacement behind the same three functions.
- **Nothing calls the cleanup by itself.** `npm run cleanup` and
  `POST /api/cleanup` exist, but a scheduler has to run one of them — a cron
  entry, a Supabase scheduled function, or a platform cron. Until one does,
  sessions and their photos stay until the user deletes them.
- `supabase/migrations/0002_retention.sql` has to be run in the SQL editor
  before the live Supabase project is safe: in Postgres a new function is
  `EXECUTE`-able by `PUBLIC`, and both helpers are `SECURITY DEFINER`, so
  without it any role holding the anon key could spend another session's
  quota or sweep the whole table.
- The SQL helper `delete_expired_sessions()` deletes the **metadata** rows in
  `storage.objects`; the pictures themselves stay in the bucket until
  something calls the Storage API. The app's own sweep removes the real files
  first, so use it (`npm run cleanup`) rather than the SQL one.
- `supabase/migrations/0003_auth.sql` has to be run in the SQL editor before
  the sign-in page works on Supabase. Until it is applied the app says so —
  on the page and on `/health` — and the chat carries on as a guest. The
  migration is additive: it creates two tables, adds one column and one
  index, and changes nothing else.
- `supabase/migrations/0004_product_fk_set_null.sql` gives `images.product_id`
  and `generation_jobs.product_id` their `ON DELETE SET NULL` rule. A database
  created from an earlier `0001_init.sql` has the plain `references
  products(id)` rule, which Postgres reads as NO ACTION — the catalogue can
  then not be replaced at all, because Postgres refuses to delete a product an
  image still points at. The seed clears those references itself, so it works
  either way, but the schema should agree with itself.
- `supabase/migrations/0005_session_state_design_brief.sql` realigns the
  `sessions.state` default with the shape the code writes now that a session
  can hold the brief of a designed room. The application does not depend on
  it — both adapters normalise the state on read, and a missing brief simply
  means "no room has been designed yet".
- A room given only as an area is drawn at a ratio of **3:2** — 24 square
  metres becomes 600 × 400 cm. The model is not asked to guess a shape, and
  the user is not asked either; the floor is a default, and a room with
  dimensions ("4x5 เมตร") is used as given.
- The style of a room is matched against the **catalogue's own tags**, which
  are English. A small map in `lib/design/brief.ts` translates the common Thai
  words ("มินิมอล" → "minimal"); a style outside that map falls back to the
  colour and the price, so the piece is still a sensible one, just not the
  most on-style.
- A room is made of what the catalogue has. The pieces are chosen by the code,
  not by the model, so nothing that is not for sale can end up in the picture —
  and a piece the catalogue does not have stops the room instead of being
  quietly left out.
- A designed room spends one unit of the image quota, like any other picture.
- A room is drawn from the user's own photograph when there is one, and from
  the brief alone when there is not — in which case it is a generic room of
  that size, not the shape of a room that exists.
- Supabase Auth has its own settings that are not the app's to make: whether
  sign-ups are open at all, and whether an email address has to be confirmed
  before the first sign-in. With confirmation on, registering returns
  "กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ" and the account cannot be used until the
  link in the mail is followed. The app reads neither setting — it takes
  whatever Supabase says and shows it.

  The setting that makes the smallest setup work is **Authentication → Sign In
  / Providers → Email**: *Enable Email provider* on, *Confirm email* **off**.
  Registering then signs the person in straight away and no mail is sent at
  all. That means no e-mail is ever checked, so anyone can register under any
  address — fine for a lab or a demo, not for something that has to prove who
  somebody is.

  The *Emails → SMTP Settings* page is a different thing: it is for supplying
  your **own** SMTP provider so Supabase can send mail. It can stay off; the
  built-in SMTP has a tiny rate limit and is meant for the project's own
  members, so a confirmation mail to an outside address may never arrive.

- The account tables are protected by RLS with **no policies**, so only the
  service role can read them. That means the accounts cannot be administered
  from the browser at all: there is no "forgot password" mail, no change of
  e-mail address, and no way to delete an account from the interface. Signing
  out and forgetting the password are the whole story for now.
- An account's conversations are found by `sessions.user_id`. A session
  created **before** the person signed in belongs to nobody until they sign in
  while that session is open in the browser — the session id is handed over
  then. Sessions closed long ago stay ownerless, and the retention sweep
  removes them like any other guest session.
- The history lists 50 conversations. Older ones are still there — the list is
  cut off, not the data — and the sweep is what eventually removes them.

## Build plan (from the spec)

| Step | Theme                                              | Status     |
| ---- | -------------------------------------------------- | ---------- |
| 1    | Project setup, adapter, catalog seed               | **done**   |
| 2    | Chat skeleton + Gemini function calling            | **done**   |
| 3    | Room photo upload + `analyzeRoom` tool             | **done**   |
| 4    | Product search + `checkFit` rule (with unit tests) | **done**   |
| 5    | Image generation with `ImageEditProvider`          | **done**   |
| 6    | Iteration, `compareOptions`, `VersionStrip`, quota | **done**   |
| 7    | `DELETE /api/session`, `PrivacyPanel`, rate limits   | **done**   |
| 8    | `results.json` test script + curated report        | **done**   |

On top of the eight steps, four things were added afterwards: the interface
was rebuilt in the blue Gemini style, every recommended piece of
furniture got its picture, an optional sign-in was added so that a person
can keep the log of their conversations (`/history`), and the assistant grew
a second half — **room styling**: it asks what is unclear, has the plan
confirmed, and draws a whole room made of real catalogue furniture, ready to
be adjusted.
# Roomy
