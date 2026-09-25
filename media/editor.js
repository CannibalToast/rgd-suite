(function () {
    // VS Code injects this into webviews; access via globalThis for static analyzers.
    const vscode = globalThis['acquireVsCodeApi']();
    let rgdData = null;
    let selectedNode = null;
    let selectedRow = null;
    let documentDirty = false;
    const nodeRegistry = new Map();
    /** @type {Record<string, string>} key path -> added|removed|changed */
    let diffHighlight = {};
    /** Leaf key paths -> kind; ancestors of these get 'diff-descendant' instead. */
    let diffLeafKinds = {};
    /** Leaf key paths -> StringDiffParts for changed string scalars. */
    let diffValueParts = {};
    /** Leaf key paths -> full TableDiffEntry (merged diff window). */
    let diffEntryByKey = {};
    /** Set for virtual documents (e.g. git: URIs in a diff view) — no editing. */
    const isReadOnly = document.body.dataset.readonly === 'true';
    /** Merged-diff window: one tree, ghost rows for removals, inline old+new. */
    const isDiffMode = document.body.dataset.diffmode === 'true';
    /** Mute window so remotely-applied diff-sync actions don't echo back. */
    let syncMuteUntil = 0;
    /** Key path a remote expand is still resolving (waits on lazy children). */
    let pendingExpand = null;
    let pendingSelectKey = null;
    /** Undo/redo stacks of { path:number[], key:string|null, oldValue, newValue }. */
    const undoStack = [];
    const redoStack = [];

    function init() {
        vscode.postMessage({ type: 'ready' });

        document.querySelectorAll('.save-action').forEach(function (btn) {
            btn.addEventListener('click', function () {
                vscode.postMessage({ type: 'save' });
            });
        });

        // Undo/redo for value edits (simple snapshot stack — the only
        // mutation this UI performs).
        const undoBtn = document.getElementById('undo-btn');
        const redoBtn = document.getElementById('redo-btn');
        if (undoBtn) undoBtn.addEventListener('click', undoEdit);
        if (redoBtn) redoBtn.addEventListener('click', redoEdit);

        // Corsix-style find bar above the tree
        const findInput = document.getElementById('tree-find');
        const findCase = document.getElementById('tree-find-case');
        const findChanged = document.getElementById('tree-find-changed');
        let findTimer = null;
        function onFindInput() {
            if (findTimer) clearTimeout(findTimer);
            findTimer = setTimeout(applyTreeFilter, 250);
        }
        if (findInput) findInput.addEventListener('input', onFindInput);
        if (findCase) findCase.addEventListener('change', applyTreeFilter);
        if (findChanged) findChanged.addEventListener('change', applyTreeFilter);

        const gitDiffBtn = document.getElementById('git-diff-btn');
        if (gitDiffBtn) {
            gitDiffBtn.addEventListener('click', function () {
                updateStatus('Opening merged diff…');
                vscode.postMessage({ type: 'requestGitDiff', ref: 'HEAD' });
            });
        }

        // Keyboard shortcut for save + undo/redo (undo skips text inputs so
        // the field's own history still works while typing).
        document.addEventListener('keydown', function (e) {
            if (!(e.ctrlKey || e.metaKey)) return;
            if (e.key === 's') {
                e.preventDefault();
                vscode.postMessage({ type: 'save' });
                return;
            }
            const tag = document.activeElement && document.activeElement.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (e.key === 'z' || e.key === 'Z') {
                e.preventDefault();
                if (e.shiftKey) redoEdit(); else undoEdit();
            } else if (e.key === 'y') {
                e.preventDefault();
                redoEdit();
            }
        });

        // Expand All
        const expandAllBtn = document.getElementById('expand-all');
        if (expandAllBtn) {
            expandAllBtn.addEventListener('click', function () {
                expandAllTrees();
                postSync({ action: 'expandAll' });
            });
        }

        // Collapse All
        const collapseAllBtn = document.getElementById('collapse-all');
        if (collapseAllBtn) {
            collapseAllBtn.addEventListener('click', function () {
                collapseAllTrees();
                postSync({ action: 'collapseAll' });
            });
        }

        // Scroll sync for the sibling pane of a git diff view
        const treeContentEl = document.getElementById('tree-content');
        if (treeContentEl) {
            let scrollTimer = null;
            treeContentEl.addEventListener('scroll', function () {
                if (scrollTimer) return;
                scrollTimer = setTimeout(function () {
                    scrollTimer = null;
                    const max = treeContentEl.scrollHeight - treeContentEl.clientHeight;
                    postSync({ action: 'scroll', ratio: max > 0 ? treeContentEl.scrollTop / max : 0 });
                }, 60);
            });
        }

        // Resizer drag
        const resizerEl = document.getElementById('resizer');
        const treePanel = document.querySelector('.tree-panel');
        if (resizerEl && treePanel) {
            let rStartX = 0;
            let rStartW = 280;
            function onResizerMove(e) {
                const newW = Math.max(120, Math.min(rStartW + (e.clientX - rStartX), window.innerWidth - 200));
                treePanel.style.width = newW + 'px';
            }
            function onResizerUp() {
                resizerEl.classList.remove('active');
                document.removeEventListener('mousemove', onResizerMove);
                document.removeEventListener('mouseup', onResizerUp);
            }
            resizerEl.addEventListener('mousedown', function (e) {
                rStartX = e.clientX;
                rStartW = treePanel.offsetWidth;
                resizerEl.classList.add('active');
                document.addEventListener('mousemove', onResizerMove);
                document.addEventListener('mouseup', onResizerUp);
                e.preventDefault();
            });
        }
    }

    window.addEventListener('message', function (e) {
        const msg = e.data;
        if (msg.type === 'loadData') {
            rgdData = msg.data;
            if (isDiffMode && msg.diffEntries) {
                setDiffState(msg.diffEntries, msg.diffHighlight);
                mergeRemovedEntries(msg.diffEntries);
                const ch = document.getElementById('tree-find-changed');
                if (ch) ch.disabled = false;
                const ds = document.getElementById('diff-status');
                if (ds) {
                    ds.textContent = msg.diffError
                        ? 'diff failed: ' + msg.diffError
                        : msg.diffEntries.length + ' Δ vs ' + (msg.baseRef || 'HEAD');
                }
            }
            renderTree(rgdData);
            if (Object.keys(diffHighlight).length) applyTreeDiffHighlights();
            undoStack.length = 0;
            redoStack.length = 0;
            updateUndoButtons();
            if (treeFilterActive()) applyTreeFilter();
            updateStatus('Loaded ' + (rgdData ? rgdData.length : 0) + ' nodes');
        } else if (msg.type === 'loadChildren') {
            mergeChildren(rgdData, msg.path, msg.children);
            const pathKey = msg.path.join('.');
            const nodeEl = document.querySelector('[data-path="' + pathKey + '"]');
            if (nodeEl) {
                const parent = nodeEl.closest('.tree-node');
                const parentData = getNodeAtPath(rgdData, msg.path);
                if (parent && parentData) {
                    fillChildren(parent, parentData, msg.path, parent.querySelector('.tree-children'), msg.path.length);
                    if (Object.keys(diffHighlight).length) applyTreeDiffHighlights();
                    resumePendingExpand();
                    if (treeFilterActive()) applyTreeFilter();
                }
            }
        } else if (msg.type === 'applyDiffSync') {
            handleDiffSync(msg);
        } else if (msg.type === 'saved') {
            documentDirty = false;
            updateStatus('Saved');
            document.querySelectorAll('.save-action').forEach(function (b) {
                b.classList.remove('dirty');
            });
        } else if (msg.type === 'gitDiff') {
            showGitDiff(msg);
        } else if (msg.type === 'gitDiffError') {
            clearDiffUi();
            updateStatus('Git diff: ' + (msg.message || 'failed'));
            const ds = document.getElementById('diff-status');
            if (ds) ds.textContent = '';
        }
    });

    function clearDiffUi() {
        diffHighlight = {};
        diffLeafKinds = {};
        diffValueParts = {};
        diffEntryByKey = {};
        document.querySelectorAll('.tree-row.diff-added, .tree-row.diff-removed, .tree-row.diff-changed, .tree-row.diff-descendant')
            .forEach(function (el) {
                el.classList.remove('diff-added', 'diff-removed', 'diff-changed', 'diff-descendant');
            });
        const ds = document.getElementById('diff-status');
        if (ds) ds.textContent = '';
        const ch = document.getElementById('tree-find-changed');
        if (ch) {
            ch.disabled = true;
            ch.checked = false;
        }
        applyTreeFilter();
        if (selectedNode) renderPropertyGrid(selectedNode.node);
    }

    function setDiffState(entries, highlight) {
        diffHighlight = highlight || {};
        diffLeafKinds = {};
        diffValueParts = {};
        diffEntryByKey = {};
        (entries || []).forEach(function (e) {
            diffLeafKinds[e.key] = e.kind;
            diffEntryByKey[e.key] = e;
            if (e.stringDiff) diffValueParts[e.key] = e.stringDiff;
        });
    }

    // A gitDiff broadcast (paired panes / post-save refresh) updates tree
    // highlights, value-cell blocks and the Δ filter — there is no separate
    // diff panel any more; the merged window carries the full report.
    function showGitDiff(msg) {
        setDiffState(msg.entries, msg.highlight);
        applyTreeDiffHighlights();
        const ch = document.getElementById('tree-find-changed');
        if (ch) ch.disabled = false;
        if (treeFilterActive()) applyTreeFilter();
        if (selectedNode) renderPropertyGrid(selectedNode.node);
        const n = (msg.entries || []).length;
        const ds = document.getElementById('diff-status');
        if (ds) ds.textContent = n + ' Δ vs ' + (msg.baseRef || 'HEAD');
        updateStatus('Git diff ready (' + n + ' changes)');
    }

    // Splice a removed leaf back into the working tree as a ghost node so the
    // merged diff view can show what was deleted.
    function materializeGhost(keyPath, oldValue) {
        const parts = keyPath.split('.');
        let list = rgdData;
        for (let i = 0; i < parts.length - 1; i++) {
            let n = list.find(function (x) { return (x.key || x.name) === parts[i]; });
            if (!n) {
                n = { key: parts[i], children: [], ghost: true };
                list.push(n);
            }
            if (!n.children) n.children = [];
            list = n.children;
        }
        const last = parts[parts.length - 1];
        if (!list.some(function (x) { return (x.key || x.name) === last; })) {
            list.push({ key: last, value: oldValue, ghost: true });
        }
    }

    function mergeRemovedEntries(entries) {
        (entries || []).forEach(function (e) {
            if (e.kind === 'removed') materializeGhost(e.key, e.oldValue);
        });
    }

    // Escape a string fragment the same way JSON.stringify does, without the
    // surrounding quotes (caller adds them once around the whole value).
    function escapeFragment(s) {
        return JSON.stringify(s || '').slice(1, -1);
    }

    // Render one side of a char-level string diff: unchanged prefix/suffix in
    // plain text, the differing middle highlighted (del = red, add = green).
    function appendInlineDiffValue(container, d, side) {
        const mid = side === 'old' ? d.oldMid : d.newMid;
        container.appendChild(document.createTextNode('"' + escapeFragment(d.prefix)));
        if (mid) {
            const m = document.createElement('span');
            m.className = side === 'old' ? 'diff-del' : 'diff-add';
            m.textContent = escapeFragment(mid);
            container.appendChild(m);
        }
        container.appendChild(document.createTextNode(escapeFragment(d.suffix) + '"'));
    }

    // Inline char-diff inside a value cell for a changed string scalar: the
    // HEAD (read-only) pane blocks removed chars red, the working pane blocks
    // added chars green. Returns null when the key has no stringDiff.
    function makeValueDiffView(keyPath) {
        const d = keyPath && diffValueParts[keyPath];
        if (!d) return null;
        const div = document.createElement('div');
        div.className = 'value-diff';
        appendInlineDiffValue(div, d, isReadOnly ? 'old' : 'new');
        return div;
    }

    // Merged-diff value cell: one string with removed chars blocked red and
    // added chars blocked green — "prefix[old][new]suffix". Non-string
    // changes show "old → new"; pure adds/removes colour the whole value.
    function makeMergedValueView(keyPath, nodeValue) {
        const div = document.createElement('div');
        div.className = 'value-diff';
        const fmt = function (v) {
            return typeof v === 'string' ? JSON.stringify(v) : String(v);
        };
        const entry = keyPath ? diffEntryByKey[keyPath] : null;
        if (nodeValue === undefined || nodeValue === null) return div;
        if (!entry) {
            div.textContent = fmt(nodeValue);
            return div;
        }
        const span = function (cls, text) {
            const s = document.createElement('span');
            s.className = cls;
            s.textContent = text;
            return s;
        };
        if (entry.kind === 'added') {
            div.appendChild(span('diff-add', fmt(entry.newValue)));
        } else if (entry.kind === 'removed') {
            div.appendChild(span('diff-del', fmt(entry.oldValue)));
        } else if (entry.stringDiff) {
            const d = entry.stringDiff;
            div.appendChild(document.createTextNode('"' + escapeFragment(d.prefix)));
            if (d.oldMid) div.appendChild(span('diff-del', escapeFragment(d.oldMid)));
            if (d.newMid) div.appendChild(span('diff-add', escapeFragment(d.newMid)));
            div.appendChild(document.createTextNode(escapeFragment(d.suffix) + '"'));
        } else {
            div.appendChild(span('diff-del', fmt(entry.oldValue)));
            div.appendChild(document.createTextNode(' → '));
            div.appendChild(span('diff-add', fmt(entry.newValue)));
        }
        return div;
    }

    // ── Undo/redo (value edits) ────────────────────────────────────────────

    function updateUndoButtons() {
        const u = document.getElementById('undo-btn');
        const r = document.getElementById('redo-btn');
        if (u) u.disabled = undoStack.length === 0;
        if (r) r.disabled = redoStack.length === 0;
    }

    // Mirror of the provider's _updateNodeValue on the webview's copy so
    // re-renders reflect edits immediately (and undo restores them).
    function setLocalValue(path, key, value) {
        const node = getNodeAtPath(rgdData, path);
        if (!node) return;
        if (key && node.children) {
            const child = node.children.find(function (c) { return c.key === key; });
            if (child) { child.value = value; return; }
        }
        node.value = value;
    }

    function pushEdit(path, key, oldValue, newValue) {
        undoStack.push({ path: path, key: key, oldValue: oldValue, newValue: newValue });
        redoStack.length = 0;
        updateUndoButtons();
    }

    function applyEditValue(entry, value) {
        setLocalValue(entry.path, entry.key, value);
        vscode.postMessage({ type: 'updateValue', path: entry.path, key: entry.key, value: value });
        if (selectedNode) renderPropertyGrid(selectedNode.node);
        markDirty();
    }

    function undoEdit() {
        const entry = undoStack.pop();
        if (!entry) return;
        applyEditValue(entry, entry.oldValue);
        redoStack.push(entry);
        updateUndoButtons();
        updateStatus('Undo');
    }

    function redoEdit() {
        const entry = redoStack.pop();
        if (!entry) return;
        applyEditValue(entry, entry.newValue);
        undoStack.push(entry);
        updateUndoButtons();
        updateStatus('Redo');
    }

    // ── Tree find/filter ───────────────────────────────────────────────────

    function treeFilterActive() {
        const f = document.getElementById('tree-find');
        const c = document.getElementById('tree-find-changed');
        return !!(f && f.value) || !!(c && c.checked);
    }

    function applyTreeFilter() {
        const f = document.getElementById('tree-find');
        const mc = document.getElementById('tree-find-case');
        const ch = document.getElementById('tree-find-changed');
        const tc = document.getElementById('tree-content');
        if (!f || !tc) return;
        const matchCase = !!(mc && mc.checked);
        const q = matchCase ? f.value : f.value.toLowerCase();
        const changedOnly = !!(ch && ch.checked);
        if (!q && !changedOnly) {
            tc.querySelectorAll('.tree-node').forEach(function (n) { n.style.display = ''; });
            return;
        }
        // Expansion during filtering must not echo to the sibling pane.
        syncMuteUntil = Date.now() + 500;
        filterContainer(tc, q, matchCase, changedOnly);
    }

    // Returns true if any node in this container is visible. Collapsed
    // subtrees are expanded so their (possibly lazy-loaded) children can be
    // searched; the loadChildren handler re-runs this filter when they land.
    function filterContainer(container, q, matchCase, changedOnly) {
        let anyVisible = false;
        Array.from(container.children).forEach(function (tn) {
            if (!tn.classList || !tn.classList.contains('tree-node')) return;
            const row = tn.querySelector(':scope > .tree-row');
            if (!row) return;
            const labelEl = row.querySelector('.tree-label');
            const label = labelEl ? labelEl.textContent : '';
            const hay = matchCase ? label : label.toLowerCase();
            let self = !q || hay.indexOf(q) !== -1;
            if (self && changedOnly) {
                // Leaves carry their kind; folders are in the highlight map as
                // ancestors-of-change, which is exactly what we want to keep.
                const kp = row.dataset.keyPath;
                self = !!(kp && (diffLeafKinds[kp] || diffHighlight[kp]));
            }
            const kids = tn.querySelector(':scope > .tree-children');
            if (kids && !kids.classList.contains('expanded')) {
                const toggle = row.querySelector('.tree-toggle');
                if (toggle && toggle.classList.contains('collapsed')) {
                    const path = row.dataset.path.split('.').map(Number);
                    const nodeData = getNodeAtPath(rgdData, path);
                    if (nodeData) toggleExpand(tn, toggle, nodeData, path, path.length);
                }
            }
            const childAny = kids ? filterContainer(kids, q, matchCase, changedOnly) : false;
            const visible = self || childAny;
            tn.style.display = visible ? '' : 'none';
            anyVisible = anyVisible || visible;
        });
        return anyVisible;
    }

    // ── Diff-pane sync ────────────────────────────────────────────────────
    // Paired git:/file: panes relay these through the extension host so both
    // trees follow the same expansion, selection and scroll position.

    function postSync(payload) {
        if (Date.now() < syncMuteUntil) return;
        vscode.postMessage(Object.assign({ type: 'diffSync' }, payload));
    }

    function findRowByKeyPath(keyPath) {
        if (!keyPath) return null;
        return document.querySelector('.tree-row[data-key-path="' + CSS.escape(keyPath) + '"]');
    }

    // Expand every ancestor prefix of keyPath; returns false when a row isn't
    // rendered yet because its parent's children are still loading.
    function expandKeyPathTo(keyPath) {
        const parts = keyPath.split('.');
        for (let i = 1; i <= parts.length; i++) {
            const row = findRowByKeyPath(parts.slice(0, i).join('.'));
            if (!row) return false;
            const treeNode = row.closest('.tree-node');
            const kids = treeNode.querySelector(':scope > .tree-children');
            if (kids && !kids.classList.contains('expanded')) {
                const path = row.dataset.path.split('.').map(Number);
                const nodeData = getNodeAtPath(rgdData, path);
                const toggle = row.querySelector('.tree-toggle');
                if (!nodeData || !toggle) return false;
                toggleExpand(treeNode, toggle, nodeData, path, path.length);
            }
        }
        return true;
    }

    function resumePendingExpand() {
        if (pendingExpand && expandKeyPathTo(pendingExpand)) pendingExpand = null;
        if (pendingSelectKey && !pendingExpand) {
            const kp = pendingSelectKey;
            pendingSelectKey = null;
            navigateToKeyPath(kp);
        }
    }

    // Jump the tree to a key path: expand ancestors (queuing the expand when
    // children are still lazy-loading), then select and reveal the row.
    function navigateToKeyPath(keyPath) {
        if (!expandKeyPathTo(keyPath)) {
            pendingExpand = keyPath;
            pendingSelectKey = keyPath;
            return;
        }
        const row = findRowByKeyPath(keyPath);
        if (!row) return;
        const path = row.dataset.path.split('.').map(Number);
        const node = getNodeAtPath(rgdData, path);
        if (!node) return;
        selectNode(node, path);
        row.scrollIntoView({ block: 'nearest' });
    }

    // Property-grid child names link back to the tree row for that child —
    // lets you jump from a "Table Children" entry to the node itself.
    function makeChildNavLink(childName, childKeyPath) {
        const a = el('a', 'prop-nav-link', childName);
        a.href = '#';
        a.title = 'Go to ' + childName;
        a.addEventListener('click', function (e) {
            e.preventDefault();
            navigateToKeyPath(childKeyPath);
        });
        return a;
    }

    function collapseKeyPath(keyPath) {
        const row = findRowByKeyPath(keyPath);
        if (!row) return;
        const treeNode = row.closest('.tree-node');
        const kids = treeNode.querySelector(':scope > .tree-children');
        if (kids && kids.classList.contains('expanded')) {
            const path = row.dataset.path.split('.').map(Number);
            const nodeData = getNodeAtPath(rgdData, path);
            const toggle = row.querySelector('.tree-toggle');
            if (nodeData && toggle) toggleExpand(treeNode, toggle, nodeData, path, path.length);
        }
    }

    function expandAllTrees() {
        if (!rgdData) return;
        const treeContent = document.getElementById('tree-content');
        Array.from(treeContent.children).forEach(function (nodeEl, idx) {
            expandNodeDeep(nodeEl, rgdData[idx], [idx], 0);
        });
    }

    function collapseAllTrees() {
        document.querySelectorAll('.tree-children').forEach(function (el) {
            el.classList.remove('expanded');
        });
        document.querySelectorAll('.tree-toggle.expanded').forEach(function (t) {
            t.classList.remove('expanded');
            t.classList.add('collapsed');
        });
    }

    function handleDiffSync(msg) {
        syncMuteUntil = Date.now() + 250;
        if (msg.action === 'scroll') {
            const tc = document.getElementById('tree-content');
            if (tc && typeof msg.ratio === 'number') {
                tc.scrollTop = msg.ratio * Math.max(0, tc.scrollHeight - tc.clientHeight);
            }
            return;
        }
        if (msg.action === 'toggle') {
            if (msg.expanded) {
                pendingExpand = msg.keyPath;
                resumePendingExpand();
            } else {
                collapseKeyPath(msg.keyPath);
            }
            return;
        }
        if (msg.action === 'expandAll') { expandAllTrees(); return; }
        if (msg.action === 'collapseAll') { collapseAllTrees(); return; }
        if (msg.action === 'select') {
            const row = findRowByKeyPath(msg.keyPath);
            if (!row) return;
            const path = row.dataset.path.split('.').map(Number);
            const node = getNodeAtPath(rgdData, path);
            if (node) {
                selectNode(node, path);
                row.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    function applyTreeDiffHighlights() {
        document.querySelectorAll('.tree-row').forEach(function (row) {
            row.classList.remove('diff-added', 'diff-removed', 'diff-changed', 'diff-descendant');
            const kp = row.dataset.keyPath;
            if (row.dataset.ghost) {
                row.classList.add('diff-removed');
            } else if (kp && diffLeafKinds[kp]) {
                row.classList.add('diff-' + diffLeafKinds[kp]);
            } else if (kp && diffHighlight[kp]) {
                // In the highlight map but not a leaf: a folder containing changes.
                row.classList.add('diff-descendant');
            }
        });
    }

    function computeKeyPath(node, path) {
        // Rebuild dotted key path from root using node keys
        if (!rgdData || !path || !path.length) return node.key || node.name || '';
        const parts = [];
        let list = rgdData;
        for (let i = 0; i < path.length; i++) {
            const n = list[path[i]];
            if (!n) break;
            parts.push(n.key || n.name || '');
            list = n.children || [];
        }
        return parts.join('.');
    }

    function mergeChildren(nodes, nodePath, children) {
        const parent = getNodeAtPath(nodes, nodePath);
        if (parent) parent.children = children;
    }

    function getNodeAtPath(nodes, nodePath) {
        let list = nodes;
        let current = null;
        for (let i = 0; i < nodePath.length; i++) {
            current = list[nodePath[i]];
            if (!current) return null;
            if (current.children) list = current.children;
        }
        return current;
    }

    function fillChildren(nodeEl, node, path, childrenDiv, depth) {
        if (!childrenDiv || !node.children) return;
        childrenDiv.replaceChildren();
        node.children.forEach(function (child, idx) {
            childrenDiv.appendChild(createTreeNode(child, path.concat([idx]), depth + 1));
        });
    }

    function renderTree(nodes) {
        nodeRegistry.clear();
        selectedRow = null;
        const treeContent = document.getElementById('tree-content');
        if (!treeContent) return;
        treeContent.replaceChildren();

        if (!nodes || nodes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            const inner = document.createElement('div');
            inner.textContent = 'No data';
            empty.appendChild(inner);
            treeContent.appendChild(empty);
            return;
        }

        nodes.forEach(function (node, index) {
            const el = createTreeNode(node, [index], 0);
            treeContent.appendChild(el);
        });

        if (nodes.length > 0) {
            selectNode(nodes[0], [0]);
        }
    }

    function createTreeNode(node, path, depth) {
        const div = document.createElement('div');
        div.className = 'tree-node';

        const hasChildren = node.hasChildren || (node.children && node.children.length > 0);
        const childCount = node.childCount != null ? node.childCount : (node.children ? node.children.length : 0);
        const nodeName = node.key || node.name || 'Unknown';
        const isRefNode = nodeName === '$REF';

        const row = document.createElement('div');
        row.className = 'tree-row';
        row.style.paddingLeft = (8 + depth * 16) + 'px';
        // Use dot-joined path as the DOM key — faster than JSON.stringify
        // and still unique because path is a numeric index array.
        row.dataset.path = path.join('.');
        const keyPath = computeKeyPath(node, path);
        row.dataset.keyPath = keyPath;
        if (node.ghost) row.dataset.ghost = '1';
        if (node.ghost) {
            row.classList.add('diff-removed');
        } else if (diffLeafKinds[keyPath]) {
            row.classList.add('diff-' + diffLeafKinds[keyPath]);
        } else if (diffHighlight[keyPath]) {
            row.classList.add('diff-descendant');
        }
        nodeRegistry.set(row.dataset.path, row);

        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle ' + (hasChildren ? 'collapsed' : 'leaf');
        row.appendChild(toggle);

        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = hasChildren ? '📁' : (isRefNode ? '🔗' : '📄');
        row.appendChild(icon);

        const label = document.createElement('span');
        label.className = 'tree-label';

        if (isRefNode && node.value) {
            const a = document.createElement('a');
            a.href = '#';
            a.className = 'tree-ref-link';
            a.dataset.ref = String(node.value);
            a.title = 'Click to open: ' + String(node.value);
            a.textContent = nodeName;
            label.appendChild(a);
        } else {
            label.textContent = nodeName;
        }
        row.appendChild(label);

        if (hasChildren && childCount > 0) {
            const badge = document.createElement('span');
            badge.className = 'tree-badge';
            badge.textContent = childCount;
            row.appendChild(badge);
        }

        row.addEventListener('click', function (e) {
            e.stopPropagation();
            // If clicked on a ref link, open the file instead
            if (e.target.classList.contains('tree-ref-link')) {
                e.preventDefault();
                vscode.postMessage({ type: 'openRef', ref: e.target.dataset.ref });
                return;
            }
            selectNode(node, path);
            // Expansion is chevron-only — clicking a row selects it.
        });

        toggle.addEventListener('click', function (e) {
            e.stopPropagation();
            if (hasChildren) {
                toggleExpand(div, toggle, node, path, depth);
            }
        });

        div.appendChild(row);

        if (hasChildren) {
            const childrenDiv = document.createElement('div');
            childrenDiv.className = 'tree-children';
            div.appendChild(childrenDiv);
        }

        return div;
    }

    function toggleExpand(nodeEl, toggle, node, path, depth) {
        const childrenDiv = nodeEl.querySelector('.tree-children');
        if (!childrenDiv) return;

        const isExpanded = childrenDiv.classList.contains('expanded');

        if (isExpanded) {
            childrenDiv.classList.remove('expanded');
            toggle.classList.remove('expanded');
            toggle.classList.add('collapsed');
        } else {
            if (childrenDiv.children.length === 0) {
                if (node.children && node.children.length > 0) {
                    fillChildren(nodeEl, node, path, childrenDiv, depth);
                } else if (node.hasChildren) {
                    vscode.postMessage({ type: 'requestChildren', path: path });
                }
            }
            childrenDiv.classList.add('expanded');
            toggle.classList.remove('collapsed');
            toggle.classList.add('expanded');
        }
        postSync({ action: 'toggle', keyPath: computeKeyPath(node, path), expanded: !isExpanded });
    }

    function selectNode(node, path) {
        if (selectedRow) selectedRow.classList.remove('selected');
        const row = nodeRegistry.get(path.join('.'));
        if (row) { row.classList.add('selected'); selectedRow = row; }
        selectedNode = { node: node, path: path };
        renderPropertyGrid(node);
        postSync({ action: 'select', keyPath: computeKeyPath(node, path) });
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null && text !== '') node.textContent = text;
        return node;
    }

    function makeRefLink(refPath) {
        const a = el('a', 'ref-link');
        a.href = '#';
        a.dataset.ref = String(refPath);
        a.title = 'Click to open';
        a.textContent = String(refPath);
        a.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            vscode.postMessage({ type: 'openRef', ref: a.dataset.ref });
        });
        return a;
    }

    function makeEditableInput(opts) {
        const input = document.createElement('input');
        input.className = 'property-input editable-value';
        input.type = opts.inputType;
        input.dataset.path = opts.pathKey;
        if (opts.keyName) input.dataset.key = opts.keyName;
        if (opts.dataType) input.dataset.type = opts.dataType;
        if (opts.inputType === 'checkbox') {
            input.checked = !!opts.value;
            input._lastValue = !!opts.value;
        } else {
            input.value = opts.value == null ? '' : String(opts.value);
            input._lastValue = opts.value;
        }
        if (opts.step) input.step = opts.step;
        if (isReadOnly) {
            input.disabled = true;
            input.title = 'Read-only (git revision)';
        }
        input.addEventListener('change', function () {
            const path = input.dataset.path.split('.').map(Number);
            const key = input.dataset.key || null;
            let value;
            if (input.type === 'checkbox') value = input.checked;
            else if (input.type === 'number') {
                value = input.step === 'any' ? parseFloat(input.value) : parseInt(input.value, 10);
            } else value = input.value;
            setLocalValue(path, key, value);
            pushEdit(path, key, input._lastValue, value);
            input._lastValue = value;
            vscode.postMessage({ type: 'updateValue', path: path, key: key, value: value });
            markDirty();
        });
        return input;
    }

    function makePropRow(name, valueNode) {
        const tr = el('tr', 'property-row');
        const nameTd = el('td', 'property-name');
        if (typeof name === 'string') nameTd.textContent = name;
        else if (name) nameTd.appendChild(name);
        tr.appendChild(nameTd);
        const td = el('td', 'property-value');
        if (typeof valueNode === 'string') td.textContent = valueNode;
        else if (valueNode) td.appendChild(valueNode);
        tr.appendChild(td);
        return tr;
    }

    function makeCollapsibleSection(title, contentId, bodyBuild, refPath) {
        const section = el('div', 'collapsible-section');
        const headTable = el('table', 'property-grid');
        const headTr = el('tr', 'section-header collapsible-header');
        headTr.dataset.target = contentId;
        const headTd = document.createElement('td');
        if (!refPath) headTd.colSpan = 2;
        const icon = el('span', 'collapse-icon', '▼');
        headTd.appendChild(icon);
        headTd.appendChild(document.createTextNode(' ' + title));
        headTr.appendChild(headTd);
        if (refPath) {
            const refTd = el('td', 'section-ref');
            refTd.appendChild(makeRefLink(refPath));
            headTr.appendChild(refTd);
        }
        headTr.addEventListener('click', function (e) {
            if (e.target.classList && e.target.classList.contains('ref-link')) return;
            const targetEl = document.getElementById(contentId);
            if (targetEl) {
                targetEl.classList.toggle('collapsed');
                icon.textContent = targetEl.classList.contains('collapsed') ? '▶' : '▼';
            }
        });
        headTable.appendChild(headTr);
        section.appendChild(headTable);
        const body = el('div', 'collapsible-content');
        body.id = contentId;
        const bodyTable = el('table', 'property-grid');
        bodyBuild(bodyTable);
        body.appendChild(bodyTable);
        section.appendChild(body);
        return section;
    }

    function renderPropertyGrid(node) {
        const content = document.getElementById('property-content');
        if (!content) return;

        const header = document.getElementById('property-header-text');
        if (header) header.textContent = 'PROPERTIES';

        const hasChildren = node.children && node.children.length > 0;
        const isTable = hasChildren;

        let refValue = null;
        if (node.children) {
            const refChild = node.children.find(function (c) {
                return c.key === '$REF' || c.name === '$REF';
            });
            if (refChild) refValue = refChild.value;
        }

        let dataType = 'Unknown';
        if (isTable) dataType = 'Table';
        else if (node.value !== undefined) {
            const t = typeof node.value;
            if (t === 'boolean') dataType = 'Boolean';
            else if (t === 'number') dataType = Number.isInteger(node.value) ? 'Integer' : 'Float';
            else if (t === 'string') {
                dataType = node.value.startsWith('$') ? 'DoW UCS Ref' : 'String';
            }
        }

        const nodePath = selectedNode ? selectedNode.path : [];
        const nodeKeyPath = computeKeyPath(node, nodePath);
        content.replaceChildren();

        content.appendChild(makeCollapsibleSection(
            'Properties',
            'properties-content',
            function (table) {
                table.appendChild(makePropRow('Name', node.key || node.name || 'Unknown'));
                table.appendChild(makePropRow('Data Type', dataType));
                if (refValue) {
                    table.appendChild(makePropRow('Reference', makeRefLink(refValue)));
                }
                if (!isTable && node.value !== undefined && node.value !== null) {
                    if (isDiffMode) {
                        table.appendChild(makePropRow('Value', makeMergedValueView(nodeKeyPath, node.value)));
                    } else {
                        const inputType = dataType === 'Boolean'
                            ? 'checkbox'
                            : (dataType === 'Integer' || dataType === 'Float' ? 'number' : 'text');
                        const wrap = document.createElement('div');
                        const valueDiff = makeValueDiffView(nodeKeyPath);
                        if (isReadOnly && valueDiff) {
                            wrap.appendChild(valueDiff);
                        } else {
                            wrap.appendChild(makeEditableInput({
                                inputType: inputType,
                                pathKey: nodePath.join('.'),
                                dataType: dataType,
                                value: node.value,
                                step: dataType === 'Float' ? 'any' : undefined,
                            }));
                            if (valueDiff) wrap.appendChild(valueDiff);
                        }
                        if (node.localeText) {
                            const loc = el('div', null, node.localeText);
                            loc.style.opacity = '0.6';
                            loc.style.fontSize = '11px';
                            loc.style.marginTop = '2px';
                            wrap.appendChild(loc);
                        }
                        table.appendChild(makePropRow('Value', wrap));
                    }
                }
            },
        ));

        // Corsix-style info strip at the bottom of the property panel.
        const info = document.getElementById('property-info');
        if (info) {
            const bits = [];
            const kind = nodeKeyPath && diffLeafKinds[nodeKeyPath];
            if (kind === 'added') bits.push('Added in working tree');
            else if (kind === 'removed') bits.push('Removed in working tree');
            else if (kind === 'changed') bits.push('Changed vs HEAD');
            else if (nodeKeyPath && diffHighlight[nodeKeyPath]) bits.push('Contains changes vs HEAD');
            if (refValue) bits.push('References ' + refValue);
            info.textContent = bits.join('  •  ');
            info.hidden = bits.length === 0;
        }

        if (hasChildren) {
            const visibleChildren = node.children.filter(function (child) {
                return child.key !== '$REF' && child.name !== '$REF';
            });
            if (visibleChildren.length > 0) {
                const childrenSection = makeCollapsibleSection(
                    'Table Children',
                    'children-content',
                    function (table) {
                        visibleChildren.forEach(function (child) {
                            // Index into the real children array — filtering
                            // out $REF shifts positions, and the provider
                            // resolves edits by this index.
                            const childIdx = node.children.indexOf(child);
                            const childName = child.key || child.name || 'Unknown';
                            const childKeyPath =
                                (nodeKeyPath ? nodeKeyPath + '.' : '') + (child.key || child.name);
                            let childRef = null;
                            if (child.children) {
                                const refChild = child.children.find(function (c) {
                                    return c.key === '$REF' || c.name === '$REF';
                                });
                                if (refChild) childRef = refChild.value;
                            }
                            let valueNode = null;
                            if (childRef) {
                                valueNode = makeRefLink(childRef);
                            } else if (child.value !== undefined && child.value !== null) {
                                if (isDiffMode) {
                                    valueNode = makeMergedValueView(childKeyPath, child.value);
                                } else {
                                    const cType = typeof child.value;
                                    const wrap = document.createElement('div');
                                    const childDiff = makeValueDiffView(childKeyPath);
                                    if (isReadOnly && childDiff) {
                                        wrap.appendChild(childDiff);
                                    } else {
                                        wrap.appendChild(makeEditableInput({
                                            inputType: cType === 'boolean' ? 'checkbox' : (cType === 'number' ? 'number' : 'text'),
                                            pathKey: nodePath.concat([childIdx]).join('.'),
                                            keyName: childName,
                                            value: child.value,
                                        }));
                                        if (childDiff) wrap.appendChild(childDiff);
                                    }
                                    if (child.localeText) {
                                        const loc = el('div', null, child.localeText);
                                        loc.style.opacity = '0.6';
                                        loc.style.fontSize = '11px';
                                        loc.style.marginTop = '2px';
                                        wrap.appendChild(loc);
                                    }
                                    valueNode = wrap;
                                }
                            } else if (child.children && child.children.length > 0) {
                                const span = el('span', null, '[' + child.children.length + ' items]');
                                span.style.opacity = '0.6';
                                valueNode = span;
                            }
                            table.appendChild(makePropRow(makeChildNavLink(childName, childKeyPath), valueNode));
                        });
                    },
                );
                childrenSection.style.marginTop = '12px';
                content.appendChild(childrenSection);
            }
        }
    }

    function markDirty() {
        documentDirty = true;
        const status = document.getElementById('status-text');
        if (status) {
            status.textContent = documentDirty ? 'Modified (unsaved)' : 'Ready';
        }
        document.querySelectorAll('.save-action').forEach(function (b) {
            b.classList.add('dirty');
        });
    }

    function expandNodeDeep(nodeEl, nodeData, nodePath, depth) {
        if (!nodeData) return;
        const hasKids = nodeData.hasChildren || (nodeData.children && nodeData.children.length > 0);
        if (!hasKids) return;
        const childrenDiv = nodeEl.querySelector(':scope > .tree-children');
        if (!childrenDiv) return;
        const toggle = nodeEl.querySelector(':scope > .tree-row > .tree-toggle');
        if (childrenDiv.children.length === 0) {
            if (nodeData.children && nodeData.children.length > 0) {
                fillChildren(nodeEl, nodeData, nodePath, childrenDiv, depth);
            } else if (nodeData.hasChildren) {
                vscode.postMessage({ type: 'requestChildren', path: nodePath });
                return;
            }
        }
        childrenDiv.classList.add('expanded');
        if (toggle) { toggle.classList.remove('collapsed'); toggle.classList.add('expanded'); }
        const kids = nodeData.children;
        if (!kids || !kids.length) return;
        let idx = 0;
        function expandNextBatch() {
            const end = Math.min(idx + 24, kids.length);
            for (; idx < end; idx++) {
                const childEl = childrenDiv.children[idx];
                if (childEl) {
                    expandNodeDeep(childEl, kids[idx], nodePath.concat([idx]), depth + 1);
                }
            }
            if (idx < kids.length) requestAnimationFrame(expandNextBatch);
        }
        requestAnimationFrame(expandNextBatch);
    }

    function updateStatus(text) {
        const s = document.getElementById('status-text');
        if (s) s.textContent = text;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
