#!/usr/bin/env python3
"""Check the site against the folder it is a window onto.

    python check.py            structure only - instant, works offline
    python check.py --links    also fetch every URL (slow, needs network)

This does NOT generate anything. index.html stays hand-written and stays
the source of truth; this only reports where it and the folder next door
have drifted apart. The site does not need it to build or deploy.

The rule it enforces:

    every directory on the page is a folder in Documents\\GitHub, and
    every project on the page is a git repo inside the matching folder.

Folders starting with _ (_archive, _external, _reference) are the ones
deliberately kept off the site, so they are skipped - the same convention
Jekyll uses, and the reason nothing in them needs explaining.

Site names and repo names differ on purpose (3d_wireframes lives in the
repo spinning-cube), so the repo is read out of data-code rather than
guessed from data-name.
"""

import os
import re
import sys
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.dirname(HERE)            # the folder the site mirrors
SITE_REPO = os.path.basename(HERE)         # this repo is not content

GREEN, RED, YELLOW, DIM, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m"
if os.name == "nt":
    os.system("")                          # let Windows terminals do colour


class Reader(HTMLParser):
    """Walks the markup keeping track of which directory it is inside,
    so a nested <li data-dir=...> yields a path like programming/examples."""

    def __init__(self):
        super().__init__()
        self.stack = []                    # (tagname, dirname or None)
        self.dirs = []                     # every directory path on the page
        self.files = []                    # every project, with its path

    def _path(self):
        return "/".join(n for _, n in self.stack if n)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        d = a.get("data-dir")
        if d:
            self.stack.append((tag, d))
            self.dirs.append(self._path())
        elif a.get("data-name"):
            a["path"] = self._path()
            self.files.append(a)
            self.stack.append((tag, None))   # or its </li> pops the parent dir
        elif tag in ("section", "li", "ul"):
            self.stack.append((tag, None))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return


def read_site():
    r = Reader()
    r.feed(open(os.path.join(HERE, "index.html"), encoding="utf-8").read())
    return r


def repo_of(p):
    m = re.match(r"https://github\.com/boris-volkov/([^/]+)", p.get("data-code", ""))
    return m.group(1) if m else None


def remote_of(repo_dir):
    """The GitHub repo a clone points at, read straight from .git/config.
    The folder may be named anything - music-theory holds the repo music."""
    cfg = os.path.join(repo_dir, ".git", "config")
    try:
        m = re.search(r"url\s*=\s*.*github\.com[:/]boris-volkov/(.+?)(?:\.git)?\s*$",
                      open(cfg, encoding="utf-8", errors="replace").read(), re.M)
        return m.group(1) if m else None
    except OSError:
        return None


def on_disk():
    """Every repo under the content folder as {directory: {repo: folder}}."""
    if not os.path.isdir(CONTENT):
        return None
    found = {}
    for root, dirs, _ in os.walk(CONTENT):
        rel = os.path.relpath(root, CONTENT).replace(os.sep, "/")
        if rel == ".":
            dirs[:] = [d for d in dirs
                       if not d.startswith(("_", ".")) and d != SITE_REPO]
            continue
        if os.path.isdir(os.path.join(root, ".git")):
            parent, folder = os.path.split(rel)
            repo = remote_of(root) or folder
            found.setdefault(parent, {})[repo] = folder
            dirs[:] = []                   # a repo is a leaf; don't descend
    return found


def check_structure(site):
    problems = []
    disk = on_disk()
    if disk is None:
        print(f"{DIM}  content folder not found next to this repo - skipping{OFF}")
        return problems

    claimed = set()
    for p in site.files:
        repo, path = repo_of(p), p["path"]
        if repo is None:
            problems.append(f"{p['data-name']}: source link is not a boris-volkov repo")
            continue
        folder = disk.get(path, {}).get(repo)
        if folder:
            claimed.add((path, repo))
            shown = f"{path}/{folder}"
            note = "" if folder == repo else f"  {DIM}(repo {repo}){OFF}"
            print(f"  {GREEN}ok{OFF}   {p['data-name']:<20} {DIM}{shown}{OFF}{note}")
        else:
            elsewhere = [d for d, rs in disk.items() if repo in rs]
            if elsewhere:
                problems.append(f"{p['data-name']}: page says {path}/, repo is in {elsewhere[0]}/")
            else:
                problems.append(f"{p['data-name']}: repo '{repo}' not cloned under {path}/")

    for d, rs in sorted(disk.items()):
        for repo, folder in sorted(rs.items()):
            if (d, repo) not in claimed:
                problems.append(f"{d}/{folder}: a repo on disk that is not on the page")

    for d in site.dirs:
        if not os.path.isdir(os.path.join(CONTENT, d)):
            problems.append(f"{d}/: a directory on the page with no folder on disk")

    return problems


def check_links(site):
    import urllib.request
    import urllib.error
    problems, seen = [], {}

    def status(url):
        if url in seen:
            return seen[url]
        full = "https://boris-volkov.github.io" + url if url.startswith("/") else url
        try:
            with urllib.request.urlopen(
                    urllib.request.Request(full, headers={"User-Agent": "check.py"}),
                    timeout=20) as r:
                code = r.status
        except urllib.error.HTTPError as e:
            code = e.code
        except Exception as e:
            code = type(e).__name__
        seen[url] = code
        return code

    for p in site.files:
        for kind in ("data-run", "data-code"):
            url = p.get(kind)
            if not url:
                continue
            code = status(url)
            mark = f"{GREEN}ok{OFF}" if code == 200 else f"{RED}{code}{OFF}"
            print(f"  {mark:<12} {p['data-name']:<20} {DIM}{kind[5:]}: {url}{OFF}")
            if code != 200:
                problems.append(f"{p['data-name']}: {kind[5:]} -> {url} returned {code}")
    return problems


def main():
    site = read_site()
    print(f"\n{len(site.files)} projects in {len(site.dirs)} directories\n")

    print("structure")
    problems = check_structure(site)

    if "--links" in sys.argv:
        print("\nlinks")
        problems += check_links(site)
    else:
        print(f"\n{DIM}(run with --links to check every URL too){OFF}")

    print()
    if problems:
        print(f"{RED}{len(problems)} problem(s):{OFF}")
        for p in problems:
            print(f"  {YELLOW}-{OFF} {p}")
        return 1
    print(f"{GREEN}the page and the folder agree{OFF}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
