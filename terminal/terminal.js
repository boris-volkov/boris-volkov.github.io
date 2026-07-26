/* ------------------------------------------------------------------
   boris_volkov — the shell

   Three layers, kept apart:

     content   the virtual filesystem, read once out of the markup in
               index.html so that the HTML stays the only place a
               project is ever written down
     shell     a command parser and a scrollback. Typed commands and
               clicked names go through the same door
     reader    a full-screen buffer over the shell showing one project

   The scrollback is the DOM — there is no second copy of it in a state
   object to keep in step. Rows are appended and never revisited.
   ------------------------------------------------------------------ */

(function () {
'use strict';

const USER = 'guest';
const HOST = 'boris_volkov';
const GITHUB = 'https://github.com/boris-volkov';
const TITLE = document.title;

/* The open project, as a path: #browser/math_arcade */
const hashPath = () => decodeURIComponent(location.hash.replace(/^#\/?/, ''));

/* Programs open in a new tab so the shell you were navigating is still
   there when you come back. Flip this to leave in the same tab. */
const NEW_TAB = true;

const COMMANDS = ['ls', 'tree', 'cd', 'cat', 'open', 'read', 'man', 'run',
                  'code', 'pwd', 'whoami', 'about', 'theme', 'clear',
                  'help', 'date'];

/* ── content ─────────────────────────────────────────────────────── */

/* Paragraphs and pull-quotes, with the indentation of the source HTML
   collapsed back out of them. */
function blocksFrom(el) {
	return Array.from(el.querySelectorAll('p, blockquote')).map(n => ({
		t: n.tagName === 'BLOCKQUOTE' ? 'q' : 'p',
		text: n.textContent.replace(/\s+/g, ' ').trim()
	}));
}

function fileNode(el, name) {
	const d = el.dataset;
	return {
		type: 'file',
		exec: d.run !== undefined,          /* runnable => executable */
		info: {
			name:     name,
			summary:  d.summary || '',
			tech:     d.tech || '',
			run:      d.run || '',
			runLabel: d.runLabel || 'run',
			code:     d.code || '',
			blocks:   blocksFrom(el)
		}
	};
}

function buildFS(root) {
	const tree = {};
	root.querySelectorAll('[data-dir]').forEach(sec => {
		const children = {};
		sec.querySelectorAll('[data-name]').forEach(el => {
			children[el.dataset.name] = fileNode(el, el.dataset.name);
		});
		tree[sec.dataset.dir] = {
			type: 'dir',
			desc: sec.dataset.desc || '',
			children: children
		};
	});
	root.querySelectorAll('[data-file]').forEach(el => {
		tree[el.dataset.file] = fileNode(el, el.dataset.file);
	});
	return tree;
}

const source = document.getElementById('source');
const fs = buildFS(source);

/* ── state ───────────────────────────────────────────────────────── */

const state = { cwd: [], input: '', hist: [], histIdx: -1, open: null };

const term    = document.getElementById('term');
const tbody   = document.getElementById('tbody');
const log     = document.getElementById('log');
const cli     = document.getElementById('cli');
const pUser   = document.getElementById('p-user');
const pPath   = document.getElementById('p-path');
const pInput  = document.getElementById('p-input');
const sBrand  = document.getElementById('s-brand');
const sPath   = document.getElementById('s-path');
const reader  = document.getElementById('reader');
const rScroll = document.getElementById('reader-scroll');

/* ── paths ───────────────────────────────────────────────────────── */

const pathString = segs => segs.length ? '~/' + segs.join('/') : '~';

function nodeAt(segs) {
	let node = { type: 'dir', children: fs };
	for (const s of segs) {
		if (node.type !== 'dir' || !node.children[s]) return null;
		node = node.children[s];
	}
	return node;
}

function resolve(p) {
	const abs = p && (p[0] === '~' || p[0] === '/');
	const cur = abs ? [] : state.cwd.slice();
	for (const part of (p || '').split('/')) {
		if (part === '' || part === '~' || part === '.') continue;
		if (part === '..') { cur.pop(); continue; }
		cur.push(part);
	}
	const node = nodeAt(cur);
	return node ? { segs: cur, node: node } : null;
}

/* A bare name, found anywhere in the tree.

   The boot screen prints every filename and invites you to run the ones
   marked *, so `./math_arcade` from the home directory has to work —
   being told "no such file" about something visibly on screen is a dead
   end, not a lesson. All twenty-two names here are unique, so this is
   never ambiguous. Think of the three folders as being on the PATH. */
function findByName(name) {
	let hit = null;
	(function walk(node, segs) {
		for (const [k, child] of Object.entries(node.children)) {
			if (k === name) { hit = hit || { segs: segs.concat(k), node: child }; return; }
			if (child.type === 'dir') walk(child, segs.concat(k));
		}
	})({ type: 'dir', children: fs }, []);
	return hit;
}

/* What every command that takes a path uses: the literal path first,
   falling back to a search. */
function locate(p) {
	return resolve(p) || findByName((p || '').replace(/\/+$/, '').split('/').pop());
}

/* Directories first, then files, each group alphabetical. */
function ordered(node) {
	return Object.entries(node.children).sort((a, b) => {
		const ad = a[1].type === 'dir', bd = b[1].type === 'dir';
		if (ad !== bd) return ad ? -1 : 1;
		return a[0] < b[0] ? -1 : 1;
	});
}

/* ── rows ────────────────────────────────────────────────────────── */

const S     = (t, role, click) => ({ t, role, click: click || null });
const line  = segs => ({ kind: 'line', segs });   /* aligned: never wraps */
const wrap  = segs => ({ kind: 'wrap', segs });   /* a sentence: may wrap */
const prose = segs => ({ kind: 'prose', segs });
const blank = () => ({ kind: 'blank', segs: [] });
const err   = t => wrap([S(t, 'error')]);
const spaces = n => ' '.repeat(Math.max(1, n));

function rowEl(row) {
	const div = document.createElement('div');
	div.className = 'row ' + row.kind;
	for (const s of row.segs) {
		const span = document.createElement('span');
		span.className = 'seg-' + s.role;
		span.textContent = s.t;
		if (s.click) {
			span.classList.add('clk');
			span.setAttribute('role', 'link');
			span.addEventListener('click', ev => {
				ev.stopPropagation();
				const c = s.click;
				if (c.kind === 'read') openReader(c.path);
				else if (c.kind === 'url') go(c.href);
				else exec(c.cmd);
			});
		}
		div.appendChild(span);
	}
	return div;
}

function push(rows) {
	const frag = document.createDocumentFragment();
	for (const r of rows) frag.appendChild(rowEl(r));
	log.appendChild(frag);
	tbody.scrollTop = tbody.scrollHeight;
}

/* Descriptions share one column across a whole listing. The connectors
   are part of the width, so a tree and a flat `ls` both line up. */
function alignRows(items) {
	let col = 0;
	for (const it of items) {
		if (it.desc) col = Math.max(col, it.prefix.length + it.label.length);
	}
	col += 3;
	return items.map(it => {
		const segs = [];
		if (it.prefix) segs.push(S(it.prefix, 'dim'));
		segs.push(S(it.label, it.role, it.click));
		if (it.desc) {
			segs.push(S(spaces(col - it.prefix.length - it.label.length), 'pad'));
			segs.push(S(it.desc, 'desc'));
		}
		return line(segs);
	});
}

/* One entry in a listing. Clicking a directory runs `cd` — it changes
   shell state, so it echoes like a typed command. Clicking a file opens
   the reader silently: a mouse user should never see a phantom `cat`
   line they did not type. */
function entryItem(prefix, name, child, segs) {
	const path = segs.concat(name).join('/');
	if (child.type === 'dir') {
		return {
			prefix, label: name + '/', role: 'dir', desc: child.desc,
			click: { kind: 'exec', cmd: 'cd ~/' + path }
		};
	}
	return {
		prefix,
		label: name + (child.exec ? '*' : ''),
		role: child.exec ? 'exec' : 'file',
		desc: child.info.summary,
		click: { kind: 'read', path: '~/' + path }
	};
}

function listRows(segs, node) {
	const entries = ordered(node);
	if (!entries.length) return [line([S('(empty)', 'dim')])];
	return alignRows(entries.map(([name, child]) => entryItem('', name, child, segs)));
}

function treeRows(base) {
	const items = [{
		prefix: '',
		label: base.length ? base[base.length - 1] + '/' : '~/',
		role: 'dir',
		desc: '',
		click: { kind: 'exec', cmd: 'cd ' + pathString(base) }
	}];
	(function walk(node, prefix, segs) {
		const entries = ordered(node);
		entries.forEach(([name, child], i) => {
			const last = i === entries.length - 1;
			items.push(entryItem(prefix + (last ? '└── ' : '├── '), name, child, segs));
			if (child.type === 'dir') {
				walk(child, prefix + (last ? '    ' : '│   '), segs.concat(name));
			}
		});
	})(nodeAt(base), '', base);
	return alignRows(items);
}

function helpRows() {
	const cmd = (c, d) => line([S('  ' + c.padEnd(18, ' '), 'file'), S(d, 'dim')]);
	return [
		blank(),
		line([S('commands', 'heading')]),
		blank(),
		cmd('ls [-R] [dir]', 'list programs — ls -R for the whole tree'),
		cmd('tree', 'the whole tree'),
		cmd('cd <dir>', 'enter a folder   (cd .. up · cd ~ home)'),
		cmd('cat <file>', 'what a program is   (aliases: open, read, man)'),
		cmd('./<file>', 'run it   (aliases: run <file>)'),
		cmd('code <file>', 'open its source'),
		cmd('pwd', 'print the current path'),
		cmd('whoami', 'who wrote all this'),
		cmd('about', 'about this page'),
		cmd('theme <name>', 'switch look: dark · light'),
		cmd('clear', 'clear the screen'),
		cmd('help', 'this list'),
		blank(),
		wrap([
			S('files marked ', 'dim'), S('*', 'exec'),
			S(' run in this browser · ', 'dim'), S('Tab', 'accent'),
			S(' completes · ', 'dim'), S('↑ ↓', 'accent'), S(' history', 'dim')
		])
	];
}

function countFiles() {
	let n = 0;
	(function walk(node) {
		for (const k in node.children) {
			const c = node.children[k];
			if (c.type === 'dir') walk(c); else if (c.info.code) n++;
		}
	})({ type: 'dir', children: fs });
	return n;
}

function whoamiRows() {
	return [
		line([S(HOST, 'accent')]),
		prose([S('Programs for practicing things worth practicing — math, music, chess, and the game of go.', 'dim')]),
		wrap([S(countFiles() + ' programs · 3 folders · no frameworks, no build step, no tracking.', 'dim')]),
		line([S('github.com/boris-volkov', 'accent', { kind: 'url', href: GITHUB })])
	];
}

/* ── the shell ───────────────────────────────────────────────────── */

function promptEcho(str) {
	return wrap([
		S(USER + '@' + HOST, 'prompt-user'),
		S(':', 'sym'),
		S(pathString(state.cwd), 'prompt-path'),
		S('$ ', 'sym'),
		S(str, 'text')
	]);
}

function go(href) {
	if (NEW_TAB) window.open(href, '_blank', 'noopener');
	else window.location.href = href;
}

/* `run` and `code` share everything but which URL they reach for. */
function launch(verb, arg, pick, missing) {
	if (!arg) return [err(verb + ': missing operand')];
	const r = locate(arg);
	if (!r) return [err(verb + ': ' + arg + ': no such file or directory')];
	if (r.node.type === 'dir') return [err(verb + ': ' + arg + ': is a directory')];
	const href = pick(r.node.info);
	if (!href) return [err(verb + ': ' + arg + ': ' + missing)];
	go(href);
	return [wrap([S('opening ', 'dim'), S(href, 'accent')])];
}

function exec(str) {
	push([promptEcho(str)]);

	const parts = (str || '').trim().split(/\s+/).filter(Boolean);
	let cmd = parts[0] || '';
	let args = parts.slice(1);

	/* ./name — the reason executables are marked at all */
	if (cmd.startsWith('./')) { args = [cmd.slice(2)]; cmd = 'run'; }

	let out = [];

	if (cmd === '') {
		/* a bare Enter */
	} else if (cmd === 'help') {
		out = helpRows();
	} else if (cmd === 'clear') {
		log.textContent = '';
	} else if (cmd === 'ls') {
		const target = args.find(a => a[0] !== '-');
		const r = target ? locate(target) : { segs: state.cwd, node: nodeAt(state.cwd) };
		if (!r) out = [err('ls: ' + target + ': no such file or directory')];
		else if (r.node.type !== 'dir') out = [line([S(target, r.node.exec ? 'exec' : 'file')])];
		else if (args.includes('-R')) out = treeRows(r.segs);
		else out = listRows(r.segs, r.node);
	} else if (cmd === 'tree') {
		const r = args[0] ? locate(args[0]) : { segs: state.cwd, node: nodeAt(state.cwd) };
		if (!r || r.node.type !== 'dir') out = [err('tree: ' + (args[0] || '.') + ': not a directory')];
		else out = treeRows(r.segs);
	} else if (cmd === 'cd') {
		if (!args[0] || args[0] === '~' || args[0] === '/') { state.cwd = []; }
		else {
			const r = locate(args[0]);
			if (!r) out = [err('cd: ' + args[0] + ': no such file or directory')];
			else if (r.node.type !== 'dir') out = [err('cd: ' + args[0] + ': not a directory')];
			else state.cwd = r.segs;
		}
		updateChrome();
	} else if (cmd === 'pwd') {
		out = [line([S(pathString(state.cwd), 'text')])];
	} else if (cmd === 'cat' || cmd === 'open' || cmd === 'read' || cmd === 'man') {
		if (!args[0]) out = [err(cmd + ': missing file operand')];
		else {
			const r = locate(args[0]);
			if (!r) out = [err(cmd + ': ' + args[0] + ': no such file or directory')];
			else if (r.node.type === 'dir') out = [err(cmd + ': ' + args[0] + ': is a directory')];
			else { showReader(r); return; }
		}
	} else if (cmd === 'run') {
		out = launch('run', args[0], i => i.run,
		             'not executable — try `code ' + (args[0] || '') + '`');
	} else if (cmd === 'code') {
		out = launch('code', args[0], i => i.code, 'no source for this one');
	} else if (cmd === 'whoami') {
		out = whoamiRows();
	} else if (cmd === 'about') {
		openReader('~/about.txt');
		return;
	} else if (cmd === 'theme') {
		if (args[0] === 'dark' || args[0] === 'light') {
			setTheme(args[0]);
			out = [line([S('theme → ' + args[0], 'accent')])];
		} else out = [err('usage: theme <dark|light>')];
	} else if (cmd === 'date') {
		out = [wrap([S(new Date().toString(), 'text')])];
	} else {
		out = [err(cmd + ': command not found'),
		       wrap([S("type 'help' for a list of commands", 'dim')])];
	}

	if (out.length) push(out);
	else tbody.scrollTop = tbody.scrollHeight;
}

/* ── completion and history ──────────────────────────────────────── */

function commonPrefix(arr) {
	let p = arr[0] || '';
	for (const s of arr) while (s.indexOf(p) !== 0) p = p.slice(0, -1);
	return p;
}

function complete() {
	const parts = state.input.split(/\s+/);

	if (parts.length <= 1) {
		const pre = parts[0] || '';
		/* ./ completes against the executables here, not the commands */
		const matches = pre.startsWith('./')
			? execNames().filter(n => n.startsWith(pre.slice(2))).map(n => './' + n)
			: COMMANDS.filter(c => c.startsWith(pre));
		return offer(matches, pre, m => setInput(m + ' '));
	}

	const cmd = parts[0], last = parts[parts.length - 1];
	const node = nodeAt(state.cwd);
	if (!node || node.type !== 'dir') return;

	const wants = cmd === 'cd' ? 'dir'
	            : (cmd === 'ls' || cmd === 'tree') ? 'any' : 'file';
	const ok = c => wants === 'any' || c.type === wants;

	const here = Object.entries(node.children).filter(([, c]) => ok(c)).map(([k]) => k);
	let matches = here.filter(n => n.startsWith(last));

	/* Nothing in this directory — but `cat piano_visualizer` works from
	   anywhere, so Tab has to reach as far as the commands do, or it
	   teaches a rule the shell does not actually follow. */
	if (!matches.length) matches = allNames(ok).filter(n => n.startsWith(last));

	offer(matches, last, m => {
		const hit = node.children[m] || (findByName(m) || {}).node;
		parts[parts.length - 1] = m + (hit && hit.type === 'dir' ? '/' : '');
		setInput(parts.join(' '));
	}, cp => { parts[parts.length - 1] = cp; setInput(parts.join(' ')); });
}

/* Every name in the tree that passes a test, for the completions above. */
function allNames(ok) {
	const names = [];
	(function walk(node) {
		for (const [k, c] of Object.entries(node.children)) {
			if (ok(c)) names.push(k);
			if (c.type === 'dir') walk(c);
		}
	})({ type: 'dir', children: fs });
	return names;
}

/* One match fills in; several echo the candidates and fill the longest
   common prefix, the way a shell does. */
function offer(matches, typed, fill, fillPrefix) {
	if (matches.length === 1) return fill(matches[0]);
	if (matches.length < 2) return;
	push([promptEcho(state.input), wrap([S(matches.slice().sort().join('   '), 'dim')])]);
	const cp = commonPrefix(matches);
	if (cp.length > typed.length) (fillPrefix || setInput)(cp);
}

/* `./` completes against everything runnable, wherever it lives — the
   same reach `./math_arcade` itself has. */
function execNames() {
	return allNames(c => c.type === 'file' && c.exec);
}

function setInput(v) {
	state.input = v;
	cli.value = v;
	pInput.textContent = v;
}

cli.addEventListener('input', () => { setInput(cli.value); state.histIdx = -1; });

cli.addEventListener('keydown', e => {
	if (e.key === 'Enter') {
		e.preventDefault();
		const v = state.input;
		if (v.trim() !== '') state.hist.push(v);
		state.histIdx = -1;
		setInput('');
		exec(v);
	} else if (e.key === 'ArrowUp') {
		e.preventDefault();
		if (!state.hist.length) return;
		state.histIdx = state.histIdx === -1
			? state.hist.length - 1
			: Math.max(0, state.histIdx - 1);
		setInput(state.hist[state.histIdx]);
	} else if (e.key === 'ArrowDown') {
		e.preventDefault();
		if (state.histIdx === -1) return;
		state.histIdx++;
		if (state.histIdx >= state.hist.length) { state.histIdx = -1; setInput(''); }
		else setInput(state.hist[state.histIdx]);
	} else if (e.key === 'Tab') {
		e.preventDefault();
		complete();
	}
});

/* ── the reader ──────────────────────────────────────────────────── */

function actionLink(href, label, cls) {
	const a = document.createElement('a');
	a.href = href;
	a.textContent = '[ ' + label + ' ]';
	a.className = cls;
	if (NEW_TAB) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
	return a;
}

function openReader(pathStr) {
	const r = locate(pathStr);
	if (r) showReader(r);
}

/* Opening a project is a navigation, so it gets a history entry and a
   URL of its own: #browser/math_arcade. That buys three things at once —
   Back closes the reader instead of leaving the site, a project can be
   linked to, and a refresh comes back to the same one.

   `cd` deliberately stays out of the URL. It is shell state, not a
   place; an entry per `cd` would turn Back into undo-cd, and nobody
   links anyone to a directory listing. */
function showReader(r) {
	if (r.node.type !== 'file') return;
	if (state.open && state.open.segs.join('/') === r.segs.join('/')) return;
	history.pushState(null, '', '#' + r.segs.join('/'));
	renderReader(r);
}

function renderReader(r) {
	const info = r.node.info;
	const name = r.segs[r.segs.length - 1];
	const topic = r.segs.length > 1 ? r.segs[r.segs.length - 2] : '~';

	document.getElementById('r-kicker').textContent = topic + ' / ' + name;
	document.getElementById('r-title').textContent = name;

	const meta = document.getElementById('r-meta');
	meta.textContent = info.tech;
	meta.hidden = !info.tech;

	const body = document.getElementById('r-body');
	body.textContent = '';
	for (const b of info.blocks) {
		const el = document.createElement(b.t === 'q' ? 'blockquote' : 'p');
		el.textContent = b.text;
		body.appendChild(el);
	}

	/* The two doors, and — under them — what you would have typed. */
	const actions = document.getElementById('r-actions');
	actions.textContent = '';
	if (info.run) actions.appendChild(actionLink(info.run, info.runLabel, 'run'));
	if (info.code) actions.appendChild(actionLink(info.code, 'source', 'code'));

	const typed = [];
	if (info.run) typed.push('./' + name);
	if (info.code) typed.push('code ' + name);
	const hint = document.getElementById('r-hint');
	hint.textContent = typed.length ? 'from the shell:   ' + typed.join('   ·   ') : '';

	document.getElementById('r-file').textContent = '"' + pathString(r.segs) + '" [readonly]';

	state.open = r;
	document.title = name + ' — ' + HOST;
	reader.hidden = false;
	rScroll.scrollTop = 0;
	reader.focus();
}

function hideReader() {
	state.open = null;
	document.title = TITLE;
	reader.hidden = true;
	focusInput();
}

/* q, Esc and :q are the same gesture as the browser's Back button, so
   they go through history too — that way the URL and what is on screen
   can never disagree about which project is open. */
function closeReader() {
	if (state.open) history.back();
}

/* The one place that decides what should be on screen, driven only by
   the URL. Idempotent, so it does not matter whether it was reached by
   Back, Forward, or someone editing the address bar. */
function syncFromURL() {
	const target = hashPath();
	const current = state.open ? state.open.segs.join('/') : '';
	if (target === current) return;
	if (target) {
		const r = locate(target);
		if (r && r.node.type === 'file') return renderReader(r);
	}
	hideReader();
}

window.addEventListener('popstate', syncFromURL);
window.addEventListener('hashchange', syncFromURL);

reader.addEventListener('keydown', e => {
	if (e.key === 'q' || e.key === 'Escape') { e.preventDefault(); return closeReader(); }
	const k = e.key;
	if (k === 'j' || k === 'ArrowDown')      { e.preventDefault(); rScroll.scrollTop += 60; }
	else if (k === 'k' || k === 'ArrowUp')   { e.preventDefault(); rScroll.scrollTop -= 60; }
	else if (k === 'g')                      { e.preventDefault(); rScroll.scrollTop = 0; }
	else if (k === 'G')                      { e.preventDefault(); rScroll.scrollTop = rScroll.scrollHeight; }
	else if (k === ' ' || k === 'PageDown')  { e.preventDefault(); rScroll.scrollTop += rScroll.clientHeight * 0.9; }
	else if (k === 'b' || k === 'PageUp')    { e.preventDefault(); rScroll.scrollTop -= rScroll.clientHeight * 0.9; }
});

/* Clicking the prose drops focus and the vim keys stop answering; take
   it back, unless the click was on something that wants focus itself. */
reader.addEventListener('click', e => {
	if (!e.target.closest('a, button')) reader.focus();
});

document.getElementById('r-back').addEventListener('click', closeReader);

/* ── chrome ──────────────────────────────────────────────────────── */

function updateChrome() {
	const path = pathString(state.cwd);
	pUser.textContent = USER + '@' + HOST;
	pPath.textContent = path;
	sBrand.textContent = USER + '@' + HOST;
	sPath.textContent = path;
}

function setTheme(name) {
	document.documentElement.setAttribute('data-theme', name);
	try { localStorage.setItem('bv-theme', name); } catch (e) {}
	document.querySelectorAll('[data-set-theme]').forEach(b => {
		b.classList.toggle('active', b.dataset.setTheme === name);
	});
}

document.querySelectorAll('[data-set-theme]').forEach(b => {
	b.addEventListener('click', () => setTheme(b.dataset.setTheme));
});

/* A phone should not be ambushed by the keyboard on load, or on every
   stray tap — there, only the prompt line itself asks for it. */
const COARSE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const focusInput = () => { if (!COARSE) cli.focus(); };

document.getElementById('promptline').addEventListener('click', () => cli.focus());

term.addEventListener('click', () => {
	if (state.open) return;
	if (String(window.getSelection() || '') !== '') return;
	focusInput();
});

/* ── boot ────────────────────────────────────────────────────────── */

/* Who this is — printed once at the top, like a login banner. */
function banner() {
	return [
		blank(),
		wrap([S(HOST, 'accent'), S('   —   math, music, chess, and the game of go', 'dim')]),
		blank()
	];
}

/* How to drive it. This goes *under* the tree rather than above it: on a
   short screen the boot output is taller than the screen, and whatever
   sits at the top has scrolled away before anyone reads it. Directly
   above the prompt it is still there. */
function hint() {
	return [
		blank(),
		wrap([
			S('type ', 'dim'), S('help', 'accent'),
			S(' for commands · click any file · ', 'dim'), S('*', 'exec'),
			S(' runs here · ', 'dim'),
			S('github.com/boris-volkov', 'accent', { kind: 'url', href: GITHUB })
		]),
		blank()
	];
}

/* Arriving on a link to a project.

   The hash is stripped first and only then pushed back, which replaces
   the single entry the visitor landed on with two: the shell, and the
   project above it. Without that, Back out of a deep link would step
   off the site — the entry it wants to return to would never have
   existed. This way there is always a shell underneath. */
function restoreFromURL() {
	const target = hashPath();
	history.replaceState(null, '', location.pathname + location.search);
	if (!target) return;
	const r = locate(target);
	if (r && r.node.type === 'file') showReader(r);
}

/* If the markup ever stops parsing into a filesystem, leave the plain
   list up rather than swapping it for an empty terminal. */
if (Object.keys(fs).length) {
	setTheme(document.documentElement.getAttribute('data-theme') || 'dark');
	updateChrome();
	source.hidden = true;
	term.hidden = false;
	push(banner());
	exec('ls -R');
	push(hint());
	focusInput();
	restoreFromURL();
}

})();
