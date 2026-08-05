# Writes golden.json from cases.json with the Rust tokenizer and transformers' apply_chat_template, the same
# two calls vLLM makes. Run it by hand in a throwaway venv with transformers 4.57.1 and tokenizers 0.22.2:
# python gen-golden.py <this folder>
# Message and tool handling below mirrors vllm/renderers/chat_utils.py and online_renderer.py at v0.32.0.
import json
import os
import sys

from transformers import AutoTokenizer

here = sys.argv[1]
tok = AutoTokenizer.from_pretrained(here, local_files_only=True)
cases = json.load(open(os.path.join(here, "cases.json"), encoding="utf-8"))


def joined(parts):
    return "\n".join(part["text"] for part in parts)


def arguments(raw):
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw)
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def message(row):
    content = row.get("content")
    out = {"role": row["role"], "content": joined(content) if isinstance(content, list) else (content or "")}
    calls = row.get("tool_calls")
    if row["role"] == "assistant" and calls:
        out["tool_calls"] = [
            {
                "id": call["id"],
                "type": call.get("type", "function"),
                "function": {"name": call["function"]["name"], "arguments": arguments(call["function"].get("arguments"))},
            }
            for call in calls
        ]
    if row["role"] == "tool" and "tool_call_id" in row:
        out["tool_call_id"] = row["tool_call_id"]
    if isinstance(row.get("name"), str):
        out["name"] = row["name"]
    return out


def tool(row):
    fn = row["function"]
    out = {"name": fn["name"], "description": fn.get("description"), "parameters": fn.get("parameters")}
    if fn.get("strict") is not None:
        out["strict"] = fn["strict"]
    return {"type": "function", "function": out}


def render(rows, tools, generation=True):
    dumped = None if tools is None else [tool(row) for row in tools]
    return tok.apply_chat_template([message(row) for row in rows], tools=dumped, tokenize=False, add_generation_prompt=generation)


def ids(text, special=False):
    return tok(text, add_special_tokens=special).input_ids


chat = []
for case in cases["chat"]:
    rendered = render(case["messages"], case.get("tools"))
    chat.append({"name": case["name"], "rendered": rendered, "ids": ids(rendered)})

text = [{"text": row, "ids": ids(row), "idsWithSpecial": ids(row, True)} for row in cases["text"]]

turns = []
for case in cases["toolTurns"]:
    question = [{"role": "user", "content": "x"}]
    answer = {"role": "assistant", "content": case["text"], "tool_calls": case["toolCalls"]}
    prefix = render(question, None)
    full = render(question + [answer], None, False)
    assert full.startswith(prefix)
    turn = full[len(prefix):].rstrip()
    turns.append({"name": case["name"], "turn": turn, "ids": ids(turn)})

golden = {"chat": chat, "text": text, "toolTurns": turns}
with open(os.path.join(here, "golden.json"), "w", encoding="utf-8") as out:
    json.dump(golden, out, ensure_ascii=False, indent=1)
    out.write("\n")
print(len(chat), len(text), len(turns))
