#!/usr/bin/env python3
"""Check the site against reality.

    python check.py            structure only - instant, works offline
    python check.py --links    also fetch every URL (slow, needs network)

This does NOT generate anything. index.html stays hand-written and stays
the source of truth; this only reports where it and the world disagree.
Nothing here is required to build or deploy the site.

Two things it looks at:

  structure  every project on the site should have its repo cloned into
             the matching category folder next door, and every repo in
             those folders should be on the site.

  links      every run/download and source URL should return 200.

The site's names and the repo names deliberately differ (3d_wireframes
lives in the repo spinning-cube), so the repo name is read out of
data-code rather than guessed from data-name.
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIBLINGS = os.path.dirname(HERE)          # Documents\GitHub
CATEGORIES = ("browser", "native", "python")

GREEN, RED, YELLOW, DIM, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m"
if os.name == "nt" and not os.environ.get("WT_SESSION"):
    os.system("")                          # let Windows terminals do colour


def projects():
    """Every project in index.html, with the category it is filed under."""
    html = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
    out = []
    for sec in re.finditer(r'<section data-dir="([^"]+)"(.*?)</section>', html, re.S):
        cat, body = sec.group(1), sec.group(2)
        for li in re.finditer(r"<li ([^>]*?)>", body, re.S):
            attrs = dict(re.findall(r'data-([a-z-]+)="([^"]*)"', li.group(1)))
            if "name" in attrs:
                attrs["category"] = cat
                out.append(attrs)
    return out


def repo_of(p):
    """The repo a project lives in, taken from its source link."""
    m = re.match(r"https://github\.com/boris-volkov/([^/]+)", p.get("code", ""))
    return m.group(1) if m else None


def check_structure(ps):
    problems = []
    if not all(os.path.isdir(os.path.join(SIBLINGS, c)) for c in CATEGORIES):
        print(f"{DIM}  category folders not found next to this repo - skipping{OFF}")
        return problems

    on_disk = {c: set(os.listdir(os.path.join(SIBLINGS, c))) for c in CATEGORIES}
    claimed = {c: set() for c in CATEGORIES}

    for p in ps:
        repo, cat = repo_of(p), p["category"]
        if repo is None:
            problems.append(f"{p['name']}: source link is not a boris-volkov repo")
            continue
        claimed.setdefault(cat, set()).add(repo)
        if cat not in on_disk:
            continue
        if repo in on_disk[cat]:
            print(f"  {GREEN}ok{OFF}   {p['name']:<20} {DIM}{cat}/{repo}{OFF}")
        else:
            where = next((c for c in CATEGORIES if repo in on_disk[c]), None)
            loose = os.path.isdir(os.path.join(SIBLINGS, repo))
            if where:
                problems.append(f"{p['name']}: site says {cat}/, but the repo is in {where}/")
            elif loose:
                problems.append(f"{p['name']}: repo sits loose in GitHub/, expected {cat}/{repo}")
            else:
                problems.append(f"{p['name']}: repo '{repo}' is not cloned locally (expected {cat}/)")

    for c in CATEGORIES:
        for extra in sorted(on_disk.get(c, set()) - claimed.get(c, set())):
            problems.append(f"{c}/{extra}: on disk but not on the site")
    return problems


def check_links(ps):
    import urllib.request
    import urllib.error
    problems = []
    seen = {}

    def status(url):
        if url in seen:
            return seen[url]
        full = "https://boris-volkov.github.io" + url if url.startswith("/") else url
        req = urllib.request.Request(full, method="GET",
                                     headers={"User-Agent": "check.py"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                code = r.status
        except urllib.error.HTTPError as e:
            code = e.code
        except Exception as e:
            code = type(e).__name__
        seen[url] = code
        return code

    for p in ps:
        for kind in ("run", "code"):
            url = p.get(kind)
            if not url:
                continue
            code = status(url)
            mark = f"{GREEN}ok{OFF}" if code == 200 else f"{RED}{code}{OFF}"
            print(f"  {mark:<12} {p['name']:<20} {DIM}{kind}: {url}{OFF}")
            if code != 200:
                problems.append(f"{p['name']}: {kind} -> {url} returned {code}")
    return problems


def main():
    ps = projects()
    print(f"\n{len(ps)} projects in index.html\n")

    print("structure")
    problems = check_structure(ps)

    if "--links" in sys.argv:
        print("\nlinks")
        problems += check_links(ps)
    else:
        print(f"\n{DIM}(run with --links to check every URL too){OFF}")

    print()
    if problems:
        print(f"{RED}{len(problems)} problem(s):{OFF}")
        for p in problems:
            print(f"  {YELLOW}-{OFF} {p}")
        return 1
    print(f"{GREEN}all consistent{OFF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
