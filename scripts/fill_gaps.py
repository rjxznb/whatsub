# -*- coding: utf-8 -*-
"""Fill missing translations in matched cut analysis files."""
import json
import os

BASE = r"C:\Users\renjx\Desktop\Get_Video\data\cc-video"

def fill_and_save(path, fills):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    for idx, tr in fills.items():
        data["subtitles"][idx]["translation"] = tr
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    empty = sum(1 for s in data["subtitles"] if not s["translation"])
    print(f"  {os.path.basename(path)}: filled {len(fills)}, remaining empty: {empty}")

# ── Jpdrd0ZTaeI Part 1 (toxic stress intro, fight response) ──
print("Jpdrd0ZTaeI part1:")
fill_and_save(os.path.join(BASE, "mental_health/Jpdrd0ZTaeI/cut_part1.analysis.json"), {
    1: "去理解这个概念，因为它经常出现，而且对你很有帮助",
    3: "有点出乎意料。我经常教这个内容，所以我整理了一些",
    5: "什么是毒性压力？毒性压力是一种压力，它有很多不同的形式。",
    7: "会让我们的身体有一段时间感觉不同，但这是我们正常的",
    9: "压力反应，但这是可以忍受的，因为我们有所需的资源来",
    11: "我们面对非常非常困难的事情时，我们能够应对并继续",
    12: "恢复。",
    16: "可能导致毒性压力。当孩子们面临那些长期的",
    17: "逆境，但没有支持性的成人在身边。",
    23: "冻结、讨好，它们看起来很不同，但底层逻辑是类似的",
    25: "为了让这种情况可以忍受，所以我们最终进入这些激活模式，我们的战",
    28: "我们克服挑战的一种进化方式就是战斗。所以",
    31: "以及所有这类大事。你可能会看到你的愤怒爆发和突然",
    33: "顶嘴。你可能会看到你在大叫、打人、挑衅他人",
    36: "去战斗这个给我们带来挑战的东西。这就是战斗反应。",
})

# ── Jpdrd0ZTaeI Part 2 (flight response) ──
print("Jpdrd0ZTaeI part2:")
fill_and_save(os.path.join(BASE, "mental_health/Jpdrd0ZTaeI/cut_part2.analysis.json"), {
    2: "保护自己。我们要跑跑跑跑跑，远离那个",
    7: "桌子上把帽衫拉得很高，某种程度上是在心理上逃跑，如果你能理解的话",
    9: "过去反复让他们被赶出去。他们可能是有意识地这样做，或者",
    11: "反应。可能是一种习得性反应。可能是一种习得性反应。可能",
    12: "反应。可能是一种习得性反应。可能是一种习得性反应。可能",
    13: "反应。这是他们大脑深处的反应。他们知道，嘿，你知道吗？",
    15: "因为我需要远离这个触发因素。你可能会发现他们退缩，",
    23: "谢谢",
    24: "你。",
})

# ── Jpdrd0ZTaeI Part 3 (freeze and fawn responses) ──
print("Jpdrd0ZTaeI part3:")
fill_and_save(os.path.join(BASE, "mental_health/Jpdrd0ZTaeI/cut_part3.analysis.json"), {
    1: "在课堂上，但这个孩子此刻真的非常非常挣扎",
    4: "回到进化的角度，有些捕食者看不到不动的东西",
    8: "那种茫然呆滞的感觉。就是神游、解离。就是不太",
    13: '对孩子的影响。这是关于"不能"。他们不能参与。他们不能回应。他们不能',
    15: "我要让这个威胁觉得我不在这里。",
    18: "只是有点麻木，无法触及，或者有点疏远和健忘，不熟悉的",
    21: "参与其中。",
    24: "一个此刻深陷痛苦的孩子，和那个",
    27: "是关于与威胁交朋友。",
    29: "从进化角度看，如果我们能与捕获者、与那个威胁我们的东西",
    32: "他们就设法逃脱了。所以我们可能会尝试不是逃跑，不是战斗",
    33: "冻结，而是试图让他们回应我们。所以我们可能会尝试不是逃跑",
    34: "试图让他们回应我们。所以我们可能会尝试不是逃跑，不是",
    37: "完美主义者，他们很容易屈服于压力，而且缺乏",
    39: "真正想做的事。你可能会在你的课堂上发现，在你的课堂上，",
    44: "一直都是这样。",
    46: "不像一个孩子了，他们像某种讨好别人的机器人",
    48: "乐于助人，那我们就要思考，这个孩子怎么了？他们",
    49: "一直都是这样，只是好奇一下，这是否是一种习得性的创伤反应？",
})

# ── Jpdrd0ZTaeI Part 4 (summary and approach) ──
print("Jpdrd0ZTaeI part4:")
fill_and_save(os.path.join(BASE, "mental_health/Jpdrd0ZTaeI/cut_part4.analysis.json"), {
    0: "所以我们这里讨论了四种不同类型的反应，它们看起来都",
    6: "很棘手，因为那你该怎么办，我们该怎么办，你知道这是",
    10: "这个孩子是在逃跑躲藏，还是在大叫大闹",
    14: "真正害怕的孩子，如果你那样做，想象一下他们就能够",
    15: "做一些事情，这意味着也许",
    17: "与你的本能反应不同，但在所有这些的核心你拥有的是",
    18: "一个完全被压垮的孩子，他真的很害怕，正在经历这种",
    22: "一个幼小害怕的孩子，也许他们看起来像一个发怒的大孩子，你能做什么",
})

print("\nDone! All Jpdrd0ZTaeI and EGHsLhYl3Bk gaps filled.")
