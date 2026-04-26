# -*- coding: utf-8 -*-
"""Generate analysis JSON for cut_part5 from VTT."""
import re, json

vtt_path = 'data/cc-video/banking/_s1rIKaoAyM/cut_part5.clean.vtt'
out_path = 'data/cc-video/banking/_s1rIKaoAyM/cut_part5.analysis.json'

with open(vtt_path, encoding='utf-8') as f:
    text = f.read()

cue_pattern = re.compile(
    r'(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})[^\n]*\n(.*?)(?=\n\n|\n\d{2}:\d{2}|\Z)',
    re.DOTALL)

def parse_ts(ts):
    parts = ts.split(':')
    return int(parts[0])*3600 + int(parts[1])*60 + float(parts[2])

cues = []
for match in cue_pattern.finditer(text):
    start = round(parse_ts(match.group(1)), 3)
    end = round(parse_ts(match.group(2)), 3)
    body = match.group(3).strip().replace('\n', ' ')
    cues.append((start, end, body))

translations = [
    "下一个词非常有用，因为它几乎可以用来描述任何事物，可以作为很多词的同义词。而且它是最容易发音错误的",  # 0
    "英语单词之一。让我来试试。Phenomenon（现象）。它的意思是",  # 1
    "发生的或存在的事物，尤其是不寻常或有趣的事物。同义词有event、occurrence、",  # 2
    "和happening。这是一个名词，常见搭配有natural phenomenon（自然现象）。你可以",  # 3
    "用natural phenomenon来描述全球变暖，或者social phenomenon（社会现象）。指的是",  # 4
    "人们开始做的某种行为，或者你去到一个新国家发现：哦，这是一个有趣的社会现象，一种我以前没注意到的事情。例如，",  # 5
    "我最近去了一个国家，你去的每家餐厅，",  # 6
    "父母都会给孩子iPad和手机，让他们大声播放音乐和游戏，",  # 7
    "声音开到最大。你会想，这是一个有趣的现象。用这个词还能让你表达得更委婉礼貌。例句：The northern lights are a natural phenomenon that attracts",  # 8
    "很多游客。北极光是天空中的自然事物，a natural phenomenon。在范文中：This phenomenon may result in younger people being apathetic,（这种现象可能导致年轻人变得冷漠，）",  # 9
    "对政治漠不关心，选举结果也不能反映民意。你可以在引言中用这个词，也可以用在主题句、解释中，",  # 10
    "也可以用在结论中。如果你实在找不到同义词，已经重复用了好几次某个词，你就可以用this",  # 11
    "phenomenon来替换。但要确保它确实是一种现象。下一个词是proportion，意思是整体的一部分或百分比。如果你在谈论",  # 12
    "某个事物的百分比，你就可以用proportion。同义词有part、portion或fraction。这是一个名词，常见搭配有large proportion或small proportion。",  # 13
    "例如：A large proportion of the population supports the new law.（大部分人支持新法律。）在范文中：有人认为这些空缺中应有a certain proportion分配给女性。这个词",  # 14
    "在学术类Task 1中也很有用。下一个词是revenue，意思是来自商业的收入，",  # 15
    "或政府以税收形式获得的收入。这就是政府赚钱的方式。同义词有income、earnings和profits。但要注意，revenue和profits是完全",  # 16
    "不同的概念。如果你经营过生意就会知道。词性是",  # 17
    "名词，常见搭配有annual revenue（年收入）、revenue from（来自……的收入），比如revenue from taxes（税收收入）、revenue from",  # 18
    "IELTS VIP课程的收入（如果幸运的话），以及tax revenue（税收）。例句：The company's annual revenue has grown steadily.（公司年收入稳步增长。）在范文中：随着经济发展，",  # 19
    "国家产生大量revenue，可以用来提供高质量服务，比如免费教育。你经常会遇到关于政府服务的题目。教育通常是",  # 20
    "政府提供的服务，取决于你住在哪个国家。医疗有时也是政府服务——如果你住在美国就不是了。但很多题目归根结底就是：政府是否应该",  # 21
    "提供这项服务，或者政府提供的服务是否足够好？你可以讨论revenue从何而来以及如何使用。下一个词是",  # 22
    "resent，意思是对某事感到愤怒或怨恨。同义词有begrudge、dislike、",  # 23
    "或be annoyed by。这是一个动词，常见搭配有resent the implication（怨恨暗示）或resent the fact（怨恨某个事实）。例如：He began to resent the implication that he was not working hard enough.",  # 24
    "在范文中：父母应该鼓励孩子多待在家里而不是强迫他们，这样孩子就不会对父母心生怨恨。这是一种很简单的表达不喜欢某事的方式，",  # 25
    "例如：I really resent the fact that I picked so many of these words（我真的很后悔选了这么多词），没想到录这个视频要花这么长时间。下一个词是sector，",  # 26
    "意思是较大群体或领域中的部分或划分。同义词有divisions、segments或areas。",  # 27
    "这是一个名词，常见搭配有the public sector（公共部门），指为政府工作。The private sector（私营部门），也就是真正干活的人，指",  # 28
    "你不为政府工作，而是为真正的企业工作。还有the voluntary sector（志愿部门），指志愿奉献时间的人。他们不为政府也不为",  # 29
    "企业工作，而是为慈善机构工作。例如：The public sector employs many people in health care and education.（公共部门在医疗和教育领域雇用了很多人。）在范文中，",  # 30
    "有人认为他们必须只学对未来有用的东西，例如与科技领域相关的学科。下一个词是workforce，意思是一个公司或国家中所有",  # 31
    "工作的人。同义词有staff、employees和labour force。这是一个名词，",  # 32
    "常见搭配是skilled workforce（技术熟练的劳动力）。例如：A skilled workforce is key to a company's success.（技术熟练的劳动力是公司成功的关键。）在范文中：跨国公司的一个好处是雇用",  # 33
    "大量劳动力。下一个词是gifted，意思是拥有特殊天赋或能力。",  # 34
    "同义词有talented、skilled和exceptional。这是一个形容词，常见搭配",  # 35
    "是gifted child（天才儿童）或gifted children。你在谈论教育话题时经常会用到，",  # 36
    "不是每篇教育类作文都会用到，但如果你在讨论有天赋的孩子时可以使用。例如：The school has programs for gifted children,（学校有针对天才儿童的课程，）",  # 37
    "在艺术和科学领域。在范文中：Children who are gifted with a particular inborn talent often achieve their goal early.（拥有特定天赋的孩子往往能较早实现目标。）你还可以用另一个",  # 38
    "我们在视频中提到的高级词汇——innate来表达与生俱来的天赋。",  # 39
    "下一个词是nutritional，意思是与食物中的营养素有关的。同义词有",  # 40
    "dietary、nutritious和nourishing。这是一个形容词，常见搭配有",  # 41
    "nutritional value（营养价值）和nutritional deficiencies（营养缺乏）。例如，考虑食物的",  # 42
    "营养价值是很重要的。在范文中：素食的一个缺点是",  # 43
    "可能导致nutritional deficiencies（营养缺乏）。Task 2最常见的话题之一就是健康，",  # 44
    "而且很容易把健康和营养或饮食习惯联系起来。所以这是个非常重要的词。下一个词是thrive，意思是成长",  # 45
    "发展良好。同义词有flourish、prosper和succeed。这是一个动词，",  # 46
    "常见搭配是thrive in（在……中蓬勃发展）。例如：Children thrive in a loving and supporting environment.（孩子在充满爱和支持的环境中茁壮成长。）在范文中：",  # 47
    "我认为一些天生的素质对人们在某些领域蓬勃发展起着关键作用，",  # 48
    "比如音乐或体育。所以如果你想到某个人或事物",  # 49
    "正在蓬勃发展的、成功的领域，你就可以用thrive in。不仅是人，公司可以thrive，动物也可以，很多",  # 50
    "事物都可以thrive。下一个词你可能不觉得是高级词汇——unsafe。你可能觉得它是个低级词，因为你认识它、会用它，",  # 51
    "而且它很短很常见。但如果你上cambridgedictionary.org查unsafe，你会发现它是一个C1词汇。这一点非常有用，",  # 52
    "因为你们很多人以为高级词汇就是那些又长又不认识、无法使用的词，",  # 53
    "以前从没听过的。但通常不是这样。你认识的C1和C2词汇往往比你以为的多得多。这个词意思是不安全的或危险的。同义词有dangerous、",  # 54
    "risky或hazardous。这是一个形容词，非常常见的搭配是unsafe conditions（不安全的条件）。",  # 55
    "例如：The building was evacuated due to unsafe conditions.（因条件不安全，大楼被疏散。）在范文中：成为明星的负面原因之二是它创造了一个unsafe environment",  # 56
    "可能危害明星的心理健康。unsafe conditions、unsafe environment——当你谈论危险事物时，这些搭配在Task 2中经常出现。还有一个非常",  # 57
    "恰当的词作为最后一个——unwind，因为我录完这个视频后绝对需要放松一下。",  # 58
    "录完这篇文章后我肯定要好好放松。unwind意思是在工作或紧张之后放松下来。同义词有relax、rest或de-stress。这是一个动词，",  # 59
    "常见搭配是unwind after。例如：It is important to unwind after",  # 60
    "忙碌的一天，比如读了无数无数的单词和释义之后。在范文中：这篇文章认为电视可以两者兼顾，因为它帮助",  # 61
    "人们放松，同时也以容易消化的形式呈现复杂信息。",  # 62
    "现在你已经知道这些词了，我希望你想一想——你为什么在看这个视频？你看这个视频不是为了增加词汇量。你在看",  # 63
    "这个视频是为了拿到你需要的雅思分数。让我告诉你现在你能做的最糟糕的事情。如果你想提高雅思写作分数，最糟糕的做法就是",  # 64
    "拿那些词然后尽可能多地塞进你的作文里。我想用数据和一个很酷的软件工具来证明这一点，你也可以用它来分析",  # 65
    "你自己的作文。我会用这本IELTS 18里的作文来给你展示",  # 66
    "Band 7、8、9的作文中实际用了多少C1和C2词汇——这些作文是剑桥考官写的。所以如果我们看一下这个面板，",  # 67
    "我做的是用了一个很棒的工具叫Text Inspector。Text Inspector有很多功能，其中一个功能是",  # 68
    "你可以输入一段文字——我输入了Band 7、8、9学生的100篇作文——它会分析所有",  # 69
    "词汇并把它们分类为A1、A2、B1、B2、C1、C2。这也是",  # 70
    "我用来选取这些词汇的工具。例如这是所有C1词汇的列表，这是所有C2词汇的列表。但真正有趣的",  # 71
    "数据是：在所有使用的词汇中，只有3.2%",  # 72
    "的词是C2的，只有6.04%的词是C1的。这告诉你什么？超过90%",  # 73
    "在Band 7、8、9作文中使用的词汇都是A1、A2、B1、B2。你们很多人可能在想，",  # 74
    "Chris，你一向告诉大家要简化语言，不要用太多",  # 75
    "高级词汇。也许你的学生的作文是这样的，但真正的Band 7、",  # 76
    "8、9作文不是这样的。所以我又找了三篇作文",  # 77
    "来自这本剑桥18。这些是非常高水平的",  # 78
    "考官写出来放在书里的范文。来看看他们的作文是什么样的：只有1.31%的词",  # 79
    "是C2的，3.67%是C1的。大约95%的词都是A1、A2、B1、B2。而且",  # 80
    "大部分词是A1和A2，超过一半。这不仅仅是雅思作文。你可以看看任何优秀的",  # 81
    "文章。我分析了George Orwell的散文，他可能是20世纪最伟大的作家。",  # 82
    "图表看起来也一样。我还分析了我大学时期的学术期刊文章。",  # 83
    "我还看了Financial Times、Wall Street Journal，可能是报纸中最好的文章。",  # 84
    "结果也一样。所以当你打开社交媒体，打开Instagram，",  # 85
    "打开TikTok，某个人给你一堆C1和C2词汇，告诉你如果你的作文没有塞满这些词就不够好，",  # 86
    "问你自己一个问题：你觉得谁更懂？是运营世界上最成功的雅思在线课程的人？剑桥考官？George Orwell？",  # 87
    "为Financial Times和Wall Street Journal撰文的人？还是TikTok或Instagram上的某个小丑？所以你现在可能在想：那我该怎么办？你",  # 88
    "给了我这个高级词汇列表，我到底怎么在作文中使用它们来提高",  # 89
    "分数？我是说不要用C1和C2词汇吗？不是的，我说的是你应该在所有",  # 90
    "级别的词汇中做到accurately and appropriately（准确恰当地）使用。如果你想了解更多，你应该看看如何做到这一点。这个视频会更详细地讲解如何正确使用",  # 91
    "高级词汇和低级词汇。如果你想要那100篇Band 7、8、9的范文，只需在Google上搜索",  # 92
    "IELTS Advantage 100 sample essays，Google就会告诉你在哪里找到。",  # 93
]

