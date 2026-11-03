"""Unit tests for JavaScript/TypeScript ast-grep search."""

from pathlib import Path

from yasa_mcp.tools.ast_grep.search.client import AstSearchClient
from yasa_mcp.tools.ast_grep.util.realtime_common import LANGUAGE_EXTENSIONS


def test_javascript_search_registered():
    client = AstSearchClient()

    assert "javascript" in client.supported_languages


def test_extract_javascript_functions_and_skip_anonymous_callbacks(tmp_path: Path):
    project = tmp_path
    source = project / "app" / "common" / "sample.js"
    source.parent.mkdir(parents=True)
    source.write_text(
        """
function plain(a) {
  return a;
}

const arrow = value => value + 1;
const expr = function (name) {
  return name;
};

[1, 2, 3].map(item => item + 1);

class Animal {
  constructor(kind) {
    this.kind = kind;
  }
  speak(words) {
    return words;
  }
}
""".strip(),
        encoding="utf-8",
    )

    funcs = AstSearchClient().extract_function_defs("javascript", source, project)
    by_name = {func.name: func for func in funcs}

    assert {"plain", "arrow", "expr", "constructor", "speak"}.issubset(by_name)
    assert "item" not in by_name
    assert by_name["plain"].fqn == "app.common.sample.plain"
    assert by_name["arrow"].signature == "arrow(value)"
    assert by_name["expr"].signature == "expr(name)"
    assert by_name["constructor"].fqn == "app.common.sample.Animal.constructor"
    assert by_name["speak"].signature == "speak(words)"


def test_extract_typescript_functions_classes_and_overload(tmp_path: Path):
    project = tmp_path
    source = project / "app" / "common" / "reload.ts"
    source.parent.mkdir(parents=True)
    source.write_text(
        """
interface Greeter {
  greet(name: string): string;
}

class XYImpl implements Greeter {
  say(param:string):string{
    return param;
  }
  constructor(q:number,w:string,r:string) {
    this.q=q;
  }
}

function add_cc(param1: string, param2: string): string;
function add_cc(param1: number, param2: number): number;
function add_cc(param1: string|number,param2: string|number){
  return param1.toString()+param2.toString();
}
""".strip(),
        encoding="utf-8",
    )

    client = AstSearchClient()
    add_funcs = client.find_functions_by_name("javascript", source, "add_cc", project)
    assert len(add_funcs) == 1
    assert add_funcs[0].fqn == "app.common.reload.add_cc"
    assert add_funcs[0].signature == "add_cc(param1: string|number, param2: string|number)"

    classes = client.find_all_classes_by_name("javascript", source, "XYImpl", project)
    assert len(classes) == 1
    cls = classes[0]
    assert cls.fqn == "app.common.reload.XYImpl"
    assert cls.interface_names == ["Greeter"]
    assert [(m.name, m.signature) for m in cls.methods] == [
        ("say", "say(param: string)"),
        ("constructor", "constructor(q: number, w: string, r: string)"),
    ]


def test_javascript_realtime_extensions_exclude_jsx_tsx():
    assert LANGUAGE_EXTENSIONS["javascript"] == (".js", ".ts")
    assert ".jsx" not in LANGUAGE_EXTENSIONS["javascript"]
    assert ".tsx" not in LANGUAGE_EXTENSIONS["javascript"]
