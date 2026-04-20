import os

from flask import Flask, jsonify, render_template, request

from analyzer import GrammarAnalyzer

app = Flask(__name__)
analyzer = GrammarAnalyzer()


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/analyze")
def analyze_grammar():
    payload = request.get_json(silent=True) or {}
    grammar_text = payload.get("grammar", "")
    precedence_text = payload.get("precedence", "")
    expression = payload.get("expression", "")

    if not grammar_text.strip():
        return jsonify({"error": "Grammar input is required."}), 400

    try:
        result = analyzer.analyze(
            grammar_text=grammar_text,
            precedence_text=precedence_text,
            expression=expression,
        )
        return jsonify(result)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