key_data = {
    1: ("Phenomenon", "现象。发音 /fɪˈnɒmɪnən/（英）或 /fɪˈnɑːmɪnɑːn/（美），重音在第二音节。复数形式是 phenomena（不是 phenomenons）。核心搭配：natural phenomenon（自然现象）、social phenomenon（社会现象）。例：Global warming is a natural phenomenon accelerated by human activities.", "Phenomenon"),
    3: ("natural phenomenon", "自然现象。雅思写作中描述自然界事物（如全球变暖、北极光等）时的核心搭配。也可用 social phenomenon（社会现象）来描述社会行为趋势。例：Climate change is a natural phenomenon that has been intensified by industrial activities.", "natural phenomenon"),
    4: ("social phenomenon", "社会现象。用来描述社会中某种普遍行为或趋势。比直接说「问题」更学术化、更中性。例：Social media addiction is a social phenomenon that affects young people worldwide.", "social phenomenon"),
    9: ("this phenomenon", "用 this phenomenon 指代前文提到的现象，是雅思写作中的高级衔接手段。可用在引言、主体段或结论中，避免重复具体描述。比用 this issue/problem 更学术。", "这种现象"),
    12: ("proportion", "比例/部分。发音 /prəˈpɔːrʃn/。比 percentage 更学术，可互相替换。核心搭配：a large/small proportion of（大/小比例的）。Task 1 学术类图表题和 Task 2 都很常用。", "proportion"),
    13: ("large proportion", "大比例。比 many/a lot 更正式学术。写作中说：A large proportion of the population supports... 也可用 a significant proportion（相当大比例）。", "large proportion"),
    14: ("a certain proportion", "一定比例/一定的比例。在范文中用于讨论配额或名额分配。a certain proportion 比 some 更正式精确，适合讨论比例分配话题。", "a certain proportion"),
    15: ("revenue", "收入（尤指企业或政府税收）。发音 /ˈrevənjuː/，重音在第一音节。注意 revenue ≠ profit（利润）：revenue 是总收入，profit 是扣除成本后的净收入。核心搭配：annual revenue（年收入）、tax revenue（税收）。", "revenue"),
    18: ("annual revenue", "年收入/年营收。常用于讨论企业或政府的财务状况。注意 annual 发音 /ˈænjuəl/。例：The company's annual revenue exceeded $10 million last year.", "annual revenue"),
    19: ("tax revenue", "税收收入。政府通过税收获得的收入。雅思写作中讨论政府服务（教育、医疗）资金来源时的关键词。例：Governments rely on tax revenue to fund public services like education and healthcare.", "tax revenue"),
    23: ("resent", "对……心怀不满/怨恨。发音 /rɪˈzent/，重音在第二音节。注意不要和 recent（最近的）混淆。核心搭配：resent the fact that...（对……感到不满）、resent the implication（对暗示感到不满）。", "resent"),
    24: ("resent the implication", "对暗示感到不满。implication 指暗含的意思。这个搭配在讨论人际关系、职场冲突等话题时很有用。也可用 resent the fact that + 从句。例：She resented the implication that she was not qualified.", "resent the implication"),
    28: ("public sector", "公共部门（政府机构）。与 private sector（私营部门）和 voluntary sector（志愿/慈善部门）并列使用。雅思写作中讨论就业、政府角色等话题时核心词汇。", "public sector"),
    29: ("voluntary sector", "志愿/慈善部门。与 public sector 和 private sector 并列的第三种就业部门，指慈善机构和非营利组织。讨论社会服务、志愿活动话题时可用。", "voluntary sector"),
    33: ("skilled workforce", "技术熟练的劳动力。讨论经济发展、教育与就业关系等话题时的核心搭配。也可说 highly skilled workforce。例：A skilled workforce is essential for economic competitiveness.", "skilled workforce"),
    34: ("gifted", "有天赋的。比 talented 更强调与生俱来的天赋。常见搭配：gifted children（天才儿童）、gifted students。讨论教育、天赋与努力话题时使用。发音 /ˈɡɪftɪd/。", "gifted"),
    36: ("gifted children", "天才儿童/资优儿童。讨论教育制度、因材施教等话题时的核心搭配。也可说 gifted students。例：Special programs for gifted children help them reach their full potential.", "gifted children"),
    38: ("gifted", "范文中 gifted with 表示「被赋予……天赋」。可与前面学过的 innate 搭配使用来讨论天赋话题。例：Children gifted with musical talent should be given opportunities to develop their skills.", "gifted"),
    42: ("nutritional value", "营养价值。讨论健康饮食话题时的核心搭配。也常见 nutritional deficiencies（营养缺乏）。注意 nutritional（形容词）和 nutrition（名词）的区别。", "nutritional value"),
    44: ("nutritional deficiencies", "营养缺乏/营养不足。讨论素食、饮食习惯等健康话题时常用。也可说 nutrient deficiency。例：A poorly planned vegetarian diet may lead to nutritional deficiencies.", "nutritional deficiencies"),
    47: ("thrive in", "在……中蓬勃发展/茁壮成长。核心搭配 thrive in + 环境/领域。不仅用于人，公司、动物、植物都可以 thrive。例：Small businesses thrive in a supportive economic environment.", "thrive in"),
    48: ("thrive in", "范文中 thrive in some areas 表示「在某些领域表现出色」。thrive 过去式是 thrived 或 throve（较少用）。和 flourish、prosper 可互换。", "蓬勃发展"),
    52: ("unsafe", "不安全的。看似简单但实际是C1词汇（剑桥词典标注）。这说明你已经认识的很多简单词其实是高级词汇。核心搭配：unsafe conditions（不安全条件）、unsafe environment（不安全环境）。", "unsafe"),
    55: ("unsafe conditions", "不安全的条件。讨论工作环境、建筑安全、健康危害等话题时常用。也可说 unsafe working conditions（不安全的工作条件）。例：Workers have the right to refuse to work in unsafe conditions.", "unsafe conditions"),
    56: ("unsafe environment", "不安全的环境。在范文中描述名人面临的负面影响。unsafe environment 比 dangerous environment 更正式。也可用于描述工作场所、学校等。", "unsafe environment"),
    58: ("unwind", "放松/减压。发音 /ʌnˈwaɪnd/。比 relax 更生动形象（像解开缠绕的线）。核心搭配：unwind after work（下班后放松）。讨论工作生活平衡、休闲活动等话题时使用。", "unwind"),
    60: ("unwind after", "……之后放松。常见句型：It is important to unwind after a stressful day.（在压力大的一天后放松很重要。）讨论工作生活平衡时的实用搭配。", "unwind after"),
    62: ("unwind", "范文中 unwind 用于讨论电视的积极作用——帮助人们放松减压。可以替换 relax 使表达更丰富。", "放松"),
    91: ("accurately and appropriately", "准确恰当地——这是雅思写作词汇使用的核心建议。不是堆砌C1/C2高级词汇，而是在对的场景用对的词。重复使用一个正确的简单词，比用一个错误的高级词得分更高。", "accurately and appropriately"),
}

