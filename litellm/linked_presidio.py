"""Presidio masking that gives every mention of one person the same placeholder.

LiteLLM's Presidio hook numbers each finding on its own, so "Jan Nowak", "Jana Nowaka" and "JN"
reach the model as three different people. This replaces only that numbering step:

- Full names whose words share a stem are one person ("Jan Nowak" ~ "Jana Nowaka" ~ "Janowi
  Nowakowi"). A heuristic for an inflected language, not a lemmatiser: a word matches when the
  two share a prefix at least three characters long and no more than three short of the shorter.
- Initials ("JN", or the first parts of a therapy code like JN-MK-MON) join the one full name they
  abbreviate. Two people with the same initials in one text are ambiguous, so the initials then
  stay a person of their own.
- Any other entity shares a placeholder only with an exact repeat of itself.
- Overlapping findings (an email also matched as a URL) are resolved before numbering, keeping the
  longer one. LiteLLM's own numbering applies both and garbles the text.

The number says who; a suffix says which form, so the reply restores exactly what was written:

    "Jana Nowaka" -> <PERSON_2_V1>    "Jan Nowak" -> <PERSON_2_V2>    "JN" -> <PERSON_2_INITIALS>

A person met in only one full form keeps a plain <PERSON_1>. A bare <PERSON_2> the model writes on
its own restores to the shortest full form, usually the nominative ("Jan Nowak"). Everything else is LiteLLM's: analysis,
the per-request map, and putting the values back into the reply.
"""

import re
from typing import Any

from litellm.proxy.guardrails.guardrail_hooks.presidio import _OPTIONAL_PresidioPIIMasking

INITIALS = re.compile(r"^[A-ZĄĆĘŁŃÓŚŹŻ]{2,3}$")
WORD = re.compile(r"[^\W\d_]+(?:['-][^\W\d_]+)*")


def _words(text: str) -> list[str]:
    return WORD.findall(text)


def _same_stem(a: str, b: str) -> bool:
    a, b = a.lower(), b.lower()
    shared = 0
    for x, y in zip(a, b):
        if x != y:
            break
        shared += 1
    return shared >= max(3, min(len(a), len(b)) - 3)


def _same_name(a: str, b: str) -> bool:
    wa, wb = _words(a), _words(b)
    return len(wa) == len(wb) and all(_same_stem(x, y) for x, y in zip(wa, wb))


def _initials_of(name: str) -> str:
    return "".join(w[0] for w in _words(name)).upper()


def _without_overlaps(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Longest first, so a finding inside another (a URL inside an email) is dropped."""
    kept: list[dict[str, Any]] = []
    for r in sorted(results, key=lambda r: (-(r["end"] - r["start"]), -r.get("score", 0))):
        if all(r["end"] <= k["start"] or r["start"] >= k["end"] for k in kept):
            kept.append(r)
    return sorted(kept, key=lambda r: r["start"])


def _link(text: str, results: list[dict[str, Any]]) -> list[tuple[int, dict[str, Any]]]:
    """For each finding, its placeholder number and the identity it belongs to."""
    identities: list[dict[str, Any]] = []
    owner: list[int | None] = [None] * len(results)
    mention = [text[r["start"] : r["end"]] for r in results]
    is_person = [r["entity_type"] == "PERSON" for r in results]
    is_initials = [p and bool(INITIALS.match(m)) for p, m in zip(is_person, mention)]

    # Full names first, so initials can find the name they abbreviate wherever it appears.
    for i, r in enumerate(results):
        if not is_person[i] or is_initials[i]:
            continue
        for n, identity in enumerate(identities):
            if any(_same_name(m, mention[i]) for m in identity["names"]):
                identity["names"].append(mention[i])
                owner[i] = n
                break
        else:
            identities.append({"entity": "PERSON", "names": [mention[i]], "first": r["start"]})
            owner[i] = len(identities) - 1

    for i, r in enumerate(results):
        if owner[i] is not None:
            continue
        if is_initials[i]:
            candidates = [
                n
                for n, identity in enumerate(identities)
                if identity["entity"] == "PERSON"
                and any(_initials_of(m) == mention[i] or m == mention[i] for m in identity["names"])
            ]
            if len(candidates) == 1:
                identities[candidates[0]]["names"].append(mention[i])
                identities[candidates[0]]["first"] = min(identities[candidates[0]]["first"], r["start"])
                owner[i] = candidates[0]
                continue
        else:
            same = [
                n
                for n, identity in enumerate(identities)
                if identity["entity"] == r["entity_type"] and mention[i] in identity["names"]
            ]
            if same:
                owner[i] = same[0]
                continue
        identities.append({"entity": r["entity_type"], "names": [mention[i]], "first": r["start"]})
        owner[i] = len(identities) - 1

    # Numbered in order of first appearance, as LiteLLM numbers its tokens.
    order = sorted(range(len(identities)), key=lambda n: identities[n]["first"])
    number = {n: k + 1 for k, n in enumerate(order)}
    return [(number[o], identities[o]) for o in owner]  # type: ignore[index]


def _restore_value(names: list[str]) -> str:
    full = [n for n in names if not INITIALS.match(n)]
    return min(full, key=len) if full else names[0]


class LinkedPresidio(_OPTIONAL_PresidioPIIMasking):
    def _finalize_presidio_anonymize_numbered_tokens(
        self,
        text: str,
        analyze_results: Any,
        request_data: dict | None,
        masked_entity_count: dict[str, int],
    ) -> str:
        if request_data is None:
            request_data = {}
        if not request_data.get("metadata"):
            request_data["metadata"] = {}
        pii_tokens = request_data["metadata"].setdefault("pii_tokens", {})

        results = _without_overlaps(list(analyze_results))
        linked = _link(text, results)

        new_text = text
        for result, (seq, identity) in sorted(zip(results, linked), key=lambda pair: -pair[0]["start"]):
            mention = text[result["start"] : result["end"]]
            base = f"{result['entity_type']}_{seq}"
            # Distinct full forms in order of first appearance; an exact repeat reuses its variant.
            forms = list(dict.fromkeys(n for n in identity["names"] if not INITIALS.match(n)))
            if result["entity_type"] == "PERSON" and INITIALS.match(mention):
                token = f"<{base}_INITIALS>"
            elif len(forms) > 1:
                token = f"<{base}_V{forms.index(mention) + 1}>"
            else:
                token = f"<{base}>"
            pii_tokens[token] = mention
            pii_tokens.setdefault(f"<{base}>", _restore_value(identity["names"]))
            new_text = new_text[: result["start"]] + token + new_text[result["end"] :]
            masked_entity_count[result["entity_type"]] = masked_entity_count.get(result["entity_type"], 0) + 1
        return new_text
