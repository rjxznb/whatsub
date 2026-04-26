# -*- coding: utf-8 -*-
"""Generate analysis.json for cut_-cDhWSVxPGE (health determinants lecture)."""
import json, re, os

BASE = r"C:\Users\renjx\Desktop\Get_Video\data\cc-video\medical\-cDhWSVxPGE"
VTT = os.path.join(BASE, "cut_-cDhWSVxPGE.clean.vtt")
OUT = os.path.join(BASE, "cut_-cDhWSVxPGE.analysis.json")
TRANS_FILE = r"C:\Users\renjx\Desktop\Get_Video\scripts\translations_cDhWSVxPGE.txt"

def parse_vtt(path):
    entries = []
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().strip().split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        m = re.match(r"(\d+:\d+:\d+\.\d+)\s*-->\s*(\d+:\d+:\d+\.\d+)", line)
        if m:
            s, e = m.group(1), m.group(2)
            start = sum(float(x) * [3600,60,1][j] for j,x in enumerate(s.split(":")))
            end = sum(float(x) * [3600,60,1][j] for j,x in enumerate(e.split(":")))
            text_lines = []
            i += 1
            while i < len(lines) and lines[i].strip() and not re.match(r"\d+:\d+:\d+\.\d+\s*-->", lines[i].strip()):
                text_lines.append(lines[i].strip())
                i += 1
            text = " ".join(text_lines)
            if text:
                entries.append({"time": round(start, 3), "endTime": round(end, 3), "text": text})
        else:
            i += 1
    return entries

entries = parse_vtt(VTT)

# Read translations from file (one per line)
with open(TRANS_FILE, "r", encoding="utf-8") as f:
    translations = [line.rstrip("\n") for line in f.readlines()]

# Key annotations: index -> {hw, kn, ht}
LQ = "\u201c"  # left curly double quote
RQ = "\u201d"  # right curly double quote

