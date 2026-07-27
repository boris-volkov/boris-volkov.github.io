# boris-volkov.github.io

The landing page. It looks like a UNIX terminal; the projects are files
in it. Three files, no frameworks, no build step, nothing to install:

| file | what it is |
|---|---|
| `index.html` | the page, **and the list of every project** |
| `style.css` | all styling, both colour themes |
| `terminal.js` | the shell — commands, listings, the reader |

---

## Adding or changing a project

**Everything lives in `index.html`.** `terminal.js` reads the list out of
the markup at load time and builds the filesystem from it. There is no
second copy anywhere — add an `<li>` and you are done.

Find the right `<section data-dir="…">` (`browser`, `native` or `python`)
and add:

```html
<li data-name="thing"
    data-summary="short line, shown beside the name"
    data-tech="javascript"
    data-run="/thing/"
    data-code="https://github.com/boris-volkov/thing">
	<h3>thing</h3>
	<p>The longer description. This is what you see when you click the
	   name, not the buttons.</p>
</li>
```

| attribute | effect |
|---|---|
| `data-name` | the filename it appears as |
| `data-summary` | the line beside it in `ls` — **keep under 35 characters** |
| `data-tech` | shown under the title in the write-up |
| `data-run` | where `[run]` goes. **Its presence is what makes the file an executable** — green, marked `*`, and `./name` works. Leave it out for source-only projects |
| `data-run-label` | when "run" is the wrong verb. `go_station` uses `download` |
| `data-code` | where `[source]` goes |

Order in the file does not matter — listings sort themselves
(directories first, then alphabetically), the same as real `ls`.

## Things that will bite you

**Every project needs a `data-code`.** The whole point of the site is
that anything you can run, you can also read. A row without a source
link should never ship.

**Keep `data-summary` short.** Listings are three columns of monospace
text padded with literal spaces, measured to fit 88 characters total.
The longest name is 17 characters and the buttons take 20, so a summary
much over 35 will push the row wide enough to scroll sideways.

**Internal links stay root-relative** — `/mandelbrot_set/`, not
`https://boris-volkov.github.io/mandelbrot_set/`. That is what lets the
whole site move to borisvolkov.com without editing every link. Only
github.com and matharcade.io are absolute.

**Don't delete the `<main id="source">` list.** It is the page with
JavaScript off, and it is what search engines read. The script hides it;
it is not decoration.

**Rows are `white-space: pre`.** The tree connectors and the aligned
columns are real spaces. If a message needs to wrap, it is a different
row kind (`wrap`), not a change to `.row`.

## Trying it before you push

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/>. That is the whole toolchain.

After pushing, GitHub Pages takes roughly **40 seconds** to rebuild, and
then may serve a cached copy — hard-refresh, or add `?x=1`, before
concluding something is broken.

## Giving a new program its own repo

Each project is its own repository with its own Pages site, which is why
the links are short. To add another:

```bash
gh repo create thing --public --source=. --remote=origin --push
gh api repos/boris-volkov/thing/pages --method POST \
   -f 'source[branch]=master' -f 'source[path]=/'
```

Three things the repo needs:

- **`index.html`**, not `main.html` — so the URL is `/thing/` with
  nothing after it. Without an index, Pages serves the README instead.
- **`.nojekyll`** — otherwise any folder starting with `_` returns 404.
  This is a real bug that bit the old `games` repo for years.
- **`README.md`** — it is where `[source]` lands, so it is the first
  thing anyone reads about the program.

Then add the `<li>` here, pointing `data-run` at `/thing/`.

---

## Checking it still hangs together

```bash
python check.py            # structure only — instant, offline
python check.py --links    # also fetch every URL
```

`check.py` **generates nothing.** `index.html` stays hand-written and stays
the source of truth; the script only reports where it and the world have
drifted apart. Deleting it would cost the site nothing.

It catches the three things that go quietly wrong:

- a project on the site whose repo isn't cloned into the matching
  category folder, or is filed under a different one
- a repo sitting in `browser/`, `native/` or `python/` that never made it
  onto the site
- with `--links`, a `[run]` or `[source]` that has started 404ing —
  the one failure nothing else will ever tell you about

Repo names and site names deliberately differ (`3d_wireframes` lives in
the repo `spinning-cube`), so the script reads the repo out of
`data-code` rather than guessing from the name.

**If you want it enforced rather than remembered**, wire the fast check
into a pre-commit hook:

```bash
printf '#!/bin/sh\nexec python check.py\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Then a commit that leaves the site and the folders disagreeing will fail.
Keep `--links` out of the hook — it needs the network and takes half a
minute, which is not something to put in front of every commit.
