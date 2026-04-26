"""Step 4: AI analysis for CC videos using Claude API.

Same scoring rubric as standard pipeline (1-5), generates review report.
Input: cc_transcribed_results.json → Output: cc_analyzed_results.json + cc_review_report.md

Usage:
    python analyze_cc.py
    python analyze_cc.py --scenes medical dining
"""

import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "video_sourcing"))
from config import ANTHROPIC_API_KEY, CC_VIDEO_DIR, SCENE_NAMES

TRANSCRIBED_FILE = CC_VIDEO_DIR / "cc_transcribed_results.json"
OUTPUT_FILE = CC_VIDEO_DIR / "cc_analyzed_results.json"
REPORT_FILE = CC_VIDEO_DIR / "cc_review_report.md"

ANALYSIS_PROMPT = """你是 Eversay 平台的内容策划专家。Eversay 是一个帮中国留学生练习英语口语的平台，用 AI 模拟真实生活场景对话。

以下是一段 YouTube CC（Creative Commons）视频的信息和字幕转写。请分析这段视频是否适合作为「{scene_name}」场景的教学素材。

## 视频信息
- 标题：{title}
- 频道：{channel}
- 时长：{duration}秒
- 授权：Creative Commons（可自由使用）

## 字幕全文
{full_text}

## 请输出以下 JSON（不要输出其他内容）

```json
{{
  "suitable": true/false,
  "score": 1-5,
  "reason": "一句话说明为什么适合/不适合",

  "content_type": "vlog" | "documentary" | "film_clip" | "tutorial" | "other",
  "has_real_dialogue": true/false,
  "dialogue_naturalness": 1-5,
  "accent": "RP" | "Northern" | "Scottish" | "American" | "Australian" | "Mixed" | "Other",
  "speech_speed": "slow" | "normal" | "fast",

  "difficulty": "EASY" | "MEDIUM" | "HARD",

  "key_phrases": [
    {{
      "expression": "英文表达原文",
      "meaning_zh": "中文释义",
      "usage": "使用场景说明",
      "register": "formal" | "casual" | "professional",
      "timestamp_approx": 123.4
    }}
  ],

  "common_errors": [
    "中国学生在这个场景中最容易犯的错误，用中文描述"
  ],

  "suggested_clip": {{
    "start_seconds": 0,
    "end_seconds": 0,
    "reason": "为什么建议剪这一段"
  }} | null,

  "role_setup": {{
    "name": "角色名，如 Dr. Wilson",
    "identity": "角色身份，如 NHS GP doctor",
    "personality": "说话风格，如 patient, speaks clearly",
    "accent": "口音，如 Standard RP"
  }} | null,

  "goal_checklist": [
    "用户在对话中需要完成的目标，如：成功描述了症状"
  ],

  "complications": {{
    "medium": ["中等难度的意外事件"],
    "hard": ["高难度的意外事件"]
  }}
}}
```

评分标准：
- 5分：有大量真实对话、语速自然、场景高度匹配、可直接用作教学素材
- 4分：有真实对话、场景匹配、可能需要小幅剪辑
- 3分：有一些对话但不是主体，或场景部分匹配
- 2分：对话很少、或主要是旁白/讲解、或场景不太匹配
- 1分：不适合，纯教学/无对话/场景不匹配

key_phrases 提取规则：
- 提取 3-8 个中国留学生最需要学会的地道表达
- 不要提取太简单的（如 hello, thank you）
- 优先提取"课本上不教但生活中常用"的表达
- 每个表达标注大概出现在视频的哪个时间位置"""


def analyze_video(client, video, scene):
    """Analyze a single video with Claude."""
    prompt = ANALYSIS_PROMPT.format(
        scene_name=SCENE_NAMES.get(scene, scene),
        title=video.get("title", ""),
        channel=video.get("channel", ""),
        duration=video.get("duration", "unknown"),
        full_text=video.get("full_text", "")[:8000],
    )

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )

    text = response.content[0].text
    json_match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    raw = json_match.group(1) if json_match else text
    raw = raw.strip()
    return json.loads(raw)


