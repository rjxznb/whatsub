# -*- coding: utf-8 -*-
"""Fill translation gaps and set metadata for all shopping cut analysis files."""
import json
import os

BASE = r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping"
SCRIPTS = r"C:\Users\renjx\Desktop\Get_Video\scripts"


def load_translations(filename):
    """Load idx|translation pairs from a file. SKIP means remove that cue."""
    path = os.path.join(SCRIPTS, filename)
    result = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            idx_str, trans = line.split("|", 1)
            result[int(idx_str)] = trans
    return result


def fill_gaps(analysis_path, tr_file):
    """Fill translation gaps in an analysis file."""
    with open(analysis_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    translations = load_translations(tr_file)

    # Fill gaps and collect indices to remove (SKIP entries)
    skip_indices = set()
    for idx, trans in translations.items():
        if idx < len(data["subtitles"]):
            if trans == "SKIP":
                skip_indices.add(idx)
            else:
                data["subtitles"][idx]["translation"] = trans

    # Remove SKIP entries (reverse order to preserve indices)
    if skip_indices:
        data["subtitles"] = [
            s for i, s in enumerate(data["subtitles"]) if i not in skip_indices
        ]

    return data


def save(data, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    subs = data["subtitles"]
    gaps = sum(1 for s in subs if not s.get("translation"))
    print(f"  Saved {os.path.basename(path)}: {len(subs)} subs, {gaps} gaps remaining", flush=True)


LQ = "\u201c"
RQ = "\u201d"


def main():
    # ============================================================
    # 1. EvvEAg2ODCs - Trader Joe's grocery haul
    # ============================================================
    print("=== EvvEAg2ODCs ===", flush=True)
    p = os.path.join(BASE, "EvvEAg2ODCs", "cut_EvvEAg2ODCs.analysis.json")
    data = fill_gaps(p, "tr_shop_EvvEAg2ODCs.txt")
    data["sceneContext"] = (
        "The user is at a Trader Joe's grocery store, doing their regular shopping trip. "
        "They are describing each item they picked up to a friend or family member. "
        "The AI plays a fellow shopper or store associate who asks about the products, "
        "suggests alternatives, and helps with shopping decisions."
    )
    data["roleSetup"] = {
        "name": "Chris",
        "identity": "Friendly Trader Joe's store associate",
        "personality": "helpful, knowledgeable, enthusiastic",
        "accent": "American"
    }
    data["keyPhrases"] = [
        {"expression": "grab some", "meaningZh": "\u968f\u624b\u62ff\u4e86\u4e00\u4e9b", "usage": "Casual way to say you picked up items while shopping", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "seasonal item", "meaningZh": "\u5b63\u8282\u9650\u5b9a\u5546\u54c1", "usage": "Products available only during certain seasons", "register": "casual", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "give it a try", "meaningZh": "\u8bd5\u8bd5\u770b", "usage": "To try something new, especially food or products", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "it was really good", "meaningZh": "\u771f\u7684\u5f88\u597d\u5403/\u5f88\u597d", "usage": "Expressing positive experience with a product or food", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "plan on doing", "meaningZh": "\u6253\u7b97\u505a", "usage": "Expressing future intentions for meal planning or activities", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "I heard really good things about", "meaningZh": "\u6211\u542c\u8bf4\u8fd9\u4e2a\u5f88\u4e0d\u9519", "usage": "Referencing recommendations from others when deciding to buy", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "some change", "meaningZh": "\u591a\u4e00\u70b9\u96f6\u5934", "usage": "Approximate amount after the main dollar figure, e.g. '$97 and some change'", "register": "casual", "speakerRole": "both", "minDifficulty": "MEDIUM"},
        {"expression": "jump right in", "meaningZh": "\u76f4\u63a5\u5f00\u59cb", "usage": "To start immediately without delay", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
    ]
    data["complications"] = {
        "medium": ["The store is out of a key item you need for a recipe"],
        "hard": ["You need to plan meals for the week within a strict budget and compare unit prices"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 10}
    data["commonErrors"] = [
        "\u4e2d\u56fd\u5b66\u751f\u5e38\u8bf4 'I want to buy this' \u800c\u4e0d\u662f\u66f4\u81ea\u7136\u7684 'I'll grab this'",
        "\u6df7\u6dc6 produce(\u751f\u9c9c\u679c\u852c) \u548c product(\u4ea7\u54c1)",
        "\u4e0d\u719f\u6089\u7f8e\u56fd\u8d85\u5e02\u7684\u5b63\u8282\u9650\u5b9a\u6587\u5316\uff0c\u5982seasonal items",
        "\u8bf4\u4ef7\u683c\u65f6\u5e38\u7701\u7565 'dollars'\uff0c\u5982 'it's only 1.79 a bag'"
    ]
    data["culturalNotes"] = (
        "Trader Joe's\u662f\u7f8e\u56fd\u5f88\u53d7\u6b22\u8fce\u7684\u8fde\u9501\u8d85\u5e02\uff0c"
        "\u4ee5\u81ea\u6709\u54c1\u724c\u3001\u5b9e\u60e0\u4ef7\u683c\u548c\u72ec\u7279\u7684\u5b63\u8282\u9650\u5b9a\u5546\u54c1\u95fb\u540d\u3002"
        "\u7f8e\u56fd\u4eba\u4e60\u60ef\u505a grocery haul\uff08\u8d2d\u7269\u5206\u4eab\uff09\uff0c"
        "\u5728\u793e\u4ea4\u5a92\u4f53\u4e0a\u5c55\u793a\u4ed6\u4eec\u8d2d\u4e70\u7684\u98df\u54c1\u548c\u7f8e\u98df\u7b56\u5212\u3002"
    )
    data["country"] = "US"
    save(data, p)

    # ============================================================
    # 2. FwqgPhtR8C0 part1 - Cooking healthy bowl
    # ============================================================
    print("=== FwqgPhtR8C0/part1_cooking ===", flush=True)
    p = os.path.join(BASE, "FwqgPhtR8C0", "cut_part1_cooking.analysis.json")
    data = fill_gaps(p, "tr_shop_FwqgPhtR8C0_p1.txt")
    data["sceneContext"] = (
        "The user is in a kitchen preparing a healthy dinner bowl with their roommate or friend. "
        "They are explaining each ingredient and cooking step. "
        "The AI plays a cooking-enthusiast friend who asks about ingredients, techniques, and healthy substitutions."
    )
    data["roleSetup"] = {
        "name": "Mia",
        "identity": "Roommate and cooking enthusiast",
        "personality": "curious, health-conscious, supportive",
        "accent": "American Female"
    }
    data["keyPhrases"] = [
        {"expression": "making a big healthy bowl", "meaningZh": "\u505a\u4e00\u4e2a\u5927\u4efd\u5065\u5eb7\u6c99\u62c9\u7897", "usage": "Describing a bowl-style meal with various healthy ingredients", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "my trick to", "meaningZh": "\u6211\u7684\u79d8\u8bc0\u662f", "usage": "Sharing a personal cooking tip or technique", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "they really don't need much", "meaningZh": "\u5b83\u4eec\u771f\u7684\u4e0d\u9700\u8981\u52a0\u592a\u591a\u4e1c\u897f", "usage": "Describing naturally flavorful ingredients that need minimal seasoning", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "for the base", "meaningZh": "\u4f5c\u4e3a\u5e95\u5c42/\u57fa\u5e95", "usage": "Describing the foundation layer of a bowl or salad", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
    ]
    data["complications"] = {
        "medium": ["You realize you're missing a key ingredient and need to improvise"],
        "hard": ["Your friend has dietary restrictions you need to accommodate"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 8}
    data["commonErrors"] = [
        "\u6df7\u6dc6 cook \u548c make \u5728\u70f9\u996a\u8bed\u5883\u4e2d\u7684\u7528\u6cd5",
        "\u4e0d\u719f\u6089\u7f8e\u5f0f\u5065\u5eb7\u996e\u98df\u672f\u8bed\u5982 quinoa, bibb lettuce",
    ]
    data["culturalNotes"] = (
        "\u7f8e\u56fd\u5e74\u8f7b\u4eba\u6d41\u884c healthy bowl \u6587\u5316\uff0c"
        "\u5c06\u591a\u79cd\u5065\u5eb7\u98df\u6750\u7ec4\u5408\u5728\u4e00\u4e2a\u7897\u91cc\uff0c"
        "\u5f3a\u8c03\u8425\u517b\u5747\u8861\u548c\u98df\u6750\u65b0\u9c9c\u5ea6\u3002"
    )
    data["country"] = "US"
    save(data, p)

    # ============================================================
    # 3. FwqgPhtR8C0 part2 - Sephora makeup haul
    # ============================================================
    print("=== FwqgPhtR8C0/part2_makeup ===", flush=True)
    p = os.path.join(BASE, "FwqgPhtR8C0", "cut_part2_makeup-1.analysis.json")
    data = fill_gaps(p, "tr_shop_FwqgPhtR8C0_p2.txt")
    data["sceneContext"] = (
        "The user is reviewing products purchased from Sephora, sharing their beauty haul. "
        "They are discussing skincare masks, makeup products (foundation, powder, bronzer), and their preferences. "
        "The AI plays a Sephora beauty advisor who helps with product recommendations and shade matching."
    )
    data["roleSetup"] = {
        "name": "Nicole",
        "identity": "Sephora Beauty Advisor",
        "personality": "knowledgeable, enthusiastic, professional",
        "accent": "American Female"
    }
    data["keyPhrases"] = [
        {"expression": "restocked on", "meaningZh": "\u8865\u8d27/\u56de\u8d2d\u4e86", "usage": "To buy again something you've run out of", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "full coverage", "meaningZh": "\u9ad8\u906e\u7780\u529b", "usage": "Makeup that covers imperfections completely", "register": "professional", "speakerRole": "both", "minDifficulty": "MEDIUM"},
        {"expression": "gone viral", "meaningZh": "\u7206\u706b\u4e86", "usage": "A product or content that became extremely popular quickly", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "a little goes a long way", "meaningZh": "\u7528\u4e00\u70b9\u5c31\u591f\u4e86", "usage": "Describing highly concentrated or pigmented products", "register": "casual", "speakerRole": "both", "minDifficulty": "MEDIUM"},
        {"expression": "finely milled", "meaningZh": "\u7814\u78e8\u5f88\u7ec6\u817b", "usage": "Describing powder texture quality in cosmetics", "register": "professional", "speakerRole": "passive"},
        {"expression": "one-size-fits-all", "meaningZh": "\u4e00\u4e2a\u5c3a\u7801\u9002\u5408\u6240\u6709\u4eba", "usage": "Something designed to suit everyone (often used negatively)", "register": "casual", "speakerRole": "both", "minDifficulty": "MEDIUM"},
    ]
    data["complications"] = {
        "medium": ["You need help finding the right shade for your skin tone"],
        "hard": ["You want to return a product but don't have the receipt"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 10}
    data["commonErrors"] = [
        "\u6df7\u6dc6 shade(\u8272\u53f7) \u548c color(\u989c\u8272) \u5728\u5316\u5986\u54c1\u8bed\u5883\u4e2d\u7684\u7528\u6cd5",
        "\u4e0d\u719f\u6089\u7f8e\u5986\u4e13\u4e1a\u672f\u8bed\u5982 coverage, pigmented, matte, dewy",
        "\u8bf4 'I want to try this' \u800c\u4e0d\u662f\u66f4\u5730\u9053\u7684 'Can I swatch this?'"
    ]
    data["culturalNotes"] = (
        "\u4e1d\u8299\u5170(Sephora)\u662f\u7f8e\u56fd\u6700\u5927\u7684\u7f8e\u5986\u8fde\u9501\u5e97\uff0c"
        "\u5e97\u5185\u6709\u7f8e\u5bb9\u987e\u95ee(Beauty Advisor)\u63d0\u4f9b\u4e13\u4e1a\u5efa\u8bae\u3002"
        "\u987e\u5ba2\u53ef\u4ee5\u81ea\u7531\u8bd5\u7528\u4ea7\u54c1\uff0c\u8fd9\u5728\u4e2d\u56fd\u7684\u5316\u5986\u54c1\u5e97\u5e76\u4e0d\u5e38\u89c1\u3002"
    )
    data["country"] = "US"
    save(data, p)

    # ============================================================
    # 4. FwqgPhtR8C0 part3 - More beauty products
    # ============================================================
    print("=== FwqgPhtR8C0/part3_makeup ===", flush=True)
    p = os.path.join(BASE, "FwqgPhtR8C0", "cut_part3_makeup-1.analysis.json")
    data = fill_gaps(p, "tr_shop_FwqgPhtR8C0_p3.txt")
    data["sceneContext"] = (
        "The user is sharing their beauty product haul from Sephora, Bath & Body Works, and Victoria's Secret. "
        "They discuss skincare routines (exfoliation, cleansers, hyaluronic acid), makeup products, and nostalgic body care. "
        "The AI plays a beauty-savvy friend who asks questions about products and skincare routines."
    )
    data["roleSetup"] = {
        "name": "Sophie",
        "identity": "Beauty-savvy friend and skincare enthusiast",
        "personality": "curious, detail-oriented, enthusiastic",
        "accent": "American Female"
    }
    data["keyPhrases"] = [
        {"expression": "exfoliate", "meaningZh": "\u53bb\u89d2\u8d28", "usage": "To remove dead skin cells from the surface of the skin", "register": "professional", "speakerRole": "both", "minDifficulty": "MEDIUM"},
        {"expression": "sitting well on your skin", "meaningZh": "\u5728\u76ae\u80a4\u4e0a\u670d\u8d34", "usage": "Describing how makeup looks and stays on the skin", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "dupes for", "meaningZh": "\u201c\u5e73\u66ff\u201d\uff0c\u66ff\u4ee3\u54c1", "usage": "Cheaper alternatives that perform similarly to expensive products", "register": "casual", "speakerRole": "both", "minDifficulty": "HARD"},
        {"expression": "nostalgic", "meaningZh": "\u6000\u65e7\u7684", "usage": "Feeling sentimental about something from the past", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "I'm obsessed with", "meaningZh": "\u6211\u8d85\u7231/\u7740\u8ff7\u4e8e", "usage": "Expressing strong enthusiasm for a product", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "what sold me", "meaningZh": "\u8ba9\u6211\u4e70\u5355\u7684\u539f\u56e0", "usage": "The feature that convinced you to buy something", "register": "casual", "speakerRole": "learner", "minDifficulty": "HARD"},
    ]
    data["complications"] = {
        "medium": ["Your friend asks you to recommend a skincare routine for sensitive skin"],
        "hard": ["You need to find affordable alternatives (dupes) for expensive products within a budget"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 10}
    data["commonErrors"] = [
        "\u6df7\u6dc6 cleanser(\u6d01\u9762\u4e73) \u548c lotion(\u4e73\u6db2)",
        "\u4e0d\u77e5\u9053 dupe \u8fd9\u4e2a\u7f8e\u5986\u5708\u5e38\u7528\u8bcd\uff0c\u4e2d\u56fd\u5b66\u751f\u5e38\u8bf4 cheap version",
        "\u4e0d\u719f\u6089 Bath & Body Works \u7684\u6000\u65e7\u6587\u5316\uff0c\u8fd9\u662f\u5f88\u591a\u7f8e\u56fd\u5973\u751f\u7684\u9752\u6625\u8bb0\u5fc6",
    ]
    data["culturalNotes"] = (
        "Bath & Body Works\u662f\u7f8e\u56fd\u7ecf\u5178\u7684\u8eab\u4f53\u62a4\u7406\u54c1\u724c\uff0c"
        "\u5f88\u591a\u7f8e\u56fd\u5973\u751f\u4ece\u521d\u4e2d\u5c31\u5f00\u59cb\u7528\uff0c"
        "\u65e5\u672c\u6a31\u82b1(Japanese Cherry Blossom)\u662f\u5176\u6700\u7ecf\u5178\u7684\u9999\u578b\u4e4b\u4e00\u3002"
        "\u5bf9\u5f88\u591a\u7f8e\u56fd\u4eba\u6765\u8bf4\u5145\u6ee1\u6000\u65e7\u611f\u3002"
    )
    data["country"] = "US"
    save(data, p)

    # ============================================================
    # 5. FwqgPhtR8C0 part4 - Mediterranean cooking
    # ============================================================
    print("=== FwqgPhtR8C0/part4_cooking ===", flush=True)
    p = os.path.join(BASE, "FwqgPhtR8C0", "cut_part4_cooking-1.analysis.json")
    data = fill_gaps(p, "tr_shop_FwqgPhtR8C0_p4.txt")
    data["sceneContext"] = (
        "The user is in the kitchen preparing a Mediterranean-style dinner for their partner. "
        "They are making fried zucchini chips, Greek chicken with pitas, salad, hummus, and lamb chops. "
        "The AI plays the partner who tastes, helps, and asks about the cooking process."
    )
    data["roleSetup"] = {
        "name": "Jake",
        "identity": "Partner and taste-tester",
        "personality": "appreciative, playful, hungry",
        "accent": "American"
    }
    data["keyPhrases"] = [
        {"expression": "can you guess what I'm doing", "meaningZh": "\u4f60\u80fd\u731c\u5230\u6211\u5728\u505a\u4ec0\u4e48\u5417", "usage": "Playful way to start a guessing game about dinner plans", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "let it sit", "meaningZh": "\u8ba9\u5b83\u8150\u4e00\u4f1a\u513f", "usage": "To let food marinate or rest for flavor absorption", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "load up the pitas", "meaningZh": "\u5f80\u53e3\u888b\u997c\u91cc\u585e\u6ee1\u98df\u6750", "usage": "To fill pita bread generously with toppings", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "bread them and fry them", "meaningZh": "\u88f9\u4e0a\u9762\u7cca\u7136\u540e\u7092", "usage": "Cooking technique of coating food before frying", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "tenderize", "meaningZh": "\u4f7f\u8089\u53d8\u5ae9", "usage": "To make meat softer through marination or physical means", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
    ]
    data["complications"] = {
        "medium": ["You realize the oil is too hot and need to adjust the temperature"],
        "hard": ["Your partner's friend arrives unexpectedly and you need to stretch the meal for one more person"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 8}
    data["commonErrors"] = [
        "\u6df7\u6dc6 marinate(\u8150\u5236) \u548c marinade(\u8150\u6599)",
        "\u4e0d\u77e5\u9053 pita, hummus, tzatziki \u7b49\u5730\u4e2d\u6d77\u98df\u7269\u7684\u82f1\u8bed\u53d1\u97f3",
        "\u8bf4 'put the food in oil' \u800c\u4e0d\u662f 'fry it' \u6216 'deep-fry it'",
    ]
    data["culturalNotes"] = (
        "\u5730\u4e2d\u6d77\u98ce\u683c\u996e\u98df\u5728\u7f8e\u56fd\u975e\u5e38\u6d41\u884c\uff0c"
        "\u5e38\u89c1\u98df\u6750\u5305\u62ec pita\u997c\u3001hummus\u9e70\u5634\u8c46\u6ce5\u3001"
        "tzatziki\u9178\u5976\u9ec4\u74dc\u9171\u3001lamb chops\u7f8a\u6392\u7b49\u3002"
        "\u5bf9\u4e2d\u56fd\u5b66\u751f\u6765\u8bf4\u8fd9\u4e9b\u98df\u7269\u540d\u79f0\u53ef\u80fd\u4e0d\u719f\u6089\u3002"
    )
    data["country"] = "US"
    save(data, p)

    # ============================================================
    # 6. pAC_BHLaNDk part1 - Exercise/Kayaking
    # ============================================================
    print("=== pAC_BHLaNDk/part1_exercise ===", flush=True)
    p = os.path.join(BASE, "pAC_BHLaNDk", "cut_part1_exercise-1.analysis.json")
    data = fill_gaps(p, "tr_shop_pAC_p1.txt")
    data["sceneContext"] = (
        "The user is at the Woodlands Waterway, going kayaking with a group of friends during spring break. "
        "They are coordinating the activity, taking photos, and deciding where to eat afterwards. "
        "The AI plays a kayaking instructor who gives safety instructions and helps coordinate the group."
    )
    data["roleSetup"] = {
        "name": "Tyler",
        "identity": "Kayaking instructor at the Woodlands Waterway",
        "personality": "energetic, safety-conscious, fun",
        "accent": "American"
    }
    data["keyPhrases"] = [
        {"expression": "I'm so excited", "meaningZh": "\u6211\u592a\u5174\u594b\u4e86", "usage": "Expressing enthusiasm about an upcoming activity", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "life jacket", "meaningZh": "\u6551\u751f\u8863", "usage": "Safety vest worn during water activities", "register": "casual", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "meet and greet", "meaningZh": "\u89c1\u9762\u4f1a", "usage": "An organized event where fans meet a public figure", "register": "casual", "speakerRole": "passive"},
        {"expression": "I definitely recommend", "meaningZh": "\u6211\u5f3a\u70c8\u63a8\u8350", "usage": "Making a strong recommendation based on personal experience", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "getting nervous", "meaningZh": "\u5f00\u59cb\u7d27\u5f20\u4e86", "usage": "Describing growing anxiety before an activity", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
    ]
    data["complications"] = {
        "medium": ["The weather changes and the instructor needs to shorten the trip"],
        "hard": ["Someone in your group is scared of water and you need to encourage them"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 8}
    data["commonErrors"] = [
        "\u4e0d\u77e5\u9053 kayaking \u548c canoeing \u7684\u533a\u522b",
        "\u7528 'play kayak' \u800c\u4e0d\u662f 'go kayaking'",
        "\u4e0d\u719f\u6089 Whataburger \u7b49\u7f8e\u56fd\u5730\u65b9\u5feb\u9910\u54c1\u724c",
    ]
    data["culturalNotes"] = (
        "\u7f8e\u56fd\u9752\u5c11\u5e74\u5e38\u5728\u6625\u5047(spring break)\u671f\u95f4\u53c2\u52a0\u6237\u5916\u6d3b\u52a8\u3002"
        "Whataburger\u662f\u5fb7\u514b\u8428\u65af\u5f88\u53d7\u6b22\u8fce\u7684\u5feb\u9910\u8fde\u9501\uff0c"
        "\u7c7b\u4f3c\u4e8eIn-N-Out\u5728\u52a0\u5dde\u7684\u5730\u4f4d\u3002"
    )
    data["country"] = "US"
    save(data, p)

    # ============================================================
    # 7. pAC_BHLaNDk part2 - Claire's shopping
    # ============================================================
    print("=== pAC_BHLaNDk/part2_shopping ===", flush=True)
    p = os.path.join(BASE, "pAC_BHLaNDk", "cut_part2_shppping.analysis.json")
    data = fill_gaps(p, "tr_shop_pAC_p2.txt")
    data["sceneContext"] = (
        "The user is a teenager at the mall with their mom, spending a gift card at Claire's accessories store. "
        "They are browsing travel pillows, rings, earrings, and other accessories, then visiting Target. "
        "The AI plays a Claire's store associate who helps find items and suggests deals."
    )
    data["roleSetup"] = {
        "name": "Ashley",
        "identity": "Claire's store associate",
        "personality": "friendly, helpful, upbeat",
        "accent": "American Female"
    }
    data["keyPhrases"] = [
        {"expression": "gift card", "meaningZh": "\u793c\u54c1\u5361", "usage": "A prepaid card for a specific store", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "buy three get three free", "meaningZh": "\u4e70\u4e09\u9001\u4e09", "usage": "A common retail promotion", "register": "casual", "speakerRole": "passive"},
        {"expression": "check out", "meaningZh": "\u7ed3\u8d26", "usage": "To pay for items at the register", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "I ended up spending", "meaningZh": "\u6700\u540e\u82b1\u4e86", "usage": "Describing the final amount spent, often more than planned", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "narrow down my options", "meaningZh": "\u7f29\u5c0f\u9009\u62e9\u8303\u56f4", "usage": "To reduce choices to find the best one", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
    ]
    data["complications"] = {
        "medium": ["The item you want is on display but out of stock"],
        "hard": ["Your gift card has less balance than you expected and you need to decide what to keep"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 8}
    data["commonErrors"] = [
        "\u8bf4 'How much money is in my card?' \u800c\u4e0d\u662f 'What's the balance on my card?'",
        "\u4e0d\u719f\u6089\u7f8e\u56fd buy X get Y free \u7684\u4fc3\u9500\u65b9\u5f0f",
        "\u6df7\u6dc6 check out(\u7ed3\u8d26) \u548c check(\u68c0\u67e5)",
    ]
    data["culturalNotes"] = (
        "Claire's\u662f\u7f8e\u56fd\u9752\u5c11\u5e74\u975e\u5e38\u559c\u6b22\u7684\u9970\u54c1\u5e97\uff0c"
        "\u4e3b\u8981\u5356\u5e73\u4ef7\u9970\u54c1\u3001\u8033\u73af\u548c\u5c0f\u914d\u4ef6\u3002"
        "\u7f8e\u56fd\u4eba\u5e38\u7528\u793c\u54c1\u5361\u4f5c\u4e3a\u751f\u65e5\u6216\u8282\u65e5\u793c\u7269\u3002"
    )
    data["country"] = "US"
    save(data, p)

    # ============================================================
    # 8. pAC_BHLaNDk part3 - Packing for trip
    # ============================================================
    print("=== pAC_BHLaNDk/part3_trip ===", flush=True)
    p = os.path.join(BASE, "pAC_BHLaNDk", "cut_part3_trip.analysis.json")
    data = fill_gaps(p, "tr_shop_pAC_p3.txt")
    data["sceneContext"] = (
        "The user is a teenager packing for a trip to Ireland. "
        "They are organizing clothes, shoes, makeup, and toiletries into their suitcase and carry-on bag. "
        "The AI plays the user's mom who helps with packing decisions and reminds them about travel restrictions."
    )
    data["roleSetup"] = {
        "name": "Mom",
        "identity": "Supportive mother helping with travel preparation",
        "personality": "organized, practical, caring",
        "accent": "American Female"
    }
    data["keyPhrases"] = [
        {"expression": "I don't think this is all going to fit", "meaningZh": "\u6211\u89c9\u5f97\u8fd9\u4e9b\u90fd\u88c5\u4e0d\u4e0b", "usage": "Expressing doubt about fitting everything in luggage", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "carry-on", "meaningZh": "\u968f\u8eab\u884c\u674e/\u767b\u673a\u7bb1", "usage": "Luggage taken into the airplane cabin", "register": "casual", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "3.4 ounces", "meaningZh": "3.4\u76ce\u53f8\uff08\u7ea6100\u6beb\u5347\uff09", "usage": "TSA liquid limit for carry-on bags", "register": "casual", "speakerRole": "both", "minDifficulty": "MEDIUM"},
        {"expression": "travel size", "meaningZh": "\u65c5\u884c\u88c5", "usage": "Smaller versions of products designed for travel", "register": "casual", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "extra room in her suitcase", "meaningZh": "\u5979\u7684\u884c\u674e\u7bb1\u8fd8\u6709\u591a\u4f59\u7684\u7a7a\u95f4", "usage": "Describing available space for additional items", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
    ]
    data["complications"] = {
        "medium": ["You realize a key outfit item doesn't match any coat you have"],
        "hard": ["The airline has stricter carry-on limits and you need to repack"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 8}
    data["commonErrors"] = [
        "\u6df7\u6dc6 suitcase(\u884c\u674e\u7bb1) \u548c luggage(\u884c\u674e\u603b\u79f0)",
        "\u4e0d\u77e5\u9053 TSA \u7684 3.4 ounce \u6db2\u4f53\u9650\u5236",
        "\u8bf4 'pack my cosmetics' \u800c\u4e0d\u662f 'pack my toiletries'(\u6d17\u6f31\u7528\u54c1)",
    ]
    data["culturalNotes"] = (
        "\u7f8e\u56fd TSA(\u8fd0\u8f93\u5b89\u5168\u7ba1\u7406\u5c40)\u89c4\u5b9a\u968f\u8eab\u884c\u674e\u6db2\u4f53\u4e0d\u5f97\u8d85\u8fc7 3.4 oz (100ml)\u3002"
        "\u7f8e\u56fd\u9752\u5c11\u5e74\u65c5\u884c\u65f6\u5f88\u91cd\u89c6\u7a7f\u642d\u548c\u62cd\u7167\uff0c"
        "\u5e38\u4e3a\u65c5\u884c\u89c6\u9891\u7279\u610f\u51c6\u5907\u591a\u5957\u7a7f\u642d\u3002"
    )
    data["country"] = "US"
    save(data, p)

    # ============================================================
    # 9. pVO8P4TKXJY - Sephora + Ralph's
    # ============================================================
    print("=== pVO8P4TKXJY ===", flush=True)
    p = os.path.join(BASE, "pVO8P4TKXJY", "cut_pVO8P4TKXJY.analysis.json")
    data = fill_gaps(p, "tr_shop_pVO8P4TKXJY.txt")
    data["sceneContext"] = (
        "The user is out shopping with their sister/assistant. They first visit Sephora for foundation, "
        "mascara, and other beauty products, then head to Ralph's grocery store for healthy groceries. "
        "The AI plays a store associate who helps with product selection at both stores."
    )
    data["roleSetup"] = {
        "name": "Emma",
        "identity": "Store associate and shopping buddy",
        "personality": "helpful, fun, relatable",
        "accent": "American Female"
    }
    data["keyPhrases"] = [
        {"expression": "break my bank", "meaningZh": "\u8981\u7834\u4ea7\u4e86/\u82b1\u5149\u6211\u7684\u94b1", "usage": "Humorous way to say you're about to spend a lot", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "get copyrighted", "meaningZh": "\u88ab\u7248\u6743\u8b66\u544a", "usage": "When content includes copyrighted material like music", "register": "casual", "speakerRole": "passive"},
        {"expression": "birthday gift", "meaningZh": "\u751f\u65e5\u793c\u7269", "usage": "Sephora gives free gifts to members during their birthday month", "register": "casual", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "I rave about", "meaningZh": "\u6211\u4e00\u76f4\u5728\u5b89\u5229\u7684", "usage": "To enthusiastically recommend something repeatedly", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "do some wifey shit", "meaningZh": "\u505a\u4e9b\u5c45\u5bb6\u8fc7\u65e5\u5b50\u7684\u4e8b", "usage": "Casual/humorous way to describe domestic errands like grocery shopping", "register": "casual", "speakerRole": "learner", "minDifficulty": "HARD"},
        {"expression": "eating healthy", "meaningZh": "\u5065\u5eb7\u996e\u98df", "usage": "Following a nutritious diet", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
    ]
    data["complications"] = {
        "medium": ["The foundation shade you want is sold out and you need help finding a match"],
        "hard": ["You're comparing products from different brands and need detailed advice"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 10}
    data["commonErrors"] = [
        "\u4e0d\u77e5\u9053 Sephora \u7684 birthday gift \u4f1a\u5458\u798f\u5229",
        "\u8bf4 'go to supermarket' \u800c\u4e0d\u662f\u7279\u5b9a\u5e97\u540d\u5982 Ralph's, Whole Foods",
        "\u4e0d\u719f\u6089 'rave about' \u8fd9\u4e2a\u8868\u8fbe\u70ed\u60c5\u63a8\u8350\u7684\u8bf4\u6cd5"
    ]
    data["culturalNotes"] = (
        "\u7f8e\u56fd\u7684\u4e1d\u8299\u5170(Sephora)\u4f1a\u5458\u5728\u751f\u65e5\u6708\u53ef\u4ee5\u9886\u53d6\u514d\u8d39\u793c\u7269\u3002"
        "Ralph's\u662f\u52a0\u5dde\u7684\u8fde\u9501\u8d85\u5e02\uff0c"
        "\u7c7b\u4f3c\u4e8e\u5168\u56fd\u6027\u7684Kroger\u3002"
        "\u7f8e\u56fd\u5e74\u8f7b\u4eba\u5e38\u628a\u8d2d\u7269\u548c\u8d85\u5e02\u91c7\u8d2d\u7ed3\u5408\u5728\u4e00\u8d77\u505avlog\u3002"
    )
    data["country"] = "US"
    save(data, p)

    # ============================================================
    # 10. rui0QIorHbE - Grocery haul / wellness
    # ============================================================
    print("=== rui0QIorHbE ===", flush=True)
    p = os.path.join(BASE, "rui0QIorHbE", "cut_rui0QIorHbE.analysis.json")
    data = fill_gaps(p, "tr_shop_rui0QIorHbE.txt")
    data["sceneContext"] = (
        "The user is back home after grocery shopping, showing and explaining their health-conscious purchases. "
        "They discuss organic turkey bacon, coconut milk, sea moss gel, ginger, turmeric, and other wellness items. "
        "The AI plays a health-conscious friend who asks about ingredients, nutrition, and healthy eating tips."
    )
    data["roleSetup"] = {
        "name": "Lisa",
        "identity": "Health-conscious friend and wellness enthusiast",
        "personality": "curious, health-focused, encouraging",
        "accent": "American Female"
    }
    data["keyPhrases"] = [
        {"expression": "organic and uncured", "meaningZh": "\u6709\u673a\u4e14\u672a\u8154\u5236\u7684", "usage": "Key health food labels when buying meat products", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "really bad for your gut", "meaningZh": "\u5bf9\u80a0\u9053\u975e\u5e38\u4e0d\u597d", "usage": "Describing negative health effects on digestion", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "flood your system with", "meaningZh": "\u7ed9\u4f60\u7684\u8eab\u4f53\u8865\u5145\u5927\u91cf\u7684", "usage": "To consume large amounts of a nutrient for health benefits", "register": "casual", "speakerRole": "learner", "minDifficulty": "HARD"},
        {"expression": "reading ingredients", "meaningZh": "\u770b\u914d\u6599\u8868", "usage": "Checking food labels for ingredients", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "replenish your body", "meaningZh": "\u7ed9\u8eab\u4f53\u8865\u5145\u80fd\u91cf", "usage": "To restore nutrients and energy after exercise", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "anti-inflammatory", "meaningZh": "\u6297\u708e\u7684", "usage": "Describing foods that reduce inflammation", "register": "professional", "speakerRole": "both", "minDifficulty": "MEDIUM"},
    ]
    data["complications"] = {
        "medium": ["Your friend asks how to start eating healthier on a student budget"],
        "hard": ["You need to explain the difference between organic, natural, and conventional products"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 10}
    data["commonErrors"] = [
        "\u6df7\u6dc6 organic(\u6709\u673a) \u548c natural(\u5929\u7136) \u7684\u533a\u522b",
        "\u4e0d\u77e5\u9053 Whole Foods, Sprouts \u7b49\u5065\u5eb7\u98df\u54c1\u8d85\u5e02",
        "\u8bf4 'good for stomach' \u800c\u4e0d\u662f 'good for your gut'",
    ]
    data["culturalNotes"] = (
        "\u7f8e\u56fd\u5065\u5eb7\u996e\u98df\u6587\u5316\u5f88\u6d41\u884c\uff0c"
        "\u5f88\u591a\u4eba\u4f1a\u4ed4\u7ec6\u9605\u8bfb\u98df\u54c1\u914d\u6599\u8868\uff0c"
        "\u9009\u62e9organic(\u6709\u673a)\u3001uncured(\u672a\u8154\u5236)\u3001unrefined(\u672a\u7cbe\u5236)\u7684\u4ea7\u54c1\u3002"
        "Whole Foods\u548cSprouts\u662f\u4e3b\u6253\u5065\u5eb7\u98df\u54c1\u7684\u8d85\u5e02\u3002"
    )
    data["country"] = "US"
    save(data, p)

    # ============================================================
    # 11. s_TAZs0U3_g - Birthday gift card shopping spree
    # ============================================================
    print("=== s_TAZs0U3_g ===", flush=True)
    p = os.path.join(BASE, "s_TAZs0U3_g", "cut_s_TAZs0U3_g.analysis.json")
    data = fill_gaps(p, "tr_shop_s_TAZs0U3_g.txt")
    data["sceneContext"] = (
        "The user is a teenager on a birthday gift card shopping spree with their mom. "
        "They visit multiple stores: Forever 21 for clothes, Bath & Body Works for room scents, "
        "Claire's for accessories, and Target for hair products, makeup, and a dress. "
        "The AI plays a store associate who helps with sizing, product selection, and checkout."
    )
    data["roleSetup"] = {
        "name": "Kelly",
        "identity": "Mall store associate",
        "personality": "friendly, patient, fashion-savvy",
        "accent": "American Female"
    }
    data["keyPhrases"] = [
        {"expression": "gift card shopping spree", "meaningZh": "\u793c\u54c1\u5361\u8d2d\u7269\u72c2\u6b22", "usage": "Going to many stores to spend gift cards received as presents", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "try this on", "meaningZh": "\u8bd5\u7a7f\u4e00\u4e0b", "usage": "To try wearing clothes in a fitting room", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "I'm obsessed", "meaningZh": "\u6211\u592a\u7740\u8ff7\u4e86", "usage": "Strong enthusiasm for a product or item", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "that's what sold me", "meaningZh": "\u5c31\u662f\u8fd9\u4e2a\u8ba9\u6211\u51b3\u5b9a\u4e70\u7684", "usage": "The deciding factor in a purchase", "register": "casual", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "Vaseline Lip Therapy", "meaningZh": "\u51e1\u58eb\u6797\u6da6\u5507\u818f", "usage": "A specific lip care product recommended as better than ChapStick", "register": "casual", "speakerRole": "passive"},
        {"expression": "now my wallet is empty", "meaningZh": "\u73b0\u5728\u94b1\u5305\u7a7a\u4e86", "usage": "Humorous way to say you've spent all your money", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
    ]
    data["complications"] = {
        "medium": ["The size you want is sold out and you need to decide between going up or down"],
        "hard": ["You've spent too much at one store and need to budget the remaining gift cards carefully"]
    }
    data["maxRounds"] = {"easy": 4, "medium": 6, "hard": 10}
    data["commonErrors"] = [
        "\u8bf4 'What size do you have?' \u800c\u4e0d\u662f 'Do you have this in a medium?'",
        "\u4e0d\u77e5\u9053 'try on' \u548c 'try out' \u7684\u533a\u522b",
        "\u4e0d\u719f\u6089\u7f8e\u56fd\u5546\u573a\u7684\u5e03\u5c40\u548c\u5e97\u94fa\u7c7b\u578b\uff0c\u5982 Forever 21, Claire's, Target",
    ]
    data["culturalNotes"] = (
        "\u7f8e\u56fd\u9752\u5c11\u5e74\u751f\u65e5\u5e38\u6536\u5230\u591a\u5f20\u4e0d\u540c\u5546\u5e97\u7684\u793c\u54c1\u5361\uff0c"
        "\u7136\u540e\u548c\u5bb6\u4eba\u4e00\u8d77\u53bb\u5546\u573a\u628a\u5b83\u4eec\u90fd\u82b1\u6389\uff0c\u8fd9\u662f\u5f88\u5e38\u89c1\u7684\u6d3b\u52a8\u3002"
        "Forever 21\u662f\u5e73\u4ef7\u5feb\u65f6\u5c1a\u54c1\u724c\uff0c"
        "Claire's\u4e13\u5356\u9752\u5c11\u5e74\u9970\u54c1\uff0c"
        "Target\u662f\u7efc\u5408\u6027\u96f6\u552e\u5546\u573a\u3002"
    )
    data["country"] = "US"
    save(data, p)

    print("\n=== All done! ===", flush=True)


if __name__ == "__main__":
    main()
