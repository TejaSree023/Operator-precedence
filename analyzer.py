import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

TOKEN_PATTERN = re.compile(r"%\w+|->|\||[A-Za-z_][A-Za-z0-9_]*|\S")
EXPR_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+|==|!=|<=|>=|\|\||&&|\S")


@dataclass
class Production:
    lhs: str
    alternatives: List[List[str]]


class GrammarAnalyzer:
    def analyze(self, grammar_text: str, precedence_text: str = "", expression: str = "") -> Dict:
        inline_precedence, productions = self._parse_grammar(grammar_text)
        explicit_precedence = self._parse_precedence_block(precedence_text)
        precedence_table = explicit_precedence if explicit_precedence else inline_precedence

        self._validate_precedence(precedence_table)

        nonterminals = {p.lhs for p in productions}
        terminals = self._collect_terminals(productions, nonterminals)
        operators, operands = self._extract_operators_operands(terminals)

        precedence_map = self._precedence_lookup(precedence_table)
        conflicts, ambiguous_patterns = self._detect_conflicts(productions, operators, precedence_map)

        suggestions = self._build_suggestions(operators, precedence_table, ambiguous_patterns)
        auto_correction = self._auto_correct_grammar(operators, precedence_table, bool(ambiguous_patterns))
        parse_trees = self._generate_parse_trees(expression, precedence_map)

        structural_count = len([c for c in conflicts if c["type"] == "ambiguous-pattern"])
        resolved_count = len([c for c in conflicts if c["status"] == "resolved"])
        unresolved_count = len([c for c in conflicts if c["status"] == "unresolved"])

        return {
            "summary": {
                "productionCount": len(productions),
                "operatorCount": len(operators),
                "operandCount": len(operands),
                "conflictCount": len(conflicts),
                "structuralConflicts": structural_count,
                "resolvedConflicts": resolved_count,
                "unresolvedConflicts": unresolved_count,
                "hasStructuralConflicts": structural_count > 0,
                "hasUnresolved": unresolved_count > 0,
                "status": "All conflicts resolved" if unresolved_count == 0 else "Unresolved conflicts exist",
            },
            "extracted": {
                "operators": sorted(operators),
                "operands": sorted(operands),
                "precedenceTable": self._flatten_precedence_table(precedence_table),
            },
            "conflicts": conflicts,
            "suggestions": suggestions,
            "autoCorrection": auto_correction,
            "parseTrees": parse_trees,
            "evaluation": parse_trees.get("evaluation", {}),
        }

    def _tokenize(self, text: str) -> List[str]:
        return TOKEN_PATTERN.findall(text)

    def _parse_grammar(self, grammar_text: str) -> Tuple[List[Dict], List[Production]]:
        precedence_rows = []
        productions = []

        for raw_line in grammar_text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("//") or line.startswith("#"):
                continue

            if line.startswith("%"):
                precedence_rows.extend(self._parse_precedence_line(line))
                continue

            if "->" not in line:
                raise ValueError(f"Invalid production '{line}'. Use A -> alpha | beta.")

            lhs_raw, rhs_raw = line.split("->", 1)
            lhs = lhs_raw.strip()
            if not lhs:
                raise ValueError(f"Missing LHS in line: {line}")

            alternatives = []
            for alt in rhs_raw.split("|"):
                tokens = self._tokenize(alt.strip())
                if not tokens:
                    raise ValueError(f"Empty production alternative in line: {line}")
                alternatives.append(tokens)

            productions.append(Production(lhs=lhs, alternatives=alternatives))

        if not productions:
            raise ValueError("No production rules found.")

        return precedence_rows, productions

    def _parse_precedence_block(self, precedence_text: str) -> List[Dict]:
        rows = []
        for raw_line in precedence_text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("//") or line.startswith("#"):
                continue
            rows.extend(self._parse_precedence_line(line))
        return rows

    def _parse_precedence_line(self, line: str) -> List[Dict]:
        tokens = self._tokenize(line)
        if len(tokens) < 3:
            raise ValueError(f"Invalid precedence declaration: {line}")

        assoc_token = tokens[0]
        if not assoc_token.startswith("%"):
            raise ValueError(f"Invalid precedence declaration: {line}")

        assoc = assoc_token[1:]
        if assoc not in {"left", "right", "nonassoc"}:
            raise ValueError(f"Unsupported declaration '{assoc_token}'. Use %left, %right, or %nonassoc.")

        return [{"assoc": assoc, "operators": tokens[1:]}]

    def _validate_precedence(self, precedence_table: List[Dict]) -> None:
        seen = {}
        for idx, row in enumerate(precedence_table):
            for op in row["operators"]:
                if op in seen:
                    previous = seen[op]
                    raise ValueError(
                        f"Operator '{op}' appears multiple times "
                        f"(level {previous['level'] + 1} and level {idx + 1})."
                    )
                seen[op] = {"level": idx, "assoc": row["assoc"]}

    def _collect_terminals(self, productions: List[Production], nonterminals: Set[str]) -> Set[str]:
        terminals = set()
        for prod in productions:
            for alt in prod.alternatives:
                for token in alt:
                    if token not in nonterminals and token != "epsilon":
                        terminals.add(token)
        return terminals

    def _extract_operators_operands(self, terminals: Set[str]) -> Tuple[Set[str], Set[str]]:
        operators = set()
        operands = set()
        for token in terminals:
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token):
                operands.add(token)
            elif token in {"(", ")", "[", "]", "{", "}", ",", ";"}:
                continue
            else:
                operators.add(token)
        return operators, operands

    def _detect_conflicts(
        self,
        productions: List[Production],
        operators: Set[str],
        precedence_map: Dict[str, Dict],
    ) -> Tuple[List[Dict], List[Dict]]:
        conflicts = []
        ambiguous = self._find_ambiguous_binary_patterns(productions)

        for item in ambiguous:
            op = item["operator"]
            resolved = op in precedence_map and precedence_map[op]["assoc"] in {"left", "right"}
            conflicts.append(
                {
                    "type": "ambiguous-pattern",
                    "displayType": "Structural Ambiguity",
                    "severity": "medium",
                    "status": "resolved" if resolved else "unresolved",
                    "classification": "Resolved Conflict" if resolved else "Structural Conflict",
                    "message": f"Ambiguous recursion found: {item['pattern']}",
                    "production": item["pattern"],
                    "details": (
                        "A -> A op A can build multiple parse trees. "
                        + (
                            f"Parser declarations for '{op}' resolve grouping."
                            if resolved
                            else f"No usable precedence/associativity declaration found for '{op}'."
                        )
                    ),
                }
            )

        ambiguous_ops = sorted({item["operator"] for item in ambiguous})
        missing = [op for op in ambiguous_ops if op not in precedence_map]
        if missing:
            conflicts.append(
                {
                    "type": "precedence-conflict",
                    "displayType": "Precedence Conflict",
                    "severity": "high",
                    "status": "unresolved",
                    "classification": "Unresolved Conflict",
                    "message": "Missing precedence declarations.",
                    "details": f"No precedence declared for: {', '.join(missing)}.",
                }
            )

        if operators and precedence_map:
            undeclared = sorted([op for op in operators if op not in precedence_map])
            if undeclared:
                conflicts.append(
                    {
                        "type": "precedence-conflict",
                        "displayType": "Precedence Conflict",
                        "severity": "medium",
                        "status": "unresolved",
                        "classification": "Unresolved Conflict",
                        "message": "Partial precedence table detected.",
                        "details": f"Operators without declarations: {', '.join(undeclared)}.",
                    }
                )

        for item in ambiguous:
            op = item["operator"]
            if op not in precedence_map:
                conflicts.append(
                    {
                        "type": "associativity-conflict",
                        "displayType": "Associativity Conflict",
                        "severity": "high",
                        "status": "unresolved",
                        "classification": "Unresolved Conflict",
                        "message": f"Associativity for '{op}' is missing.",
                        "production": item["pattern"],
                        "details": "Add %left or %right for deterministic grouping.",
                    }
                )
            elif precedence_map[op]["assoc"] == "nonassoc":
                conflicts.append(
                    {
                        "type": "associativity-conflict",
                        "displayType": "Associativity Conflict",
                        "severity": "medium",
                        "status": "unresolved",
                        "classification": "Unresolved Conflict",
                        "message": f"Operator '{op}' is %nonassoc in recursive grammar.",
                        "production": item["pattern"],
                        "details": "Chained expressions may be rejected.",
                    }
                )
            else:
                conflicts.append(
                    {
                        "type": "associativity-conflict",
                        "displayType": "Associativity Conflict",
                        "severity": "low",
                        "status": "resolved",
                        "classification": "Resolved Conflict",
                        "message": f"Associativity for '{op}' is defined as %{precedence_map[op]['assoc']}.",
                        "production": item["pattern"],
                        "details": "Parser can resolve left/right grouping.",
                    }
                )

        return conflicts, ambiguous

    def _find_ambiguous_binary_patterns(self, productions: List[Production]) -> List[Dict]:
        findings = []
        for prod in productions:
            for alt in prod.alternatives:
                if len(alt) == 3 and alt[0] == prod.lhs and alt[2] == prod.lhs:
                    findings.append(
                        {
                            "lhs": prod.lhs,
                            "operator": alt[1],
                            "pattern": f"{prod.lhs} -> {prod.lhs} {alt[1]} {prod.lhs}",
                        }
                    )
        return findings

    def _build_suggestions(self, operators: Set[str], precedence_table: List[Dict], ambiguous: List[Dict]) -> List[Dict]:
        suggestions = []
        precedence_map = self._precedence_lookup(precedence_table)
        ambiguous_ops = sorted({item["operator"] for item in ambiguous})
        missing = [op for op in ambiguous_ops if op not in precedence_map]

        if missing:
            guessed = self._guess_precedence_order(set(missing))
            lines = [f"%left {' '.join(group)}" for group in guessed if group]
            if not lines:
                lines = [f"%left {' '.join(missing)}"]
            suggestions.append(
                {
                    "title": "Parser Fix: Define operator precedence",
                    "detail": "Add YACC/Bison precedence declarations for unresolved operators.",
                    "example": "\n".join(lines),
                }
            )

        if ambiguous:
            levels = [row["operators"] for row in precedence_table] if precedence_table else self._guess_precedence_order(operators)
            levels = [group for group in levels if group]
            if not levels:
                levels = [["+", "-"], ["*", "/"]]
            suggestions.append(
                {
                    "title": "Grammar Fix: Rewrite into unambiguous layers",
                    "detail": "Split expression levels by precedence to remove structural ambiguity.",
                    "example": "\n".join(self._generate_unambiguous_expression_grammar(levels)),
                }
            )

        return suggestions

    def _auto_correct_grammar(self, operators: Set[str], precedence_table: List[Dict], has_ambiguous: bool) -> Dict:
        if not has_ambiguous:
            return {
                "applied": False,
                "message": "No direct A -> A op A pattern detected. Auto-correction skipped.",
                "correctedGrammar": "",
            }

        levels = [row["operators"] for row in precedence_table] if precedence_table else self._guess_precedence_order(operators)
        levels = [group for group in levels if group]
        if not levels:
            levels = [["+", "-"], ["*", "/"]]

        corrected = self._generate_unambiguous_expression_grammar(levels)
        return {
            "applied": True,
            "message": "Generated layered grammar based on precedence levels.",
            "correctedGrammar": "\n".join(corrected),
        }

    def _generate_unambiguous_expression_grammar(self, levels: List[List[str]]) -> List[str]:
        symbols = ["Expr", "Term", "Factor", "Atom", "Primary", "Value"]
        while len(symbols) < len(levels) + 1:
            symbols.append(f"Level{len(symbols)}")

        lines = []
        for idx, ops in enumerate(levels):
            lhs = symbols[idx]
            rhs = symbols[idx + 1]
            alternatives = " | ".join([f"{lhs} {op} {rhs}" for op in ops])
            lines.append(f"{lhs} -> {alternatives} | {rhs}")
        lines.append(f"{symbols[len(levels)]} -> ( Expr ) | id")
        return lines

    def _generate_parse_trees(self, expression: str, precedence_map: Dict[str, Dict]) -> Dict:
        expression = expression.strip()
        if not expression:
            return {
                "canVisualize": False,
                "message": "Enter an expression to generate parse trees.",
                "trees": [],
                "evaluation": {
                    "interpretedAs": "",
                    "selectedTree": "",
                    "ignoredTree": "",
                    "explanation": "",
                    "steps": [],
                },
            }

        tokens = self._tokenize_expression(expression)
        if len(tokens) < 3:
            return {
                "canVisualize": False,
                "message": "Use an infix expression with at least one operator (example: id + id * id).",
                "trees": [],
                "evaluation": {
                    "interpretedAs": "",
                    "selectedTree": "",
                    "ignoredTree": "",
                    "explanation": "",
                    "steps": [],
                },
            }

        operator_count = len([token for token in tokens if self._is_operator_token(token)])
        complete_precedence = operator_count > 0 and all(token in precedence_map for token in tokens if self._is_operator_token(token))

        if len(tokens) == 3 and operator_count == 1:
            selected_tree_ast = self._build_expression_parse_tree(tokens, precedence_map, mode="precedence")
            selected_label = self._tree_to_infix(selected_tree_ast)
            selected_tree = {
                "id": "selected",
                "title": "Selected Tree",
                "interpreted": selected_label,
                "role": "Selected Tree",
                "ast": selected_tree_ast,
            }
            svg, svg_error = self._render_graphviz_svg(selected_tree_ast, "Selected Tree")
            selected_tree["svg"] = svg
            selected_tree["svgError"] = svg_error
            trees = [selected_tree]
            explanation = "Single-operator expression rendered as one parse tree."
            interpreted = selected_label
            steps = self._build_evaluation_steps_from_tree(selected_tree_ast)
            ignored_title = ""
        else:
            left_tree_ast = self._build_expression_parse_tree(tokens, precedence_map, mode="left")
            right_tree_ast = self._build_expression_parse_tree(tokens, precedence_map, mode="right")

            if complete_precedence:
                precedence_tree_ast = self._build_expression_parse_tree(tokens, precedence_map, mode="precedence")
                precedence_infix = self._tree_to_infix(precedence_tree_ast)
                left_infix = self._tree_to_infix(left_tree_ast)
                right_infix = self._tree_to_infix(right_tree_ast)

                if precedence_infix == left_infix and precedence_infix != right_infix:
                    selected_tree_ast, ignored_tree_ast = left_tree_ast, right_tree_ast
                elif precedence_infix == right_infix and precedence_infix != left_infix:
                    selected_tree_ast, ignored_tree_ast = right_tree_ast, left_tree_ast
                else:
                    selected_tree_ast, ignored_tree_ast = precedence_tree_ast, right_tree_ast
            else:
                selected_tree_ast, ignored_tree_ast = left_tree_ast, right_tree_ast

            selected_label = self._tree_to_infix(selected_tree_ast)
            ignored_label = self._tree_to_infix(ignored_tree_ast)

            selected_tree = {
                "id": "selected",
                "title": "Selected Tree",
                "interpreted": selected_label,
                "role": "Selected Tree" if complete_precedence else "Ambiguous Candidate",
                "ast": selected_tree_ast,
            }
            ignored_tree = {
                "id": "ignored",
                "title": "Ignored Tree",
                "interpreted": ignored_label,
                "role": "Ignored Tree" if complete_precedence else "Ambiguous Candidate",
                "ast": ignored_tree_ast,
            }

            selected_svg, selected_svg_error = self._render_graphviz_svg(selected_tree_ast, "Selected Tree")
            ignored_svg, ignored_svg_error = self._render_graphviz_svg(ignored_tree_ast, "Ignored Tree")
            selected_tree["svg"] = selected_svg
            selected_tree["svgError"] = selected_svg_error
            ignored_tree["svg"] = ignored_svg
            ignored_tree["svgError"] = ignored_svg_error
            trees = [ignored_tree, selected_tree]

            if complete_precedence:
                explanation = self._build_precedence_explanation(tokens, precedence_map, selected_tree_ast)
                interpreted = selected_label
            else:
                explanation = "No precedence declarations were provided, so the trees show left-associative and right-associative candidates."
                interpreted = f"Ambiguous: {selected_label} OR {ignored_label}"

            steps = self._build_evaluation_steps_from_tree(selected_tree_ast)
            ignored_title = ignored_tree["title"]

        if len(tokens) == 3 and operator_count == 1:
            trees = [selected_tree]
            ignored_title = ""

        return {
            "canVisualize": True,
            "message": explanation,
            "trees": trees,
            "evaluation": {
                "interpretedAs": f"{expression} -> {interpreted}",
                "selectedTree": "Selected Tree",
                "ignoredTree": ignored_title,
                "explanation": explanation,
                "steps": steps,
            },
        }

    def _render_graphviz_svg(self, tree: Dict, graph_name: str) -> Tuple[str, Optional[str]]:
        try:
            return self._render_tree_svg(tree, graph_name), None
        except Exception as exc:
            return "", f"Tree rendering failed: {exc}"

    def _render_tree_svg(self, tree: Dict, graph_name: str) -> str:
        operator_symbols = {"+", "-", "*", "/", "%", "^", "&&", "||", "==", "!=", "<", ">", "<=", ">="}
        node_width = 76
        leaf_width = 58
        node_height = 36
        vertical_gap = 72
        horizontal_gap = 28
        margin_x = 28
        margin_y = 44

        nodes = []
        edges = []
        depths = {}

        def collect(node: Dict, depth: int = 0, parent: Optional[int] = None) -> int:
            index = len(nodes)
            label = node["label"]
            children = node.get("children", [])
            nodes.append({"label": label, "children": [], "depth": depth, "parent": parent})
            depths[index] = depth
            if parent is not None:
                edges.append((parent, index))
                nodes[parent]["children"].append(index)
            for child in children:
                collect(child, depth + 1, index)
            return index

        collect(tree)

        leaf_positions = {}
        next_x = 0

        def assign_x(index: int) -> float:
            nonlocal next_x
            child_ids = nodes[index]["children"]
            if not child_ids:
                x = next_x
                next_x += 1
                leaf_positions[index] = x
                return x
            child_xs = [assign_x(child_id) for child_id in child_ids]
            x = sum(child_xs) / len(child_xs)
            leaf_positions[index] = x
            return x

        assign_x(0)

        max_depth = max(depths.values()) if depths else 0
        max_x = max(leaf_positions.values()) if leaf_positions else 0
        canvas_width = max(420, int((max_x + 1) * (node_width + horizontal_gap) + margin_x * 2))
        canvas_height = max(280, int((max_depth + 1) * vertical_gap + margin_y * 2))

        def node_style(label: str) -> Tuple[str, str, str, str]:
            if label in operator_symbols:
                return "circle", "#d98c3f", "#b5732f", "#ffffff"
            if label in {"E", "Expr", "Term", "Factor", "Primary", "Atom", "Value"}:
                return "roundrect", "#f4ddbb", "#d5a86e", "#5a3e2b"
            return "roundrect", "#efefef", "#bdbdbd", "#5a3e2b"

        def node_center(index: int) -> Tuple[float, float]:
            x_slot = leaf_positions[index]
            y_slot = depths[index]
            return margin_x + x_slot * (node_width + horizontal_gap) + node_width / 2, margin_y + y_slot * vertical_gap + node_height / 2

        svg_parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{canvas_width}" height="{canvas_height}" viewBox="0 0 {canvas_width} {canvas_height}" role="img" aria-label="{graph_name}">',
            '<defs>',
            '<marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="strokeWidth">',
            '<polygon points="0 0, 10 3.5, 0 7" fill="#ad8450" />',
            '</marker>',
            '</defs>',
            '<rect x="0" y="0" width="100%" height="100%" fill="#fffdf8" rx="18" ry="18" />',
        ]

        for parent, child in edges:
            x1, y1 = node_center(parent)
            x2, y2 = node_center(child)
            start_y = y1 + node_height / 2
            end_y = y2 - node_height / 2
            mid_y = (start_y + end_y) / 2
            path = f"M {x1:.1f} {start_y:.1f} C {x1:.1f} {mid_y:.1f}, {x2:.1f} {mid_y:.1f}, {x2:.1f} {end_y:.1f}"
            svg_parts.append(
                f'<path d="{path}" fill="none" stroke="#ad8450" stroke-width="2" marker-end="url(#arrowhead)" opacity="0.92" />'
            )

        for index, node in enumerate(nodes):
            label = node["label"]
            shape, fill, stroke, text_fill = node_style(label)
            x, y = node_center(index)
            box_width = leaf_width if label not in {"E", "Expr", "Term", "Factor", "Primary", "Atom", "Value"} and label not in operator_symbols else node_width
            box_height = node_height
            if shape == "circle":
                radius = max(box_width, box_height) / 2
                svg_parts.append(
                    f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="1.5" />'
                )
            else:
                rx = 12 if label in {"E", "Expr", "Term", "Factor", "Primary", "Atom", "Value"} else 8
                svg_parts.append(
                    f'<rect x="{x - box_width / 2:.1f}" y="{y - box_height / 2:.1f}" width="{box_width:.1f}" height="{box_height:.1f}" rx="{rx}" ry="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.4" />'
                )
            svg_parts.append(
                f'<text x="{x:.1f}" y="{y + 4:.1f}" text-anchor="middle" font-family="Manrope, Arial, sans-serif" font-size="14" font-weight="700" fill="{text_fill}">{label}</text>'
            )

        svg_parts.append('</svg>')
        return "".join(svg_parts)

    def _tokenize_expression(self, expression: str) -> List[str]:
        return EXPR_PATTERN.findall(expression)

    def _is_operator_token(self, token: str) -> bool:
        return token not in {"(", ")", "[", "]", "{", "}", ",", ";"} and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token) and not re.fullmatch(r"\d+", token)

    def _strip_outer_parentheses(self, tokens: List[str]) -> List[str]:
        while len(tokens) >= 2 and tokens[0] == "(" and tokens[-1] == ")":
            depth = 0
            wraps_all = True
            for idx, token in enumerate(tokens):
                if token == "(":
                    depth += 1
                elif token == ")":
                    depth -= 1
                    if depth == 0 and idx < len(tokens) - 1:
                        wraps_all = False
                        break
            if wraps_all:
                tokens = tokens[1:-1]
            else:
                break
        return tokens

    def _choose_split_index(self, tokens: List[str], precedence_map: Dict[str, Dict], mode: str) -> Optional[int]:
        depth = 0
        candidates = []
        for idx, token in enumerate(tokens):
            if token == "(":
                depth += 1
            elif token == ")":
                depth -= 1
            elif depth == 0 and self._is_operator_token(token):
                candidates.append(idx)

        if not candidates:
            return None

        if mode == "left":
            return candidates[0]
        if mode == "right":
            return candidates[-1]

        best_level = None
        for idx in candidates:
            token = tokens[idx]
            level = precedence_map.get(token, {"level": 10**6})["level"]
            if best_level is None or level < best_level:
                best_level = level

        best_candidates = [idx for idx in candidates if precedence_map.get(tokens[idx], {"level": 10**6})["level"] == best_level]
        if len(best_candidates) == 1:
            return best_candidates[0]

        assoc = precedence_map.get(tokens[best_candidates[0]], {"assoc": "left"})["assoc"]
        return best_candidates[-1] if assoc == "right" else best_candidates[0]

    def _build_expression_parse_tree(self, tokens: List[str], precedence_map: Dict[str, Dict], mode: str = "precedence") -> Dict:
        tokens = self._strip_outer_parentheses(list(tokens))
        if len(tokens) == 1:
            return {"label": tokens[0], "children": []}

        split_index = self._choose_split_index(tokens, precedence_map, mode)
        if split_index is None or split_index <= 0 or split_index >= len(tokens) - 1:
            raise ValueError("Unable to build parse tree from the provided expression.")

        left_tokens = tokens[:split_index]
        operator = tokens[split_index]
        right_tokens = tokens[split_index + 1 :]

        return {
            "label": "E",
            "children": [
                self._build_expression_parse_tree(left_tokens, precedence_map, mode),
                {"label": operator, "children": []},
                self._build_expression_parse_tree(right_tokens, precedence_map, mode),
            ],
        }

    def _tree_to_infix(self, node: Dict) -> str:
        children = node.get("children", [])
        if not children:
            return node["label"]
        if len(children) == 3:
            left = self._tree_to_infix(children[0])
            operator = children[1]["label"]
            right = self._tree_to_infix(children[2])
            return f"({left} {operator} {right})"
        return node["label"]

    def _build_evaluation_steps_from_tree(self, tree: Dict) -> List[str]:
        operations = []

        def walk(node: Dict) -> str:
            children = node.get("children", [])
            if not children:
                return node["label"]
            if len(children) == 3:
                left = walk(children[0])
                operator = children[1]["label"]
                right = walk(children[2])
                expression = f"{left} {operator} {right}"
                if operator in {"+", "-", "*", "/", "%", "^", "&&", "||", "==", "!=", "<", ">", "<=", ">="}:
                    operations.append(expression)
                return expression
            return node["label"]

        final_expression = walk(tree)
        if not operations:
            return []

        steps = []
        for idx, expression in enumerate(operations):
            shown = expression
            for previous in operations[:idx]:
                shown = shown.replace(previous, "result", 1)
            steps.append(f"Step {idx + 1}: {shown}")

        if len(operations) > 1:
            final_shown = final_expression
            for previous in operations[:-1]:
                final_shown = final_shown.replace(previous, "result", 1)
            steps[-1] = f"Step {len(operations)}: {final_shown}"

        return steps

    def _build_precedence_explanation(self, tokens: List[str], precedence_map: Dict[str, Dict], tree: Dict) -> str:
        operators = [token for token in tokens if self._is_operator_token(token)]
        if not operators:
            return "No operators found to evaluate precedence."

        known = [operator for operator in operators if operator in precedence_map]
        if not known:
            return "No precedence declarations were provided, so the tree is interpreted using structural grouping."

        if len(known) == 1:
            op = known[0]
            return f"'{op}' determines the grouping because it is the only declared operator in the expression."

        highest = max(known, key=lambda op: precedence_map[op]["level"])
        lowest = min(known, key=lambda op: precedence_map[op]["level"])
        if highest != lowest:
            return f"'{highest}' has higher precedence than '{lowest}', so it is evaluated first."

        selected_root = tree["children"][1]["label"] if tree.get("children") and len(tree["children"]) == 3 else ""
        if selected_root in precedence_map:
            assoc = precedence_map[selected_root]["assoc"]
            return f"Operators share the same precedence level, so %{assoc} associativity selects the grouping."

        return "The tree is grouped by the available precedence declarations."

    def _flatten_precedence_table(self, precedence_table: List[Dict]) -> List[Dict]:
        rows = []
        for idx, row in enumerate(precedence_table):
            for op in row["operators"]:
                rows.append({"operator": op, "level": idx + 1, "assoc": row["assoc"]})
        return rows

    def _precedence_lookup(self, precedence_table: List[Dict]) -> Dict[str, Dict]:
        mapping = {}
        for idx, row in enumerate(precedence_table):
            for op in row["operators"]:
                mapping[op] = {"level": idx, "assoc": row["assoc"]}
        return mapping

    def _guess_precedence_order(self, operators: Set[str]) -> List[List[str]]:
        canonical = [
            ["||"],
            ["&&"],
            ["==", "!="],
            ["<", ">", "<=", ">="],
            ["+", "-"],
            ["*", "/", "%"],
            ["^"],
        ]
        remaining = set(operators)
        ordered = []
        for group in canonical:
            present = [op for op in group if op in remaining]
            if present:
                ordered.append(present)
                remaining -= set(present)
        if remaining:
            ordered.append(sorted(remaining))
        return ordered