def generate_report(results):
    """Generate a human-review report sorted by score."""
    report_lines = ["# CC 视频素材分析报告\n"]

    total_suitable = 0
    total_videos = 0

    for scene, videos in results.items():
        report_lines.append(f"\n## {SCENE_NAMES.get(scene, scene)}\n")

        scored = [
            v for v in videos
            if isinstance(v.get("analysis"), dict) and "score" in v["analysis"]
        ]
        scored.sort(key=lambda x: x["analysis"]["score"], reverse=True)
        total_videos += len(scored)

        for v in scored:
            a = v["analysis"]
            score = a.get("score", "?")
            suitable = a.get("suitable", False)
            if suitable and score >= 4:
                total_suitable += 1
            icon = "✅" if suitable else "❌"
            difficulty = a.get("difficulty", "?")
            naturalness = a.get("dialogue_naturalness", "?")
            phrases = len(a.get("key_phrases", []))

            vid = v.get("video_id", "?")
            report_lines.append(f"### {icon} [{score}/5] {v.get('title', '')[:60]}")
            report_lines.append(f"- URL: https://www.youtube.com/watch?v={vid}")
            report_lines.append(f"- Channel: {v.get('channel', '?')}")
            report_lines.append(f"- License: Creative Commons")
            report_lines.append(f"- Difficulty: {difficulty} | Naturalness: {naturalness}/5")
            report_lines.append(f"- Key phrases: {phrases}")

            if a.get("reason"):
                report_lines.append(f"- Reason: {a['reason']}")

            if a.get("key_phrases"):
                report_lines.append("- Top expressions:")
                for kp in a["key_phrases"][:3]:
                    report_lines.append(f'  - "{kp["expression"]}" — {kp["meaning_zh"]}')

            if a.get("suggested_clip"):
                clip = a["suggested_clip"]
                report_lines.append(
                    f"- Suggested clip: {clip['start_seconds']}s - {clip['end_seconds']}s"
                )
                report_lines.append(f"  {clip['reason']}")

            report_lines.append("")

    report_lines.insert(1, f"\n> Total: {total_videos} CC videos, "
                        f"{total_suitable} suitable (score >= 4)\n")

    report = "\n".join(report_lines)
    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"\nReport generated: {REPORT_FILE}", flush=True)
    print(f"Suitable for review: {total_suitable}/{total_videos}", flush=True)


def analyze_all(scenes=None):
    """Analyze all transcribed CC videos."""
    if not ANTHROPIC_API_KEY:
        print("WARNING: ANTHROPIC_API_KEY is not set. Skipping AI analysis.", flush=True)
        print("Set it and re-run, or use Claude Code agents for Step 4.", flush=True)
        return None

    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    with open(TRANSCRIBED_FILE, "r", encoding="utf-8") as f:
        transcribed = json.load(f)

    results = {}

    for scene, videos in transcribed.items():
        if scenes and scene not in scenes:
            continue

        scene_results = []
        for v in videos:
            title = v.get("title", "")[:50]
            print(f"[{SCENE_NAMES.get(scene, scene)}] Analyzing: {title}...", flush=True)

            try:
                analysis = analyze_video(client, v, scene)
                v["analysis"] = analysis
                scene_results.append(v)

                score = analysis.get("score", 0)
                suitable = analysis.get("suitable", False)
                n_phrases = len(analysis.get("key_phrases", []))
                print(f"  -> Score: {score}/5, Suitable: {suitable}, "
                      f"Key phrases: {n_phrases}", flush=True)

            except Exception as e:
                print(f"  -> ERROR: {e}", flush=True)
                v["analysis"] = {"error": str(e)}
                scene_results.append(v)

            time.sleep(1)

        results[scene] = scene_results

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    generate_report(results)
    print(f"\nOutput: {OUTPUT_FILE}", flush=True)
    return results


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="AI analysis for CC videos")
    parser.add_argument("--scenes", nargs="+", help="Specific scenes only")
    args = parser.parse_args()
    analyze_all(scenes=args.scenes)
