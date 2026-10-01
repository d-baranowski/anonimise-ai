# PII round-trip proxy POC

LiteLLM proxy + Microsoft Presidio (now `data-privacy-stack/presidio`): names and identifiers are
replaced with numbered placeholders before a prompt leaves the machine, and put back into the reply.

```
your app ──► LiteLLM :4000 ──► AI provider
               │  ▲
     analyze   │  │ restore <PERSON_1> → "Anna Kowalska"
               ▼  │
   Presidio analyzer :5002   (spaCy NER, en + pl, plus PESEL / phone / IBAN / email patterns)
   Presidio anonymizer :5001
```

Everything runs locally. Detection is a spaCy model plus regexes and checksums, not an LLM.
The default provider is `fake-llm` (:4010): it records exactly what it received and echoes it
back, so you can see what a real provider would get without sending anything anywhere.

## Web UI

http://localhost:4020 — pick a sample or type a prompt, choose the provider, Run. It shows every
state: the prompt with what Presidio found, the detections (overlaps and deny-listed ones
flagged), what the provider received, the placeholder → original map the proxy keeps, the
provider's raw reply, and what your app gets back — plus checks for leaks, a lossless round trip,
unrestored placeholders and stream buffering.

With "Claude (real)", requests go through a recording tap in `fake-llm` on their way to
Anthropic, so stages 3 and 5 show exactly what Anthropic received and returned.

## Run

```bash
docker compose up -d --build          # first build pulls the Polish spaCy model (~500 MB)
node demo.mjs                         # every sample in samples.json
node demo.mjs basic same-person-twice # chosen samples
node demo.mjs --text "Twój tekst z Janem Kowalskim" --lang pl
node demo.mjs basic --stream          # streamed reply
node demo.mjs initials --plain        # LiteLLM's own numbering, for comparison
```

A real provider: put `ANTHROPIC_API_KEY=...` in `.env`, `docker compose up -d`, then
`node demo.mjs --model claude`. The masked prompt is then really sent to Anthropic.

Each sample prints: 1 original prompt · 2 what Presidio detected · 3 what the provider received
(and whether any expected value leaked) · 4 the provider's raw reply · 5 the restored reply, with
a check that the round trip did not change the text.

Add your own cases to `samples.json` (`expect` lists the values that must not reach the provider).

## Findings (LiteLLM v1.103.2, Presidio 2.2.364, pl_core_news_lg 3.8.0)

- **Polish works.** Names incl. inflected forms ("Annie Kowalskiej", "Marka Wiśniewskiego") and
  first names alone ("Kuba", "Bartek") were caught; PESEL (checksum), +48 phones, PL IBANs too.
  Six samples only — measure on real-shaped data before trusting it.
- **Overlapping detections corrupt the text.** LiteLLM replaces findings by offset without
  resolving overlaps: an email also matched as a URL sent `…<EMAIL_ADDRESS_1>ziękuję!` (lost
  ". D") and swallowed "and" into a name token. Worked around with
  `presidio_entities_deny_list: [URL]`; any other overlap would trip it again.
- **Streaming is broken.** The reply is restored and then masked again by a second post-call pass,
  so the app receives `<PERSON>` instead of the name. Non-streamed requests are fine. Streaming
  is also buffered: one chunk at the end, no token-by-token output.
- **Linked mode (default) gives one person one placeholder** — `litellm/linked_presidio.py`, a
  subclass of LiteLLM's Presidio hook that replaces only its numbering. Full names sharing stems
  ("Jan Nowak", "Janowi Nowakowi") and initials that abbreviate exactly one of them ("JN", the
  JN/MK in a JN-MK-MON code) share a number; initials get `<PERSON_1_INITIALS>` so the code
  restores intact. Inflected forms restore to the shortest one ("Przypomnij Jan Nowak"), and two
  people with the same initials stay unlinked. It also resolves overlapping findings, so the
  email/URL bug does not hit it. Heuristic stem matching, not a lemmatiser.
- **LiteLLM's own numbering (`--plain`, or "LiteLLM" in the UI): each mention is a separate token.** "Marek Wiśniewski" and "Marka Wiśniewskiego" become
  `<PERSON_1>` and `<PERSON_2>`; the model cannot tell they are one person.
- **Restore is plain string replacement** of the tokens the model echoes back; a model that
  rewrites a token (e.g. `<PERSON 1>`) leaves it unrestored.
