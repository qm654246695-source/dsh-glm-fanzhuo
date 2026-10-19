#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
GLM 本地版的 OpenAI 兼容小服务（她自己的 9B，住 H: 盘）。

  python local_glm_server.py                     # 默认 127.0.0.1:11434
  python local_glm_server.py --max-new 512 --port 11434
  python local_glm_server.py --load-only          # 只加载，验显存

端点：
  GET  /v1/models   /health
  POST /v1/chat/completions   text + image_url(data:URL) + tools

说明：
- GLM 的 chat template 用「文本 XML」表示工具调用（<tool_call>name<arg_key>..），
  这里把它解析回 OpenAI 的 tool_calls，glm-chat.mjs 才能直接用。
- 思考默认开着（模板里的 <think></think>），可用 body.enable_thinking=false 关掉。
- 显存不够时 device_map=auto 会把部分层放内存；速度会掉。
"""
import argparse
import base64
import io
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoProcessor, Glm4vForConditionalGeneration

MODEL_DIR = r"H:\GLM\models\glm46v-flash-official"
MODEL_NAME = "glm-local"

STATE = {"model": None, "processor": None, "max_new": 512, "device": None}

TOOL_CALL_RE = re.compile(r"<tool_call>\s*([\w.\-]+)(.*?)</tool_call>", re.S)
ARG_RE = re.compile(r"<arg_key>\s*(.*?)\s*</arg_key>\s*<arg_value>\s*(.*?)\s*</arg_value>", re.S)


def load(model_dir, max_new, quant="none"):
    t0 = time.time()
    print(f"[load] {model_dir} quant={quant}", flush=True)
    processor = AutoProcessor.from_pretrained(model_dir)
    kwargs = dict(
        dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
        attn_implementation="sdpa",
    )
    if quant == "hqq4":
        # 16 GB 显存放不下 19.2 GB 的 bf16，4-bit 量化后约 5-6 GB，全部进显存
        from transformers import HqqConfig
        kwargs["quantization_config"] = HqqConfig(nbits=4, group_size=64)
        kwargs["device_map"] = "cuda:0"
    elif quant == "hqq8":
        from transformers import HqqConfig
        kwargs["quantization_config"] = HqqConfig(nbits=8, group_size=64)
        kwargs["device_map"] = "cuda:0"
    elif quant in ("bnb4", "bnb8"):
        from transformers import BitsAndBytesConfig
        if quant == "bnb4":
            kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_use_double_quant=True,
            )
        else:
            kwargs["quantization_config"] = BitsAndBytesConfig(load_in_8bit=True)
        kwargs["device_map"] = "cuda:0"
    else:
        kwargs["device_map"] = "auto"
    model = Glm4vForConditionalGeneration.from_pretrained(model_dir, **kwargs)
    model.eval()
    STATE.update(model=model, processor=processor, max_new=max_new)
    try:
        STATE["device"] = str(next(model.parameters()).device)
    except Exception:
        STATE["device"] = "?"
    print(f"[load] done in {time.time()-t0:.1f}s device={STATE['device']}", flush=True)
    if torch.cuda.is_available():
        print(f"[load] vram allocated {torch.cuda.memory_allocated()/2**30:.1f} GiB "
              f"reserved {torch.cuda.memory_reserved()/2**30:.1f} GiB", flush=True)


def img_from_data_url(url):
    from PIL import Image
    b64 = url.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def to_messages(body):
    """OpenAI messages → GLM chat template 认识的 messages。"""
    out = []
    for m in body.get("messages", []):
        role = m.get("role", "user")
        content = m.get("content")
        parts = []
        if isinstance(content, str):
            parts = [{"type": "text", "text": content}]
        elif isinstance(content, list):
            for c in content:
                t = c.get("type")
                if t == "text":
                    parts.append({"type": "text", "text": c.get("text", "")})
                elif t == "image_url":
                    parts.append({"type": "image", "image": c["image_url"]["url"]})
        entry = {"role": role, "content": parts}
        if role == "assistant" and m.get("tool_calls"):
            tcs = []
            for tc in m["tool_calls"]:
                fn = tc.get("function", {})
                args = fn.get("arguments", "{}")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {"raw": args}
                tcs.append({"name": fn.get("name", "unknown"), "arguments": args})
            entry["tool_calls"] = tcs
        out.append(entry)
    return out


def parse_output(reply):
    """把 <tool_call>/<arg_key> 解析成 OpenAI tool_calls；分离 <think>。"""
    reasoning = ""
    m = re.search(r"<think>(.*?)</think>", reply, re.S)
    if m:
        reasoning = m.group(1).strip()
        reply = reply[:m.start()] + reply[m.end():]
    calls = []
    for i, tc in enumerate(TOOL_CALL_RE.finditer(reply)):
        name = tc.group(1)
        args = {}
        for k, v in ARG_RE.findall(tc.group(2)):
            v = v.strip()
            try:
                args[k] = json.loads(v)
            except Exception:
                args[k] = v
        calls.append({
            "id": f"call_{i}_{int(time.time()*1000)}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
        })
    content = TOOL_CALL_RE.sub("", reply).strip()
    return content, reasoning, calls


def run(body):
    processor, model = STATE["processor"], STATE["model"]
    msgs = to_messages(body)
    enable_thinking = body.get("enable_thinking", False)
    tpl_kwargs = {"add_generation_prompt": True, "tokenize": False}
    if body.get("tools"):
        tpl_kwargs["tools"] = body["tools"]
    if not enable_thinking:
        tpl_kwargs["enable_thinking"] = False
    text = processor.apply_chat_template(msgs, **tpl_kwargs)

    images = [img_from_data_url(p["image"]) for m in msgs for p in m["content"]
              if p.get("type") == "image" and isinstance(p.get("image"), str)
              and p["image"].startswith("data:")]
    kwargs = {"text": [text], "return_tensors": "pt"}
    if images:
        kwargs["images"] = images
    inputs = processor(**kwargs).to(model.device)
    max_new = min(int(body.get("max_tokens") or STATE["max_new"]), 4096)

    t0 = time.time()
    with torch.inference_mode():
        out = model.generate(**inputs, max_new_tokens=max_new, do_sample=False)
    gen = out[0][inputs["input_ids"].shape[1]:]
    raw = processor.tokenizer.decode(gen, skip_special_tokens=True).strip()
    # 模型自带的装饰标记，别带给客户端
    for tag in ("<|begin_of_box|>", "<|end_of_box|>", "<|begin_of_image|>", "<|end_of_image|>",
                "<|begin_of_video|>", "<|end_of_video|>", "<|user|>", "<|assistant|>", "<|observation|>"):
        raw = raw.replace(tag, "")
    raw = raw.strip()
    dt = time.time() - t0
    n = int(gen.shape[0])

    content, reasoning, calls = parse_output(raw)
    msg = {"role": "assistant", "content": content}
    if reasoning:
        msg["reasoning_content"] = reasoning
    if calls:
        msg["tool_calls"] = calls
    return {
        "id": "chatcmpl-local",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_NAME,
        "choices": [{
            "index": 0,
            "message": msg,
            "finish_reason": "tool_calls" if calls else "stop",
        }],
        "usage": {"prompt_tokens": int(inputs["input_ids"].shape[1]),
                  "completion_tokens": n,
                  "total_tokens": int(inputs["input_ids"].shape[1]) + n},
        "_speed": f"{n/dt:.1f} tok/s" if dt > 0 else "?",
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[http] " + (fmt % args) + "\n")

    def _send(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            return self._send(200, {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]})
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True, "device": STATE["device"]})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/v1/chat/completions"):
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        try:
            t0 = time.time()
            resp = run(body)
            sys.stderr.write(f"[gen] {resp['_speed']} total {time.time()-t0:.1f}s\n")
            self._send(200, resp)
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._send(500, {"error": {"message": str(e)}})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=MODEL_DIR)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=11434)
    ap.add_argument("--max-new", type=int, default=512)
    ap.add_argument("--quant", choices=["none", "hqq4", "hqq8", "bnb4", "bnb8"], default="bnb4")
    ap.add_argument("--load-only", action="store_true")
    args = ap.parse_args()

    load(args.model_dir, args.max_new, args.quant)
    if args.load_only:
        print("[load-only] OK", flush=True)
        return
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[serve] http://{args.host}:{args.port}/v1  model={MODEL_NAME}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
