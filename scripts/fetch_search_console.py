#!/usr/bin/env python3
"""Henter søkeord-data fra Google Search Console for keyword-analysis-agent.

Henter query, impressions, clicks, ctr og position for de siste N dagene og
skriver dem som en flat JSON-liste til --output (standard
data/gsc-queries.json). Resultatet brukes av
scripts/generate_keyword_suggestions.py.

Autentiserer med en service account-nøkkel (JSON-streng) fra
miljøvariabelen GSC_SA_KEY. Service accounten må være lagt til som bruker på
eiendommen i Search Console (Innstillinger → Brukere og tillatelser).

Eksempel:
  GSC_SA_KEY="$(cat nøkkel.json)" python scripts/fetch_search_console.py \
      --site-url sc-domain:seiltips.no --days 90
"""

import argparse
import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"]
# Search Console API returnerer maks 25 000 rader per kall, så vi blar med startRow.
ROW_LIMIT = 25000
# Search Console-data har typisk 2–3 dagers forsinkelse; de siste dagene er
# ufullstendige og ville gitt misvisende lave tall.
DATA_LAG_DAYS = 3


def fail(message: str) -> None:
    print(f"::error::{message}" if os.environ.get("GITHUB_ACTIONS") else f"FEIL: {message}", file=sys.stderr)
    sys.exit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hent søkeord-data fra Google Search Console.")
    parser.add_argument(
        "--site-url",
        required=True,
        help='Eiendommen slik den heter i Search Console, f.eks. "sc-domain:seiltips.no" '
        '(domene-eiendom) eller "https://seiltips.no/" (URL-prefiks-eiendom).',
    )
    parser.add_argument("--days", type=int, default=90, help="Antall dager bakover (standard: 90).")
    parser.add_argument(
        "--output", default="data/gsc-queries.json", help="Utfil (standard: data/gsc-queries.json)."
    )
    args = parser.parse_args()
    if args.days < 1:
        parser.error("--days må være minst 1.")
    return args


def build_service():
    raw_key = os.environ.get("GSC_SA_KEY", "").strip()
    if not raw_key:
        fail("Mangler miljøvariabelen GSC_SA_KEY (service account-nøkkel som JSON-streng).")
    try:
        key_info = json.loads(raw_key)
    except json.JSONDecodeError as err:
        fail(f"GSC_SA_KEY er ikke gyldig JSON ({err}). Lim inn hele innholdet i nøkkelfilen.")
    if key_info.get("type") != "service_account":
        fail('GSC_SA_KEY ser ikke ut som en service account-nøkkel (mangler "type": "service_account").')

    # Importeres her slik at en manglende pakke gir en tydelig feilmelding.
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError as err:
        fail(f"Mangler Python-avhengighet ({err}). Kjør: pip install -r requirements.txt")

    try:
        credentials = service_account.Credentials.from_service_account_info(key_info, scopes=SCOPES)
    except (ValueError, KeyError) as err:
        fail(f"Kunne ikke lese service account-nøkkelen i GSC_SA_KEY: {err}")
    return build("searchconsole", "v1", credentials=credentials, cache_discovery=False), key_info.get(
        "client_email", "(ukjent)"
    )


def list_accessible_sites(service) -> list[str]:
    try:
        response = service.sites().list().execute()
    except Exception:  # noqa: BLE001 – kun brukt som hjelpetekst i feilmelding
        return []
    return [entry.get("siteUrl", "") for entry in response.get("siteEntry", [])]


def fetch_rows(service, site_url: str, start: date, end: date, sa_email: str) -> list[dict]:
    from google.auth.exceptions import RefreshError
    from googleapiclient.errors import HttpError

    rows: list[dict] = []
    start_row = 0
    while True:
        body = {
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "dimensions": ["query"],
            "rowLimit": ROW_LIMIT,
            "startRow": start_row,
        }
        try:
            response = service.searchanalytics().query(siteUrl=site_url, body=body).execute()
        except HttpError as err:
            status = getattr(err.resp, "status", None)
            if status in (401, 403):
                sites = list_accessible_sites(service)
                hint = (
                    f"Service accounten har tilgang til: {', '.join(sites)}"
                    if sites
                    else "Service accounten har ikke tilgang til noen eiendommer."
                )
                fail(
                    f"Ingen tilgang til '{site_url}' i Search Console (HTTP {status}). "
                    f"Legg til {sa_email} som bruker på eiendommen, og sjekk at --site-url "
                    f"er skrevet nøyaktig slik eiendommen heter. {hint}"
                )
            if status == 404:
                fail(f"Fant ikke eiendommen '{site_url}' i Search Console (HTTP 404).")
            fail(f"Kall til Search Console API feilet (HTTP {status}): {err}")
        except RefreshError as err:
            fail(
                f"Google avviste service account-nøkkelen i GSC_SA_KEY ({err}). Nøkkelen kan være "
                "slettet/deaktivert, eller Search Console API er ikke aktivert i Google Cloud-prosjektet."
            )
        except Exception as err:  # noqa: BLE001 – nettverksfeil o.l.
            fail(f"Kall til Search Console API feilet: {err}")

        batch = response.get("rows", [])
        rows.extend(batch)
        if len(batch) < ROW_LIMIT:
            return rows
        start_row += ROW_LIMIT


def main() -> None:
    args = parse_args()
    service, sa_email = build_service()

    end = date.today() - timedelta(days=DATA_LAG_DAYS)
    start = end - timedelta(days=args.days - 1)
    print(f"Henter Search Console-data for {args.site_url} ({start} – {end}) …")

    raw_rows = fetch_rows(service, args.site_url, start, end, sa_email)
    queries = [
        {
            "query": row["keys"][0],
            "impressions": int(row.get("impressions", 0)),
            "clicks": int(row.get("clicks", 0)),
            "ctr": round(float(row.get("ctr", 0.0)), 4),
            "position": round(float(row.get("position", 0.0)), 1),
        }
        for row in raw_rows
        if row.get("keys")
    ]
    queries.sort(key=lambda q: q["impressions"], reverse=True)

    if not queries:
        # Ikke en reell feil (f.eks. ny eiendom eller lite trafikk) – vi skriver
        # en tom liste slik at neste steg kan hoppe pent over analysen.
        print(
            f"::warning::Search Console returnerte ingen søkeord for {args.site_url} i perioden."
            if os.environ.get("GITHUB_ACTIONS")
            else f"ADVARSEL: Search Console returnerte ingen søkeord for {args.site_url} i perioden."
        )

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(queries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Skrev {len(queries)} søkeord til {output}")


if __name__ == "__main__":
    main()
