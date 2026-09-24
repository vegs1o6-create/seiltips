#!/usr/bin/env python3
"""Lager artikkelforslag fra Search Console-data med en modell i Microsoft Foundry.

Del av keyword-analysis-agent (se README.md):
  1. Leser data/gsc-queries.json (fra scripts/fetch_search_console.py) og plukker
     ut kandidat-søkeord (impressions > 50, position 8–20).
  2. Leser titlene på publiserte artikler i src/content/artikler/ og tidligere
     forslag i keyword-suggestions.json.
  3. Fyller inn promptmalen .github/prompts/keyword-analysis.md og kaller
     chat-completions-endepunktet i Microsoft (Azure) AI Foundry – samme
     OpenAI v1-kompatible endepunkt (/openai/v1/chat/completions, "Authorization:
     Bearer") som scripts/seilruteplanlegger.mjs bruker.
  4. Legger nye forslag til i keyword-suggestions.json. Eksisterende forslag
     (både brukte og ubrukte) beholdes – historikken slettes aldri.

Miljøvariabler:
  AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_API_KEY  – påkrevd (delt med de andre agentene)
  AZURE_FOUNDRY_MODEL                            – deployment-navnet (samme secret som
                                                   seilruteplanleggeren bruker)
  AZURE_FOUNDRY_KEYWORD_MODEL                    – valgfri, overstyrer AZURE_FOUNDRY_MODEL
  AZURE_FOUNDRY_KEYWORD_MAX_TOKENS               – valgfri, standard 16000
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PRIORITIES = ("høy", "middels", "lav")
MAX_ATTEMPTS = 3
RETRY_DELAYS_SECONDS = (5, 20)
REQUEST_TIMEOUT_SECONDS = 300
# Feil som skyldes oppsettet (feil nøkkel, endepunkt eller deployment) blir ikke
# bedre av å prøve igjen.
NON_RETRYABLE_STATUS = {400, 401, 403, 404}


class ModelResponseError(Exception):
    """Svaret fra modellen kunne ikke brukes (tomt, ugyldig JSON, feil form)."""


class FatalError(Exception):
    """Feil som ikke skal prøves på nytt."""


def fail(message: str) -> None:
    print(f"::error::{message}" if os.environ.get("GITHUB_ACTIONS") else f"FEIL: {message}", file=sys.stderr)
    sys.exit(1)


def warn(message: str) -> None:
    print(f"::warning::{message}" if os.environ.get("GITHUB_ACTIONS") else f"ADVARSEL: {message}")


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        fail(f"Mangler påkrevd miljøvariabel: {name}")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generer artikkelforslag fra Search Console-data.")
    parser.add_argument("--gsc-data", default="data/gsc-queries.json")
    parser.add_argument("--articles-dir", default="src/content/artikler")
    parser.add_argument("--prompt", default=".github/prompts/keyword-analysis.md")
    parser.add_argument("--output", default="keyword-suggestions.json")
    parser.add_argument("--min-impressions", type=int, default=50, help="Impressions må være større enn dette.")
    parser.add_argument("--min-position", type=float, default=8.0)
    parser.add_argument("--max-position", type=float, default=20.0)
    parser.add_argument(
        "--max-candidates",
        type=int,
        default=300,
        help="Maks antall kandidat-søkeord som sendes til modellen (de med flest impressions).",
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Inndata
# ---------------------------------------------------------------------------


def load_gsc_queries(path: Path) -> list[dict]:
    if not path.exists():
        fail(f"Fant ikke {path}. Kjør scripts/fetch_search_console.py først.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        fail(f"{path} er ikke gyldig JSON: {err}")
    if not isinstance(data, list):
        fail(f"{path} skal inneholde en JSON-liste med søkeord.")
    return data


def select_candidates(queries: list[dict], args: argparse.Namespace) -> list[dict]:
    # Filtreringen står også i prompten, men gjøres her i tillegg slik at vi
    # sender et lite, relevant utvalg (en stor side kan ha titusenvis av rader).
    candidates = [
        q
        for q in queries
        if q.get("impressions", 0) > args.min_impressions
        and args.min_position <= q.get("position", 0) <= args.max_position
    ]
    candidates.sort(key=lambda q: q["impressions"], reverse=True)
    return candidates[: args.max_candidates]


def extract_title(markdown: str) -> str | None:
    frontmatter = re.match(r"^---\n(.*?)\n---", markdown, re.DOTALL)
    if not frontmatter:
        return None
    match = re.search(r'^title:\s*"?([^"\n]+)"?\s*$', frontmatter.group(1), re.MULTILINE)
    return match.group(1).strip() if match else None


def load_article_titles(articles_dir: Path) -> list[str]:
    if not articles_dir.is_dir():
        warn(f"Fant ikke artikkelmappen {articles_dir} – antar at ingen artikler er publisert.")
        return []
    titles = []
    for path in sorted(articles_dir.glob("**/*.md")):
        title = extract_title(path.read_text(encoding="utf-8"))
        if title:
            titles.append(title)
    return titles


def load_existing_suggestions(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        # Vi overskriver aldri en fil vi ikke klarer å lese – da kunne vi mistet historikk.
        fail(f"{path} finnes, men er ikke gyldig JSON ({err}). Rett filen manuelt før neste kjøring.")
    suggestions = data.get("suggestions") if isinstance(data, dict) else None
    if not isinstance(suggestions, list):
        fail(f'{path} mangler en "suggestions"-liste. Rett filen manuelt før neste kjøring.')
    return suggestions


def build_prompt(template: str, candidates: list[dict], titles: list[str], existing: list[dict]) -> str:
    template = re.sub(r"<!--.*?-->\s*", "", template, count=1, flags=re.DOTALL)
    articles = "\n".join(f"- {t}" for t in titles) or "(ingen artikler publisert ennå)"
    previous = "\n".join(
        f"- {s.get('title')} ({'allerede skrevet' if s.get('brukt') else 'ikke skrevet ennå'})"
        for s in existing
        if s.get("title")
    ) or "(ingen tidligere forslag)"
    gsc = json.dumps(
        [{k: q.get(k) for k in ("query", "impressions", "clicks", "ctr", "position")} for q in candidates],
        ensure_ascii=False,
        indent=1,
    )
    replacements = {
        "{{TODAY}}": datetime.now(timezone.utc).date().isoformat(),
        "{{GSC_DATA}}": gsc,
        "{{EXISTING_ARTICLES}}": articles,
        "{{EXISTING_SUGGESTIONS}}": previous,
    }
    for placeholder, value in replacements.items():
        if placeholder not in template:
            fail(f"Promptmalen mangler plassholderen {placeholder}.")
        template = template.replace(placeholder, value)
    return template


# ---------------------------------------------------------------------------
# Microsoft Foundry
# ---------------------------------------------------------------------------


def call_foundry(prompt: str) -> str:
    import requests

    endpoint = require_env("AZURE_FOUNDRY_ENDPOINT").rstrip("/")
    api_key = require_env("AZURE_FOUNDRY_API_KEY")
    model = os.environ.get("AZURE_FOUNDRY_KEYWORD_MODEL", "").strip() or require_env("AZURE_FOUNDRY_MODEL")
    max_tokens = int(os.environ.get("AZURE_FOUNDRY_KEYWORD_MAX_TOKENS") or 16000)

    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        # Reasoning-modeller bruker en del av budsjettet på skjulte resonnement-
        # tokens før selve svaret, så vi gir god margin (som seilruteplanleggeren).
        "max_completion_tokens": max_tokens,
    }
    try:
        res = requests.post(
            f"{endpoint}/openai/v1/chat/completions",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            json=body,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as err:
        raise ModelResponseError(f"Nettverksfeil mot Azure AI Foundry: {err}") from err

    if not res.ok:
        message = f"Kall til Azure AI Foundry feilet ({res.status_code} {res.reason}): {res.text[:500]}"
        if res.status_code in NON_RETRYABLE_STATUS:
            raise FatalError(
                message + "\nSjekk AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_API_KEY og deployment-navnet i "
                "AZURE_FOUNDRY_MODEL / AZURE_FOUNDRY_KEYWORD_MODEL."
            )
        raise ModelResponseError(message)

    data = res.json()
    choice = (data.get("choices") or [{}])[0]
    content = (choice.get("message") or {}).get("content")
    if not content:
        if choice.get("finish_reason") == "length":
            raise ModelResponseError(
                f"Modellen brukte opp hele tokenbudsjettet ({max_tokens}) uten å svare. "
                "Sett AZURE_FOUNDRY_KEYWORD_MAX_TOKENS høyere."
            )
        raise ModelResponseError(f"Fikk ikke noe svarinnhold fra modellen. Rått svar: {json.dumps(data)[:500]}")
    return content


def parse_model_json(text: str) -> dict:
    cleaned = text.strip()
    # Modellen blir bedt om rent JSON, men pakker det av og til i ```json-fences.
    fence = re.search(r"```(?:json|JSON)?\s*\n?(.*?)\n?```", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1).strip()
    # Siste utvei: tekst rundt selve objektet.
    if not cleaned.startswith("{"):
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start != -1 and end > start:
            cleaned = cleaned[start : end + 1]
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as err:
        raise ModelResponseError(f"Svaret fra modellen var ikke gyldig JSON ({err}). Start: {text[:300]!r}") from err
    if not isinstance(data, dict) or not isinstance(data.get("suggestions"), list):
        raise ModelResponseError('Svaret fra modellen manglet en "suggestions"-liste.')
    return data


def normalize_suggestion(raw: dict, gsc_lookup: dict[str, dict]) -> dict | None:
    """Validerer ett forslag. Returnerer None (med advarsel) hvis det ikke kan brukes."""
    if not isinstance(raw, dict):
        return None
    title = str(raw.get("title") or "").strip()
    keywords = [str(k).strip() for k in raw.get("keywords") or [] if str(k).strip()]
    reasoning = str(raw.get("reasoning") or "").strip()
    priority = str(raw.get("priority") or "").strip().lower().replace("hoy", "høy")
    if not title or not keywords or not reasoning:
        warn(f"Hopper over ufullstendig forslag fra modellen: {json.dumps(raw, ensure_ascii=False)[:200]}")
        return None
    if priority not in PRIORITIES:
        warn(f'Ukjent prioritet "{priority}" for "{title}" – setter "middels".')
        priority = "middels"

    # Tallene hentes fra de faktiske GSC-dataene, ikke fra modellen, og søkeord
    # modellen har funnet på droppes.
    source_queries = []
    for item in raw.get("source_queries") or []:
        query = str(item.get("query") if isinstance(item, dict) else item or "").strip()
        real = gsc_lookup.get(query.lower())
        if real:
            source_queries.append(
                {"query": real["query"], "impressions": real["impressions"], "position": real["position"]}
            )
    if not source_queries:
        warn(f'Hopper over "{title}": ingen av søkeordene i source_queries finnes i Search Console-dataene.')
        return None

    return {
        "title": title,
        "keywords": keywords[:5],
        "reasoning": reasoning,
        "priority": priority,
        "brukt": False,
        "source_queries": source_queries,
    }


def generate_with_retries(prompt: str, gsc_lookup: dict[str, dict]) -> list[dict]:
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            print(f"Ber Azure AI Foundry-modellen analysere søkeordene (forsøk {attempt}/{MAX_ATTEMPTS}) …")
            data = parse_model_json(call_foundry(prompt))
            suggestions = [normalize_suggestion(s, gsc_lookup) for s in data["suggestions"]]
            return [s for s in suggestions if s]
        except FatalError as err:
            fail(str(err))
        except ModelResponseError as err:
            if attempt == MAX_ATTEMPTS:
                fail(f"Ga opp etter {MAX_ATTEMPTS} forsøk. Siste feil: {err}")
            delay = RETRY_DELAYS_SECONDS[min(attempt - 1, len(RETRY_DELAYS_SECONDS) - 1)]
            warn(f"Forsøk {attempt} feilet: {err} Prøver igjen om {delay} s …")
            time.sleep(delay)
    return []  # nås ikke


# ---------------------------------------------------------------------------


def title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9æøå]+", " ", title.lower()).strip()


def main() -> None:
    args = parse_args()
    output = Path(args.output)

    queries = load_gsc_queries(Path(args.gsc_data))
    candidates = select_candidates(queries, args)
    print(
        f"{len(queries)} søkeord fra Search Console, {len(candidates)} kandidater med "
        f"impressions > {args.min_impressions} og posisjon {args.min_position:g}–{args.max_position:g}."
    )
    if not candidates:
        print("Ingen søkeord oppfyller kriteriene denne uken – ingen nye forslag, keyword-suggestions.json er uendret.")
        return

    titles = load_article_titles(Path(args.articles_dir))
    existing = load_existing_suggestions(output)
    print(f"{len(titles)} publiserte artikler, {len(existing)} tidligere forslag.")

    template = Path(args.prompt).read_text(encoding="utf-8")
    prompt = build_prompt(template, candidates, titles, existing)
    gsc_lookup = {str(q.get("query", "")).lower(): q for q in queries}

    generated = generate_with_retries(prompt, gsc_lookup)

    known = {title_key(t) for t in titles} | {title_key(s.get("title", "")) for s in existing}
    new_suggestions = []
    for suggestion in generated:
        key = title_key(suggestion["title"])
        if key in known:
            print(f'Hopper over duplikat: "{suggestion["title"]}"')
            continue
        known.add(key)
        new_suggestions.append(suggestion)

    if not new_suggestions:
        print("Modellen fant ingen nye temaer – keyword-suggestions.json er uendret.")
        return

    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        # Eksisterende forslag (særlig de med "brukt": true) beholdes alltid.
        "suggestions": existing + new_suggestions,
    }
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"La til {len(new_suggestions)} nye forslag i {output}:")
    for s in new_suggestions:
        print(f'  [{s["priority"]}] {s["title"]}')


if __name__ == "__main__":
    main()
