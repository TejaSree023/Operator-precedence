const grammarInput = document.getElementById("grammar");
const precedenceInput = document.getElementById("precedence");
const expressionInput = document.getElementById("expression");
const analyzeBtn = document.getElementById("analyzeBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const statusText = document.getElementById("status");

const summaryEl = document.getElementById("summary");
const extractedEl = document.getElementById("extracted");
const conflictsEl = document.getElementById("conflicts");
const suggestionsEl = document.getElementById("suggestions");
const autocorrectEl = document.getElementById("autocorrect");
const treeMessageEl = document.getElementById("treeMessage");
const parseTreesEl = document.getElementById("parseTrees");
const evaluationEl = document.getElementById("evaluation");
const copyAutocorrectBtn = document.getElementById("copyAutocorrect");
const precedenceToggle = document.getElementById("togglePrecedenceRules");
const precedencePanel = document.getElementById("precedencePanel");
const precedenceRulesEl = document.getElementById("precedenceRules");

let debounceTimer = null;
let requestCounter = 0;
let latestAnalysis = null;
let activeTreeRole = "selected";
let syntheticPrecedenceTokens = [];
let currentTreeView = {
    selectedTree: null,
    ignoredTree: null,
    deterministic: false,
    selectedInterpretation: "",
    ignoredInterpretation: "",
    selectedSteps: [],
    ignoredSteps: [],
    explanation: "",
};

const EXPR_TOKEN_REGEX = /[A-Za-z_][A-Za-z0-9_]*|\d+|==|!=|<=|>=|\|\||&&|\S/g;
const SYNTHETIC_PREFIX = "__pcsynthetic__";

function tokenizeExpression(expression) {
    return (expression.match(EXPR_TOKEN_REGEX) || []).filter(Boolean);
}

function parsePrecedenceUserInput(rawText) {
    const rows = [];
    rawText.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
            return;
        }
        const parts = trimmed.split(/\s+/);
        const assocToken = parts[0];
        if (!assocToken.startsWith("%")) {
            return;
        }
        const assoc = assocToken.slice(1);
        if (!["left", "right", "nonassoc"].includes(assoc)) {
            return;
        }
        const operators = parts.slice(1);
        if (!operators.length) {
            return;
        }
        rows.push({ assoc, operators });
    });
    return rows;
}

function normalizePrecedenceForBackend(rawText) {
    const synthetic = [];
    const normalized = rawText
        .split(/\r?\n/)
        .map((line, index) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
                return line;
            }

            const parts = trimmed.split(/\s+/);
            if (!parts[0]?.startsWith("%")) {
                return line;
            }

            if (parts.length === 2) {
                const syntheticToken = `${SYNTHETIC_PREFIX}${index}`;
                synthetic.push(syntheticToken);
                return `${parts[0]} ${parts[1]} ${syntheticToken}`;
            }

            return line;
        })
        .join("\n");

    return { normalizedText: normalized, syntheticTokens: synthetic };
}

function stripSyntheticTokens(text, syntheticTokens) {
    if (!text || !syntheticTokens.length) {
        return text;
    }

    let result = String(text);
    syntheticTokens.forEach((token) => {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        result = result.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "g"), "");
    });

    return result
        .replace(/\s+\|/g, " |")
        .replace(/\|\s+\|/g, "|")
        .replace(/\s{2,}/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .trim();
}

function sanitizeAnalysisData(data, syntheticTokens) {
    if (!syntheticTokens.length || !data) {
        return data;
    }

    const cleaned = structuredClone(data);

    if (cleaned.extracted?.precedenceTable) {
        cleaned.extracted.precedenceTable = cleaned.extracted.precedenceTable.filter(
            (row) => !syntheticTokens.includes(row.operator)
        );
    }

    if (Array.isArray(cleaned.suggestions)) {
        cleaned.suggestions = cleaned.suggestions.map((suggestion) => ({
            ...suggestion,
            detail: stripSyntheticTokens(suggestion.detail || "", syntheticTokens),
            example: stripSyntheticTokens(suggestion.example || "", syntheticTokens),
        }));
    }

    if (cleaned.autoCorrection) {
        cleaned.autoCorrection = {
            ...cleaned.autoCorrection,
            message: stripSyntheticTokens(cleaned.autoCorrection.message || "", syntheticTokens),
            correctedGrammar: stripSyntheticTokens(cleaned.autoCorrection.correctedGrammar || "", syntheticTokens),
        };
    }

    if (Array.isArray(cleaned.conflicts)) {
        cleaned.conflicts = cleaned.conflicts.map((conflict) => ({
            ...conflict,
            message: stripSyntheticTokens(conflict.message || "", syntheticTokens),
            details: stripSyntheticTokens(conflict.details || "", syntheticTokens),
            production: stripSyntheticTokens(conflict.production || "", syntheticTokens),
        }));
    }

    return cleaned;
}