keys = {
    0: {
        "hw": ["sick or healthy"],
        "kn": {"sick or healthy": f"生病或健康。在公共卫生语境中，健康不仅指没有疾病，还包括身体、心理和社会适应的完好状态。WHO对健康的定义：Health is a state of complete physical, mental and social well-being."},
        "ht": {"sick or healthy": "生病或保持健康"}
    },
    3: {
        "hw": ["public health"],
        "kn": {"public health": "公共卫生。指通过有组织的社会努力来预防疾病、延长寿命和促进健康的科学与实践。区别：public health（公共卫生，关注群体）vs. clinical medicine（临床医学，关注个体）。例：Public health policies help prevent disease outbreaks."},
        "ht": {"public health": "公共卫生"}
    },
    9: {
        "hw": ["determinants"],
        "kn": {"determinants": "决定因素。发音 /d\u026a\u02c8t\u025c\u02d0rm\u026an\u0259nts/，重音在第二音节。在公共卫生领域特指影响健康状况的各种因素，包括社会、经济、环境等。常见搭配：determinants of health（健康的决定因素）、social determinants（社会决定因素）。"},
        "ht": {"determinants": "决定因素"}
    },
    11: {
        "hw": ["Determinants of health"],
        "kn": {"Determinants of health": "健康的决定因素。公共卫生核心概念，指影响个人和群体健康状况的全部因素。WHO将其分为社会经济因素、物理环境、个人行为和医疗服务获取等类别。例：Understanding the determinants of health helps us design better prevention programs."},
        "ht": {"Determinants of health": "健康的决定因素"}
    },
    24: {
        "hw": ["income and status"],
        "kn": {"income and status": "收入和社会地位。健康的首要社会决定因素。研究表明收入越高、社会地位越高的人通常越健康（称为health gradient/健康梯度）。status此处指social status（社会地位），不是身份状态。"},
        "ht": {"income and status": "收入和社会地位"}
    },
    29: {
        "hw": ["get health care"],
        "kn": {"get health care": "获得医疗保健。get在这里=obtain/access（获得/享受到）。注意英语中常说get health care或access health care，不说receive health care（较正式）。在美国，能否获得医疗保健与收入直接相关。"},
        "ht": {"get health care": "获得医疗保健"}
    },
    35: {
        "hw": ["people in your lives"],
        "kn": {"people in your lives": "你生活中的人（社会支持网络）。这里指social support networks（社会支持网络），包括家人、朋友、同事等。研究表明有良好社会支持的人身心更健康、寿命更长。"},
        "ht": {"people in your lives": "你生活中"}
    },
    38: {
        "hw": ["networks"],
        "kn": {"networks": "（人际）网络/社交圈。在公共卫生语境中指social networks/support networks（社会支持网络），即你在需要帮助时可以依靠的人际关系。例：Strong social networks are linked to better mental health outcomes."},
        "ht": {"networks": "人际网络"}
    },
    41: {
        "hw": ["literacy"],
        "kn": {"literacy": "读写能力/识字率。发音 /\u02c8l\u026at\u0259r\u0259si/。在公共卫生中还有一个重要概念叫health literacy（健康素养），指理解和运用健康信息做出正确决策的能力。反义词：illiteracy（文盲/不识字）。"},
        "ht": {"literacy": "读写能力"}
    },
    44: {
        "hw": ["employment"],
        "kn": {"employment": "就业/工作。发音 /\u026am\u02c8pl\u0254\u026am\u0259nt/。作为健康决定因素，包括：是否有工作、工作类型、工作条件、职业暴露风险等。相关词：unemployment（失业）、underemployment（就业不足）。例：Stable employment is associated with better health outcomes."},
        "ht": {"employment": "就业"}
    },
    47: {
        "hw": ["factory work"],
        "kn": {"factory work": "工厂工作。这里用来对比不同职业对健康的影响：factory work通常涉及体力劳动、噪音、化学品暴露等职业危害；office work则可能导致久坐、眼疲劳等不同健康问题。这种比较说明employment类型是健康的重要决定因素。"},
        "ht": {"factory work": "工厂工作"}
    },
    56: {
        "hw": ["social environments"],
        "kn": {"social environments": "社会环境。指一个人所处的人际关系和社交氛围，包括朋友圈、家庭、社区等。区别：social environment（社会环境，指人际关系）vs. physical environment（物理环境，指自然/建筑环境）。你的社会环境会影响你的行为习惯和健康决策。"},
        "ht": {"social environments": "社会环境"}
    },
    74: {
        "hw": ["physical environment"],
        "kn": {"physical environment": "物理环境/自然环境。指你生活和工作的实际物质环境，包括空气质量、水质、住房条件、城市规划等。physical在这里不是身体的而是物质的/有形的。例：The physical environment of a neighborhood affects residents' health."},
        "ht": {"physical environment": "物理环境"}
    },
    79: {
        "hw": ["nuclear waste site"],
        "kn": {"nuclear waste site": "核废料场。nuclear发音注意不要读成nucular。waste site = 废料场/废弃物处置场。这里作为极端例子说明物理环境对健康的影响——生活在核废料附近的人面临辐射风险。"},
        "ht": {"nuclear waste site": "核废料场"}
    },
    82: {
        "hw": ["unpolluted"],
        "kn": {"unpolluted": "未受污染的。un-（否定前缀）+ polluted（被污染的）。相关词：pollution（污染）、pollutant（污染物）、air pollution（空气污染）。savannah发音 /s\u0259\u02c8v\u00e6n\u0259/，指热带草原/大草原。"},
        "ht": {"unpolluted": "未受污染的"}
    },
    84: {
        "hw": ["Personal practices"],
        "kn": {"Personal practices": "个人行为习惯。在公共卫生中指个人的日常行为和生活方式选择，如饮食、运动、吸烟、饮酒等。也叫health behaviors（健康行为）或lifestyle factors（生活方式因素）。这是个人可以主动控制的健康决定因素。"},
        "ht": {"Personal practices": "个人习惯"}
    },
    90: {
        "hw": ["habit-building abilities"],
        "kn": {"habit-building abilities": "养成习惯的能力。指一个人培养和维持健康生活习惯的能力。habit-building是复合形容词修饰abilities。相关表达：build a habit（养成习惯）、break a habit（改掉习惯）、form healthy habits（培养健康习惯）。"},
        "ht": {"habit-building abilities": "养成习惯的能力"}
    },
    94: {
        "hw": ["Childhood"],
        "kn": {"Childhood": "童年/儿童时期。在公共卫生中，childhood development（儿童发展）是关键的健康决定因素。早期经历（包括营养、教育、家庭环境）对终身健康有深远影响。相关概念：ACEs（Adverse Childhood Experiences，童年不良经历），与成年后的慢性病风险密切相关。"},
        "ht": {"Childhood": "童年"}
    },
    98: {
        "hw": ["reversible"],
        "kn": {"reversible": "可逆的/可以逆转的。发音 /r\u026a\u02c8v\u025c\u02d0rs\u0259bl/。指童年的不良影响可以通过后天干预来改变。反义词：irreversible（不可逆的）。医学中常用：reversible condition（可逆病症）vs. irreversible damage（不可逆损伤）。"},
        "ht": {"reversible": "可逆的"}
    },
    107: {
        "hw": ["genetic predisposition"],
        "kn": {"genetic predisposition": "遗传易感性/遗传倾向。指由基因决定的患某种疾病的较高风险。predisposition = 倾向/易感性。注意：有遗传易感性不等于一定会患病，环境和行为也起重要作用。例：She has a genetic predisposition to diabetes."},
        "ht": {"genetic predisposition": "遗传易感性"}
    },
    108: {
        "hw": ["history of cancer"],
        "kn": {"history of cancer": "癌症病史/癌症家族史。在医疗场景中，family history（家族史）是医生问诊时必问的重要信息。常见问法：Does your family have a history of...?（你的家族有……的病史吗？）。history此处不是历史而是病史。"},
        "ht": {"history of cancer": "癌症病史"}
    },
    116: {
        "hw": ["health care services"],
        "kn": {"health care services": "医疗卫生服务。包括预防保健、初级保健、专科治疗、急救等。在美国，医疗服务的获取（access to health care）是重大社会议题。常见搭配：access to health care services（获得医疗服务）、health care provider（医疗服务提供者）。"},
        "ht": {"health care services": "医疗卫生服务"}
    },
    123: {
        "hw": ["steer your way around it"],
        "kn": {"steer your way around it": "绕过它/避开它。steer本意是驾驶/引导方向，steer around = 避开/绕开。这里比喻通过医生的提前预警来避免疾病。类似表达：avoid（避免）、prevent（预防）、work around（绕过）。"},
        "ht": {"steer your way around it": "绕过它"}
    },
    130: {
        "hw": ["negative side effects"],
        "kn": {"negative side effects": "负面的副作用。side effect（副作用）是医学常用词，指治疗或疾病带来的非预期附带影响。这里指疾病如果不及时治疗会带来的长期不良后果。常见搭配：side effects of medication（药物副作用）、adverse effects（不良反应）。"},
        "ht": {"negative side effects": "负面的副作用"}
    },
    133: {
        "hw": ["gender plays a role"],
        "kn": {"gender plays a role": "性别起着作用。play a role (in)是固定搭配，意为在……中起作用。gender此处不仅指生理性别（sex），也包括社会性别认同。在公共卫生中，性别影响就医行为、疾病风险和医疗资源获取。"},
        "ht": {"gender plays a role": "性别也起着作用"}
    },
    136: {
        "hw": ["gender identity"],
        "kn": {"gender identity": "性别认同。指个人对自己性别的内在感受和认知，可能与出生时的生理性别不同。这是公共卫生和医学中越来越受重视的话题。相关词：transgender（跨性别）、non-binary（非二元性别）。性别认同可能影响一个人获取医疗服务的意愿和能力。"},
        "ht": {"gender identity": "性别认同"}
    },
    137: {
        "hw": ["discriminated against"],
        "kn": {"discriminated against": "遭受歧视。discriminate against sb = 歧视某人。被动语态：be discriminated against。名词形式：discrimination（歧视）。在健康领域，歧视导致某些群体难以获得平等的医疗服务。例：People should not be discriminated against based on their gender identity."},
        "ht": {"discriminated against": "遭受歧视"}
    },
    143: {
        "hw": ["seeking help"],
        "kn": {"seeking help": "寻求帮助。seek help是正式用法，比ask for help更书面。在心理健康领域尤其重要——很多人（尤其男性）因为pride（自尊心/面子）而不愿寻求帮助。这是性别作为健康决定因素的一个具体表现。"},
        "ht": {"seeking help": "寻求帮助"}
    },
    150: {
        "hw": ["a blunt hammer"],
        "kn": {"a blunt hammer": "一个粗糙的锤子（比喻不够精确的工具/方法）。blunt本意是钝的，引申为不精确的/粗略的。这里比喻文化这个词太宽泛，不够精确地描述其对健康的影响。英语常用工具比喻：blunt instrument（粗暴的手段）、sharp tool（精确的工具）。"},
        "ht": {"a blunt hammer": "粗糙的锤子"}
    },
}

