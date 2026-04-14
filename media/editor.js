(function () {
    const vscode = acquireVsCodeApi();
    let rgdData = null;
    let selectedNode = null;
    let selectedRow = null;
    let isDirty = false;
    const nodeRegistry = new Map();

    function init() {
        vscode.postMessage({ type: 'ready' });

        // Save button handler
        const saveBtn = document.getElementById('save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                vscode.postMessage({ type: 'save' });
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
            updateStatus('Loaded ' + (rgdData ? rgdData.length : 0) + ' nodes');
        } else if (msg.type === 'saved') {
            isDirty = false;
            updateStatus('Saved');
        }
    });

    function renderTree(nodes) {
        nodeRegistry.clear();
        selectedRow = null;
        const treeContent = document.getElementById('tree-content');
        if (!treeContent) return;
        treeContent.innerHTML = '';

        if (!nodes || nodes.length === 0) {
            treeContent.innerHTML = '<div class="empty-state"><div>No data</div></div>';
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

        const hasChildren = node.children && node.children.length > 0;
        const nodeName = node.key || node.name || 'Unknown';
        const isRefNode = nodeName === '$REF';

        const row = document.createElement('div');
        row.className = 'tree-row';
        row.style.paddingLeft = (8 + depth * 16) + 'px';
        row.dataset.path = JSON.stringify(path);
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

        // For $REF nodes, make the label a clickable hyperlink showing the ref path
        if (isRefNode && node.value) {
            label.innerHTML = '<a href="#" class="tree-ref-link" data-ref="' + esc(node.value) + '" title="Click to open: ' + esc(node.value) + '">' + esc(nodeName) + '</a>';
        } else {
            label.textContent = nodeName;
        }
        row.appendChild(label);

        if (hasChildren) {
            const badge = document.createElement('span');
            badge.className = 'tree-badge';
            badge.textContent = node.children.length;
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
            if (childrenDiv.children.length === 0 && node.children) {
                node.children.forEach(function (child, idx) {
                    const childPath = path.concat([idx]);
                    const childEl = createTreeNode(child, childPath, depth + 1);
                    childrenDiv.appendChild(childEl);
                });
            }
            childrenDiv.classList.add('expanded');
            toggle.classList.remove('collapsed');
            toggle.classList.add('expanded');
        }
    }

    function selectNode(node, path) {
        if (selectedRow) selectedRow.classList.remove('selected');
        const row = nodeRegistry.get(JSON.stringify(path));
        if (row) { row.classList.add('selected'); selectedRow = row; }
        selectedNode = { node: node, path: path };
        renderPropertyGrid(node);
    }

    function renderPropertyGrid(node) {
        const content = document.getElementById('property-content');
        if (!content) return;

        const header = document.getElementById('property-header-text');
        if (header) {
            header.textContent = 'PROPERTIES';
        }

        const hasChildren = node.children && node.children.length > 0;
        const isTable = hasChildren;

        // Find $REF child if it exists
        let refValue = null;
        if (node.children) {
            const refChild = node.children.find(function (c) {
                return c.key === '$REF' || c.name === '$REF';
            });
            if (refChild) refValue = refChild.value;
        }

        // Determine data type
        let dataType = 'Unknown';
        if (isTable) {
            dataType = 'Table';
        } else if (node.value !== undefined) {
            const t = typeof node.value;
            if (t === 'boolean') dataType = 'Boolean';
            else if (t === 'number') dataType = Number.isInteger(node.value) ? 'Integer' : 'Float';
            else if (t === 'string') {
                if (node.value.startsWith('$')) dataType = 'DoW UCS Ref';
                else dataType = 'String';
            }
        }

        let html = '';
        const nodePath = selectedNode ? selectedNode.path : [];

        // === PROPERTIES SECTION with Reference in header ===
        html += '<div class="collapsible-section" data-section="properties">';
        html += '<table class="property-grid">';

        // Header row: clickable to collapse/expand, with reference link on the right
        if (refValue) {
            html += '<tr class="section-header collapsible-header" data-target="properties-content"><td><span class="collapse-icon">▼</span> Properties</td><td class="section-ref"><a href="#" class="ref-link" data-ref="' + esc(refValue) + '" title="Click to open">' + esc(refValue) + '</a></td></tr>';
        } else {
            html += '<tr class="section-header collapsible-header" data-target="properties-content"><td colspan="2"><span class="collapse-icon">▼</span> Properties</td></tr>';
        }

        html += '</table>';
        html += '<div class="collapsible-content" id="properties-content">';
        html += '<table class="property-grid">';

        // Name row
        html += '<tr class="property-row"><td class="property-name">Name</td><td class="property-value">' + esc(node.key || node.name || 'Unknown') + '</td></tr>';

        // Data Type / Value merged: use dataType as label, show editable value
        if (!isTable && node.value !== undefined && node.value !== null) {
            const inputType = dataType === 'Boolean' ? 'checkbox' : (dataType === 'Integer' || dataType === 'Float' ? 'number' : 'text');
            const inputValue = dataType === 'Boolean' ? (node.value ? ' checked' : '') : ' value="' + esc(String(node.value)) + '"';
            const inputStep = dataType === 'Float' ? ' step="any"' : '';
            html += '<tr class="property-row"><td class="property-name">' + dataType + '</td><td class="property-value">';
            html += '<input type="' + inputType + '" class="property-input editable-value" data-path="' + esc(JSON.stringify(nodePath)) + '" data-type="' + dataType + '"' + inputValue + inputStep + '>';
            if (node.localeText) {
                html += '<div style="opacity:0.6;font-size:11px;margin-top:2px;">' + esc(node.localeText) + '</div>';
            }
            html += '</td></tr>';
        } else if (isTable) {
            html += '<tr class="property-row"><td class="property-name">Data Type</td><td class="property-value">' + dataType + '</td></tr>';
        }

        html += '</table>';
        html += '</div></div>';

        // === TABLE CHILDREN SECTION (only for tables) ===
        if (hasChildren) {
            // Filter out $REF and reference-only children (children that only have a $REF)
            const visibleChildren = node.children.filter(function (child) {
                if (child.key === '$REF' || child.name === '$REF') return false;
                return true;
            });

            if (visibleChildren.length > 0) {
                html += '<div class="collapsible-section" data-section="children" style="margin-top:12px;">';
                html += '<table class="property-grid">';
                html += '<tr class="section-header collapsible-header" data-target="children-content"><td colspan="2"><span class="collapse-icon">▼</span> Table Children</td></tr>';
                html += '</table>';
                html += '<div class="collapsible-content" id="children-content">';
                html += '<table class="property-grid">';

                visibleChildren.forEach(function (child, idx) {
                    const childName = child.key || child.name || 'Unknown';
                    let childValue = '';

                    // Find $REF in child if it exists
                    let childRef = null;
                    if (child.children) {
                        const refChild = child.children.find(function (c) {
                            return c.key === '$REF' || c.name === '$REF';
                        });
                        if (refChild) childRef = refChild.value;
                    }

                    if (childRef) {
                        childValue = '<a href="#" class="ref-link" data-ref="' + esc(childRef) + '" title="Click to open">' + esc(childRef) + '</a>';
                    } else if (child.value !== undefined && child.value !== null) {
                        // Editable input for child values
                        const childPath = nodePath.concat([idx]);
                        const cType = typeof child.value;
                        const cInputType = cType === 'boolean' ? 'checkbox' : (cType === 'number' ? 'number' : 'text');
                        const cInputValue = cType === 'boolean' ? (child.value ? ' checked' : '') : ' value="' + esc(String(child.value)) + '"';
                        childValue = '<input type="' + cInputType + '" class="property-input editable-value" data-path="' + esc(JSON.stringify(childPath)) + '" data-key="' + esc(childName) + '"' + cInputValue + '>';
                        if (child.localeText) {
                            childValue += '<div style="opacity:0.6;font-size:11px;margin-top:2px;">' + esc(child.localeText) + '</div>';
                        }
                    } else if (child.children && child.children.length > 0) {
                        childValue = '<span style="opacity:0.6;">[' + child.children.length + ' items]</span>';
                    }

                    html += '<tr class="property-row"><td class="property-name">' + esc(childName) + '</td><td class="property-value">' + childValue + '</td></tr>';
                });

                html += '</table>';
                html += '</div></div>';
            }
        }

        content.innerHTML = html;

        // Add click handlers for collapsible headers
        content.querySelectorAll('.collapsible-header').forEach(function (header) {
            header.addEventListener('click', function (e) {
                if (e.target.classList.contains('ref-link')) return; // Don't collapse when clicking ref link
                const targetId = header.dataset.target;
                const targetEl = document.getElementById(targetId);
                const icon = header.querySelector('.collapse-icon');
                if (targetEl) {
                    targetEl.classList.toggle('collapsed');
                    icon.textContent = targetEl.classList.contains('collapsed') ? '▶' : '▼';
                }
            });
        });

        // Add click handlers for ref links
        content.querySelectorAll('.ref-link').forEach(function (link) {
            link.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                vscode.postMessage({ type: 'openRef', ref: link.dataset.ref });
            });
        });

        // Add change handlers for editable inputs
        content.querySelectorAll('.editable-value').forEach(function (input) {
            input.addEventListener('change', function () {
                const path = JSON.parse(input.dataset.path);
                const key = input.dataset.key || null;
                let value;
                if (input.type === 'checkbox') {
                    value = input.checked;
                } else if (input.type === 'number') {
                    value = input.step === 'any' ? parseFloat(input.value) : parseInt(input.value, 10);
                } else {
                    value = input.value;
                }
                vscode.postMessage({ type: 'updateValue', path: path, key: key, value: value });
                markDirty();
            });
        });
    }

    function markDirty() {
        isDirty = true;
        const status = document.getElementById('status-text');
        if (status) status.textContent = 'Modified (unsaved)';
    }

    function expandNodeDeep(nodeEl, nodeData, nodePath, depth) {
        if (!nodeData || !nodeData.children || nodeData.children.length === 0) return;
        const childrenDiv = nodeEl.querySelector(':scope > .tree-children');
        if (!childrenDiv) return;
        const toggle = nodeEl.querySelector(':scope > .tree-row > .tree-toggle');
        if (childrenDiv.children.length === 0) {
            nodeData.children.forEach(function (child, idx) {
                childrenDiv.appendChild(createTreeNode(child, nodePath.concat([idx]), depth + 1));
            });
        }
        childrenDiv.classList.add('expanded');
        if (toggle) { toggle.classList.remove('collapsed'); toggle.classList.add('expanded'); }
        Array.from(childrenDiv.children).forEach(function (childEl, idx) {
            expandNodeDeep(childEl, nodeData.children[idx], nodePath.concat([idx]), depth + 1);
        });
    }

    function esc(text) {
        if (text === null || text === undefined) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
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