function precedenceMapFromRows(rows) {
    const mapping = new Map();
    rows.forEach((row, level) => {
        row.operators.forEach((op) => {
            mapping.set(op, { level, assoc: row.assoc });
        });
    });
    return mapping;
}

function normalizeExprString(text) {
    return String(text || "").replace(/\s+/g, "").trim();
}

function toParenthesizedInfix(node) {
    if (!node) {
        return "";
    }
    if (!node.left && !node.right) {
        return node.value;
    }
    return `(${toParenthesizedInfix(node.left)} ${node.value} ${toParenthesizedInfix(node.right)})`;
}

function buildExpectedTreeFromExpression(expression, precedenceRows) {
    const tokens = tokenizeExpression(expression);
    if (!tokens.length) {
        return null;
    }

    const precMap = precedenceMapFromRows(precedenceRows);
    const output = [];
    const operators = [];

    const isOperand = (token) => /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/.test(token);
    const isOperator = (token) => !isOperand(token) && token !== "(" && token !== ")";
    const getPrec = (op) => precMap.get(op)?.level ?? -1;
    const getAssoc = (op) => precMap.get(op)?.assoc ?? "left";

    for (const token of tokens) {
        if (isOperand(token)) {
            output.push(token);
            continue;
        }

        if (token === "(") {
            operators.push(token);
            continue;
        }

        if (token === ")") {
            while (operators.length && operators[operators.length - 1] !== "(") {
                output.push(operators.pop());
            }
            if (operators[operators.length - 1] === "(") {
                operators.pop();
            }
            continue;
        }

        if (!isOperator(token)) {
            continue;
        }

        while (operators.length && operators[operators.length - 1] !== "(") {
            const top = operators[operators.length - 1];
            const tokenPrec = getPrec(token);
            const topPrec = getPrec(top);
            const assoc = getAssoc(token);
            const shouldPop = assoc === "right" ? tokenPrec < topPrec : tokenPrec <= topPrec;
            if (!shouldPop) {
                break;
            }
            output.push(operators.pop());
        }
        operators.push(token);
    }

    while (operators.length) {
        const token = operators.pop();
        if (token !== "(") {
            output.push(token);
        }
    }

    const stack = [];
    for (const token of output) {
        if (isOperand(token)) {
            stack.push({ value: token, left: null, right: null });
            continue;
        }
        const right = stack.pop();
        const left = stack.pop();
        if (!left || !right) {
            return null;
        }
        stack.push({ value: token, left, right });
    }

    return stack.length === 1 ? stack[0] : null;
}