subs = []
for i, (start, end, txt) in enumerate(cues):
    sub = {
        "time": start,
        "endTime": end,
        "text": txt,
        "translation": translations[i] if i < len(translations) else "",
        "isKeyPoint": i in key_data,
        "highlightWords": [key_data[i][0]] if i in key_data else [],
        "keyNotes": {key_data[i][0]: key_data[i][1]} if i in key_data else {},
        "highlightTranslations": {key_data[i][0]: key_data[i][2]} if i in key_data else {},
    }
    subs.append(sub)

data = {
    "sceneContext": "The user is an IELTS student preparing for the writing exam, working with a vocabulary coach. They need to learn and practice advanced vocabulary words (phenomenon, proportion, revenue, resent, sector, workforce, gifted, nutritional, thrive, unsafe, unwind) and understand that high IELTS scores come from using vocabulary accurately and appropriately, not from overusing C1/C2 words.",
    "subtitles": subs,
    "keyPhrases": [
        {"expression": "natural phenomenon", "meaningZh": "自然现象", "usage": "Used to describe events in nature such as global warming or northern lights", "register": "formal", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "a large proportion of", "meaningZh": "大部分/大比例的", "usage": "Formal alternative to 'many' or 'a lot of', commonly used in IELTS Task 1 and Task 2", "register": "formal", "speakerRole": "learner", "minDifficulty": "EASY"},
        {"expression": "tax revenue", "meaningZh": "税收收入", "usage": "Government income from taxation, used when discussing public services and funding", "register": "formal", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "resent the fact that", "meaningZh": "对……感到不满/怨恨", "usage": "Expresses anger or bitterness about a situation, followed by a clause", "register": "formal", "speakerRole": "learner", "minDifficulty": "HARD"},
        {"expression": "public sector", "meaningZh": "公共部门/政府部门", "usage": "Government employment sector, contrasted with private sector and voluntary sector", "register": "formal", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "skilled workforce", "meaningZh": "技术熟练的劳动力", "usage": "Workers with specialized training, used in discussions about economics and employment", "register": "formal", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "gifted children", "meaningZh": "天才儿童/资优儿童", "usage": "Children with exceptional natural talent, used in education discussions", "register": "formal", "speakerRole": "both", "minDifficulty": "EASY"},
        {"expression": "nutritional deficiencies", "meaningZh": "营养缺乏", "usage": "Lack of essential nutrients in diet, used in health and diet discussions", "register": "formal", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "thrive in", "meaningZh": "在……中蓬勃发展", "usage": "To grow or develop successfully in a particular environment or area", "register": "formal", "speakerRole": "learner", "minDifficulty": "MEDIUM"},
        {"expression": "unwind after", "meaningZh": "……之后放松", "usage": "To relax after work or tension, more vivid than simply saying 'relax'", "register": "casual", "speakerRole": "learner", "minDifficulty": "EASY"},
    ],
    "roleSetup": {"name": "Chris", "identity": "IELTS writing instructor and vocabulary coach", "personality": "enthusiastic, humorous, knowledgeable", "accent": "American"},
    "complications": {
        "medium": [
            "The student confuses 'revenue' with 'profit' when discussing company finances",
            "The student uses 'phenomenon' in singular form when the plural 'phenomena' is needed"
        ],
        "hard": [
            "The student must write a paragraph about government spending using revenue, public sector, and proportion while maintaining appropriate register",
            "The student needs to argue about education policy using gifted, thrive in, and nutritional while avoiding overuse of C1/C2 vocabulary"
        ]
    },
    "maxRounds": {"easy": 4, "medium": 6, "hard": 10},
    "commonErrors": [
        "revenue 和 profit 混淆——revenue 是总收入，profit 是净利润",
        "phenomenon 复数用 phenomenons（应为 phenomena）",
        "堆砌高级词汇以为能得高分——实际上 Band 7-9 作文中 90% 以上是 A1-B2 词汇",
        "resent 和 recent 混淆，发音和拼写都要注意区分"
    ],
    "culturalNotes": "雅思写作的核心不是堆砌高级词汇。根据视频中展示的数据，即使是剑桥考官写的 Band 9 范文，C1 和 C2 词汇也只占不到 5%。George Orwell 和 Financial Times 的文章也是如此。关键在于「准确恰当」地使用各级别词汇，而非盲目追求高级词。",
    "country": "US"
}

with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

kp = sum(1 for s in subs if s['isKeyPoint'])
print(f'Generated: {len(subs)} subs, {kp} key points ({kp*100//len(subs)}%)')
