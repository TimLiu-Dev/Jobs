"""Validate companies.json and regenerate companies.js + the Markdown matrix rows from it.

companies.json is the single source of truth. After editing it, run:

    python build_data.py

Only the company table rows (lines starting with "| <id> |") of the .md file are rewritten;
headings, the comp-band key and tier descriptions are left untouched.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
JSON_PATH = ROOT / "companies.json"
JS_PATH = ROOT / "companies.js"
MD_PATH = next(ROOT.glob("2027_US_Android_Engineering_Target_Companies_*.md"))

JS_HEADER = """/**
 * 2027 U.S. Android Engineering Career & Job-Hop Command Center — Standalone Dataset
 * Separated from application logic for clean Git diffs, instant loading over file:// or HTTP,
 * and easy editing without touching UI or scoring code.
 * GENERATED from companies.json by build_data.py — edit companies.json, not this file.
 */
"""

ENUMS = {
    "band": {"A", "B", "C", "D"},
    "wfa": {"Hybrid / Onsite", "WFA 20–30d", "WFA 60–90d", "All-Remote"},
    "wlb": {"High WLB", "Balanced", "High Pace / Startup", "Regulated / Enterprise"},
    "interview": {
        "AOSP / BLE / Hardware Systems",
        "Live Compose / Android Build",
        "CodeSignal / LeetCode OA",
        "Architecture / Take-Home",
    },
    "levelFit": {"Mid & Senior", "Mid Pipeline Strong", "Senior Stretch", "Senior-Only Bar"},
    "statusFlag": {"Active", "Watchlist / Distressed"},
}
TC_RE = re.compile(r"^\$(\d+)k–\$(\d+)k$")


def validate(data):
    errors = []
    companies = data["companies"]
    metro_ids = {m["id"] for m in data["metros"]} - {"ALL"}
    if [c["id"] for c in companies] != list(range(1, len(companies) + 1)):
        errors.append("ids must run 1..N in order")
    if data.get("totalCompanies") != len(companies):
        errors.append(f"totalCompanies={data.get('totalCompanies')} but {len(companies)} companies")
    for c in companies:
        cid = c["id"]
        for field, allowed in ENUMS.items():
            if c[field] not in allowed:
                errors.append(f"#{cid} {field}={c[field]!r}")
        if str(c["tier"]) not in data["tiers"]:
            errors.append(f"#{cid} unknown tier {c['tier']}")
        for m in c["metros"]:
            if m not in metro_ids:
                errors.append(f"#{cid} unknown metro {m!r}")
        for field in ("midTc", "seniorTc"):
            match = TC_RE.match(c[field])
            if not match or int(match.group(1)) > int(match.group(2)):
                errors.append(f"#{cid} bad {field} {c[field]!r}")
        if not 0 <= c["overlap"] <= 10:
            errors.append(f"#{cid} overlap out of range")
        if "|" in c["name"] + c["hq"] + c["stackNote"]:
            errors.append(f"#{cid} contains '|' (breaks Markdown table)")
    tiers = [c["tier"] for c in companies]
    if tiers != sorted(tiers):
        errors.append("companies must be ordered by tier")
    for sid in data.get("starterTargetIds", []):
        if not 1 <= sid <= len(companies):
            errors.append(f"starterTargetIds has unknown id {sid}")
    return errors


def md_name(c):
    name = c["name"]
    i = name.find(" (")
    out = f"**{name}**" if i < 0 else f"**{name[:i]}**{name[i:]}"
    if c["statusFlag"] != "Active":
        out += " **[WATCHLIST]**"
    return out


def md_row(c):
    return (
        f"| {c['id']} | {md_name(c)} | {c['hq']} | {c['stage']} | Band {c['band']} | {c['midTc']} | {c['seniorTc']} | "
        f"{c['wfa']} • {c['wlb']} | {c['levelFit']} ({c['interview']}) | **{c['overlap']}/10** — {c['stackNote']} |"
    )


def main():
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    errors = validate(data)
    if errors:
        print("Validation failed:\n  " + "\n  ".join(errors))
        sys.exit(1)

    body = json.dumps(data, indent=2, ensure_ascii=False)
    JSON_PATH.write_text(body, encoding="utf-8", newline="\n")
    JS_PATH.write_text(f"{JS_HEADER}window.ANDROID_COMMAND_CENTER_DATA = {body};\n", encoding="utf-8", newline="\n")

    by_id = {c["id"]: c for c in data["companies"]}
    lines = MD_PATH.read_text(encoding="utf-8").split("\n")
    seen = set()
    for i, line in enumerate(lines):
        m = re.match(r"^\| (\d+) \|", line)
        if m:
            cid = int(m.group(1))
            lines[i] = md_row(by_id[cid])
            seen.add(cid)
    missing = set(by_id) - seen
    if missing:
        print(f"Warning: {len(missing)} companies have no row in {MD_PATH.name}: {sorted(missing)[:10]}")
    MD_PATH.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"OK: {len(data['companies'])} companies -> {JS_PATH.name}, {MD_PATH.name}")


if __name__ == "__main__":
    main()