# Build subtitles
subtitles = []
for i, entry in enumerate(entries):
    tr = translations[i] if i < len(translations) else ""
    sub = {
        "time": entry["time"],
        "endTime": entry["endTime"],
        "text": entry["text"],
        "translation": tr,
        "isKeyPoint": i in keys,
        "highlightWords": keys[i]["hw"] if i in keys else [],
        "keyNotes": keys[i]["kn"] if i in keys else {},
        "highlightTranslations": keys[i]["ht"] if i in keys else {},
    }
    subtitles.append(sub)

analysis = {
    "sceneContext": "The user is a student in a public health course, attending a lecture on the determinants of health. The instructor is explaining the various factors that influence whether people become sick or stay healthy, including income, social support, education, employment, environment, personal practices, childhood development, biology, health care services, gender, and culture. The user needs to understand and discuss these determinants, ask clarifying questions, and relate them to real-world health scenarios. The AI plays Professor Mitchell, a public health instructor at a university.",
    "subtitles": subtitles,
    "keyPhrases": [
        {
            "expression": "determinants of health",
            "meaningZh": "健康的决定因素",
            "usage": "The broad set of factors that influence an individual's or population's health status",
            "register": "professional",
            "speakerRole": "both",
            "minDifficulty": "MEDIUM"
        },
        {
            "expression": "genetic predisposition",
            "meaningZh": "遗传易感性/遗传倾向",
            "usage": "An inherited increased likelihood of developing a particular disease",
            "register": "professional",
            "speakerRole": "passive"
        },
        {
            "expression": "social support networks",
            "meaningZh": "社会支持网络",
            "usage": "The people and relationships that provide help and emotional support",
            "register": "professional",
            "speakerRole": "both",
            "minDifficulty": "MEDIUM"
        },
        {
            "expression": "physical environment",
            "meaningZh": "物理环境/自然环境",
            "usage": "The natural and built surroundings that affect health",
            "register": "professional",
            "speakerRole": "both",
            "minDifficulty": "EASY"
        },
        {
            "expression": "health care services",
            "meaningZh": "医疗卫生服务",
            "usage": "The system of medical care and prevention available to a population",
            "register": "professional",
            "speakerRole": "both",
            "minDifficulty": "EASY"
        },
        {
            "expression": "discriminated against",
            "meaningZh": "遭受歧视",
            "usage": "Treated unfairly based on characteristics like gender, race, or identity",
            "register": "formal",
            "speakerRole": "passive"
        },
        {
            "expression": "childhood development",
            "meaningZh": "儿童发展/童年成长",
            "usage": "The physical, cognitive, and emotional growth during childhood that affects lifelong health",
            "register": "professional",
            "speakerRole": "passive"
        },
        {
            "expression": "play a role in",
            "meaningZh": "在……中起作用",
            "usage": "To be a contributing factor in something",
            "register": "formal",
            "speakerRole": "both",
            "minDifficulty": "EASY"
        }
    ],
    "roleSetup": {
        "name": "Professor Mitchell",
        "identity": "Public health instructor at a university",
        "personality": "knowledgeable, approachable, encouraging",
        "accent": "American"
    },
    "complications": {
        "medium": [
            "The professor asks you to explain how two determinants might interact with each other",
            "You need to give a real-world example of how income affects health outcomes"
        ],
        "hard": [
            "The professor challenges you to argue whether individual behavior or social factors have a greater impact on health",
            "You need to discuss how cultural traditions can both positively and negatively affect health"
        ]
    },
    "maxRounds": {"easy": 4, "medium": 6, "hard": 10},
    "commonErrors": [
        "把 determinant 和 determination 混淆——前者是决定因素，后者是决心",
        "把 public health（公共卫生）等同于 hospital/clinic（医院），实际上公共卫生重点在预防而非治疗",
        "说 genetic predisposition 时重音放错位置——predisposition 重音在第四音节",
        "混淆 gender（社会性别）和 sex（生理性别）——在公共卫生语境中这两个概念有重要区别"
    ],
    "culturalNotes": "在美国，公共卫生是一个重要的学术和政策领域。健康的社会决定因素（Social Determinants of Health, SDOH）近年来受到越来越多的关注，强调健康不仅取决于个人行为和医疗服务，还深受社会经济条件、物理环境和政策制度的影响。了解这些概念对在美留学生理解美国医疗体系和健康政策讨论非常有帮助。",
    "country": "US"
}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(analysis, f, ensure_ascii=False, indent=2)

print(f"Written: {OUT}")
print(f"Total subtitles: {len(subtitles)}")
print(f"Key points: {sum(1 for s in subtitles if s['isKeyPoint'])}")
print(f"With translations: {sum(1 for s in subtitles if s['translation'])}")