function buildStepsFromAst(ast) {
    if (!ast) {
        return [];
    }

    const operations = [];

    function walk(node) {
        const children = node?.children || [];
        if (!children.length) {
            return node?.label || "";
        }
        if (children.length === 3) {
            const left = walk(children[0]);
            const op = children[1]?.label || "";
            const right = walk(children[2]);
            const expr = `${left} ${op} ${right}`;
            operations.push(expr);
            return expr;
        }
        return node?.label || "";
    }

    const finalExpr = walk(ast);
    if (!operations.length) {
        return [];
    }

    const steps = operations.map((expr, idx) => {
        let shown = expr;
        operations.slice(0, idx).forEach((prev) => {
            shown = shown.replace(prev, "result");
        });
        return `Step ${idx + 1}: ${shown}`;
    });

    if (steps.length > 1) {
        let collapsed = finalExpr;
        operations.slice(0, operations.length - 1).forEach((prev) => {
            collapsed = collapsed.replace(prev, "result");
        });
        steps[steps.length - 1] = `Step ${steps.length}: ${collapsed}`;
    }

    return steps;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function chip(label, klass = "") {
    return `<span class="chip ${klass}">${escapeHtml(label)}</span>`;
}

function renderTreeSvgMarkup(svg, fallbackMessage) {
    if (!svg) {
        return `<p class="muted">${escapeHtml(fallbackMessage || "Graphviz SVG unavailable")}</p>`;
    }
    return svg;
}

function renderSummary(summary) {
    const entries = [
        ["Productions", summary.productionCount, "Grammar rules"],
        ["Operators", summary.operatorCount, "Detected operators"],
        ["Operands", summary.operandCount, "Detected operands"],
        ["Findings", summary.conflictCount, "Conflicts found"],
    ];

    const statusClass = summary.hasUnresolved ? "summary-bad" : "summary-good";
    const statusTextLabel = summary.hasUnresolved ? "Needs attention" : "Precedence-consistent";

    summaryEl.innerHTML = `
        ${entries
            .map(
                ([label, value, meta]) =>
                    `<div class="kpi"><span class="label">${escapeHtml(meta)}</span><span class="value">${value}</span><span class="muted">${escapeHtml(label)}</span></div>`
            )
            .join("")}
        <div class="card summary-card ${statusClass}">
            <h3>Conflict Analysis Summary</h3>
            <p>Structural Conflicts: <strong>${summary.structuralConflicts}</strong></p>
            <p>Resolved Conflicts: <strong>${summary.resolvedConflicts}</strong></p>
            <p>Unresolved Conflicts: <strong>${summary.unresolvedConflicts}</strong></p>
            <p><strong>Status:</strong> ${escapeHtml(statusTextLabel)} (${escapeHtml(summary.status)})</p>
        </div>
    `;
}

function renderExtracted(extracted) {
    extractedEl.innerHTML = `
        <div>
            <strong>Operators</strong>
            <div class="token-list">${extracted.operators.map((op) => chip(op, "operator")).join("") || "<span class='muted'>None</span>"}</div>
        </div>
        <div style="margin-top:10px;">
            <strong>Operands</strong>
            <div class="token-list">${extracted.operands.map((op) => chip(op)).join("") || "<span class='muted'>None</span>"}</div>
        </div>
    `;

    renderPrecedenceRules(extracted.precedenceTable || []);
}

function renderPrecedenceRules(precedenceTable) {
    if (!precedenceRulesEl) {
        return;
    }

    if (!precedenceTable.length) {
        precedenceRulesEl.innerHTML = `<p class="muted">No precedence declarations found.</p>`;
        return;
    }

    precedenceRulesEl.innerHTML = precedenceTable
        .map(
            (row) => `
            <div class="card" style="margin-top:8px;">
                <p><strong>${escapeHtml(row.operator)}</strong> → Level ${row.level} (${escapeHtml(
                row.assoc[0].toUpperCase() + row.assoc.slice(1)
            )})</p>
            </div>
        `
        )
        .join("");
}

function renderConflicts(conflicts) {
    if (!conflicts.length) {
        conflictsEl.innerHTML = `<div class="card low"><h3>No conflicts found</h3><p>The grammar looks consistent with the implemented checks.</p></div>`;
        return;
    }

    const legend = `
        <div class="legend-row">
            <span class="legend-chip high">High Severity</span>
            <span class="legend-chip structural">Structural</span>
            <span class="legend-chip resolved">Resolved</span>
        </div>
    `;

    conflictsEl.innerHTML =
        legend +
        conflicts
            .map((conflict) => {
                const isResolved = conflict.status === "resolved";
                const statusClass = isResolved ? "resolved-card" : "unresolved-card";
                const structuralClass = conflict.type === "ambiguous-pattern" ? "structural" : "";
                const typeBadgeClass = (conflict.type || "").toLowerCase().replace(/\s+/g, "-");
                const shownType = conflict.displayType || conflict.type;
                const shownStatus = conflict.classification || (isResolved ? "Resolved Conflict" : "Unresolved Conflict");
                return `
            <div class="card ${conflict.severity} ${statusClass} ${structuralClass}">
                <h3>${escapeHtml(conflict.message)}</h3>
                <p>${escapeHtml(conflict.details || "")}</p>
                ${conflict.production ? `<p class="muted">Problematic Production: <strong>${escapeHtml(conflict.production)}</strong></p>` : ""}
                <p class="muted">Type: <span class="type-badge ${typeBadgeClass}">${escapeHtml(shownType)}</span> | Severity: ${escapeHtml(conflict.severity)} | Status: <span class="status-badge ${
                    isResolved ? "resolved" : "unresolved"
                }">${escapeHtml(shownStatus)}</span></p>
            </div>
        `;
            })
            .join("");
}

function wireCopyFixButtons() {
    suggestionsEl.querySelectorAll(".copy-fix-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const pre = btn.parentElement?.querySelector("pre");
            if (!pre) {
                return;
            }
            try {
                await navigator.clipboard.writeText(pre.textContent || "");
                const previous = btn.textContent;
                btn.textContent = "Copied";
                setTimeout(() => {
                    btn.textContent = previous;
                }, 900);
            } catch {
                btn.textContent = "Copy failed";
            }
        });
    });
}

