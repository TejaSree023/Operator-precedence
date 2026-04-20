# Operator Precedence Conflict Detector

A Flask full-stack web app that analyzes context-free grammars, detects ambiguity and precedence/associativity conflicts, and visualizes parse trees.

## Live Demo

https://operator-precedence-1.onrender.com

## Features

- Grammar input via production rules (`E -> E + E | E * E | id`)
- Separate precedence declarations (`%left`, `%right`, `%nonassoc`)
- Automatic extraction of operators and operands
- Conflict detection:
  - Structural ambiguity (`A -> A op A`)
  - Missing/partial precedence
  - Associativity issues
- Clear conflict explanations with severity and resolved/unresolved status
- Fix suggestions:
  - Precedence declarations
  - Grammar rewrite into layered unambiguous form
- Auto-corrected grammar output
- Parse tree visualization (Graphviz SVG)
- Live analysis while typing

## Run

```bash
pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5000`.
