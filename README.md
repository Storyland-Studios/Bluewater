# Bluewater

Nateland Experiences — investor presentation.

## The deck

[`nateland-investor-deck-EXTERNAL.html`](nateland-investor-deck-EXTERNAL.html) is a
single self-contained file converted from `Nateland_Investor_Deck_DRAFT_V8.pptx`.
No server, no build step, no internet — double-click it and present. Images are
embedded as base64 WebP, so it survives being emailed or dropped into a data room.

### Driving it

| Key | Action |
| --- | --- |
| `→` `←` `Space` | next / previous slide |
| `Home` / `End` | first / last slide |
| `7` then `Enter` | jump to slide 7 |
| `O` | overview grid |
| `S` | presenter panel (speaker notes + timer) |
| `F` | fullscreen |
| `B` | blackout |
| `H` | hide the amber OPEN ITEM flags |
| `P` | print → save as PDF, one slide a page |
| `?` | full shortcut list |

### URL switches

- `#s18` or `?slide=18` — open on slide 18
- `?present=1` — open with the presenter panel out
- `?clean=1` — open with open-item flags hidden

Editing notes (palette, slide markup, chart data) are in the comment block at the
top of the HTML file itself.

## The reader record

The hosted copy keeps what the sign-in card collects, and how long each reader
spent on each slide, in Postgres — which is also where the read-back's "across
all readers" column gets its figures. Opened from a file or an email attachment
the deck does not reach for the network at all, and behaves exactly as described
above.

Setup, the endpoints, how to get the data out, and what the reader is told about
it: [`DATABASE.md`](DATABASE.md).

```bash
npm install && npm run migrate    # create the tables
npm run dev                       # deck + API locally, nothing to set up
npm run report                    # who has read it
```
