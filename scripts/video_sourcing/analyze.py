"""Step 4: AI analysis using Claude — score, extract key phrases, generate teaching config."""

import json
import re
import time

import anthropic

from config import ANTHROPIC_API_KEY, VIDEOS_DIR, SCENE_NAMES

ANALYSIS_PROMPT = """你是 Eversay 平台的内容策划专家。Eversay 是一个帮中国留学生练习英语口语的平台，用 AI 模拟真实生活场景对话。

以下是一段 YouTube 视频的信息和字幕转写。请分析这段视频是否适合作为「{scene_name}」场景的教学素材。

## 视频信息
- 标题：{title}
- 频道：{channel}
- 时长：{duration}秒

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
        title=video["title"],
        channel=video["channel"],
        duration=video.get("duration_seconds", "unknown"),
        full_text=video["full_text"][:8000],
    )

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )

    text = response.content[0].text

    # Extract JSON from markdown code block or raw text
    json_match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    raw = json_match.group(1) if json_match else text

    # Fix common JSON issues: true/false without quotes, trailing commas
    raw = raw.strip()
    return json.loads(raw)


def analyze_all():
    """Analyze all transcribed videos."""
    if not ANTHROPIC_API_KEY:
        print("WARNING: ANTHROPIC_API_KEY is not set. Skipping AI analysis.")
        print("Set it and re-run this step when ready.")
        return None

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    input_path = VIDEOS_DIR / "transcribed_results.json"
    with open(input_path, "r", encoding="utf-8") as f:
        transcribed = json.load(f)

    results = {}

    for scene, videos in transcribed.items():
        scene_results = []

        for v in videos:
            print(f"[{SCENE_NAMES.get(scene, scene)}] Analyzing: {v['title'][:50]}...")

            try:
                analysis = analyze_video(client, v, scene)
                v["analysis"] = analysis
                scene_results.append(v)

                score = analysis.get("score", 0)
                suitable = analysis.get("suitable", False)
                n_phrases = len(analysis.get("key_phrases", []))
                print(f"  -> Score: {score}/5, Suitable: {suitable}, Key phrases: {n_phrases}")

            except Exception as e:
                print(f"  -> ERROR: {e}")
                v["analysis"] = {"error": str(e)}
                scene_results.append(v)

            time.sleep(1)  # Rate limit for API

        results[scene] = scene_results

    output_path = VIDEOS_DIR / "analyzed_results.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    generate_report(results)
    return results


def generate_report(results):
    """Generate a human-review report sorted by score."""
    report_lines = ["# 视频素材分析报告\n"]

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

            report_lines.append(f"### {icon} [{score}/5] {v['title'][:60]}")
            report_lines.append(f"- URL: {v['url']}")
            report_lines.append(f"- Channel: {v['channel']}")
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

    report_lines.insert(1, f"\n> Total: {total_videos} videos, {total_suitable} suitable (score >= 4)\n")

    report = "\n".join(report_lines)
    report_path = VIDEOS_DIR / "review_report.md"
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"\nReport generated: {report_path}")
    print(f"Suitable for review: {total_suitable}/{total_videos}")


if __name__ == "__main__":
    analyze_all()
