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

    function init() {
        vscode.postMessage({ type: 'ready' });

        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                vscode.postMessage({ type: 'save' });
            });
        }

        const gitDiffBtn = document.getElementById('git-diff-btn');
        if (gitDiffBtn) {
            gitDiffBtn.addEventListener('click', function () {
                updateStatus('Loading git diff…');
                vscode.postMessage({ type: 'requestGitDiff', ref: 'HEAD' });
            });
        }

        const diffClose = document.getElementById('diff-close');
        if (diffClose) {
            diffClose.addEventListener('click', function () {
                clearDiffUi();
            });
        }

        // Keyboard shortcut for save
        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                vscode.postMessage({ type: 'save' });
            }
        });

        // Expand All
        const expandAllBtn = document.getElementById('expand-all');
        if (expandAllBtn) {
            expandAllBtn.addEventListener('click', function () {
                if (!rgdData) return;
                const treeContent = document.getElementById('tree-content');
                Array.from(treeContent.children).forEach(function (nodeEl, idx) {
                    expandNodeDeep(nodeEl, rgdData[idx], [idx], 0);
                });
            });
        }

        // Collapse All
        const collapseAllBtn = document.getElementById('collapse-all');
        if (collapseAllBtn) {
            collapseAllBtn.addEventListener('click', function () {
                document.querySelectorAll('.tree-children').forEach(function (el) {
                    el.classList.remove('expanded');
                });
                document.querySelectorAll('.tree-toggle.expanded').forEach(function (t) {
                    t.classList.remove('expanded');
                    t.classList.add('collapsed');
                });
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
            renderTree(rgdData);
            if (Object.keys(diffHighlight).length) applyTreeDiffHighlights();
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
                }
            }
        } else if (msg.type === 'saved') {
            documentDirty = false;
            updateStatus('Saved');
            const saveBtn = document.getElementById('save-btn');
            if (saveBtn) saveBtn.classList.remove('dirty');
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
        document.querySelectorAll('.tree-row.diff-added, .tree-row.diff-removed, .tree-row.diff-changed')
            .forEach(function (el) {
                el.classList.remove('diff-added', 'diff-removed', 'diff-changed');
            });
        const panel = document.getElementById('diff-panel');
        if (panel) panel.hidden = true;
        const ds = document.getElementById('diff-status');
        if (ds) ds.textContent = '';
    }

    function showGitDiff(msg) {
        diffHighlight = msg.highlight || {};
        const entries = msg.entries || [];
        const panel = document.getElementById('diff-panel');
        const content = document.getElementById('diff-content');
        const header = document.getElementById('diff-header-text');
        if (header) {
            header.textContent = 'Git Diff vs ' + (msg.baseRef || 'HEAD') +
                ' — ' + entries.length + ' change' + (entries.length === 1 ? '' : 's');
        }
        if (content) {
            content.replaceChildren();
            if (entries.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                empty.textContent = 'No differences vs ' + (msg.baseRef || 'HEAD');
                content.appendChild(empty);
            } else {
                entries.forEach(function (entry) {
                    content.appendChild(createDiffRow(entry));
                });
            }
        }
        if (panel) panel.hidden = false;
        applyTreeDiffHighlights();
        const ds = document.getElementById('diff-status');
        if (ds) {
            ds.textContent = entries.length + ' Δ vs ' + (msg.baseRef || 'HEAD');
        }
        updateStatus('Git diff ready (' + entries.length + ' changes)');
    }

    function createDiffRow(entry) {
        const row = document.createElement('div');
        row.className = 'diff-row diff-' + entry.kind;
        row.title = 'Click to jump in tree';
        const kind = document.createElement('span');
        kind.className = 'diff-kind';
        kind.textContent = entry.kind === 'added' ? '+' : entry.kind === 'removed' ? '−' : '~';
        const keyEl = document.createElement('span');
        keyEl.className = 'diff-key';
        keyEl.textContent = entry.key;
        const valEl = document.createElement('span');
        valEl.className = 'diff-vals';
        if (entry.kind === 'changed') {
            valEl.textContent = formatScalar(entry.oldValue) + ' → ' + formatScalar(entry.newValue);
        } else if (entry.kind === 'added') {
            valEl.textContent = formatScalar(entry.newValue);
        } else {
            valEl.textContent = formatScalar(entry.oldValue);
        }
        row.appendChild(kind);
        row.appendChild(keyEl);
        row.appendChild(valEl);
        row.addEventListener('click', function () {
            jumpToKeyPath(entry.key);
        });
        return row;
    }

    function formatScalar(s) {
        if (!s) return '';
        if (typeof s.value === 'string') return JSON.stringify(s.value);
        return String(s.value);
    }

    function jumpToKeyPath(keyPath) {
        if (!rgdData || !keyPath) return;
        const parts = keyPath.split('.');
        let list = rgdData;
        const idxPath = [];
        for (let i = 0; i < parts.length; i++) {
            if (!list) return;
            const want = parts[i];
            let found = -1;
            for (let j = 0; j < list.length; j++) {
                const n = list[j];
                if ((n.key || n.name) === want) {
                    found = j;
                    break;
                }
            }
            if (found < 0) return;
            idxPath.push(found);
            // Expand ancestors
            const nodeEl = document.querySelector('[data-path="' + idxPath.join('.') + '"]');
            if (nodeEl) {
                const treeNode = nodeEl.closest('.tree-node');
                const toggle = nodeEl.querySelector('.tree-toggle');
                const nodeData = getNodeAtPath(rgdData, idxPath);
                if (treeNode && toggle && nodeData && (nodeData.hasChildren || (nodeData.children && nodeData.children.length))) {
                    const kids = treeNode.querySelector('.tree-children');
                    if (kids && !kids.classList.contains('expanded')) {
                        toggleExpand(treeNode, toggle, nodeData, idxPath.slice(), idxPath.length - 1);
                    }
                }
            }
            const cur = list[found];
            list = cur && cur.children ? cur.children : null;
        }
        const leaf = getNodeAtPath(rgdData, idxPath);
        if (leaf) selectNode(leaf, idxPath);
        const row = nodeRegistry.get(idxPath.join('.'));
        if (row) row.scrollIntoView({ block: 'center' });
    }

    function applyTreeDiffHighlights() {
        document.querySelectorAll('.tree-row').forEach(function (row) {
            row.classList.remove('diff-added', 'diff-removed', 'diff-changed');
            const kp = row.dataset.keyPath;
            if (kp && diffHighlight[kp]) {
                row.classList.add('diff-' + diffHighlight[kp]);
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
        if (diffHighlight[keyPath]) {
            row.classList.add('diff-' + diffHighlight[keyPath]);
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
            if (hasChildren) {
                toggleExpand(div, toggle, node, path, depth);
            }
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
    }

    function selectNode(node, path) {
        if (selectedRow) selectedRow.classList.remove('selected');
        const row = nodeRegistry.get(path.join('.'));
        if (row) { row.classList.add('selected'); selectedRow = row; }
        selectedNode = { node: node, path: path };
        renderPropertyGrid(node);
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
        } else {
            input.value = opts.value == null ? '' : String(opts.value);
        }
        if (opts.step) input.step = opts.step;
        input.addEventListener('change', function () {
            const path = input.dataset.path.split('.').map(Number);
            const key = input.dataset.key || null;
            let value;
            if (input.type === 'checkbox') value = input.checked;
            else if (input.type === 'number') {
                value = input.step === 'any' ? parseFloat(input.value) : parseInt(input.value, 10);
            } else value = input.value;
            vscode.postMessage({ type: 'updateValue', path: path, key: key, value: value });
            markDirty();
        });
        return input;
    }

    function makePropRow(name, valueNode) {
        const tr = el('tr', 'property-row');
        tr.appendChild(el('td', 'property-name', name));
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
        content.replaceChildren();

        content.appendChild(makeCollapsibleSection(
            'Properties',
            'properties-content',
            function (table) {
                table.appendChild(makePropRow('Name', node.key || node.name || 'Unknown'));
                if (!isTable && node.value !== undefined && node.value !== null) {
                    const inputType = dataType === 'Boolean'
                        ? 'checkbox'
                        : (dataType === 'Integer' || dataType === 'Float' ? 'number' : 'text');
                    const wrap = document.createElement('div');
                    wrap.appendChild(makeEditableInput({
                        inputType: inputType,
                        pathKey: nodePath.join('.'),
                        dataType: dataType,
                        value: node.value,
                        step: dataType === 'Float' ? 'any' : undefined,
                    }));
                    if (node.localeText) {
                        const loc = el('div', null, node.localeText);
                        loc.style.opacity = '0.6';
                        loc.style.fontSize = '11px';
                        loc.style.marginTop = '2px';
                        wrap.appendChild(loc);
                    }
                    table.appendChild(makePropRow(dataType, wrap));
                } else if (isTable) {
                    table.appendChild(makePropRow('Data Type', dataType));
                }
            },
            refValue || undefined,
        ));

        if (hasChildren) {
            const visibleChildren = node.children.filter(function (child) {
                return child.key !== '$REF' && child.name !== '$REF';
            });
            if (visibleChildren.length > 0) {
                const childrenSection = makeCollapsibleSection(
                    'Table Children',
                    'children-content',
                    function (table) {
                        visibleChildren.forEach(function (child, idx) {
                            const childName = child.key || child.name || 'Unknown';
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
                                const cType = typeof child.value;
                                const wrap = document.createElement('div');
                                wrap.appendChild(makeEditableInput({
                                    inputType: cType === 'boolean' ? 'checkbox' : (cType === 'number' ? 'number' : 'text'),
                                    pathKey: nodePath.concat([idx]).join('.'),
                                    keyName: childName,
                                    value: child.value,
                                }));
                                if (child.localeText) {
                                    const loc = el('div', null, child.localeText);
                                    loc.style.opacity = '0.6';
                                    loc.style.fontSize = '11px';
                                    loc.style.marginTop = '2px';
                                    wrap.appendChild(loc);
                                }
                                valueNode = wrap;
                            } else if (child.children && child.children.length > 0) {
                                const span = el('span', null, '[' + child.children.length + ' items]');
                                span.style.opacity = '0.6';
                                valueNode = span;
                            }
                            table.appendChild(makePropRow(childName, valueNode));
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
        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) saveBtn.classList.add('dirty');
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
