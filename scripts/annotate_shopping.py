# -*- coding: utf-8 -*-
"""Add key annotations to shopping cut analysis files."""
import json
import os

BASE = r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\shopping"
LQ = "\u201c"
RQ = "\u201d"


def annotate(analysis_path, annotations):
    """
    annotations: dict of text_substring -> {isKeyPoint, highlightWords, keyNotes, highlightTranslations}
    Matches by checking if the text_substring appears in the subtitle text.
    """
    with open(analysis_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    matched = 0
    for sub in data["subtitles"]:
        text = sub["text"]
        for pattern, ann in annotations.items():
            if pattern in text:
                sub["isKeyPoint"] = True
                hw = ann.get("hw", [])
                # Validate that highlight words are in the text
                valid_hw = [w for w in hw if w in text]
                sub["highlightWords"] = valid_hw
                sub["keyNotes"] = {w: ann["kn"][w] for w in valid_hw if w in ann.get("kn", {})}
                sub["highlightTranslations"] = {w: ann["ht"][w] for w in valid_hw if w in ann.get("ht", {})}
                matched += 1
                break

    with open(analysis_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    key_count = sum(1 for s in data["subtitles"] if s.get("isKeyPoint"))
    print(f"  {os.path.basename(analysis_path)}: {matched} new annotations, {key_count} total key points", flush=True)


def main():
    # ============================================================
    # EvvEAg2ODCs - Trader Joe's haul
    # ============================================================
    print("=== EvvEAg2ODCs ===", flush=True)
    annotate(os.path.join(BASE, "EvvEAg2ODCs", "cut_EvvEAg2ODCs.analysis.json"), {
        "welcome back to our channel": {
            "hw": ["welcome back"],
            "kn": {"welcome back": "YouTube\u89c6\u9891\u5f00\u573a\u767d\uff0c\u610f\u4e3a" + LQ + "\u6b22\u8fce\u56de\u6765" + RQ + "\u3002\u51e0\u4e4e\u6bcf\u4e2aYouTuber\u90fd\u7528\u8fd9\u53e5\u5f00\u573a\u3002\u4f8b\uff1aHey guys, welcome back to my channel!"},
            "ht": {"welcome back": "\u6b22\u8fce\u56de\u6765"},
        },
        "haul from Trader Joe": {
            "hw": ["haul"],
            "kn": {"haul": "\u8d2d\u7269\u5206\u4eab\u3002haul \u672c\u610f\u662f" + LQ + "\u62d6\u62fd" + RQ + "\uff0c\u5728\u8d2d\u7269\u8bed\u5883\u4e2d\u6307" + LQ + "\u4e00\u6b21\u6027\u4e70\u56de\u6765\u7684\u5168\u90e8\u4e1c\u897f" + RQ + "\u3002\u5e38\u89c1\u4e8eYouTube\u8d2d\u7269\u89c6\u9891\u6807\u9898\uff0c\u5982grocery haul, Sephora haul\u3002"},
            "ht": {"haul": "\u8d2d\u7269\u5206\u4eab"},
        },
        "start with the produce": {
            "hw": ["produce"],
            "kn": {"produce": "\u751f\u9c9c\u679c\u852c\u533a\u3002\u6ce8\u610f\u91cd\u97f3\u5728\u7b2c\u4e00\u97f3\u8282 /\u02c8pr\u0251\u02d0du\u02d0s/\uff0c\u4e0d\u8981\u8bfb\u6210\u52a8\u8bcd produce /pr\u0259\u02c8dju\u02d0s/\u3002\u8d85\u5e02\u91cc produce section \u5c31\u662f\u679c\u852c\u533a\u3002"},
            "ht": {"produce": "\u751f\u9c9c\u679c\u852c"},
        },
        "grab some buttermilk biscuits for a recipe": {
            "hw": ["buttermilk biscuits"],
            "kn": {"buttermilk biscuits": "\u9175\u4e73\u997c\u5e72\uff0c\u7f8e\u5f0f\u70d8\u7119\u5e38\u89c1\u98df\u6750\u3002\u548c\u82f1\u5f0f biscuit(\u997c\u5e72)\u4e0d\u540c\uff0c\u7f8e\u5f0f biscuit \u662f\u677e\u8f6f\u7684\u9762\u5305\u5377\u3002buttermilk \u662f\u9175\u4e73\uff0c\u8ba9\u997c\u5e72\u66f4\u677e\u8f6f\u3002"},
            "ht": {"buttermilk biscuits": "\u9175\u4e73\u997c\u5e72"},
        },
        "taco seasoning mix": {
            "hw": ["taco seasoning mix"],
            "kn": {"taco seasoning mix": "\u5861\u53ef\u8c03\u5473\u6599\u5305\u3002\u7f8e\u56fd\u5bb6\u5ead\u5e38\u7528\u6765\u505ataco\u8089\u9985\uff0c\u52a0\u5165\u7275\u8089\u672b(ground beef)\u6216\u706b\u9e21\u8089\u672b(ground turkey)\u5373\u53ef\u3002seasons two pounds \u6307\u53ef\u4ee5\u8c03\u5473\u4e24\u78c5\u8089\u3002"},
            "ht": {"taco seasoning mix": "\u5861\u53ef\u8c03\u5473\u6599"},
        },
        "seasonal item": {
            "hw": ["seasonal item"],
            "kn": {"seasonal item": "\u5b63\u8282\u9650\u5b9a\u5546\u54c1\u3002Trader Joe's\u4ee5\u5b63\u8282\u9650\u5b9a\u4ea7\u54c1\u95fb\u540d\uff0c\u9519\u8fc7\u5c31\u53ef\u80fd\u8981\u7b49\u660e\u5e74\u3002\u7c7b\u4f3c\u4e2d\u56fd\u7684" + LQ + "\u9650\u5b9a\u6b3e" + RQ + "\u6982\u5ff5\u3002"},
            "ht": {"seasonal item": "\u5b63\u8282\u9650\u5b9a"},
        },
        "I've heard so many great things": {
            "hw": ["I've heard so many great things"],
            "kn": {"I've heard so many great things": "\u6211\u542c\u8bf4\u4e86\u5f88\u591a\u597d\u8bc4\u3002\u8fd9\u662f\u7f8e\u56fd\u4eba\u8868\u8fbe" + LQ + "\u53e3\u7891\u5f88\u597d" + RQ + "\u7684\u5e38\u7528\u8bf4\u6cd5\u3002\u6bd4\u76f4\u63a5\u8bf4 people say it's good \u66f4\u81ea\u7136\u3002"},
            "ht": {"I've heard so many great things": "\u542c\u5230\u5f88\u591a\u597d\u8bc4"},
        },
        "give it a try": {
            "hw": ["give it a try"],
            "kn": {"give it a try": "\u8bd5\u8bd5\u770b\u3002\u6bd4 try it \u66f4\u53e3\u8bed\u5316\uff0c\u8bed\u6c14\u66f4\u8f7b\u677e\u3002\u5e38\u7528\u4e8e\u5c1d\u8bd5\u65b0\u98df\u7269\u6216\u65b0\u4ea7\u54c1\u7684\u573a\u666f\u3002\u4f8b\uff1aI wanted to give the garlic naan a try."},
            "ht": {"give it a try": "\u8bd5\u8bd5\u770b"},
        },
        "peanut butter filled pretzel": {
            "hw": ["pretzel nuggets"],
            "kn": {"pretzel nuggets": "\u8774\u8776\u997c\u5c0f\u5757\u3002pretzel\u662f\u7f8e\u56fd\u5e38\u89c1\u7684\u54b8\u5473\u96f6\u98df\uff0c\u6ce8\u610f\u53d1\u97f3 /\u02c8pr\u025bts\u0259l/\u3002nugget \u6307\u5c0f\u5757\u72b6\u98df\u7269\uff0c\u5982 chicken nuggets\u3002"},
            "ht": {"pretzel nuggets": "\u8774\u8776\u997c\u5c0f\u5757"},
        },
    })

    # ============================================================
    # FwqgPhtR8C0 part1 - Cooking bowl
    # ============================================================
    print("=== FwqgPhtR8C0/part1 ===", flush=True)
    annotate(os.path.join(BASE, "FwqgPhtR8C0", "cut_part1_cooking.analysis.json"), {
        "big healthy bowl": {
            "hw": ["healthy bowl"],
            "kn": {"healthy bowl": "\u5065\u5eb7\u6c99\u62c9\u7897\u3002\u7f8e\u56fd\u6d41\u884c\u7684\u4e00\u9910\u5f0f\u5065\u5eb7\u7897\u98df\uff0c\u5c06\u591a\u79cd\u98df\u6750\u7ec4\u5408\u5728\u4e00\u4e2a\u5927\u7897\u91cc\uff0c\u5e38\u5305\u62ec\u8c37\u7269\u3001\u86cb\u767d\u8d28\u3001\u852c\u83dc\u548c\u8c03\u5473\u6c41\u3002"},
            "ht": {"healthy bowl": "\u5065\u5eb7\u7897"},
        },
        "Japanese sweet potato": {
            "hw": ["Japanese sweet potato"],
            "kn": {"Japanese sweet potato": "\u65e5\u672c\u7ea2\u85af\uff0c\u5916\u76ae\u7d2b\u7ea2\u8272\u3001\u5185\u90e8\u91d1\u9ec4\u8272\uff0c\u6bd4\u666e\u901a\u7ea2\u85af\u66f4\u751c\u66f4\u7ef5\u5bc6\u3002\u5728\u7f8e\u56fd\u5065\u5eb7\u98df\u54c1\u8d85\u5e02\u5f88\u5e38\u89c1\uff0c\u662f\u597d\u7684\u590d\u5408\u78b3\u6c34\u6765\u6e90\u3002"},
            "ht": {"Japanese sweet potato": "\u65e5\u672c\u7ea2\u85af"},
        },
        "My trick to quinoa": {
            "hw": ["quinoa"],
            "kn": {"quinoa": "\u85dc\u9ea6\uff0c\u53d1\u97f3 /\u02c8ki\u02d0nw\u0251\u02d0/\uff0c\u4e0d\u8981\u8bfb\u6210 /kwi\u02c8no\u028a\u0259/\u3002\u9ad8\u86cb\u767d\u8d28\u8c37\u7269\uff0c\u5728\u7f8e\u56fd\u5065\u5eb7\u996e\u98df\u5708\u975e\u5e38\u6d41\u884c\uff0c\u5e38\u4f5c\u4e3a\u7c73\u996d\u7684\u66ff\u4ee3\u54c1\u3002"},
            "ht": {"quinoa": "\u85dc\u9ea6"},
        },
        "bibb lettuce": {
            "hw": ["bibb lettuce"],
            "kn": {"bibb lettuce": "\u6bd4\u5e03\u751f\u83dc\uff0c\u4e00\u79cd\u53f6\u5b50\u5c0f\u800c\u67d4\u8f6f\u7684\u751f\u83dc\uff0c\u53e3\u611f\u5ae9\u6ed1\u3002\u7f8e\u56fd\u8d85\u5e02\u6709\u5f88\u591a\u751f\u83dc\u54c1\u79cd\uff0c\u5982 romaine, iceberg, arugula, bibb \u7b49\uff0c\u4e2d\u56fd\u5b66\u751f\u53ef\u80fd\u4e0d\u719f\u6089\u3002"},
            "ht": {"bibb lettuce": "\u6bd4\u5e03\u751f\u83dc"},
        },
        "spicy broccoli": {
            "hw": ["spicy broccoli"],
            "kn": {"spicy broccoli": "\u8fa3\u5473\u897f\u5170\u82b1\u3002\u7f8e\u5f0f\u5065\u5eb7\u7897\u4e2d\u5e38\u89c1\u7684\u914d\u83dc\uff0c\u901a\u5e38\u7528\u8fa3\u6912\u7247\u548c\u8611\u6cb9\u70e4\u5236\u3002"},
            "ht": {"spicy broccoli": "\u8fa3\u5473\u897f\u5170\u82b1"},
        },
    })

    # ============================================================
    # FwqgPhtR8C0 part2 - Sephora makeup
    # ============================================================
    print("=== FwqgPhtR8C0/part2 ===", flush=True)
    annotate(os.path.join(BASE, "FwqgPhtR8C0", "cut_part2_makeup-1.analysis.json"), {
        "restocked on my favorite": {
            "hw": ["restocked on"],
            "kn": {"restocked on": "\u8865\u8d27\u4e86\u3002restock = re + stock\uff0c\u610f\u4e3a\u91cd\u65b0\u8865\u8d27\u3002\u7528\u4e86\u5b8c\u518d\u4e70\u53eb restock\uff0c\u4e0d\u662f rebuy\u3002\u4f8b\uff1aI need to restock on my skincare products."},
            "ht": {"restocked on": "\u8865\u8d27\u4e86"},
        },
        "rooted in artistry": {
            "hw": ["rooted in artistry"],
            "kn": {"rooted in artistry": "\u4ee5\u827a\u672f\u6027\u4e3a\u6839\u57fa\u3002rooted in \u610f\u4e3a" + LQ + "\u690d\u6839\u4e8e/\u4ee5\u2026\u4e3a\u57fa\u7840" + RQ + "\u3002artistry \u6307\u7f8e\u5986\u7684\u827a\u672f\u6027\u548c\u6280\u672f\u542b\u91cf\uff0c\u4e0d\u4ec5\u4ec5\u662f\u6d82\u5728\u8138\u4e0a\u3002"},
            "ht": {"rooted in artistry": "\u827a\u672f\u6027\u4e3a\u6839\u57fa"},
        },
        "gone viral": {
            "hw": ["gone viral"],
            "kn": {"gone viral": "\u7206\u706b\u4e86\u3002\u539f\u610f\u662f\u75c5\u6bd2\u5f0f\u4f20\u64ad\uff0c\u73b0\u5728\u5e38\u7528\u4e8e\u63cf\u8ff0\u4ea7\u54c1\u6216\u5185\u5bb9\u5728\u793e\u4ea4\u5a92\u4f53\u4e0a\u8fc5\u901f\u8d70\u7ea2\u3002\u8fd9\u662f\u975e\u5e38\u5730\u9053\u7684\u8868\u8fbe\uff0c\u6bd4\u8bf4 became very popular \u66f4\u81ea\u7136\u3002"},
            "ht": {"gone viral": "\u7206\u706b\u4e86"},
        },
        "full coverage": {
            "hw": ["full coverage"],
            "kn": {"full coverage": "\u9ad8\u906e\u7780\u529b\u3002\u5316\u5986\u54c1\u672f\u8bed\uff0c\u6307\u80fd\u5b8c\u5168\u906e\u76d6\u7622\u75d5\u3001\u6591\u70b9\u7b49\u3002\u5bf9\u5e94 light coverage(\u8f7b\u8584)\u548c medium coverage(\u4e2d\u7b49)\u3002\u4e70\u7c89\u5e95\u65f6\u5e38\u7528\u7684\u63cf\u8ff0\u3002"},
            "ht": {"full coverage": "\u9ad8\u906e\u7780\u529b"},
        },
        "a little goes a long way": {
            "hw": ["a little goes a long way"],
            "kn": {"a little goes a long way": "\u7528\u4e00\u70b9\u5c31\u591f\u4e86\u3002\u5f62\u5bb9\u4ea7\u54c1\u6d53\u7f29\u5ea6\u9ad8\uff0c\u4e0d\u9700\u8981\u7528\u5f88\u591a\u3002\u8fd9\u662f\u5f62\u5bb9\u5316\u5986\u54c1\u663e\u8272\u5ea6\u9ad8\u7684\u7ecf\u5178\u8868\u8fbe\uff0c\u4e5f\u53ef\u7528\u4e8e\u5176\u4ed6\u8bed\u5883\u3002"},
            "ht": {"a little goes a long way": "\u7528\u4e00\u70b9\u5c31\u591f\u4e86"},
        },
        "finely milled": {
            "hw": ["finely milled"],
            "kn": {"finely milled": "\u7814\u78e8\u5f88\u7ec6\u817b\u3002milled \u6307\u7814\u78e8\u52a0\u5de5\u3002\u5316\u5986\u54c1\u4e2d\u5f62\u5bb9\u6563\u7c89\u8d28\u5730\u7ec6\u816e\uff0c\u4e0a\u5986\u6548\u679c\u597d\u3002finely milled powder \u4e0d\u4f1a\u5361\u7c89\u6216\u663e\u6bdb\u5b54\u3002"},
            "ht": {"finely milled": "\u7814\u78e8\u5f88\u7ec6\u817b"},
        },
        "not a one-size-fits-all": {
            "hw": ["one-size-fits-all"],
            "kn": {"one-size-fits-all": "\u4e00\u4e2a\u5c3a\u7801\u9002\u5408\u6240\u6709\u4eba\u3002\u6bd4\u55bb\u610f\u4e49\u4e3a" + LQ + "\u4e07\u80fd\u89e3\u51b3\u65b9\u6848" + RQ + "\uff0c\u8fd9\u91cc\u6307\u6563\u7c89\u4e0d\u5e94\u8be5\u53ea\u6709\u4e00\u4e2a\u989c\u8272\u9002\u5408\u6240\u6709\u80a4\u8272\u3002\u5e38\u7528\u4e8e\u6279\u8bc4\u6ca1\u6709\u591a\u6837\u6027\u7684\u4ea7\u54c1\u3002"},
            "ht": {"one-size-fits-all": "\u4e00\u4e2a\u5c3a\u7801\u9002\u5408\u6240\u6709\u4eba"},
        },
    })

    # ============================================================
    # FwqgPhtR8C0 part3 - Beauty products continued
    # ============================================================
    print("=== FwqgPhtR8C0/part3 ===", flush=True)
    annotate(os.path.join(BASE, "FwqgPhtR8C0", "cut_part3_makeup-1.analysis.json"), {
        "freshly exfoliated skin": {
            "hw": ["exfoliated"],
            "kn": {"exfoliated": "\u53bb\u89d2\u8d28\u7684\u3002exfoliate /\u026ak\u02c8sfo\u028ali\u026a\u02cce\u026at/ \u6307\u53bb\u9664\u76ae\u80a4\u8868\u9762\u6b7b\u76ae\u3002\u4e2d\u56fd\u5b66\u751f\u5e38\u4e0d\u77e5\u9053\u8fd9\u4e2a\u8bcd\uff0c\u8bf4 'remove dead skin' \u4e5f\u53ef\u4ee5\u4f46\u4e0d\u591f\u4e13\u4e1a\u3002"},
            "ht": {"exfoliated": "\u53bb\u89d2\u8d28\u7684"},
        },
        "dupes for this product": {
            "hw": ["dupes"],
            "kn": {"dupes": "\u5e73\u66ff/\u66ff\u4ee3\u54c1\u3002dupe \u6765\u81ea duplicate\uff0c\u7f8e\u5986\u5708\u7279\u6709\u7528\u8bed\uff0c\u6307\u4ef7\u683c\u66f4\u4f4e\u4f46\u6548\u679c\u76f8\u4f3c\u7684\u4ea7\u54c1\u3002\u4f8b\uff1aThis $10 lip gloss is a great dupe for the $40 one."},
            "ht": {"dupes": "\u5e73\u66ff"},
        },
        "hyaluronic acid": {
            "hw": ["hyaluronic acid"],
            "kn": {"hyaluronic acid": "\u73bb\u5c3f\u9178\uff0c\u62a4\u80a4\u5708\u7ecf\u5178\u4fdd\u6e7f\u6210\u5206\u3002\u53d1\u97f3 /\u02cchai\u0259l\u028a\u02c8r\u0252n\u026ak \u02c8\u00e6s\u026ad/\uff0c\u975e\u5e38\u96be\u8bfb\u3002\u5e38\u7f29\u5199\u4e3a HA\u3002\u8fd9\u662f\u62a4\u80a4\u8c08\u8bdd\u4e2d\u5fc5\u77e5\u8bcd\u6c47\u3002"},
            "ht": {"hyaluronic acid": "\u73bb\u5c3f\u9178"},
        },
        "nostalgic": {
            "hw": ["nostalgic"],
            "kn": {"nostalgic": "\u6000\u65e7\u7684\u3002/n\u0252\u02c8st\u00e6ld\u0292\u026ak/ \u5f62\u5bb9\u5bf9\u8fc7\u53bb\u7f8e\u597d\u65f6\u5149\u7684\u6000\u5ff5\u3002\u8fd9\u91cc\u6307Bath & Body Works\u7684\u4ea7\u54c1\u52fe\u8d77\u4e86\u521d\u4e2d\u65f6\u4ee3\u7684\u56de\u5fc6\u3002"},
            "ht": {"nostalgic": "\u6000\u65e7"},
        },
        "what sold me": {
            "hw": ["what sold me"],
            "kn": {"what sold me": "\u8ba9\u6211\u51b3\u5b9a\u4e70\u7684\u539f\u56e0\u3002\u975e\u5e38\u5730\u9053\u7684\u8868\u8fbe\uff0c\u610f\u4e3a" + LQ + "\u6700\u5438\u5f15\u6211\u7684\u5356\u70b9" + RQ + "\u3002\u4e0d\u662f\u5b57\u9762\u610f\u601d\u7684" + LQ + "\u5356\u7ed9\u6211" + RQ + "\u3002\u4f8b\uff1aThe packaging is what sold me."},
            "ht": {"what sold me": "\u8ba9\u6211\u4e70\u5355\u7684\u539f\u56e0"},
        },
        "I'm obsessed with these bronzer sticks": {
            "hw": ["obsessed with"],
            "kn": {"obsessed with": "\u8d85\u7231/\u7740\u8ff7\u4e8e\u3002\u7f8e\u56fd\u5e74\u8f7b\u4eba\u5e38\u7528\u6765\u8868\u8fbe\u5bf9\u67d0\u4e2a\u4ea7\u54c1\u7684\u6781\u5ea6\u559c\u7231\u3002\u8bed\u6c14\u6bd4 I really like \u5f3a\u70c8\u5f97\u591a\u3002\u4f8b\uff1aI'm obsessed with this new moisturizer!"},
            "ht": {"obsessed with": "\u8d85\u7231"},
        },
        "Bath & Body Works": {
            "hw": ["Bath & Body Works"],
            "kn": {"Bath & Body Works": "\u7f8e\u56fd\u8eab\u4f53\u62a4\u7406\u54c1\u724c\uff0c\u4ee5\u9999\u6c1b\u4ea7\u54c1\u95fb\u540d\u3002\u5f88\u591a\u7f8e\u56fd\u5973\u751f\u4ece\u521d\u4e2d\u5c31\u5f00\u59cb\u7528\uff0cJapanese Cherry Blossom\u662f\u6700\u7ecf\u5178\u7684\u9999\u578b\u4e4b\u4e00\u3002"},
            "ht": {"Bath & Body Works": "Bath & Body Works"},
        },
        "underwire bra": {
            "hw": ["underwire bra"],
            "kn": {"underwire bra": "\u6709\u94a2\u5708\u7684\u6587\u80f8\u3002underwire \u6307\u6258\u4f4f\u80f8\u90e8\u7684\u91d1\u5c5e\u4e1d\u3002\u76f8\u5bf9\u7684\u662f wireless bra(\u65e0\u94a2\u5708\u6587\u80f8)\u548c sports bra(\u8fd0\u52a8\u5185\u8863)\u3002"},
            "ht": {"underwire bra": "\u6709\u94a2\u5708\u7684"},
        },
    })

    # ============================================================
    # FwqgPhtR8C0 part4 - Mediterranean cooking
    # ============================================================
    print("=== FwqgPhtR8C0/part4 ===", flush=True)
    annotate(os.path.join(BASE, "FwqgPhtR8C0", "cut_part4_cooking-1.analysis.json"), {
        "mediterranean style": {
            "hw": ["mediterranean style"],
            "kn": {"mediterranean style": "\u5730\u4e2d\u6d77\u98ce\u683c\u3002\u6ce8\u610f\u53d1\u97f3 /\u02ccmed\u026at\u0259\u02c8re\u026ani\u0259n/\u3002\u5730\u4e2d\u6d77\u996e\u98df\u4ee5\u6a44\u6984\u6cb9\u3001\u65b0\u9c9c\u852c\u83dc\u3001\u8c46\u7c7b\u548c\u8349\u672c\u4e3a\u7279\u8272\uff0c\u88ab\u8ba4\u4e3a\u662f\u4e16\u754c\u4e0a\u6700\u5065\u5eb7\u7684\u996e\u98df\u4e4b\u4e00\u3002"},
            "ht": {"mediterranean style": "\u5730\u4e2d\u6d77\u98ce\u683c"},
        },
        "fried zucchini chips": {
            "hw": ["zucchini chips"],
            "kn": {"zucchini chips": "\u7092\u897f\u8461\u82a6\u7247\u3002zucchini /zu\u02d0\u02c8ki\u02d0ni/ \u662f\u7f8e\u5f0f\u82f1\u8bed\uff0c\u82f1\u5f0f\u82f1\u8bed\u53eb courgette\u3002\u5207\u6210\u8584\u7247\u3001\u88f9\u7c89\u540e\u6cb9\u7092\u662f\u5730\u4e2d\u6d77\u98ce\u5473\u5c0f\u5403\u3002"},
            "ht": {"zucchini chips": "\u897f\u8461\u82a6\u7247"},
        },
        "pitas to put the chicken in": {
            "hw": ["pitas"],
            "kn": {"pitas": "\u53e3\u888b\u997c\u3002/\u02c8pi\u02d0t\u0259z/ \u5730\u4e2d\u6d77\u548c\u4e2d\u4e1c\u5e38\u89c1\u7684\u5706\u5f62\u9762\u997c\uff0c\u4e2d\u95f4\u6709\u53e3\u888b\u53ef\u4ee5\u585e\u8089\u548c\u852c\u83dc\u3002\u5728\u7f8e\u56fd\u5e38\u548c Greek food \u4e00\u8d77\u5403\u3002"},
            "ht": {"pitas": "\u53e3\u888b\u997c"},
        },
        "lamb chops": {
            "hw": ["lamb chops"],
            "kn": {"lamb chops": "\u7f8a\u6392\u3002lamb \u6307\u7f94\u7f8a\u8089\uff0cchops \u6307\u5e26\u9aa8\u7684\u8089\u6392\u3002\u5730\u4e2d\u6d77\u996e\u98df\u4e2d\u5e38\u89c1\u3002\u6ce8\u610f lamb \u7684 b \u4e0d\u53d1\u97f3\uff0c\u8bfb /l\u00e6m/\u3002"},
            "ht": {"lamb chops": "\u7f8a\u6392"},
        },
        "tzatziki": {
            "hw": ["tzatziki"],
            "kn": {"tzatziki": "\u5e0c\u814a\u9178\u5976\u9ec4\u74dc\u9171\u3002\u53d1\u97f3 /ts\u0251\u02d0t\u02c8si\u02d0ki/\uff0c\u662f\u5e0c\u814a\u83dc\u7684\u7ecf\u5178\u8c03\u5473\u6599\uff0c\u7528\u9178\u5976\u3001\u9ec4\u74dc\u3001\u5927\u849c\u548c\u8584\u8377\u5236\u6210\u3002\u5e38\u642d\u914d pita \u548c grilled meat\u3002"},
            "ht": {"tzatziki": "\u9178\u5976\u9ec4\u74dc\u9171"},
        },
        "egg wash": {
            "hw": ["egg wash"],
            "kn": {"egg wash": "\u86cb\u6db2\u3002\u70f9\u996a\u672f\u8bed\uff0c\u6307\u6253\u6563\u7684\u86cb\u6db2\uff0c\u7528\u4e8e\u88f9\u7c89\u524d\u7684\u7c98\u5408\u5c42\u6216\u5237\u5728\u9762\u5305\u8868\u9762\u589e\u52a0\u5149\u6cfd\u3002\u5e38\u89c1\u6d41\u7a0b\uff1aegg wash \u2192 flour coating \u2192 fry\u3002"},
            "ht": {"egg wash": "\u86cb\u6db2"},
        },
    })

    # ============================================================
    # pAC_BHLaNDk part2 - Claire's shopping
    # ============================================================
    print("=== pAC_BHLaNDk/part2 ===", flush=True)
    annotate(os.path.join(BASE, "pAC_BHLaNDk", "cut_part2_shppping.analysis.json"), {
        "Claire's gift card": {
            "hw": ["gift card"],
            "kn": {"gift card": "\u793c\u54c1\u5361\u3002\u7f8e\u56fd\u5e38\u89c1\u7684\u9001\u793c\u65b9\u5f0f\uff0c\u5c24\u5176\u662f\u9752\u5c11\u5e74\u4e4b\u95f4\u3002\u5728\u5546\u5e97\u7ed3\u8d26\u65f6\u76f4\u63a5\u5237\u5361\u4f7f\u7528\uff0c\u4f59\u989d\u4e0d\u8db3\u53ef\u7528\u73b0\u91d1\u6216\u5361\u8865\u5dee\u3002"},
            "ht": {"gift card": "\u793c\u54c1\u5361"},
        },
        "buy three get three free": {
            "hw": ["buy three get three free"],
            "kn": {"buy three get three free": "\u4e70\u4e09\u9001\u4e09\u3002\u5e38\u89c1\u4fc3\u9500\u65b9\u5f0f\u3002\u7c7b\u4f3c\u7684\u8fd8\u6709 BOGO (buy one get one free)\u3001buy two get one 50% off \u7b49\u3002\u4e2d\u56fd\u5b66\u751f\u8981\u719f\u6089\u8fd9\u4e9b\u4fc3\u9500\u8868\u8fbe\u3002"},
            "ht": {"buy three get three free": "\u4e70\u4e09\u9001\u4e09"},
        },
        "narrow": {
            "hw": ["narrowed all my options down"],
            "kn": {"narrowed all my options down": "\u7f29\u5c0f\u4e86\u9009\u62e9\u8303\u56f4\u3002narrow down \u662f\u5e38\u7528\u8bcd\u7ec4\uff0c\u6307\u4ece\u591a\u4e2a\u9009\u9879\u4e2d\u7b5b\u9009\u51fa\u5c11\u6570\u51e0\u4e2a\u3002\u4f8b\uff1aI narrowed it down to three choices."},
            "ht": {"narrowed all my options down": "\u7b5b\u9009\u51fa\u6765\u7684"},
        },
        "ended up spending one dollar": {
            "hw": ["ended up spending"],
            "kn": {"ended up spending": "\u6700\u540e\u82b1\u4e86\u3002end up + doing \u8868\u793a\u6700\u7ec8\u7ed3\u679c\uff0c\u5e38\u6709\u610f\u6599\u4e4b\u5916\u7684\u610f\u601d\u3002\u4f8b\uff1aI went in for one thing and ended up spending $200."},
            "ht": {"ended up spending": "\u6700\u540e\u82b1\u4e86"},
        },
    })

    # ============================================================
    # pVO8P4TKXJY - Sephora + Ralph's
    # ============================================================
    print("=== pVO8P4TKXJY ===", flush=True)
    annotate(os.path.join(BASE, "pVO8P4TKXJY", "cut_pVO8P4TKXJY.analysis.json"), {
        "break my bank": {
            "hw": ["break my bank"],
            "kn": {"break my bank": "\u8981\u7834\u4ea7\u4e86\u3002\u5e7d\u9ed8\u7684\u8bf4\u6cd5\uff0c\u8868\u793a\u5373\u5c06\u82b1\u5f88\u591a\u94b1\u3002\u6bd4 spend a lot \u66f4\u751f\u52a8\u6709\u8da3\u3002\u4e5f\u53ef\u4ee5\u8bf4 break the bank\u3002\u4f8b\uff1aThis bag won't break the bank."},
            "ht": {"break my bank": "\u6e05\u7a7a\u6211\u7684\u94b1\u5305"},
        },
        "I rave about all the time": {
            "hw": ["rave about"],
            "kn": {"rave about": "\u75af\u72c2\u5b89\u5229/\u6781\u529b\u63a8\u8350\u3002rave \u672c\u610f\u662f" + LQ + "\u6b22\u547c\u96c0\u8dc3" + RQ + "\uff0crave about \u8868\u793a\u5bf9\u67d0\u4e1c\u897f\u8d5e\u4e0d\u7edd\u53e3\u3002\u6bd4 recommend \u8bed\u6c14\u5f3a\u70c8\u5f97\u591a\u3002"},
            "ht": {"rave about": "\u4e00\u76f4\u5728\u5b89\u5229\u7684"},
        },
        "wifey shit": {
            "hw": ["wifey shit"],
            "kn": {"wifey shit": "\u5c45\u5bb6\u8fc7\u65e5\u5b50\u7684\u4e8b\u3002\u975e\u5e38\u53e3\u8bed\u5316\u7684\u8868\u8fbe\uff0c\u6307\u4e70\u83dc\u3001\u505a\u996d\u7b49\u5bb6\u52a1\u6d3b\u52a8\u3002wifey \u662f wife \u7684\u6635\u79f0\uff0c\u8fd9\u91cc\u5e26\u6709\u5e7d\u9ed8\u611f\u3002\u6ce8\u610f\u8fd9\u662f\u975e\u5e38\u968f\u610f\u7684\u7528\u8bed\u3002"},
            "ht": {"wifey shit": "\u5c45\u5bb6\u7684\u4e8b"},
        },
        "we don't do that here": {
            "hw": ["we don't do that here"],
            "kn": {"we don't do that here": "\u6211\u4eec\u4e0d\u5403\u8fd9\u4e9b\u3002\u5f15\u7528\u4e86\u7f51\u7edc\u6d41\u884c\u8bed meme\uff0c\u8bed\u6c14\u5e7d\u9ed8\u3002\u5728\u8fd9\u91cc\u8868\u793a\u5065\u5eb7\u996e\u98df\u8005\u62d2\u7edd\u4e0d\u5065\u5eb7\u98df\u54c1\u7684\u6001\u5ea6\u3002"},
            "ht": {"we don't do that here": "\u4e0d\u5403\u8fd9\u4e9b"},
        },
    })

    # ============================================================
    # rui0QIorHbE - Health grocery haul
    # ============================================================
    print("=== rui0QIorHbE ===", flush=True)
    annotate(os.path.join(BASE, "rui0QIorHbE", "cut_rui0QIorHbE.analysis.json"), {
        "organic turkey bacon": {
            "hw": ["organic turkey bacon"],
            "kn": {"organic turkey bacon": "\u6709\u673a\u706b\u9e21\u57f9\u6839\u3002turkey bacon \u662f\u666e\u901a\u57f9\u6839\u7684\u5065\u5eb7\u66ff\u4ee3\u54c1\uff0c\u8102\u80aa\u66f4\u4f4e\u3002organic \u6307\u65e0\u519c\u836f\u3001\u65e0\u6297\u751f\u7d20\u517b\u6b96\u3002uncured \u6307\u672a\u7528\u786c\u5316\u5242\u5904\u7406\u3002"},
            "ht": {"organic turkey bacon": "\u6709\u673a\u706b\u9e21\u57f9\u6839"},
        },
        "guar gum": {
            "hw": ["guar gum"],
            "kn": {"guar gum": "\u74dc\u5c14\u80f6/\u74dc\u5c14\u8c46\u80f6\u3002\u5e38\u89c1\u7684\u98df\u54c1\u589e\u7a20\u5242\uff0c\u5728\u6930\u5976\u3001\u51b0\u6dc7\u6dcb\u7b49\u4e2d\u5e38\u89c1\u3002\u5065\u5eb7\u996e\u98df\u8005\u5e38\u907f\u514d\u542b\u6709gums\u7684\u98df\u54c1\uff0c\u8ba4\u4e3a\u5bf9\u80a0\u9053\u4e0d\u597d\u3002"},
            "ht": {"guar gum": "\u74dc\u5c14\u80f6"},
        },
        "sea moss": {
            "hw": ["sea moss"],
            "kn": {"sea moss": "\u6d77\u82d4\u3002\u5065\u5eb7\u98df\u54c1\u5708\u7684\u8d85\u7ea7\u98df\u7269(superfood)\uff0c\u5bcc\u542b92\u79cd\u77ff\u7269\u8d28\u3002\u5e38\u5236\u6210\u51dd\u80f6\u72b6(gel)\u52a0\u5165\u5962\u6614\u4e2d\u3002\u8fd1\u5e74\u5728\u7f8e\u56fd\u5065\u5eb7\u5708\u5f88\u6d41\u884c\u3002"},
            "ht": {"sea moss": "\u6d77\u82d4"},
        },
        "anti-inflammatory": {
            "hw": ["anti-inflammatory"],
            "kn": {"anti-inflammatory": "\u6297\u708e\u7684\u3002/\u02cc\u00e6nti\u026an\u02c8fl\u00e6m\u0259t\u0259ri/ \u8fd9\u91cc\u6307\u59dc\u9ec4\u3001\u751f\u59dc\u7b49\u98df\u7269\u7684\u6297\u708e\u7279\u6027\u3002\u5065\u5eb7\u996e\u98df\u5708\u5e38\u8ba8\u8bba\u7684\u8bdd\u9898\uff0c\u4e0e chronic inflammation(\u6162\u6027\u708e\u75c7)\u76f8\u5173\u3002"},
            "ht": {"anti-inflammatory": "\u6297\u708e\u7684"},
        },
        "unrefined": {
            "hw": ["unrefined"],
            "kn": {"unrefined": "\u672a\u7cbe\u5236\u7684\u3002\u6307\u672a\u7ecf\u8fc7\u8fc7\u5ea6\u52a0\u5de5\u7684\u98df\u7269\uff0c\u4fdd\u7559\u4e86\u66f4\u591a\u5929\u7136\u8425\u517b\u3002\u5e38\u89c1\u4e8e\u6930\u5b50\u6cb9\u3001\u6a44\u6984\u6cb9\u7b49\u3002\u5bf9\u5e94 refined(\u7cbe\u5236\u7684)\u3002"},
            "ht": {"unrefined": "\u672a\u7cbe\u5236\u7684"},
        },
        "replenish your body": {
            "hw": ["replenish"],
            "kn": {"replenish": "\u8865\u5145/\u6062\u590d\u3002/r\u026a\u02c8pl\u025bn\u026a\u0283/ \u6307\u8865\u5145\u8eab\u4f53\u6d88\u8017\u7684\u80fd\u91cf\u548c\u8425\u517b\u3002\u6bd4 refill \u66f4\u6b63\u5f0f\uff0c\u5e38\u7528\u4e8e\u5065\u5eb7/\u8fd0\u52a8\u8bed\u5883\u3002\u4f8b\uff1aEat dates to replenish your energy after a workout."},
            "ht": {"replenish": "\u8865\u5145"},
        },
    })

    # ============================================================
    # s_TAZs0U3_g - Birthday shopping spree
    # ============================================================
    print("=== s_TAZs0U3_g ===", flush=True)
    annotate(os.path.join(BASE, "s_TAZs0U3_g", "cut_s_TAZs0U3_g.analysis.json"), {
        "I'm gonna try this on": {
            "hw": ["try this on"],
            "kn": {"try this on": "\u8bd5\u7a7f\u4e00\u4e0b\u3002try on \u4e13\u6307\u8bd5\u7a7f\u8863\u670d\uff0c\u548c try out(\u8bd5\u7528\u4ea7\u54c1)\u4e0d\u540c\u3002\u5728\u5546\u5e97\u91cc\u5e38\u8bf4\uff1aCan I try this on? \u6216 Where are the fitting rooms?"},
            "ht": {"try this on": "\u8bd5\u7a7f\u4e00\u4e0b"},
        },
        "That is adorable": {
            "hw": ["adorable"],
            "kn": {"adorable": "\u592a\u53ef\u7231\u4e86\u3002\u6bd4 cute \u8bed\u6c14\u66f4\u5f3a\uff0c\u5e38\u7528\u4e8e\u5f62\u5bb9\u8863\u670d\u3001\u9970\u54c1\u3001\u5c0f\u52a8\u7269\u7b49\u3002\u7f8e\u56fd\u5973\u751f\u8d2d\u7269\u65f6\u5f88\u5e38\u7528\u7684\u8d5e\u7f8e\u8bcd\u3002"},
            "ht": {"adorable": "\u53ef\u7231"},
        },
        "photo shoot outfit": {
            "hw": ["photo shoot outfit"],
            "kn": {"photo shoot outfit": "\u62cd\u7167\u4e13\u7528\u7a7f\u642d\u3002photo shoot \u6307\u4e13\u4e1a\u6216\u7cbe\u5fc3\u51c6\u5907\u7684\u62cd\u7167\uff0coutfit \u6307\u4e00\u5957\u5b8c\u6574\u7684\u7a7f\u642d\u3002\u7f8e\u56fd\u9752\u5c11\u5e74\u5e38\u4e3a\u793e\u4ea4\u5a92\u4f53\u7cbe\u5fc3\u642d\u914d\u7a7f\u642d\u3002"},
            "ht": {"photo shoot outfit": "\u62cd\u7167\u7a7f\u642d"},
        },
        "pineapple is my new favorite scent": {
            "hw": ["scent"],
            "kn": {"scent": "\u9999\u5473/\u6c14\u5473\u3002/s\u025bnt/ \u6ce8\u610f c \u4e0d\u53d1\u97f3\u3002\u6bd4 smell \u66f4\u6b63\u9762/\u4f18\u96c5\uff0c\u5e38\u7528\u4e8e\u8ba8\u8bba\u9999\u6c34\u3001\u8682\u70db\u3001\u62a4\u80a4\u54c1\u7b49\u7684\u9999\u6c14\u3002"},
            "ht": {"scent": "\u9999\u5473"},
        },
        "Vaseline Lip Therapy": {
            "hw": ["Vaseline Lip Therapy"],
            "kn": {"Vaseline Lip Therapy": "\u51e1\u58eb\u6797\u6da6\u5507\u818f\u3002\u89c6\u9891\u4e2d\u63a8\u8350\u4e3a\u6bd4ChapStick\u66f4\u597d\u7528\u7684\u66ff\u4ee3\u54c1\u3002ChapStick\u662f\u7f8e\u56fd\u6700\u5e38\u89c1\u7684\u6da6\u5507\u818f\u54c1\u724c\uff0c\u51e0\u4e4e\u6210\u4e86\u6da6\u5507\u818f\u7684\u4ee3\u540d\u8bcd\u3002"},
            "ht": {"Vaseline Lip Therapy": "\u51e1\u58eb\u6797\u6da6\u5507\u818f"},
        },
        "now my wallet is empty": {
            "hw": ["my wallet is empty"],
            "kn": {"my wallet is empty": "\u94b1\u5305\u7a7a\u4e86\u3002\u5e7d\u9ed8\u7684\u8868\u8fbe\u65b9\u5f0f\uff0c\u8868\u793a\u628a\u6240\u6709\u793c\u54c1\u5361\u90fd\u82b1\u5149\u4e86\u3002\u7c7b\u4f3c\u7684\u8868\u8fbe\u8fd8\u6709 I'm broke, I'm cleaned out\u3002"},
            "ht": {"my wallet is empty": "\u94b1\u5305\u7a7a\u4e86"},
        },
        "I'm obsessed": {
            "hw": ["I'm obsessed"],
            "kn": {"I'm obsessed": "\u6211\u592a\u7740\u8ff7\u4e86\u3002\u7f8e\u56fd\u5e74\u8f7b\u4eba\u8868\u8fbe\u5f3a\u70c8\u559c\u7231\u7684\u5e38\u7528\u8bcd\uff0c\u5728\u8d2d\u7269\u573a\u666f\u4e2d\u51e0\u4e4e\u662f\u53e3\u5934\u7985\u3002\u8bed\u6c14\u8fdc\u6bd4 I really like it \u5f3a\u70c8\u3002"},
            "ht": {"I'm obsessed": "\u6211\u592a\u7740\u8ff7\u4e86"},
        },
        "intensive repair conditioner": {
            "hw": ["intensive repair conditioner"],
            "kn": {"intensive repair conditioner": "\u6df1\u5c42\u4fee\u62a4\u62a4\u53d1\u7d20\u3002intensive = \u5f3a\u6548\u7684\uff0crepair = \u4fee\u590d\uff0cconditioner = \u62a4\u53d1\u7d20\u3002\u8d2d\u4e70\u62a4\u53d1\u4ea7\u54c1\u65f6\u5e38\u89c1\u7684\u63cf\u8ff0\uff0c\u9002\u5408\u53d7\u635f\u53d1\u8d28\u3002"},
            "ht": {"intensive repair conditioner": "\u6df1\u5c42\u4fee\u62a4\u62a4\u53d1\u7d20"},
        },
    })

    # ============================================================
    # pAC_BHLaNDk part1 - Kayaking (add a few annotations)
    # ============================================================
    print("=== pAC_BHLaNDk/part1 ===", flush=True)
    annotate(os.path.join(BASE, "pAC_BHLaNDk", "cut_part1_exercise-1.analysis.json"), {
        "life jacket on": {
            "hw": ["life jacket"],
            "kn": {"life jacket": "\u6551\u751f\u8863\u3002\u6c34\u4e0a\u6d3b\u52a8\u5fc5\u5907\u7684\u5b89\u5168\u88c5\u5907\uff0c\u4e5f\u53eb life vest\u3002\u5728\u7f8e\u56fd\u5f88\u591a\u6c34\u4e0a\u6d3b\u52a8\u573a\u6240\u6cd5\u5f8b\u8981\u6c42\u5fc5\u987b\u7a7f\u6234\u3002"},
            "ht": {"life jacket": "\u6551\u751f\u8863"},
        },
        "meet and greet": {
            "hw": ["meet and greets"],
            "kn": {"meet and greets": "\u89c1\u9762\u4f1a\u3002\u6307\u7c89\u4e1d\u4e0e\u7f51\u7ea2/\u660e\u661f\u7684\u89c1\u9762\u6d3b\u52a8\u3002\u5728\u7f8e\u56fd\u5f88\u5e38\u89c1\uff0c\u7c89\u4e1d\u53ef\u4ee5\u5408\u5f71\u3001\u7b7e\u540d\u7b49\u3002\u7c7b\u4f3c\u4e2d\u56fd\u7684" + LQ + "\u7c89\u4e1d\u89c1\u9762\u4f1a" + RQ + "\u3002"},
            "ht": {"meet and greets": "\u89c1\u9762\u4f1a"},
        },
        "I definitely recommend": {
            "hw": ["I definitely recommend"],
            "kn": {"I definitely recommend": "\u6211\u5f3a\u70c8\u63a8\u8350\u3002\u52a0 definitely \u8ba9\u63a8\u8350\u66f4\u6709\u529b\u5ea6\u3002\u6bd4 I recommend \u8bed\u6c14\u66f4\u5f3a\uff0c\u663e\u5f97\u66f4\u771f\u8bda\u3002"},
            "ht": {"I definitely recommend": "\u5f3a\u70c8\u63a8\u8350"},
        },
        "getting nervous": {
            "hw": ["getting nervous"],
            "kn": {"getting nervous": "\u5f00\u59cb\u7d27\u5f20\u4e86\u3002getting + adj \u8868\u793a\u72b6\u6001\u53d8\u5316\uff0c\u6bd4 I am nervous \u66f4\u5f3a\u8c03\u8fc7\u7a0b\u3002\u4f8b\uff1aI'm getting hungry(\u6211\u5f00\u59cb\u997f\u4e86)\u3002"},
            "ht": {"getting nervous": "\u5f00\u59cb\u7d27\u5f20"},
        },
    })

    # ============================================================
    # pAC_BHLaNDk part3 - Packing (add a few annotations)
    # ============================================================
    print("=== pAC_BHLaNDk/part3 ===", flush=True)
    annotate(os.path.join(BASE, "pAC_BHLaNDk", "cut_part3_trip.analysis.json"), {
        "3.4 ounces": {
            "hw": ["3.4 ounces"],
            "kn": {"3.4 ounces": "\u7ea6100\u6beb\u5347\u3002\u7f8e\u56fdTSA\u89c4\u5b9a\u968f\u8eab\u884c\u674e\u4e2d\u6db2\u4f53\u4e0d\u5f97\u8d85\u8fc73.4 oz (100ml)\u3002\u8fd9\u662f\u5750\u98de\u673a\u5fc5\u987b\u77e5\u9053\u7684\u89c4\u5219\uff0c\u6240\u4ee5\u624d\u6709 travel size \u4ea7\u54c1\u3002"},
            "ht": {"3.4 ounces": "3.4\u76ce\u53f8"},
        },
        "carry-on": {
            "hw": ["travel on"],
            "kn": {"travel on": "\u968f\u8eab\u884c\u674e/\u767b\u673a\u7bb1\u3002\u8fd9\u91cc\u5176\u5b9e\u662f carry-on \u7684\u53e3\u8bef\u3002carry-on bag \u6307\u5e26\u4e0a\u98de\u673a\u7684\u5c0f\u884c\u674e\uff0c\u4e0e checked bag(\u6258\u8fd0\u884c\u674e)\u76f8\u5bf9\u3002"},
            "ht": {"travel on": "\u968f\u8eab\u884c\u674e"},
        },
        "extra room in her suitcase": {
            "hw": ["extra room"],
            "kn": {"extra room": "\u591a\u4f59\u7684\u7a7a\u95f4\u3002room \u8fd9\u91cc\u4e0d\u662f" + LQ + "\u623f\u95f4" + RQ + "\u7684\u610f\u601d\uff0c\u800c\u662f" + LQ + "\u7a7a\u95f4" + RQ + "\u3002\u5e38\u89c1\u8868\u8fbe\uff1aIs there room for one more? \u8fd8\u80fd\u518d\u585e\u4e00\u4e2a\u5417\uff1f"},
            "ht": {"extra room": "\u591a\u4f59\u7684\u7a7a\u95f4"},
        },
        "beauty blender": {
            "hw": ["beauty blender"],
            "kn": {"beauty blender": "\u7f8e\u5986\u86cb\u3002\u6700\u521d\u662f\u54c1\u724c\u540d(beautyblender)\uff0c\u73b0\u5728\u6cdb\u6307\u6240\u6709\u7c7b\u4f3c\u7684\u6d77\u7ef5\u5316\u5986\u5de5\u5177\u3002\u7528\u6765\u4e0a\u7c89\u5e95\u6db2\u3001\u906e\u7780\u7b49\uff0c\u662f\u7f8e\u56fd\u5973\u751f\u5316\u5986\u5305\u7684\u5fc5\u5907\u54c1\u3002"},
            "ht": {"beauty blender": "\u7f8e\u5986\u86cb"},
        },
    })

    print("\n=== All annotations done! ===", flush=True)


if __name__ == "__main__":
    main()