function renderSuggestions(suggestions) {
    if (!suggestions.length) {
        suggestionsEl.innerHTML = `<p class="muted">No additional suggestions generated.</p>`;
        return;
    }

    suggestionsEl.innerHTML = suggestions
        .map(
            (suggestion) => `
            <div class="card">
                <h3>${escapeHtml(suggestion.title)}</h3>
                <p>${escapeHtml(suggestion.detail)}</p>
                <pre class="code-box">${escapeHtml(suggestion.example || "")}</pre>
                <button type="button" class="btn ghost copy-fix-btn">Copy Fix</button>
            </div>
        `
        )
        .join("");

    wireCopyFixButtons();
}

function renderOperatorPrecedenceAnalysis(analysis) {
    if (!analysis) return;
    
    // Render FIRSTVT
    const firstvtEl = document.getElementById("firstvt");
    if (firstvtEl && analysis.firstvt) {
        firstvtEl.innerHTML = Object.entries(analysis.firstvt)
            .filter(([_, terminals]) => terminals.length > 0)
            .map(([nt, terminals]) => `
                <div class="vt-item">
                    <strong>${escapeHtml(nt)}:</strong> ${terminals.map(t => `<span class="vt-terminal">${escapeHtml(t)}</span>`).join(" ")}
                </div>
            `)
            .join("") || `<p class="muted">No FIRSTVT terminals found.</p>`;
    }
    
    // Render LASTVT
    const lastvtEl = document.getElementById("lastvt");
    if (lastvtEl && analysis.lastvt) {
        lastvtEl.innerHTML = Object.entries(analysis.lastvt)
            .filter(([_, terminals]) => terminals.length > 0)
            .map(([nt, terminals]) => `
                <div class="vt-item">
                    <strong>${escapeHtml(nt)}:</strong> ${terminals.map(t => `<span class="vt-terminal">${escapeHtml(t)}</span>`).join(" ")}
                </div>
            `)
            .join("") || `<p class="muted">No LASTVT terminals found.</p>`;
    }
    
    // Render Precedence Relations
    const relationsEl = document.getElementById("precedenceRelations");
    if (relationsEl && analysis.precedenceRelations) {
        if (analysis.precedenceRelations.length === 0) {
            relationsEl.innerHTML = `<p class="muted">No operator relations found.</p>`;
            return;
        }
        
        const relationSymbols = {
            "<": "&#60;",
            ">": "&#62;",
            "=": "=",
            "?": "?"
        };
        
        relationsEl.innerHTML = `
            <table class="relations-table">
                <thead>
                    <tr>
                        <th>Op1</th>
                        <th>Relation</th>
                        <th>Op2</th>
                        <th>Production</th>
                    </tr>
                </thead>
                <tbody>
                    ${analysis.precedenceRelations.map(rel => `
                        <tr class="relation-row relation-${rel.relation}">
                            <td class="op-cell"><code>${escapeHtml(rel.op1)}</code></td>
                            <td class="relation-cell">${relationSymbols[rel.relation] || rel.relation}</td>
                            <td class="op-cell"><code>${escapeHtml(rel.op2)}</code></td>
                            <td class="prod-cell"><code>${escapeHtml(rel.production)}</code></td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        `;
    }
}

function replaceWithRect(nodeGroup, fill, stroke, paddingX, paddingY, radius = 12) {
    const text = nodeGroup.querySelector("text");
    if (!text) {
        return;
    }

    const textBox = text.getBBox();
    const x = textBox.x - paddingX;
    const y = textBox.y - paddingY;
    const width = textBox.width + paddingX * 2;
    const height = textBox.height + paddingY * 2;

    const oldShape = nodeGroup.querySelector("ellipse, polygon, path");
    if (oldShape) {
        oldShape.remove();
    }

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", String(height));
    rect.setAttribute("rx", String(radius));
    rect.setAttribute("ry", String(radius));
    rect.setAttribute("fill", fill);
    rect.setAttribute("stroke", stroke);
    rect.setAttribute("stroke-width", "1.4");
    nodeGroup.insertBefore(rect, text);
}

function replaceWithCircle(nodeGroup, fill, stroke, padding = 12) {
    const text = nodeGroup.querySelector("text");
    if (!text) {
        return;
    }

    const textBox = text.getBBox();
    const cx = textBox.x + textBox.width / 2;
    const cy = textBox.y + textBox.height / 2;
    const r = Math.max(textBox.width, textBox.height) / 2 + padding;

    const oldShape = nodeGroup.querySelector("ellipse, polygon, path");
    if (oldShape) {
        oldShape.remove();
    }

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", fill);
    circle.setAttribute("stroke", stroke);
    circle.setAttribute("stroke-width", "1.5");
    nodeGroup.insertBefore(circle, text);
}

function styleTreeNode(nodeGroup) {
    const textEl = nodeGroup.querySelector("text");
    if (!textEl) {
        return;
    }

    const value = (textEl.textContent || "").trim();
    if (value === "E") {
        nodeGroup.classList.add("node-e");
        replaceWithRect(nodeGroup, "#f4ddbb", "#d5a86e", 14, 8, 11);
        textEl.setAttribute("fill", "#5a3e2b");
        return;
    }

    if (value === "id") {
        nodeGroup.classList.add("node-id");
        replaceWithRect(nodeGroup, "#efefef", "#bdbdbd", 8, 6, 7);
        textEl.setAttribute("fill", "#5a3e2b");
        return;
    }

    if (["+", "*", "-", "/"].includes(value)) {
        nodeGroup.classList.add("node-op");
        replaceWithCircle(nodeGroup, "#d98c3f", "#b5732f", 10);
        textEl.setAttribute("fill", "#fff");
    }
}

function installSubtreeInteractions(svgElement, role) {
    const nodeElements = Array.from(svgElement.querySelectorAll("g.node"));
    const edgeElements = Array.from(svgElement.querySelectorAll("g.edge"));

    const nodeMap = new Map();
    const childrenMap = new Map();

    nodeElements.forEach((node, index) => {
        const title = (node.querySelector("title")?.textContent || `node-${index}`).trim();
        node.dataset.nodeId = title;
        node.style.cursor = "pointer";
        styleTreeNode(node);
        nodeMap.set(title, node);
        childrenMap.set(title, []);
    });

    edgeElements.forEach((edge) => {
        const title = (edge.querySelector("title")?.textContent || "").trim();
        const parts = title.split("->");
        if (parts.length === 2) {
            const from = parts[0].trim();
            const to = parts[1].trim();
            edge.dataset.from = from;
            edge.dataset.to = to;
            if (childrenMap.has(from)) {
                childrenMap.get(from).push(to);
            }
        }

        edge.querySelectorAll("path").forEach((path) => {
            if (typeof path.getTotalLength === "function") {
                const length = path.getTotalLength();
                path.style.strokeDasharray = `${length}`;
                path.style.strokeDashoffset = `${length}`;
                path.style.setProperty("--path-length", String(length));
            }
        });
    });

    const clearHighlights = () => {
        nodeElements.forEach((node) => node.classList.remove("subtree-active"));
        edgeElements.forEach((edge) => edge.classList.remove("subtree-active"));
    };

    const collectSubtree = (rootId) => {
        const visited = new Set();
        const stack = [rootId];

        while (stack.length) {
            const current = stack.pop();
            if (!current || visited.has(current)) {
                continue;
            }
            visited.add(current);
            const children = childrenMap.get(current) || [];
            children.forEach((child) => stack.push(child));
        }

        return visited;
    };

    nodeElements.forEach((node) => {
        node.addEventListener("mouseenter", () => {
            const rootId = node.dataset.nodeId;
            if (!rootId) {
                return;
            }

            clearHighlights();
            const subtree = collectSubtree(rootId);
            subtree.forEach((id) => {
                nodeMap.get(id)?.classList.add("subtree-active");
            });

            edgeElements.forEach((edge) => {
                const from = edge.dataset.from;
                const to = edge.dataset.to;
                if (from && to && subtree.has(from) && subtree.has(to)) {
                    edge.classList.add("subtree-active");
                }
            });
        });

        node.addEventListener("mouseleave", clearHighlights);

        node.addEventListener("click", () => {
            const nodeLabel = (node.querySelector("text")?.textContent || "node").trim();
            setActiveTree(role, nodeLabel);
        });
    });
}

function buildEvaluationSteps(role, focusLabel = "") {
    const fallback = ["No precedence-driven evaluation steps available for this parse tree."];
    const baseSteps = role === "selected" ? currentTreeView.selectedSteps : currentTreeView.ignoredSteps;
    const steps = baseSteps.length ? baseSteps : fallback;
    return focusLabel ? [`Focused subtree: ${focusLabel}`, ...steps] : steps;
}

function renderEvaluationForRole(role = "selected", focusedNode = "") {
    const heading = role === "selected" ? "Precedence-Aware Evaluation" : "Wrong-Precedence Evaluation";
    const interpretedAs = role === "selected" ? currentTreeView.selectedInterpretation || "N/A" : currentTreeView.ignoredInterpretation || "N/A";
    const explanation =
        role === "selected"
            ? currentTreeView.explanation || "This is the selected interpretation after applying precedence and associativity."
            : "This parse ordering is intentionally ignored because it conflicts with precedence/associativity or parenthesized grouping.";

    const steps = buildEvaluationSteps(role, focusedNode)
        .map((step) => `<div class="timeline-step">${escapeHtml(step)}</div>`)
        .join("");

    evaluationEl.innerHTML = `
        <div class="card">
            <h3>${escapeHtml(heading)}</h3>
            <p><strong>Interpreted as:</strong> ${escapeHtml(interpretedAs)}</p>
            <p><strong>Explanation:</strong> ${escapeHtml(explanation)}</p>
            <div class="evaluation-timeline">${steps}</div>
        </div>
    `;
}

function setActiveTree(role, focusedNode = "") {
    activeTreeRole = role;

    parseTreesEl.querySelectorAll(".tree-card").forEach((card) => {
        card.classList.remove("active-tree");
    });

    const activeCard = parseTreesEl.querySelector(`.tree-card[data-role="${role}"]`);
    if (activeCard) {
        activeCard.classList.add("active-tree");
    }

    renderEvaluationForRole(role, focusedNode);
}

function normalizeTrees(parseTrees) {
    const trees = Array.isArray(parseTrees.trees) ? parseTrees.trees : [];
    const expression = expressionInput.value.trim();
    const precedenceRows = parsePrecedenceUserInput(precedenceInput.value);
    const expectedAst = buildExpectedTreeFromExpression(expression, precedenceRows);
    const expectedInfix = expectedAst ? toParenthesizedInfix(expectedAst) : "";
    const expectedNormalized = normalizeExprString(expectedInfix);

    let selectedTree = null;
    let ignoredTree = null;

    if (expectedNormalized) {
        selectedTree =
            trees.find((tree) => normalizeExprString(tree.interpreted) === expectedNormalized) ||
            trees.find((tree) => tree.role === "Selected Tree") ||
            null;
        ignoredTree = trees.find((tree) => tree !== selectedTree) || null;
    } else {
        selectedTree = trees.find((tree) => tree.role === "Selected Tree") || trees[0] || null;
        ignoredTree = trees.find((tree) => tree.role === "Ignored Tree") || trees.find((tree) => tree !== selectedTree) || null;
    }

    const uniqueInterpreted = new Set(trees.map((tree) => normalizeExprString(tree.interpreted)));
    const hasParentheses = /[()]/.test(expression);
    const deterministic = hasParentheses || uniqueInterpreted.size <= 1;

    if (deterministic) {
        ignoredTree = null;
    }

    const explanation = hasParentheses
        ? "Parentheses dominate precedence, so grouping is deterministic and only one parse tree is shown."
        : parseTrees.message || "";

    const selectedSteps = buildStepsFromAst(selectedTree?.ast);
    const ignoredSteps = ignoredTree ? buildStepsFromAst(ignoredTree.ast) : [];

    currentTreeView = {
        selectedTree,
        ignoredTree,
        deterministic,
        selectedInterpretation: selectedTree ? `${expression || "Expression"} -> ${selectedTree.interpreted}` : "",
        ignoredInterpretation: ignoredTree ? `${expression || "Expression"} -> ${ignoredTree.interpreted}` : "",
        selectedSteps,
        ignoredSteps,
        explanation,
    };

    return { selectedTree, ignoredTree, deterministic, explanation };
}

function renderSingleTreeCard({ title, roleBadge, roleClass, roleKey, tree, sideClass, fallbackMessage }) {
    if (!tree) {
        return `
            <article class="tree-card ${sideClass}" data-role="${roleKey}">
                <h3>${escapeHtml(title)}</h3>
                <p><span class="tree-role ${roleClass}">${escapeHtml(roleBadge)}</span></p>
                <div class="graphviz-tree-container">
                    <div class="graphviz-tree-svg"><p class="muted">${escapeHtml(fallbackMessage)}</p></div>
                </div>
            </article>
        `;
    }

    return `
        <article class="tree-card ${sideClass}" data-role="${roleKey}">
            <h3>${escapeHtml(title)}</h3>
            <p><span class="tree-role ${roleClass}">${escapeHtml(roleBadge)}</span></p>
            <div class="graphviz-tree-container">
                <div class="graphviz-tree-svg" data-svg-role="${roleKey}">${renderTreeSvgMarkup(
        tree.svg,
        tree.svgError || "Graphviz SVG unavailable"
    )}</div>
            </div>
        </article>
    `;
}

function renderParseTrees(parseTrees) {
    treeMessageEl.textContent = parseTrees.message || "";

    if (!parseTrees.canVisualize || !parseTrees.trees?.length) {
        parseTreesEl.innerHTML = `
            <article class="tree-card tree-card-left" data-role="ignored">
                <h3>❌ Ignored Tree (Wrong Precedence)</h3>
                <p><span class="tree-role ignored-tree">Ignored Tree</span></p>
                <div class="graphviz-tree-container"><div class="graphviz-tree-svg"><p class="muted">No ignored parse tree available.</p></div></div>
            </article>
            <article class="tree-card tree-card-right" data-role="selected">
                <h3>✅ Correct Tree (Follows Precedence)</h3>
                <p><span class="tree-role selected-tree">Correct Tree</span></p>
                <div class="graphviz-tree-container"><div class="graphviz-tree-svg"><p class="muted">No precedence-aware parse tree available.</p></div></div>
            </article>
        `;
        return;
    }

    const { selectedTree, ignoredTree, deterministic, explanation } = normalizeTrees(parseTrees);
    treeMessageEl.textContent = explanation || parseTrees.message || "";

    if (deterministic) {
        parseTreesEl.innerHTML = `
            <article class="tree-card tree-card-right active-tree" data-role="selected" style="grid-column: 1 / -1;">
                <h3>✅ Deterministic Tree</h3>
                <p><span class="tree-role selected-tree">Selected Tree</span></p>
                <div class="graphviz-tree-container">
                    <div class="graphviz-tree-svg" data-svg-role="selected">${renderTreeSvgMarkup(
                        selectedTree?.svg,
                        selectedTree?.svgError || "Deterministic parse tree not generated."
                    )}</div>
                </div>
            </article>
        `;
    } else {
        parseTreesEl.innerHTML = [
            renderSingleTreeCard({
                title: "❌ Ignored Tree (Wrong Precedence)",
                roleBadge: "Ignored Tree",
                roleClass: "ignored-tree",
                roleKey: "ignored",
                tree: ignoredTree,
                sideClass: "tree-card-left",
                fallbackMessage: "Ignored parse tree not generated.",
            }),
            renderSingleTreeCard({
                title: "✅ Correct Tree (Follows Precedence)",
                roleBadge: "Correct Tree",
                roleClass: "selected-tree",
                roleKey: "selected",
                tree: selectedTree,
                sideClass: "tree-card-right",
                fallbackMessage: "Correct parse tree not generated.",
            }),
        ].join("");
    }

    parseTreesEl.querySelectorAll(".tree-card").forEach((card) => {
        const role = card.dataset.role || "selected";
        card.addEventListener("click", () => {
            setActiveTree(role);
        });

        const svg = card.querySelector("svg");
        if (svg) {
            svg.classList.add("interactive-tree");
            installSubtreeInteractions(svg, role);
        }
    });

    setActiveTree("selected");
}

function clearOutput() {
    summaryEl.innerHTML = "";
    extractedEl.innerHTML = "";
    conflictsEl.innerHTML = "";
    suggestionsEl.innerHTML = "";
    autocorrectEl.textContent = "";
    treeMessageEl.textContent = "";
    parseTreesEl.innerHTML = "";
    evaluationEl.innerHTML = "";
    if (precedenceRulesEl) {
        precedenceRulesEl.innerHTML = "";
    }
    currentTreeView = {
        selectedTree: null,
        ignoredTree: null,
        deterministic: false,
        selectedInterpretation: "",
        ignoredInterpretation: "",
        selectedSteps: [],
        ignoredSteps: [],
        explanation: "",
    };
}

async function analyzeNow() {
    const localRequestId = ++requestCounter;
    statusText.textContent = "Analyzing...";

    const normalizedPrecedence = normalizePrecedenceForBackend(precedenceInput.value);
    syntheticPrecedenceTokens = normalizedPrecedence.syntheticTokens;

    const payload = {
        grammar: grammarInput.value,
        precedence: normalizedPrecedence.normalizedText,
        expression: expressionInput.value,
    };

    try {
        const response = await fetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        const rawData = await response.json();
        const data = sanitizeAnalysisData(rawData, syntheticPrecedenceTokens);
        if (localRequestId !== requestCounter) {
            return;
        }

        if (!response.ok) {
            clearOutput();
            conflictsEl.innerHTML = `<div class="card high"><h3>Input error</h3><p>${escapeHtml(data.error || "Unknown error")}</p></div>`;
            statusText.textContent = "Fix input errors";
            return;
        }

        clearOutput();
        renderSummary(data.summary);
        renderExtracted(data.extracted);
        renderConflicts(data.conflicts);
        renderSuggestions(data.suggestions);
        renderOperatorPrecedenceAnalysis(data.operatorPrecedenceAnalysis);
        autocorrectEl.textContent = data.autoCorrection.correctedGrammar || data.autoCorrection.message;
        latestAnalysis = data;
        renderParseTrees(data.parseTrees);

        if (data.summary.hasUnresolved) {
            statusText.textContent = "Unresolved conflicts exist";
        } else if (data.summary.hasStructuralConflicts) {
            statusText.textContent = "All structural conflicts are parser-resolved";
        } else {
            statusText.textContent = "No structural conflicts detected";
        }
    } catch (error) {
        clearOutput();
        conflictsEl.innerHTML = `<div class="card high"><h3>Request failed</h3><p>${escapeHtml(String(error))}</p></div>`;
        statusText.textContent = "Server error";
    }
}

function scheduleAnalyze() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(analyzeNow, 350);
}

function exportLatestJson() {
    if (!latestAnalysis) {
        statusText.textContent = "Run analysis before exporting";
        return;
    }

    const blob = new Blob([JSON.stringify(latestAnalysis, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
    anchor.href = href;
    anchor.download = `analysis-${timestamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(href);
    statusText.textContent = "Exported analysis JSON";
}

function wireSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
        anchor.addEventListener("click", (event) => {
            const href = anchor.getAttribute("href") || "";
            const target = document.querySelector(href);
            if (!target) {
                return;
            }
            event.preventDefault();
            target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    });
}

if (copyAutocorrectBtn) {
    copyAutocorrectBtn.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(autocorrectEl.textContent || "");
            const previous = copyAutocorrectBtn.textContent;
            copyAutocorrectBtn.textContent = "Copied";
            setTimeout(() => {
                copyAutocorrectBtn.textContent = previous;
            }, 900);
        } catch {
            copyAutocorrectBtn.textContent = "Copy failed";
        }
    });
}

if (precedenceToggle && precedencePanel) {
    precedenceToggle.addEventListener("change", () => {
        precedencePanel.classList.toggle("hidden", !precedenceToggle.checked);
    });
}

analyzeBtn.addEventListener("click", analyzeNow);
if (exportJsonBtn) {
    exportJsonBtn.addEventListener("click", exportLatestJson);
}
grammarInput.addEventListener("input", scheduleAnalyze);
precedenceInput.addEventListener("input", scheduleAnalyze);
expressionInput.addEventListener("input", scheduleAnalyze);

wireSmoothScroll();
statusText.textContent = "Ready for input";
